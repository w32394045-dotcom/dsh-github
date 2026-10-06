#!/usr/bin/env bash
# 把 @ptfm/dsh-github 装进本机 DSH（macOS / Linux）。
#
# 做三件事，全部幂等：
#   1. 把插件放到 $DSH_HOME/plugins/dsh-github（或用 --from <目录> 指定本地 checkout）；
#   2. 在目标 profile 的 package.json 里登记 link: 依赖与 bundle；
#   3. 安装依赖并在 node_modules/@ptfm 下建好链接。
#
# 用法：
#   bash scripts/install.sh                    # 装进 $DSH_PROFILE（默认 desktop）
#   bash scripts/install.sh --profile web
#   bash scripts/install.sh --from ~/code/dsh-github
#
# 卸载：从 profile 的 package.json 里删掉 @ptfm/dsh-github（dependencies 与
# dsh.profile.bundles），重跑 pnpm install 即可。
set -euo pipefail

PLUGIN_NAME='@ptfm/dsh-github'
REPO_SLUG='w32394045-dotcom/dsh-github'
PROFILE_ARG=''
FROM_ARG=''

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE_ARG="${2:-}"; shift 2 ;;
    --from) FROM_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

info() { printf '• %s\n' "$1"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
[ -d "$DSH_HOME_DIR" ] || die "找不到 DSH home：$DSH_HOME_DIR。请先安装并运行一次 DeepSeek Harness。"

PROFILE_NAME="${PROFILE_ARG:-${DSH_PROFILE:-desktop}}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE_NAME"
[ -d "$PROFILE_DIR" ] || die "找不到 profile 目录：$PROFILE_DIR"

# ── 1. 落地插件源码 ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -n "$FROM_ARG" ]; then
  PLUGIN_DIR="$(cd "$FROM_ARG" && pwd)"
  info "使用本地插件目录：$PLUGIN_DIR"
elif [ -f "$REPO_ROOT/lib/index.js" ]; then
  PLUGIN_DIR="$DSH_HOME_DIR/plugins/dsh-github"
  info "从当前 checkout 复制到：$PLUGIN_DIR"
  rm -rf "$PLUGIN_DIR"
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  # 复制时排除 .git 与任何本地数据文件。
  tar -C "$REPO_ROOT" --exclude='.git' --exclude='node_modules' -cf - . | tar -C "$PLUGIN_DIR" -xf - 2>/dev/null \
    || { mkdir -p "$PLUGIN_DIR"; cp -R "$REPO_ROOT/." "$PLUGIN_DIR/"; rm -rf "$PLUGIN_DIR/.git"; }
else
  PLUGIN_DIR="$DSH_HOME_DIR/plugins/dsh-github"
  info "从 GitHub 下载：$REPO_SLUG"
  command -v curl >/dev/null 2>&1 || die '需要 curl 才能下载插件；也可以用 git clone 后加 --from。'
  command -v tar >/dev/null 2>&1 || die '需要 tar 才能解压插件。'
  tmp="$(mktemp -d)"
  curl -fsSL "https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/main" -o "$tmp/plugin.tgz"
  tar -C "$tmp" -xzf "$tmp/plugin.tgz"
  inner="$(find "$tmp" -maxdepth 1 -type d -name 'dsh-github-*' | head -n1)"
  [ -n "$inner" ] || die '解压后没找到插件目录。'
  rm -rf "$PLUGIN_DIR"
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  mv "$inner" "$PLUGIN_DIR"
  rm -rf "$tmp"
fi

[ -f "$PLUGIN_DIR/lib/index.js" ] || die "插件目录里没有 lib/index.js：$PLUGIN_DIR"
ok "插件源码就绪：$PLUGIN_DIR"

# ── 2. 登记到 profile（用 node 安全地改 JSON，不用 jq） ─────────
NODE_BIN=''
BUNDLED_NODE="$DSH_HOME_DIR/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
if [ -x "$BUNDLED_NODE" ]; then NODE_BIN="$BUNDLED_NODE"; else NODE_BIN="$(command -v node || true)"; fi
[ -n "$NODE_BIN" ] || die '找不到 node：既没有 dsh 自带的，也没有 PATH 里的。'

info "登记到 profile：$PROFILE_DIR/package.json"
"$NODE_BIN" - "$PROFILE_DIR" "$PLUGIN_DIR" "$PLUGIN_NAME" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [profileDir, pluginDir, pluginName] = process.argv.slice(2)
const manifestPath = path.join(profileDir, 'package.json')
const raw = fs.readFileSync(manifestPath, 'utf8')
let manifest
try { manifest = JSON.parse(raw) } catch (error) { console.error(`package.json 不是合法 JSON：${error.message}`); process.exit(1) }

const relative = path.relative(profileDir, pluginDir).split(path.sep).join('/')
const linkSpec = `link:${relative}`

manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies[pluginName] = linkSpec
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes(pluginName)) bundles.push(pluginName)
manifest.dsh.profile.bundles = bundles

// 跟着原文件的缩进风格走：用 Get-Content 改过的是 4 空格，pnpm 写的是 2 空格。
const indentMatch = /\n(\s+)"/.exec(raw)
const indent = indentMatch ? indentMatch[1] : '  '
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, indent)}\n`, 'utf8')
console.log(`  dependencies["${pluginName}"] = ${linkSpec}`)
console.log(`  bundles = [${bundles.join(', ')}]`)
NODE
ok "已更新 package.json"

# ── 3. 安装依赖 ────────────────────────────────────────────────
BUNDLED_PNPM="$DSH_HOME_DIR/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
info '在 profile 里安装依赖…'
if [ -f "$BUNDLED_PNPM" ] && [ -n "$NODE_BIN" ]; then
  (cd "$PROFILE_DIR" && "$NODE_BIN" "$BUNDLED_PNPM" install)
elif command -v pnpm >/dev/null 2>&1; then
  (cd "$PROFILE_DIR" && pnpm install)
else
  die "找不到 pnpm：既没有 dsh 自带的 $BUNDLED_PNPM，也没有 PATH 里的。"
fi

LINKED="$PROFILE_DIR/node_modules/@ptfm/dsh-github"
if [ -e "$LINKED" ]; then ok "链接已建立：$LINKED"; else warn "没找到 $LINKED，请检查上面的 pnpm 输出"; fi

echo
ok '安装完成。'
echo '  下一步：打开 DSH → 设置 → GitHub → 粘贴 Personal Access Token 登录（或用 OAuth 设备流）。'
echo '  如果插件没有立刻出现，重启一次 DeepSeek Harness。'
echo "  卸载：从 profile 的 package.json 里删掉 $PLUGIN_NAME，重跑 pnpm install。"
