#!/usr/bin/env bash
# 把 docs/mockups.html 的 7 屏导出成 2x PNG（需要本机 Chrome；在沙箱外运行）
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="docs/screens"
mkdir -p "$OUT"

# 序号  文件名            宽    高   （= 画板尺寸 + 48px 边距×2）
shots=(
  "1 01-unlock       616  676"
  "2 02-vault        1156 796"
  "3 03-new-item     716  696"
  "4 04-quick-search 656  398"
  "5 05-context-menu 1256 736"
  "6 06-save-prompt  936  616"
  "7 07-settings     766  736"
)

for row in "${shots[@]}"; do
  read -r n name w h <<<"$row"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size="$w,$h" --virtual-time-budget=2500 \
    --screenshot="$OUT/$name.png" \
    "file://$(pwd)/docs/mockups.html?only=$n" 2>/dev/null
  echo "✓ $OUT/$name.png"
done

# 整版设计板（长图）
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1500,5400 --virtual-time-budget=3000 \
  --screenshot="$OUT/00-all-screens.png" \
  "file://$(pwd)/docs/mockups.html" 2>/dev/null
echo "✓ $OUT/00-all-screens.png"
