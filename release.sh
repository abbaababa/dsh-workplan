#!/usr/bin/env bash
#
# release.sh — dsh-workplan 一键发布脚本
# ============================================================================
# 它做什么：把 RELEASING.md §0–§7 里「人工照清单一步步敲」的发布流程封装成
# 一条命令：版本四处同步 → 检查/构建/测试 → 提交打 tag 推送 → 按 tag 干净打包
# tgz → GitHub Release（必须带制品）→ npm publish → 发布后验证。
#
# 用法（在本目录 plugins/dsh-workplan/ 下执行）：
#   ./release.sh --version 2.1.4 --summary "一句话说明" --yes  # 完整发布
#   ./release.sh --version 2.1.4 --dry-run                     # 干跑：只打印将执行的命令
#   ./release.sh --version 2.1.4 --rollback                    # 回滚：删 GitHub Release（tag 保留）
#   ./release.sh --help                                        # 查看帮助
#
# 参数：
#   --version X.Y.Z   必填（除 --help 外）。要发布的语义化版本号，如 2.1.4
#   --summary "文本"  本次发布的一句话说明（默认 "release vX.Y.Z"）。
#                     同时用于 CHANGELOG 条目 / 提交信息 / tag 说明 / Release 标题
#   --dry-run         干跑模式：只打印每个步骤将执行的命令，
#                     不改任何文件、不做任何网络请求、不创建临时目录
#   --yes             跳过发布前的确认提问（无人值守/脚本化时必须加）
#   --with-w5         追加执行 RELEASING.md §1.4 的 W5 跨版本探针。默认不执行：
#                     该探针自 2026-11-04 起有已知未决偏差 RESULT: FAIL (1)，
#                     断言/夹具待工程与质量确认（见 RELEASING.md §1.4「已知偏差」）
#   --rollback        回滚模式：gh release delete vX.Y.Z（npm unpublish 只打印
#                     命令不自动执行，因为它 24 小时内不可逆，需人工确认）
#   --help            显示本帮助
#
# 前置条件：
#   1) 已安装 node、npm、git、gh、curl，且 `gh auth status` 已登录、
#      `npm whoami` 是有 dsh-workplan 发布权的账号；
#   2) 在 main 分支、工作区干净（所有改动已提交或还原）；
#   3) 目标版本号尚未存在对应 git tag。
#
# 步骤顺序（依据 RELEASING.md §0–§7 与 RELEASE_STEPS_T1.md 的顺序铁律）：
#   ① 检查（工具存在/gh 登录/工作区干净/tag 不存在/版本号确实是新的）
#   ② 版本四处同步：package.json + package-lock.json（npm version）、
#      src/host.ts 的 meta.version（sed 精确匹配唯一一行）、
#      CHANGELOG.md 顶部插入新小节、生成 docs/release-notes-X.Y.Z.md
#   ③ npm run check → npm test（含 build 与 version-sync 四处一致断言）→
#      重新 build → git diff --exit-code -- lib client.js（产物可复现）
#   ④ git add -A → commit "Release X.Y.Z: 说明" → tag -a vX.Y.Z → push 分支与 tag
#   ⑤ 按 tag 干净检出（clone 到临时目录）→ npm ci → build → npm pack → 记录 sha256
#   ⑥ gh release create vX.Y.Z 附 tgz 制品（Release 不带制品会让索引源 404，教训见 §3）
#   ⑦ curl 验证 Release 制品 URL 可下载（HTTP 200，仍在步骤⑥内完成）
#   ⑧ npm whoami → npm publish → npm view 验证 latest 指向新版本
#
# 本脚本明确不做的事（边界）：
#   - 不重启任何服务/进程（运行中的 DSH 加载新代码由用户重启，属运行环境职责）；
#   - 不改上游索引源 dsh-plugin-catalog（条目 PR 由人工完成，见 RELEASING.md §5）；
#   - 不执行 npm unpublish（回滚时仅打印命令，由人工确认后执行）；
#   - 除仓库目录与系统临时目录（mktemp）外不写任何位置。
#
# 发布成功后还需人工收尾（脚本末尾会再次提醒）：
#   - RELEASING.md §5：索引源条目 PR（tarball 指向本次 Release）；
#   - RELEASING.md §6：docs/release-record-<版本>-<日期>.md 发布记录；
#   - 如需让本机运行中的 DSH 立即用上新版，由用户重启服务。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GH_REPO="abbaababa/dsh-workplan"
NPM_PKG="dsh-workplan"

