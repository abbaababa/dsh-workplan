#!/usr/bin/env bash
#
# build.sh — 从最新源码构建 dsh-workplan 发布产物
# ============================================================================
# 做什么：把「最新源码 → 可复用构建产物」这一步封装成一条命令。
#   ① 校验 node >= 22（package.json engines.node 要求）
#   ② 依赖缺失时 npm install（node_modules 或 tsc 不存在才装，避免重复安装）
#   ③ npm run build（tsc 编译 src → dist，并同步 lib/*.js 与 client.js）
#   ④ npm pack（产出可分发 tgz）
#   ⑤ 逐项校验产物真实存在，并把每个产物的绝对路径打印到标准输出
#
# 用法（在任意目录下执行均可，脚本会自动定位仓库根 plugins/dsh-workplan/）：
#   scripts/build.sh
#
# 产出（全部位于仓库根 plugins/dsh-workplan/ 下）：
#   dist/                        tsc 编译产物（src → dist）
#   lib/*.js                     宿主运行时加载的构建产物（由 dist 复制）
#   client.js                    客户端构建产物（由 dist/client.js 复制）
#   dsh-workplan-<version>.tgz   npm pack 分发制品（可复用发布产物）
#
# 已知环境坑（已内置规避，无需人工处理）：
#   - 宿主 ~/.npm 缓存可能含 root 文件，npm pack/install 会报 EPERM；本脚本改用
#     独立临时缓存目录并随进程清理，不依赖 ~/.npm 状态。
#
# 边界：
#   - 只构建与打包，不 commit / 不打 tag / 不 push / 不发 GitHub Release / 不发 npm；
#   - 不重启任何服务；除仓库目录与系统临时目录外不写任何位置。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

log()  { printf '[build] %s\n' "$*"; }
die()  { printf '[build][错误] %s\n' "$*" >&2; exit 1; }

# npm 独立可写缓存：规避宿主 ~/.npm 含 root 文件导致 EPERM（本机已复现）
NPM_CACHE="$(mktemp -d)"
export npm_config_cache="${NPM_CACHE}"
trap 'rm -rf "${NPM_CACHE}"' EXIT
log "npm 缓存使用临时目录 ${NPM_CACHE}"

# ---------- ① 校验 node 版本 >= 22 ----------
command -v node >/dev/null 2>&1 || die "未找到 node"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || die "无法解析 node 主版本号"
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  die "node 版本 ${NODE_MAJOR} < 22（package.json engines.node 要求 >=22）"
fi
log "node $(node -v) 满足 >=22"

# ---------- ② 依赖缺失时安装 ----------
if [[ ! -d node_modules ]] || [[ ! -x node_modules/.bin/tsc ]]; then
  log "node_modules 或 tsc 缺失，执行 npm install"
  npm install
else
  log "node_modules 与 tsc 齐全，跳过安装（tsc $(node_modules/.bin/tsc --version)）"
fi

# ---------- ③ 构建（tsc 编译 → 同步 lib 与 client.js）----------
log "执行 npm run build"
npm run build

# ---------- ④ 打包 ----------
VERSION="$(node -p "require('./package.json').version")"
log "执行 npm pack（预期产出 dsh-workplan-${VERSION}.tgz）"
PACK_OUT="$(npm pack 2>&1)"
printf '%s\n' "${PACK_OUT}" | tail -n 8 | sed 's/^/[build] /'
PACKED_NAME="$(printf '%s\n' "${PACK_OUT}" | grep -Eo '[A-Za-z0-9._-]+\.tgz' | tail -n 1 || true)"
if [[ -z "${PACKED_NAME}" ]]; then
  die "npm pack 未产出 .tgz 文件名（输出见上）"
fi

# ---------- ⑤ 逐项校验产物真实存在并打印绝对路径 ----------
TGZ_ABS="${REPO_DIR}/${PACKED_NAME}"
ARTIFACTS=("${TGZ_ABS}" "${REPO_DIR}/dist" "${REPO_DIR}/lib" "${REPO_DIR}/client.js")
for a in "${ARTIFACTS[@]}"; do
  [[ -e "${a}" ]] || die "产物缺失：${a}"
done
[[ -f "${REPO_DIR}/lib/host.js" && -f "${REPO_DIR}/lib/runtime.js" ]] \
  || die "lib/host.js 或 lib/runtime.js 缺失，构建未同步 lib 产物"

SHA256="$({ command -v sha256sum >/dev/null 2>&1 && sha256sum "${TGZ_ABS}" || shasum -a 256 "${TGZ_ABS}"; } | awk '{print $1}')"

log "── 构建产物（绝对路径）──"
log "tgz 制品:  ${TGZ_ABS}"
log "dist 目录: ${REPO_DIR}/dist"
log "lib 目录:  ${REPO_DIR}/lib"
log "client.js: ${REPO_DIR}/client.js"
log "制品 sha256: ${SHA256}"
log "构建完成，产物可复用"
