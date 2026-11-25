#!/usr/bin/env bash
#
# 验收沙箱入口（开发者 / 验收者 / 总验收者共用）。
#
# 为什么要沙箱：仓库目录里跑着仓库主人自己的 `next dev`（端口 3000，连真实数据库），
# 在仓库目录里再跑 dev 或 build 会互相干扰。所以凡是需要“运行或构建”的操作都放进沙箱副本。
#
# 可用环境变量（都有默认值）：
#   DM_SANDBOX  沙箱目录。默认 /tmp/dm-accept-sandbox（验收者）。
#               开发者用 DM_SANDBOX=/tmp/dm-dev-sandbox，总验收者用 /tmp/dm-final-sandbox。
#               目录名需要包含 sandbox，且不能是仓库目录或在仓库目录内部。
#   DM_PORT     dev server 端口。默认 3457（验收者）；开发者 3458；总验收者 3459。
#   DM_REPO     仓库目录。默认按本脚本所在位置推导，一般不用设置。
#
# 用法：
#   sandbox.sh sync                把“工作树”（含未提交改动）同步进沙箱。验收改动后的代码用这个。
#   sandbox.sh snapshot <提交>     把“某个提交”的内容导出进沙箱，不经过工作树。采集改动前的基线用这个，
#                                  例如：sandbox.sh snapshot 97d8af4
#   sandbox.sh dev                 在沙箱里前台启动 mock 模式的 dev server（Ctrl-C 停止）。
#   sandbox.sh build               在沙箱里执行生产构建（Supabase 变量置空）。
#   sandbox.sh measure             测量各路由首屏 JS 体积。先 build，再 measure。
#   sandbox.sh typecheck           在沙箱里跑类型检查（npx tsc --noEmit）。
#   sandbox.sh test                在沙箱里跑单元测试（npm test）。
#
# 典型流程（两个终端）：
#   终端 1：  sandbox.sh snapshot 97d8af4 && sandbox.sh dev
#   终端 2：  等终端 1 出现 Ready 后，用浏览器访问 http://localhost:$DM_PORT
#   注意：必须用 http://localhost:<端口> 访问，不能用 127.0.0.1（Next dev 会拦截，页面无法完成 hydration）。
#
# 约定：
#   - 沙箱里不带任何 .env* 文件，Supabase 变量置空后走 mock 数据，不会连接任何数据库。
#   - mock 模式的登录秘钥是 smoke-test-key（见下方 DM_ACCESS_KEY）。
#   - sync 和 snapshot 都不会修改仓库目录，也不会执行任何改变 git 状态的命令。
#   - 两种同步方式共用同一个沙箱目录：后执行的那个会覆盖前一个。当前沙箱是哪份代码，见
#     <沙箱>/.dm-sandbox-source。
#   - 兼容 macOS 自带的 bash 3.2：变量一律写成 ${var}，否则变量名后紧跟中文标点时会被一起当成变量名。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DM_REPO="${DM_REPO:-$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)}"
DM_SANDBOX="${DM_SANDBOX:-/tmp/dm-accept-sandbox}"
DM_PORT="${DM_PORT:-3457}"
DM_ACCESS_KEY="${DM_ACCESS_KEY:-smoke-test-key}"
DM_ACCESS_SESSION_SIGNING_KEY="${DM_ACCESS_SESSION_SIGNING_KEY:-smoke-test-signing-key-0123456789abcdef0123456789abcdef}"

# 同步时始终跳过的内容：依赖和构建产物留在沙箱里不动，凭据文件永远不进沙箱。
RSYNC_EXCLUDES=(--exclude node_modules --exclude .next --exclude .git --exclude '.env*' --exclude '.claude/worktrees' --exclude .dm-snapshot --exclude .dm-sandbox-source)
SOURCE_MARKER=.dm-sandbox-source

log() { printf '[sandbox] %s\n' "$*"; }
die() { printf '[sandbox] 错误：%s\n' "$*" >&2; exit 1; }
# 打印文件头的注释块（从第 3 行到第一个空行），不依赖行号。
usage() { sed -n '3,/^[[:space:]]*$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# 把路径转成“以 / 开头、不含 . / .. / 连续斜杠”的字面绝对路径。不解析符号链接，目录不存在也能算。
lexical_abs_path() {
  local path="$1" rest segment out=""
  case "${path}" in /*) ;; *) path="${PWD}/${path}" ;; esac
  rest="${path#/}"
  while [ -n "${rest}" ]; do
    segment="${rest%%/*}"
    if [ "${segment}" = "${rest}" ]; then rest=""; else rest="${rest#*/}"; fi
    case "${segment}" in
      ""|".") ;;
      "..") out="${out%/*}" ;;
      *) out="${out}/${segment}" ;;
    esac
  done
  printf '%s\n' "${out:-/}"
}

