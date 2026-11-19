#!/usr/bin/env bash
#
# publish-release.sh — dsh-workplan 幂等自动发布编排脚本（T4 产物）
# ============================================================================
# 它做什么：一条可重复执行的命令，覆盖「GitHub 源码+tag 推送」与「索引源
# （npm 官方注册表）发布」两个动作。默认发布通道是仓库自带的 CI 流水线
# .github/workflows/release.yml（推 tag 后自动 build→test→GitHub Release→
# npm publish，Release 已存在时 --clobber 覆盖、天然幂等）；本脚本负责本地
# 侧编排：版本四处同步 → 检查/测试 → 提交打 tag 推送 → 轮询 CI 与两端结果
# 直至可复核。加 --local 时才回退到本地直发（release.sh 全链路）。
#
# 为什么默认走 CI 而不本地直发：release.sh 的本地链路自己也会 gh release
# create + npm publish；若同时又推了 tag，CI 的 release job 会再次发布，
# npm 对已存在版本会报错造成 CI 红叉。两个发布者必须二选一，CI 通道的
# 凭证（GITHUB_TOKEN / NPM_TOKEN secrets 与 npm --provenance）已在仓库内
# 配置完毕（T2 已核实），故选 CI 为默认发布者。
#
# 用法（在 plugins/dsh-workplan/ 仓库根执行）：
#   ./scripts/publish-release.sh --version 3.0.5 --summary "一句话说明" --yes
#   ./scripts/publish-release.sh --version 3.0.5 --dry-run        # 干跑
#   ./scripts/publish-release.sh --version 3.0.5 --local --dry-run # 本地直发模式干跑
#   ./scripts/publish-release.sh --version 3.0.5 --phase verify   # 只做事后验证
#
# 幂等性（重复执行安全，A2）：
#   - 版本号已与目标一致 → 跳过版本同步；
#   - 提交后工作区干净且远端已有该 tag → 跳过提交/打 tag/推送；
#   - GitHub Release 已存在 → 不重复创建（CI 侧 --clobber 覆盖资产）；
#   - npm 上该版本已存在且 dist-tags.latest 指向它 → 验证通过直接退出 0。
#
# 凭证（质量要求 1：绝不硬编码任何密钥/token）：
#   本脚本不读取、不打印任何 token。推送用 git/SSH（ssh-agent 或系统钥匙串），
#   GitHub 查询用 gh CLI 的登录态，npm 验证用 npm CLI 的登录态；
#   CI 通道的 NPM_TOKEN/GITHUB_TOKEN 由 GitHub Secrets 注入，本脚本只引用
#   环境变量名而不赋值。可选环境变量：GH_TOKEN（gh 非交互场景）、
#   NODE_AUTH_TOKEN（--local 模式 npm publish 所需）。
#
# 错误处理（质量要求 2）：set -euo pipefail + 每步显式校验，任一失败立即
# 非零退出并打印失败步骤，绝不带着半成品继续。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GH_REPO="abbaababa/dsh-workplan"
NPM_PKG="dsh-workplan"

VERSION=""
SUMMARY=""
DRY_RUN=0
ASSUME_YES=0
LOCAL_MODE=0
PHASE="all"
CI_TIMEOUT_MINUTES="${CI_TIMEOUT_MINUTES:-15}"

log()  { printf '[publish] %s\n' "$*"; }
warn() { printf '[publish][警告] %s\n' "$*" >&2; }
die()  { printf '[publish][错误] %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

# 统一执行入口：dry-run 只打印
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: $*"
  else
    log "执行: $*"
    "$@"
  fi
}

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  [[ $# -ge 2 ]] || die "--version 需要参数"; VERSION="$2"; shift 2 ;;
    --summary)  [[ $# -ge 2 ]] || die "--summary 需要参数"; SUMMARY="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --local)    LOCAL_MODE=1; shift ;;
    --phase)    [[ $# -ge 2 ]] || die "--phase 需要参数"; PHASE="$2"; shift 2 ;;
    --help|-h)  usage; exit 0 ;;
    *)          die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

[[ -n $VERSION ]] || die "缺少 --version。示例: ./scripts/publish-release.sh --version 3.0.5 --dry-run"
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "版本号格式不对: '$VERSION'"
case "$PHASE" in all|prepare|push|verify) ;; *) die "--phase 只能是 all|prepare|push|verify" ;; esac

