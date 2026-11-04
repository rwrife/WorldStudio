// Renders the World Studio app icon (orange tile, isometric terrain block, mountain and prop crate) without image dependencies.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const size = 512, samples = 4
const out = resolve(process.argv[2] ?? 'src/renderer/public/icon.png')
const hex = value => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)]
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

function inPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

// Isometric block centred in the tile.
const cx = 256, top = 250, w = 170, h = 98, depth = 70
const T = [cx, top - h / 2], R = [cx + w, top], B = [cx, top + h / 2], L = [cx - w, top]
const down = ([x, y]) => [x, y + depth]
const layers = [
  { color: hex('#7a3f12'), poly: [L, B, down(B), down(L)] },
  { color: hex('#5a2c0b'), poly: [B, R, down(R), down(B)] },
  { color: hex('#ffe2c2'), poly: [T, R, B, L] },
  // Mountain on the terrain: lit and shaded faces.
  { color: hex('#3a1f08'), poly: [[150, 248], [222, 118], [262, 196], [236, 262]] },
  { color: hex('#5e3410'), poly: [[222, 118], [300, 236], [236, 262], [262, 196]] },
  { color: hex('#fff4e8'), poly: [[222, 118], [244, 158], [230, 166], [214, 150], [203, 152]] },
  // Small crate prop.
  { color: hex('#ff9a3c'), poly: [[318, 226], [350, 210], [382, 226], [350, 242]] },
  { color: hex('#c96619'), poly: [[318, 226], [350, 242], [350, 276], [318, 260]] },
  { color: hex('#a24f10'), poly: [[350, 242], [382, 226], [382, 260], [350, 276]] }
]
const tileTop = hex('#ffb35f'), tileBottom = hex('#ff7f24')

const pixels = Buffer.alloc(size * (size * 4 + 1))
for (let y = 0; y < size; y++) {
  pixels[y * (size * 4 + 1)] = 0
  for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples, py = y + (sy + 0.5) / samples
      if (!inRoundedRect(px, py, 16, 16, 496, 496, 104)) continue
      let color = lerp(tileTop, tileBottom, (px + py) / (2 * size))
      for (const layer of layers) if (inPolygon(px, py, layer.poly)) color = layer.color
      r += color[0]; g += color[1]; b += color[2]; a += 1
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4, n = samples * samples
    // Store premultiplied coverage as straight alpha.
    pixels[offset] = a ? Math.round(r / a) : 0
    pixels[offset + 1] = a ? Math.round(g / a) : 0
    pixels[offset + 2] = a ? Math.round(b / a) : 0
    pixels[offset + 3] = Math.round(a / n * 255)
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = data => { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
  return Buffer.concat([length, body, sum])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`Wrote ${out} (${png.length} bytes)`)