# rsync --delete 会清空目标里多余的文件，所以动手之前先确认这个路径确实是独立的沙箱目录。
# 同一个检查做两遍：第一遍在创建任何目录之前按字面路径查（被拒绝时不会留下任何东西），
# 第二遍在目录存在之后按真实路径再查（防止沙箱路径经符号链接指进仓库）。
assert_sandbox_is_safe() {
  local candidate
  candidate="$(lexical_abs_path "$1")"
  case "${candidate}" in
    "${REPO}") die "沙箱目录就是仓库目录：${candidate}。为避免误删，已中止。" ;;
    "${REPO}"/*) die "沙箱目录位于仓库目录内部：${candidate}。为避免误删，已中止。" ;;
  esac
  case "${REPO}" in
    "${candidate}"/*) die "仓库目录位于沙箱目录内部：${candidate}。为避免误删，已中止。" ;;
  esac
  case "$(basename "${candidate}")" in
    *sandbox*) ;;
    *) die "沙箱目录名需要包含 sandbox，不接受：${candidate}。为避免误删，已中止。" ;;
  esac
  # 至少两级（例如 /tmp/xxx-sandbox），不接受 /xxx-sandbox 这种顶层目录。
  [ "$(printf '%s\n' "${candidate}" | awk -F/ '{print NF-2}')" -ge 1 ] \
    || die "沙箱目录层级太浅，不接受：${candidate}。为避免误删，已中止。"
}

REPO="$(cd "${DM_REPO}" 2>/dev/null && pwd -P)" || die "仓库目录不存在：${DM_REPO}"
assert_sandbox_is_safe "${DM_SANDBOX}"

# 判断一个非空目录是不是“本项目的副本”：package.json 里的 name 与仓库一致，且带有 Next 的配置和 app 目录。
looks_like_project_copy() {
  local dir="$1" expected actual
  [ -f "${dir}/package.json" ] && [ -f "${dir}/next.config.mjs" ] && [ -d "${dir}/app" ] || return 1
  expected="$(package_name "${REPO}/package.json")"
  actual="$(package_name "${dir}/package.json")"
  [ -n "${expected}" ] && [ "${expected}" = "${actual}" ]
}

# 读出一个 package.json 的 name。路径通过参数传入，不拼进 JS 字符串，路径里有引号或空格也不会出错。
package_name() {
  node -e "try { process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).name || '') } catch { process.exit(1) }" "$1" 2>/dev/null || true
}

# --delete 会清空目标里多余的文件，所以只对三种目录动手：全新（不存在或为空）、带来源标记的沙箱、
# 能确认是本项目副本的目录。其他任何非空目录一律拒绝，避免把别的东西清空。
if [ -d "${DM_SANDBOX}" ] && [ -n "$(ls -A "${DM_SANDBOX}" 2>/dev/null)" ] \
  && [ ! -f "${DM_SANDBOX}/${SOURCE_MARKER}" ] && ! looks_like_project_copy "${DM_SANDBOX}"; then
  die "目录已存在、非空，且无法确认是沙箱或本项目副本：${DM_SANDBOX}。为避免误删，已中止。"
fi
mkdir -p "${DM_SANDBOX}"
SB="$(cd "${DM_SANDBOX}" && pwd -P)"
assert_sandbox_is_safe "${SB}"

# node_modules 只在缺失时复制一次。cp -c 是 APFS 克隆（写时复制，约 15 秒），对仓库的 node_modules 只读。
ensure_node_modules() {
  if [ ! -d "${REPO}/node_modules" ]; then
    die "仓库里没有 node_modules：${REPO}/node_modules。本脚本不会执行 npm install。"
  fi
  if [ ! -d "${SB}/node_modules" ]; then
    log "克隆 node_modules 到沙箱（仅首次，约 15 秒）..."
    if ! cp -c -R "${REPO}/node_modules" "${SB}/node_modules"; then
      log "APFS 克隆不可用，改用普通复制..."
      rm -rf "${SB}/node_modules"
      cp -R "${REPO}/node_modules" "${SB}/node_modules"
    fi
  fi
}

assert_sandbox_ready() {
  [ -f "${SB}/package.json" ] || die "沙箱里没有 package.json：${SB}。先执行 sandbox.sh sync 或 sandbox.sh snapshot <提交>。"
  [ -d "${SB}/node_modules" ] || die "沙箱里没有 node_modules：${SB}。先执行 sandbox.sh sync 或 sandbox.sh snapshot <提交>。"
}

assert_port_free() {
  if command -v lsof >/dev/null 2>&1; then
    local holders
    holders="$(lsof -nP -iTCP:"${DM_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${holders}" ]; then
      printf '%s\n' "${holders}" >&2
      die "端口 ${DM_PORT} 已被占用（见上方输出）。本脚本只启动自己的服务，不会停止占用端口的进程；请换一个 DM_PORT。"
    fi
  else
    log "找不到 lsof，跳过端口占用检查。"
  fi
}

write_source_marker() {
  printf 'source=%s\nref=%s\ncommit=%s\nsynced_at=%s\n' \
    "$1" "$2" "$3" "$(date '+%Y-%m-%d %H:%M:%S %Z')" > "${SB}/${SOURCE_MARKER}"
}

# Supabase 变量显式置空：即使外层 shell 里恰好设了这些变量，也不会连到任何数据库。
# 用数组而不是 shell 函数，因为 dev 需要用 exec 把本脚本替换成 dev server（exec 只能接可执行文件）。
MOCK_ENV=(
  "NEXT_PUBLIC_SUPABASE_URL="
  "NEXT_PUBLIC_SUPABASE_ANON_KEY="
  "SUPABASE_SERVICE_ROLE_KEY="
  "ACCESS_KEY=${DM_ACCESS_KEY}"
  "ACCESS_SESSION_SIGNING_KEY=${DM_ACCESS_SESSION_SIGNING_KEY}"
)

cmd_sync() {
  log "同步工作树（含未提交改动）：${REPO} -> ${SB}"
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "${REPO}/" "${SB}/"
  ensure_node_modules
  local head dirty
  head="$(git -C "${REPO}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  dirty="$(git -C "${REPO}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  write_source_marker worktree "" "${head}（HEAD；同步时工作树有 ${dirty} 处未提交改动）"
  log "完成。当前沙箱 = 工作树（HEAD ${head}，含 ${dirty} 处未提交改动）。"
}

cmd_snapshot() {
  local ref="${1:-}"
  [ -n "${ref}" ] || die "用法：sandbox.sh snapshot <提交或分支>，例如 sandbox.sh snapshot 97d8af4"
  local commit
  commit="$(git -C "${REPO}" rev-parse --verify "${ref}^{commit}" 2>/dev/null)" \
    || die "在仓库里找不到提交：${ref}"
  log "导出提交 ${commit}（不经过工作树）-> ${SB}"
  local snap="${SB}/.dm-snapshot"
  rm -rf "${snap}"
  mkdir -p "${snap}"
  # git archive 是只读操作：只读取提交对象，不切换分支，不改动工作树和索引。
  git -C "${REPO}" archive --format=tar "${commit}" | tar -x -C "${snap}"
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "${snap}/" "${SB}/"
  rm -rf "${snap}"
  ensure_node_modules
  write_source_marker snapshot "${ref}" "${commit}"
  log "完成。当前沙箱 = 提交 ${commit}（不含任何未提交改动）。"
}

cmd_dev() {
  assert_sandbox_ready
  assert_port_free
  local pid="$$"
  log "沙箱：${SB}"
  log "来源：$(tr '\n' ' ' < "${SB}/${SOURCE_MARKER}" 2>/dev/null || echo '未知（沙箱由旧版本脚本同步）')"
  log "启动 mock 模式 dev server：http://localhost:${DM_PORT}  （登录秘钥 ${DM_ACCESS_KEY}）"
  log "进程号 ${pid}。停止：在本终端按 Ctrl-C，或 kill ${pid}"
  cd "${SB}"
  # 只监听 localhost。exec 之后本脚本的进程号就是 dev server 的进程号，
  # 停止时按这个 PID 即可，不要按进程名匹配 next。
  exec env "${MOCK_ENV[@]}" "${SB}/node_modules/.bin/next" dev --hostname localhost -p "${DM_PORT}"
}

cmd_build() {
  assert_sandbox_ready
  log "生产构建（Supabase 变量置空）：${SB}"
  cd "${SB}"
  env "${MOCK_ENV[@]}" "${SB}/node_modules/.bin/next" build
}

cmd_measure() {
  assert_sandbox_ready
  local script="${SCRIPT_DIR}/measure-bundle.mjs"
  [ -f "${script}" ] || die "找不到测量脚本：${script}"
  log "测量首屏 JS 体积：${SB}"
  node "${script}" "${SB}"
}

cmd_typecheck() {
  assert_sandbox_ready
  log "类型检查：${SB}"
  cd "${SB}"
  "${SB}/node_modules/.bin/tsc" --noEmit
}

cmd_test() {
  assert_sandbox_ready
  log "单元测试：${SB}"
  cd "${SB}"
  npm test
}

case "${1:-}" in
  sync) cmd_sync ;;
  snapshot) shift; cmd_snapshot "${1:-}" ;;
  dev) cmd_dev ;;
  build) cmd_build ;;
  measure) cmd_measure ;;
  typecheck) cmd_typecheck ;;
  test) cmd_test ;;
  ""|-h|--help|help) usage ;;
  *) die "未知子命令：${1}（支持 sync / snapshot / dev / build / measure / typecheck / test）" ;;
esac