TAG="v$VERSION"
SUMMARY="${SUMMARY:-release $TAG}"
cd "$REPO_ROOT"
git rev-parse --show-toplevel >/dev/null 2>&1 || die "必须在 dsh-workplan 仓库根内执行"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "仓库: $REPO_ROOT  分支: $BRANCH  目标版本: $VERSION  模式: $( [[ $DRY_RUN -eq 1 ]] && echo dry-run || echo 正式 )  通道: $( [[ $LOCAL_MODE -eq 1 ]] && echo '本地直发(release.sh)' || echo 'CI(release.yml)' )"

# ---------- 通用小工具 ----------
tool_ok() { command -v "$1" >/dev/null 2>&1; }

# 远端是否已有该 tag（幂等守卫）
remote_has_tag() {
  git ls-remote --tags origin "$TAG" 2>/dev/null | grep -q "refs/tags/$TAG"
}

# npm 上该版本是否已发布且为 latest（幂等守卫）
npm_done() {
  tool_ok npm || return 1
  local v
  v="$(npm view "$NPM_PKG@latest" version 2>/dev/null)" || return 1
  [[ $v == "$VERSION" ]]
}

# GitHub Release 是否已存在（幂等守卫）
gh_release_done() {
  tool_ok gh || return 1
  gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1
}

# ---------- 前置检查 ----------
preflight() {
  log "── 前置检查 ──"
  for c in git node npm; do tool_ok "$c" || die "未找到命令 $c"; done
  if [[ $LOCAL_MODE -eq 0 ]]; then
    if [[ $DRY_RUN -eq 0 ]]; then tool_ok gh || die "CI 模式需要 gh CLI 做发布验证"; fi
  fi
  [[ $DRY_RUN -eq 1 ]] || gh auth status >/dev/null 2>&1 || die "gh 未登录（gh auth login）"
  # 敏感操作凭证只检查存在性/登录态，绝不读取或打印明文（质量要求 1）
  if [[ $DRY_RUN -eq 0 ]]; then
    npm whoami >/dev/null 2>&1 || warn "npm 未登录：verify 阶段将无法本地复核（CI 不受影响）"
  fi
  # 目标版本不得与线上已发布版本重复（除非两端都已发布完毕 = 幂等直通）
  if [[ $DRY_RUN -eq 0 ]] && npm_done && gh_release_done; then
    log "npm latest 与 GitHub Release 均已是 ${VERSION}：发布早已完成，幂等退出 ✓"
    exit 0
  fi
  if [[ $DRY_RUN -eq 0 ]] && tool_ok npm && [[ -n $(npm view "$NPM_PKG@$VERSION" version 2>/dev/null) ]]; then
    if ! npm_done; then
      die "npm 上 $VERSION 已存在但不是 latest：版本号冲突，请换一个未占用的新版本号"
    fi
  fi
  log "前置检查通过 ✓"
}