VERSION=""
SUMMARY=""
DRY_RUN=0
ASSUME_YES=0
WITH_W5=0
ROLLBACK=0

log()  { printf '[release] %s\n' "$*"; }
warn() { printf '[release][警告] %s\n' "$*" >&2; }
die()  { printf '[release][错误] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
release.sh — dsh-workplan 一键发布脚本

用法:
  ./release.sh --version 2.1.4 --summary "一句话说明" --yes   # 完整发布
  ./release.sh --version 2.1.4 --dry-run                      # 干跑（只打印，不执行）
  ./release.sh --version 2.1.4 --rollback                     # 回滚 GitHub Release
  ./release.sh --help

参数:
  --version X.Y.Z   必填。要发布的语义化版本号（如 2.1.4）
  --summary "文本"  一句话发布说明（默认 "release vX.Y.Z"）
  --dry-run         干跑：只打印将执行的命令，不改文件、不发请求
  --yes             跳过发布前确认提问
  --with-w5         追加 W5 跨版本探针（默认不跑，见 RELEASING.md §1.4 已知偏差）
  --rollback        回滚：删除 GitHub Release（tag 保留；npm unpublish 只打印命令）

完整步骤、前置条件与边界说明见本文件头部注释。
EOF
}

# 统一执行入口：干跑模式只打印将要执行的命令，不真正执行
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: $*"
  else
    log "执行: $*"
    "$@"
  fi
}

# 跨平台 sed -i（macOS/BSD 与 GNU/Linux 语法不同）
sed_inplace() {
  local expr="$1"; shift
  if sed --version >/dev/null 2>&1; then sed -i -E "$expr" "$@"; else sed -i '' -E "$expr" "$@"; fi
}

