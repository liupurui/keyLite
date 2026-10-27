#!/usr/bin/env bash
# 注册 Native Messaging Host —— 让 Chrome 允许「密钥库」扩展调起本机桥程序
#
# 用法（三种都行）：
#   bash extension/install-host.sh                  # 自动从浏览器配置里找扩展 ID
#   bash extension/install-host.sh <扩展ID>          # 手动指定
#   bash extension/install-host.sh --uninstall       # 卸载注册
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

HOST_NAME="dev.keylite.host"
APP_DIR="$HOME/Library/Application Support/dev.keylite.app"
BIN_DST="$APP_DIR/bin/keylite-host"

BROWSERS=(
  "Chrome|$HOME/Library/Application Support/Google/Chrome"
  "Edge|$HOME/Library/Application Support/Microsoft Edge"
  "Brave|$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
  "Chromium|$HOME/Library/Application Support/Chromium"
)

reg_dirs() {
  for b in "${BROWSERS[@]}"; do
    echo "${b#*|}/NativeMessagingHosts"
  done
}

# ---------- 卸载 ----------
if [ "${1:-}" = "--uninstall" ]; then
  while IFS= read -r d; do rm -f "$d/$HOST_NAME.json"; done < <(reg_dirs)
  rm -f "$BIN_DST"
  echo "✓ 已卸载：$HOST_NAME"
  exit 0
fi

# ---------- 1. 确定扩展 ID ----------
EXT_ID="${1:-}"

if [ -z "$EXT_ID" ]; then
  echo "→ 正在从浏览器配置里查找扩展 ID…"
  EXT_ID=$(python3 - "$ROOT" <<'PY' 2>/dev/null || true
import json, os, sys, glob

root = os.path.realpath(sys.argv[1])
homes = [
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Microsoft Edge",
    "~/Library/Application Support/BraveSoftware/Brave-Browser",
    "~/Library/Application Support/Chromium",
]
found = []
for h in homes:
    # 新版 Chrome 把部分扩展信息放在 Secure Preferences 里，两边都扫
    patterns = [
        os.path.expanduser(h) + "/*/Preferences",
        os.path.expanduser(h) + "/*/Secure Preferences",
    ]
    for pat in patterns:
        for prefs in glob.glob(pat):
            try:
                data = json.load(open(prefs, encoding="utf-8"))
            except Exception:
                continue
            for ext_id, info in (data.get("extensions", {}).get("settings", {}) or {}).items():
                path = (info or {}).get("path") or ""
                if not path:
                    continue
                p = os.path.realpath(path)
                # 只认指向本仓库 extension/ 目录的那一个
                if p == os.path.join(root, "extension"):
                    found.append(ext_id)
print(found[0] if found else "")
PY
)
fi

if [ -z "$EXT_ID" ]; then
  cat <<'EOF'

✗ 没自动找到扩展 ID。请先加载扩展：
  1. 打开 chrome://extensions
  2. 右上角打开「开发者模式」
  3. 点「加载已解压的扩展程序」，选择本项目的 extension/ 目录
  4. 卡片上会显示「ID: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx」，复制它
  5. 重新运行：bash extension/install-host.sh <扩展ID>

EOF
  exit 1
fi

# 校验格式：Chrome 扩展 ID 固定 32 个 a-p 字符
if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "✗ 「$EXT_ID」不像 Chrome 扩展 ID（应为 32 位 a-p 字符）"
  exit 1
fi
echo "✓ 扩展 ID：$EXT_ID"

# ---------- 2. 准备桥程序 ----------
BIN_SRC=""
for p in "$ROOT/target/release/keylite-host" "$ROOT/target/debug/keylite-host"; do
  [ -x "$p" ] && BIN_SRC="$p" && break
done

if [ -z "$BIN_SRC" ]; then
  echo "→ 还没编译过桥程序，现在编译（debug 版，约 1 分钟）…"
  cargo build -p keylite --bin keylite-host
  BIN_SRC="$ROOT/target/debug/keylite-host"
fi

mkdir -p "$(dirname "$BIN_DST")"
cp "$BIN_SRC" "$BIN_DST"
chmod 700 "$BIN_DST"
echo "✓ 桥程序：$BIN_DST"

# ---------- 3. 写白名单清单 ----------
MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "密钥库 Native Messaging 桥",
  "path": "$BIN_DST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

while IFS= read -r d; do
  mkdir -p "$d"
  printf '%s\n' "$MANIFEST" > "$d/$HOST_NAME.json"
  echo "✓ 已注册：$d/$HOST_NAME.json"
done < <(reg_dirs)

# ---------- 4. 自检：桌面端在跑就能直接通 ----------
echo
if [ -x /usr/bin/python3 ]; then
  /usr/bin/python3 - "$BIN_DST" <<'PY'
import json, struct, subprocess, sys

host = sys.argv[1]
body = json.dumps({"type": "ping"}).encode()
frame = struct.pack("<I", len(body)) + body

# 注意：桥程序在连接开着时不会退出（正常，Chrome 端是长连接），
# 所以不能用 subprocess.run 等退出，要边读边收，读完就收工。
p = subprocess.Popen([host], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
try:
    p.stdin.write(frame)
    p.stdin.flush()
    hdr = p.stdout.read(4)
    if len(hdr) < 4:
        print("… 自检跳过：桥程序没有返回数据")
        raise SystemExit
    n = struct.unpack("<I", hdr)[0]
    res = json.loads(p.stdout.read(n).decode())
    if res.get("type") == "pong":
        print(f"✓ 通道已连通（pong，桌面端 v{res.get('version')}）")
    elif res.get("code") == "app_not_running":
        print("… 桥程序正常，但桌面端没在运行。先执行： cd app && npm run tauri dev")
    else:
        print("… 桥程序返回：", json.dumps(res, ensure_ascii=False))
finally:
    try:
        p.stdin.close()
    except Exception:
        pass
    p.terminate()
    try:
        p.wait(timeout=3)
    except Exception:
        p.kill()
PY
fi

cat <<EOF

完成。接下来：
  1. 回 chrome://extensions 点一下扩展卡片上的「刷新」图标
  2. 打开任意登录页（如 github.com/login），点进密码框
  3. 右键 → 「密钥库」→ 选账号 → 自动填入
  4. 提交登录后，桌面端右下角会弹「保存这条登录？」

注意：桌面端必须处于「已解锁」状态，右键菜单才会列出条目。
EOF