# ---------- prepare：版本四处同步 + 检查/测试 + 提交（幂等） ----------
do_prepare() {
  log "── prepare：版本同步与本地检查 ──"
  local cur
  cur="$(node -p "require('./package.json').version")"
  if [[ $cur == "$VERSION" ]]; then
    log "package.json 已是 ${VERSION}，跳过版本同步（幂等）"
  else
    # 版本同步逻辑与 release.sh 步骤②保持一致（含 src/host.ts 唯一行校验，防误改）
    if [[ $DRY_RUN -eq 1 ]]; then
      log "[dry-run] 将执行: npm version $VERSION --no-git-tag-version"
      log "[dry-run] 将执行: sed 修改 src/host.ts meta.version → $VERSION"
      log "[dry-run] 将在 CHANGELOG.md 顶部插入 ## $VERSION — $(date +%F)"
      log "[dry-run] 将同步三语 README 徽章与 tests/fixtures/tool-surface.json → $VERSION"
      log "[dry-run] 将执行: npm run check && npm test && npm run build && git diff --exit-code -- lib client.js"
    else
      npm version "$VERSION" --no-git-tag-version
      local cnt
      cnt="$(grep -cE "^[[:space:]]*version: '[^']*',[[:space:]]*$" src/host.ts || true)"
      [[ $cnt == 1 ]] || die "src/host.ts 版本行有 $cnt 处（预期 1 处），中止"
      if sed --version >/dev/null 2>&1; then
        sed -i -E "s/^([[:space:]]*)version: '[^']*',[[:space:]]*$/\1version: '$VERSION',/" src/host.ts
      else
        sed -i '' -E "s/^([[:space:]]*)version: '[^']*',[[:space:]]*$/\1version: '$VERSION',/" src/host.ts
      fi
      grep -qE "^[[:space:]]*version: '$VERSION'," src/host.ts || die "src/host.ts 版本写入校验失败"
      local cur_esc tmp
      cur_esc="$(printf '%s' "$cur" | sed 's/\./\\./g')"
      if sed --version >/dev/null 2>&1; then
        sed -i -E "s/version-$cur_esc-blue\.svg/version-$VERSION-blue.svg/g; s|releases/tag/v$cur_esc|releases/tag/v$VERSION|g; s/dsh-workplan@$cur_esc/dsh-workplan@$VERSION/g" README.md README.en.md README.zh.md
        sed -i -E "s/\"version\": \"$cur_esc\"/\"version\": \"$VERSION\"/" tests/fixtures/tool-surface.json
      else
        sed -i '' -E "s/version-$cur_esc-blue\.svg/version-$VERSION-blue.svg/g; s|releases/tag/v$cur_esc|releases/tag/v$VERSION|g; s/dsh-workplan@$cur_esc/dsh-workplan@$VERSION/g" README.md README.en.md README.zh.md
        sed -i '' -E "s/\"version\": \"$cur_esc\"/\"version\": \"$VERSION\"/" tests/fixtures/tool-surface.json
      fi
      tmp="$(mktemp)"
      { printf '## %s — %s\n\n- %s\n\n' "$VERSION" "$(date +%F)" "$SUMMARY"; cat CHANGELOG.md; } > "$tmp"
      mv "$tmp" CHANGELOG.md
      head -1 CHANGELOG.md | grep -qF "## $VERSION" || die "CHANGELOG.md 插入校验失败"
      printf '# %s\n\n%s\n\n- tag: %s\n- date: %s\n- npm: https://www.npmjs.com/package/%s/v/%s\n' \
        "$TAG" "$SUMMARY" "$TAG" "$(date +%F)" "$NPM_PKG" "$VERSION" > "docs/release-notes-$VERSION.md"
      log "版本四处同步完成 ✓（含三语 README 与 tool-surface.json，规避 #399/#400 CI 红叉）"
      npm run check && npm test && npm run build
      git diff --exit-code -- lib client.js || die "构建产物不可复现，禁止发布"
      log "check/test/build 全绿且产物可复现 ✓"
    fi
  fi
  # 提交（幂等：无变更则跳过）
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: git add -A && git commit（有变更才提交）"
  elif [[ -n $(git status --porcelain) ]]; then
    git add -A
    git commit -m "Release $VERSION: $SUMMARY"
    log "提交完成 ✓"
  else
    log "工作区干净，无新提交（幂等跳过）"
  fi
}