# 跨平台 sha256（macOS 用 shasum -a 256，Linux 用 sha256sum）
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  [[ $# -ge 2 ]] || die "--version 需要参数，如 --version 2.1.4"; VERSION="$2"; shift 2 ;;
    --summary)  [[ $# -ge 2 ]] || die "--summary 需要参数"; SUMMARY="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --with-w5)  WITH_W5=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --help|-h)  usage; exit 0 ;;
    *)          die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

if [[ -z $VERSION ]]; then
  die "缺少 --version 参数。用法示例: ./release.sh --version 2.1.4 --summary \"说明\" --yes（或先 --dry-run）"
fi
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "版本号格式不对: '$VERSION'（应为 X.Y.Z 或 X.Y.Z-后缀）"

# ---------- 定位仓库与基础量 ----------
cd "$SCRIPT_DIR"
git rev-parse --show-toplevel >/dev/null 2>&1 || die "未找到 git 仓库：本脚本必须放在 dsh-workplan 仓库根目录内（plugins/dsh-workplan/）"

TAG="v$VERSION"
TODAY="$(date +%F)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ORIGIN_URL="$(git remote get-url origin)"
TARBALL_NAME="dsh-workplan-$VERSION.tgz"
ASSET_URL="https://github.com/$GH_REPO/releases/download/$TAG/$TARBALL_NAME"
SUMMARY="${SUMMARY:-release $TAG}"

log "仓库: $(git rev-parse --show-toplevel)"
log "分支: $BRANCH   远端: $ORIGIN_URL"
log "目标版本: $VERSION   日期: $TODAY   模式: $( [[ $DRY_RUN -eq 1 ]] && echo '干跑(dry-run)' || echo '正式发布' )"
log "发布说明: $SUMMARY"

# ---------- 步骤①：发布前检查 ----------
log "── 步骤①：发布前检查 ──"
for c in node npm git gh curl; do
  if ! command -v "$c" >/dev/null 2>&1; then
    if [[ $DRY_RUN -eq 1 ]]; then warn "未找到命令 ${c}（正式发布会用到；干跑继续）"
    else die "未找到命令 ${c}，请先安装后再发布"; fi
  fi
done
if [[ $DRY_RUN -eq 0 ]]; then
  gh auth status >/dev/null 2>&1 || die "gh 未登录：请先执行 gh auth login"
  log "gh 已登录 ✓"
fi
if [[ $BRANCH != "main" ]]; then
  warn "当前分支是 ${BRANCH}（发布清单默认 main）；本次将推送到 origin/$BRANCH"
fi
if [[ -n $(git status --porcelain) ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then warn "工作区有未提交改动（正式发布要求先提交或还原）："; git status --short >&2
  else die "工作区不干净：先提交或还原所有改动（RELEASING.md §1）"; fi
else
  log "工作区干净 ✓"
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 1 ]]; then warn "tag $TAG 已存在（正式发布要求新的版本号）"
  else die "tag $TAG 已存在，请换一个新版本号"; fi
else
  log "tag $TAG 可用 ✓"
fi
CUR_VERSION="$(node -p "require('./package.json').version")"
if [[ $CUR_VERSION == "$VERSION" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then warn "package.json 当前版本已是 ${VERSION}（正式发布会在此中止）"
  else die "package.json 当前版本已是 ${VERSION}，请换一个新版本号"; fi
else
  log "当前版本 $CUR_VERSION → 目标版本 $VERSION ✓"
fi
[[ -f src/host.ts ]] || die "找不到 src/host.ts（版本四处之一）"
[[ -f CHANGELOG.md ]] || die "找不到 CHANGELOG.md（版本四处之一）"

# ---------- 步骤②：版本四处同步 ----------
do_version_bump() {
  log "── 步骤②：版本四处同步 ──"
  # 四处之一/之二：package.json 与 package-lock.json（npm version 原子完成）
  run npm version "$VERSION" --no-git-tag-version
  # 四处之三：src/host.ts 的 meta.version（形如 version: 'X.Y.Z', 的行必须恰好一处）
  local cnt
  cnt="$(grep -cE "^[[:space:]]*version: '[^']*',([[:space:]]*)$" src/host.ts || true)"
  [[ $cnt == 1 ]] || die "src/host.ts 中形如 version: '…', 的行有 $cnt 处（预期恰好 1 处），为防误改中止"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: sed 修改 src/host.ts 该行 → version: '$VERSION',"
  else
    sed_inplace "s/^([[:space:]]*)version: '[^']*',([[:space:]]*)$/\1version: '$VERSION',\2/" src/host.ts
    grep -qE "^[[:space:]]*version: '$VERSION'," src/host.ts || die "src/host.ts 版本写入后校验失败"
    log "src/host.ts meta.version → $VERSION ✓"
  fi
  # 四处之四：CHANGELOG.md 顶部插入新小节（格式与现有条目一致：## 版本 — 日期）
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将在 CHANGELOG.md 顶部插入: ## $VERSION — ${TODAY}（条目: ${SUMMARY}）"
  else
    local tmp
    tmp="$(mktemp)"
    { printf '## %s — %s\n\n- %s\n\n' "$VERSION" "$TODAY" "$SUMMARY"; cat CHANGELOG.md; } > "$tmp"
    mv "$tmp" CHANGELOG.md
    head -1 CHANGELOG.md | grep -qF "## $VERSION — $TODAY" || die "CHANGELOG.md 顶部插入校验失败"
    log "CHANGELOG.md 顶部已插入 ## $VERSION ✓"
  fi
  # 其余同步点：三语 README（徽章 + 安装命令）与 tests/fixtures/tool-surface.json。
  # version-sync 测试 #400 断言 README.md / README.en.md 必须含 dsh-workplan@<版本>；
  # README.zh.md 与 tool-surface.json 虽无断言，也是历史同步点。不补这五处会重蹈
  # 2.1.2 的 CI 红叉（#399/#400 失败）：npm test 在步骤③就会失败中止。
  local sync_files=(README.md README.en.md README.zh.md tests/fixtures/tool-surface.json)
  for f in "${sync_files[@]}"; do
    [[ -f $f ]] || die "找不到版本同步点 $f"
  done
  local cur_esc
  cur_esc="$(printf '%s' "$CUR_VERSION" | sed 's/\./\\./g')"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将同步三语 README 徽章/安装命令与 tests/fixtures/tool-surface.json → $VERSION"
  else
    sed_inplace "s/version-$cur_esc-blue\.svg/version-$VERSION-blue.svg/g; s/releases\/tag\/v$cur_esc/releases\/tag\/v$VERSION/g; s/dsh-workplan@$cur_esc/dsh-workplan@$VERSION/g" \
      README.md README.en.md README.zh.md
    sed_inplace "s/\"version\": \"$cur_esc\"/\"version\": \"$VERSION\"/" tests/fixtures/tool-surface.json
    for f in README.md README.en.md README.zh.md; do
      grep -q "dsh-workplan@$VERSION" "$f" || die "$f 版本同步后校验失败"
    done
    grep -q "\"version\": \"$VERSION\"" tests/fixtures/tool-surface.json || die "tests/fixtures/tool-surface.json 版本同步后校验失败"
    log "三语 README 与 tool-surface.json → $VERSION ✓"
  fi
  # 发布说明文件：随本次提交入库，干净检出后供 gh release --notes-file 使用
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将生成 docs/release-notes-$VERSION.md（标题+说明+tag/日期/npm 链接）"
  else
    printf '# dsh-workplan %s\n\n%s\n\n- tag: %s\n- date: %s\n- npm: https://www.npmjs.com/package/%s/v/%s\n' \
      "$TAG" "$SUMMARY" "$TAG" "$TODAY" "$NPM_PKG" "$VERSION" \
      > "docs/release-notes-$VERSION.md"
    log "docs/release-notes-$VERSION.md 已生成 ✓"
  fi
}

# ---------- 步骤③：类型检查 / 测试 / 产物可复现 ----------
do_build_checks() {
  log "── 步骤③：npm run check / npm test / 产物可复现 ──"
  run npm run check
  run npm test
  run npm run build
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: git diff --exit-code -- lib client.js"
  else
    git diff --exit-code -- lib client.js || die "重新构建后 lib/ 或 client.js 出现差异：产物过期，禁止发布（RELEASING.md §1）"
    log "构建产物可复现 ✓"
  fi
}

# ---------- 可选：W5 跨版本探针（RELEASING.md §1.4）----------
do_w5_probe() {
  log "── 追加：W5 跨版本探针（RELEASING.md §1.4）──"
  local fixture="${W5_ROOT_LOG:-../_baseline_work/root/root.jsonl}"  # 相对仓库根（从仓库根执行时指向工作区夹具）
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: git archive v1.8.19 lib | tar -x -C <临时目录>/w5-old"
    log "[dry-run] 将执行: W5_ROOT_LOG=$fixture node scripts/w5-cross-version-check.mjs <旧>/lib/runtime.js $PWD/lib/runtime.js $PWD/lib/plan.js"
    log "[dry-run] 通过判据: 打印 RESULT: PASS 且退出码 0"
    return 0
  fi
  [[ -f $fixture ]] || die "W5 夹具缺失: ${fixture}（可用 W5_ROOT_LOG 环境变量覆盖）；按 §1.4 缺夹具不得判 PASS"
  local w5dir
  w5dir="$(mktemp -d)/w5-old"
  mkdir -p "$w5dir"
  git archive v1.8.19 lib | tar -x -C "$w5dir"
  local out rc=0
  out="$(W5_ROOT_LOG="$fixture" node scripts/w5-cross-version-check.mjs \
        "$w5dir/lib/runtime.js" "$PWD/lib/runtime.js" "$PWD/lib/plan.js" 2>&1)" || rc=$?
  printf '%s\n' "$out"
  [[ $rc -eq 0 ]] || die "W5 探针退出码 $rc ≠ 0：按 §1.4 失败处置，不得打 tag"
  printf '%s\n' "$out" | grep -q "RESULT: PASS" || die "W5 探针未打印 RESULT: PASS：不得打 tag"
  log "W5 探针 PASS ✓"
}

# ---------- 步骤④：提交 / 打 tag / 推送 ----------
do_commit_tag_push() {
  log "── 步骤④：提交 / 打 tag / 推送 ──"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: git add -A"
    log "[dry-run] 将执行: git commit -m 'Release $VERSION: $SUMMARY'"
    log "[dry-run] 将执行: git tag -a $TAG -m '$TAG $SUMMARY'"
    log "[dry-run] 将执行: git push origin $BRANCH"
    log "[dry-run] 将执行: git push origin $TAG"
    return 0
  fi
  git add -A
  if [[ -n $(git status --porcelain) ]]; then
    git commit -m "Release $VERSION: $SUMMARY"
  else
    warn "版本同步未产生任何变更，无可提交内容（请确认版本号确实改了）"
  fi
  git tag -a "$TAG" -m "$TAG $SUMMARY"
  git push origin "$BRANCH"
  git push origin "$TAG"
  log "提交与 tag 已推送 ✓"
}

# ---------- 步骤⑤⑥：按 tag 干净打包 + GitHub Release（必须带 tgz 制品）----------
do_gh_release() {
  log "── 步骤⑤⑥：干净打包 tgz + GitHub Release ──"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: git clone --depth 1 --branch $TAG $ORIGIN_URL <临时目录>/pack"
    log "[dry-run] 将在 clone 目录内执行: npm ci && npm run build && npm pack"
    log "[dry-run] 将记录制品 sha256（sha256sum 或 shasum -a 256）: $TARBALL_NAME"
    log "[dry-run] 将执行: gh release create $TAG <目录>/$TARBALL_NAME --repo $GH_REPO --title '$TAG — $SUMMARY' --notes-file <目录>/docs/release-notes-$VERSION.md"
    log "[dry-run] 将执行: curl -sIL 校验 $ASSET_URL 返回 HTTP 200"
    return 0
  fi
  local pack_root tarball notes_file code
  pack_root="$(mktemp -d)/pack"
  rm -rf "$pack_root"
  git clone --depth 1 --branch "$TAG" "$ORIGIN_URL" "$pack_root"
  ( cd "$pack_root" && npm ci && npm run build && npm pack )
  tarball="$pack_root/$TARBALL_NAME"
  [[ -f $tarball ]] || die "干净打包未产出 $TARBALL_NAME"
  log "制品 sha256: $(sha256_of "$tarball")"
  notes_file="$pack_root/docs/release-notes-$VERSION.md"
  if [[ -f $notes_file ]]; then
    gh release create "$TAG" "$tarball" --repo "$GH_REPO" --title "$TAG — $SUMMARY" --notes-file "$notes_file"
  else
    warn "干净检出内无 docs/release-notes-$VERSION.md，回退为 --notes"
    gh release create "$TAG" "$tarball" --repo "$GH_REPO" --title "$TAG — $SUMMARY" --notes "$SUMMARY"
  fi
  code="$(curl -sIL -o /dev/null -w '%{http_code}' "$ASSET_URL" || true)"
  [[ $code == 200 ]] || die "Release 制品下载校验失败（HTTP ${code}）: $ASSET_URL"
  log "Release 制品可下载 ✓（HTTP 200）"
}

# ---------- 步骤⑦：npm 发布 ----------
do_npm_publish() {
  log "── 步骤⑦：npm 发布 ──"
  run npm whoami
  run npm publish
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] 将执行: npm view $NPM_PKG@$VERSION version dist.tarball"
    log "[dry-run] 将执行: npm view $NPM_PKG@latest version（应等于 ${VERSION}）"
    return 0
  fi
  npm view "$NPM_PKG@$VERSION" version dist.tarball
  local latest
  latest="$(npm view "$NPM_PKG@latest" version)"
  [[ $latest == "$VERSION" ]] || die "npm dist-tags.latest=$latest ≠ $VERSION"
  log "npm latest=$VERSION ✓"
}

# ---------- 回滚（RELEASING.md §7）----------
do_rollback() {
  log "── 回滚 ${TAG}（RELEASING.md §7）──"
  run gh release delete "$TAG" --repo "$GH_REPO" --yes
  warn "git tag $TAG 按清单保留（可追溯）"
  warn "npm 回滚需人工确认后执行（24 小时内有效）: npm unpublish $NPM_PKG@$VERSION"
  warn "索引源回滚：把上游条目的 tarball 改回上一个可用地址并提 PR（RELEASING.md §7）"
}

# ---------- 主流程 ----------
if [[ $ROLLBACK -eq 1 ]]; then
  do_rollback
  log "回滚动作已执行完毕（npm 与索引源步骤见上方提示）"
  exit 0
fi

do_version_bump
do_build_checks
if [[ $WITH_W5 -eq 1 ]]; then do_w5_probe; fi

# 正式发布前的最后确认：终端里询问；非交互且未加 --yes 时拒绝执行
if [[ $DRY_RUN -eq 0 ]]; then
  if [[ $ASSUME_YES -eq 1 ]]; then
    log "已指定 --yes，跳过确认"
  elif [[ -t 0 ]]; then
    printf '[release] 即将正式发布 %s（提交+打tag+推送+GitHub Release+npm publish）。输入 y 确认: ' "$TAG"
    read -r REPLY
    [[ $REPLY == y || $REPLY == Y ]] || die "已按用户要求取消"
  else
    die "当前是非交互环境且未加 --yes：为防误发布已中止。确认无误后请加 --yes 重新执行"
  fi
fi

do_commit_tag_push
do_gh_release
do_npm_publish

log "──────────────────────────────────────────────"
log "✅ $VERSION 发布完成"
log "GitHub Release: https://github.com/$GH_REPO/releases/tag/$TAG"
log "npm:            https://www.npmjs.com/package/$NPM_PKG/v/$VERSION"
log "制品下载:        $ASSET_URL"
warn "以下为清单内的人工收尾步骤，脚本不代做："
warn "  ① RELEASING.md §5：索引源条目 PR（tarball: 指向本次 Release URL）"
warn "  ② RELEASING.md §6：写 docs/release-record-$VERSION-$(date +%Y%m%d).md 发布记录（含上方 sha256）"
warn "  ③ 如需本机运行中的 DSH 立即加载新版本，由你重启服务（脚本不做任何重启）"
