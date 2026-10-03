import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'desktop', 'assets');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
function crc32(data) { let n = 0xffffffff; for (const byte of data) n = crcTable[(n ^ byte) & 255] ^ n >>> 8; return (n ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const name = Buffer.from(type), out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return out;
}
const size = 256, rows = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const position = y * (size * 4 + 1) + x * 4 + 1;
  const cornerX = Math.max(32 - x, x - 223, 0), cornerY = Math.max(32 - y, y - 223, 0);
  const visible = cornerX * cornerX + cornerY * cornerY < 32 * 32;
  const leftStroke = y >= 60 && y <= 197 && Math.abs(x - (128 - (y - 60) * 0.45)) < 12;
  const rightStroke = y >= 60 && y <= 197 && Math.abs(x - (128 + (y - 60) * 0.45)) < 12;
  const crossbar = y >= 143 && y < 165 && x >= 92 && x <= 164;
  const white = leftStroke || rightStroke || crossbar;
  rows.set(white ? [255, 255, 255, visible ? 255 : 0] : [36, 93, 218, visible ? 255 : 0], position);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'icon.png'), png); fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([ico, png]));
console.log('应用图标已生成。');
