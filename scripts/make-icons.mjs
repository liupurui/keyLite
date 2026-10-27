/**
 * 生成应用图标（纯 Node，无第三方依赖）。
 * 输出：app/src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png
 *
 * 形状：蓝色圆角方块 + 白色挂锁剪影，4×4 超采样做抗锯齿。
 * 正式发布前可以用 `npx tauri icon path/to/logo.png` 换成设计稿图标。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "app", "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

/* ---------- 几何 ---------- */
const inRect = (px, py, x, y, w, h, r) => {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r || (px >= x + r && px <= x + w - r) || (py >= y + r && py <= y + h - r);
};
const inCircle = (px, py, cx, cy, r) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
const inRing = (px, py, cx, cy, rOut, rIn) => inCircle(px, py, cx, cy, rOut) && !inCircle(px, py, cx, cy, rIn);

/** 返回 [r,g,b,a]，坐标归一化到 0..1 */
function shade(u, v) {
  // 圆角方块
  if (!inRect(u, v, 0.02, 0.02, 0.96, 0.96, 0.22)) return null;

  const blue = [0x3b + (0x25 - 0x3b) * v, 0x82 + (0x63 - 0x82) * v, 0xf6 + (0xeb - 0xf6) * v];

  // 锁梁（上半环 + 两条竖腿）
  const shackle =
    inRing(u, v, 0.5, 0.42, 0.175, 0.115) && v <= 0.42
      ? true
      : (inRect(u, v, 0.325, 0.42, 0.06, 0.12, 0.03) || inRect(u, v, 0.615, 0.42, 0.06, 0.12, 0.03));

  // 锁体
  const body = inRect(u, v, 0.27, 0.46, 0.46, 0.31, 0.075);

  // 钥匙孔（从白色里再挖回蓝色）
  const keyhole = inCircle(u, v, 0.5, 0.585, 0.045) || inRect(u, v, 0.478, 0.585, 0.044, 0.105, 0.02);

  if ((shackle || body) && !keyhole) return [255, 255, 255];
  return blue;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          const c = shade(u, v);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      const cov = a / (255 * n);
      buf[i] = cov > 0 ? Math.round(r / (a / 255)) : 0;
      buf[i + 1] = cov > 0 ? Math.round(g / (a / 255)) : 0;
      buf[i + 2] = cov > 0 ? Math.round(b / (a / 255)) : 0;
      buf[i + 3] = Math.round(cov * 255);
    }
  }
  return buf;
}

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = [
  [512, "icon.png"],
  [256, "128x128@2x.png"],
  [128, "128x128.png"],
  [32, "32x32.png"],
];

for (const [size, name] of targets) {
  writeFileSync(join(outDir, name), png(size, render(size)));
  console.log(`✓ ${name} (${size}×${size})`);
}
