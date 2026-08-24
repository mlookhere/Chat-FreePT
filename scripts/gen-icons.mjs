// Deterministic flat-color extension icons, generated without any image dependency:
// a minimal PNG encoder (single IDAT, filter 0) over hand-drawn RGBA pixels.
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const GREEN = [16, 163, 127, 255];
const DARK = [11, 116, 91, 255];
const WHITE = [255, 255, 255, 255];

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rounded green tile with a white "chat tail" notch — recognizable at 16px. */
function iconPixel(size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  const inset = Math.max(1, Math.round(size * 0.06));
  const tail = {
    x0: Math.round(size * 0.3),
    x1: Math.round(size * 0.7),
    y0: Math.round(size * 0.42),
    y1: Math.round(size * 0.58),
  };
  return (x, y) => {
    const lo = inset;
    const hi = size - 1 - inset;
    if (x < lo || x > hi || y < lo || y > hi) return [0, 0, 0, 0];
    const cx = x < lo + radius ? lo + radius : x > hi - radius ? hi - radius : x;
    const cy = y < lo + radius ? lo + radius : y > hi - radius ? hi - radius : y;
    const dx = x - cx;
    const dy = y - cy;
    if (
      dx * dx + dy * dy > radius * radius &&
      (x < lo + radius || x > hi - radius) &&
      (y < lo + radius || y > hi - radius)
    ) {
      return [0, 0, 0, 0];
    }
    if (x >= tail.x0 && x <= tail.x1 && y >= tail.y0 && y <= tail.y1) return WHITE;
    if (x === lo || x === hi || y === lo || y === hi) return DARK;
    return GREEN;
  };
}

export async function writeIcons(dir) {
  for (const size of [16, 48, 128]) {
    await writeFile(join(dir, `icon${size}.png`), encodePng(size, iconPixel(size)));
  }
}