# ---------- push：打 tag 并推送（幂等），触发 CI 发布 ----------
do_push() {
  log "── push：tag 与推送 ──"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: git tag -a $TAG -m '$TAG $SUMMARY'（本地无此 tag 时）"
    log "[dry-run] 将执行: git push origin $BRANCH && git push origin $TAG"
    if [[ $LOCAL_MODE -eq 0 ]]; then
      log "[dry-run] 推送后 CI(release.yml) 将自动: 校验版本一致 → build → test → 创建 GitHub Release(带 tgz) → npm publish --provenance"
    fi
    return 0
  fi
  if remote_has_tag; then
    log "远端已存在 ${TAG}，跳过打 tag/推送（幂等）；发布状态转 verify 复核"
  else
    git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1 || git tag -a "$TAG" -m "$TAG $SUMMARY"
    git push origin "$BRANCH"
    git push origin "$TAG"
    log "tag $TAG 已推送 ✓"
  fi
  if [[ $LOCAL_MODE -eq 1 ]]; then
    log "本地直发模式：调用 release.sh 发布链路（步骤⑤→⑧）"
    ./release.sh --version "$VERSION" --summary "$SUMMARY" --yes
  fi
}

# ---------- verify：轮询 CI 与两端，直至可复核或超时 ----------
do_verify() {
  log "── verify：发布结果复核 ──"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: gh run list --repo ${GH_REPO} --workflow release.yml（观察 tag 触发的运行）"
    log "[dry-run] 将执行: gh release view ${TAG} --repo ${GH_REPO}（Release 存在且含 tgz 资产）"
    log "[dry-run] 将执行: curl -sIL 校验制品下载 URL 返回 HTTP 200"
    log "[dry-run] 将执行: npm view ${NPM_PKG}@${VERSION} version 与 npm view ${NPM_PKG}@latest version（应等于 ${VERSION}）"
    return 0
  fi
  if [[ $LOCAL_MODE -eq 0 ]] && remote_has_tag && ! gh_release_done; then
    log "等待 CI 完成（最长 $CI_TIMEOUT_MINUTES 分钟）……"
    gh run watch "$(gh run list --repo "$GH_REPO" --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" \
      --repo "$GH_REPO" --exit-status --interval 30 || die "CI 运行失败或超时，请到 GitHub Actions 查看"
  fi
  gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1 || die "GitHub Release $TAG 不存在"
  local assets
  assets="$(gh release view "$TAG" --repo "$GH_REPO" --json assets --jq '.assets | length')"
  [[ $assets -ge 1 ]] || die "Release $TAG 没有 tgz 资产（索引源会 404，RELEASING.md §3 教训）"
  local code
  code="$(curl -sIL -o /dev/null -w '%{http_code}' \
    "https://github.com/$GH_REPO/releases/download/$TAG/dsh-workplan-$VERSION.tgz" || true)"
  [[ $code == 200 ]] || die "Release 制品下载校验失败（HTTP ${code}）"
  log "GitHub Release ✓（含 $assets 个资产，下载 HTTP 200）"
  npm_done || die "npm latest 尚未指向 $VERSION"
  npm view "$NPM_PKG@$VERSION" version dist.tarball
  log "npm latest=$VERSION ✓"
}

# ---------- 主流程 ----------
preflight
case "$PHASE" in
  prepare) do_prepare ;;
  push)    do_push ;;
  verify)  do_verify ;;
  all)
    do_prepare
    if [[ $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 && -t 0 ]]; then
      printf '[publish] 即将推送 %s 触发正式发布。输入 y 确认: ' "$TAG"
      read -r REPLY
      [[ $REPLY == y || $REPLY == Y ]] || die "已按用户要求取消"
    elif [[ $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 && ! -t 0 ]]; then
      die "非交互环境须加 --yes"
    fi
    do_push
    do_verify
    ;;
esac

log "──────────────────────────────────────────────"
log "✅ $VERSION 编排完成（通道: $( [[ $LOCAL_MODE -eq 1 ]] && echo 本地 || echo CI )）"
log "GitHub: https://github.com/$GH_REPO/releases/tag/$TAG"
log "npm:    https://www.npmjs.com/package/$NPM_PKG/v/$VERSION"
warn "人工收尾（脚本不代做，RELEASING.md §5/§6）：索引源 dsh-plugin-catalog 条目 PR + docs/release-record 发布记录"
