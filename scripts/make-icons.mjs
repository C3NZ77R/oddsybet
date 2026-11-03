// Íconos PNG de la PWA desde el logo del favicon (public/index.html): fondo #11161f lleno (sirve como maskable) y el arco
// #c6f432. Sin dependencias: dibuja con supermuestreo 4×4 y escribe el PNG con zlib. Uso: node scripts/make-icons.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0x11, 0x16, 0x1f], FG = [0xc6, 0xf4, 0x32];
// En el viewBox 32×32 del favicon: path 'M22 10a8 8 0 1 0 0 12', trazo 4 con puntas redondas. Centro del arco (16.71, 16), r 8.
const CX = 22 - Math.sqrt(64 - 36), CY = 16, R = 8, HALF = 2, END = Math.atan2(-6, 22 - CX);

function inside(x, y) {
  const a = Math.atan2(y - CY, x - CX), d = Math.hypot(x - CX, y - CY);
  if (Math.abs(a) >= -END && Math.abs(d - R) <= HALF) return true; // el arco pasa por la izquierda
  return Math.hypot(x - 22, y - 10) <= HALF || Math.hypot(x - 22, y - 22) <= HALF; // puntas
}

// scale < 1 achica el logo hacia el centro (margen para la máscara del sistema).
function png(size, scale = 1) {
  const S = 4, rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = ((px + (sx + 0.5) / S) / size - 0.5) * 32 / scale + 16, y = ((py + (sy + 0.5) / S) / size - 0.5) * 32 / scale + 16;
        hit += inside(x, y);
      }
      const t = hit / (S * S);
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round(BG[c] + (FG[c] - BG[c]) * t);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const dir = new URL('../public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('icon-192.png', dir), png(192, 0.8));
writeFileSync(new URL('icon-512.png', dir), png(512, 0.8));
writeFileSync(new URL('apple-touch-icon.png', dir), png(180, 0.85));
