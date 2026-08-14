// Dependency-free 1024x1024 app icon generator.
//
// Renders a two-tone rounded square with a block "D" glyph into an RGBA
// buffer and serializes it as PNG (signature + IHDR + IDAT + IEND) using only
// node:zlib — no canvas or image libraries. electron-builder converts the PNG
// into the platform icon formats (icns on macOS, ico on Windows) at packaging
// time, so this script is the single source for the app icon.
//
// Geometry is supersampled 2x2: each output pixel averages four 2048x2048
// samples so the hard-edged glyph and rounded corners alias cleanly when
// electron-builder downscales to the 16..512px sizes it derives.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const SAMPLE = 2 // supersampling factor per axis
const SCALE = SAMPLE // canonical geometry is defined in 1024-space
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../build/icon.png')

// Two-tone navy background with a near-white glyph.
const BG_TOP = { r: 31, g: 62, b: 158 }
const BG_BOTTOM = { r: 22, g: 42, b: 107 }
const GLYPH = { r: 244, g: 247, b: 255 }

// Outer rounded square: full canvas minus a fixed margin.
const MARGIN = 64
const CORNER = 220

// Block "D" glyph in canonical 1024-space: left bar, top/bottom bars, and a
// right bar whose outer corners are filleted by `cap` radius.
const D = { x0: 240, y0: 200, x1: 880, y1: 824, bar: 140, cap: 60 }

/** True when (x, y) lies inside the axis-aligned rounded rectangle. */
function inRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius)
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

/** True when (x, y) lies inside the block "D" glyph (canonical space). */
function inD(x, y) {
  if (x < D.x0 || x > D.x1 || y < D.y0 || y > D.y1) return false
  if (x <= D.x0 + D.bar) return true // left bar
  if (y <= D.y0 + D.bar) return true // top bar
  if (y >= D.y1 - D.bar) return true // bottom bar
  // Middle band: only the right side remains, filleted at its outer corners.
  const barLeft = D.x1 - D.bar
  if (x < barLeft) return false // hollow between the left bar and right side
  const top = (x - D.x1) ** 2 + (y - (D.y0 + D.bar)) ** 2
  const bottom = (x - D.x1) ** 2 + (y - (D.y1 - D.bar)) ** 2
  return top >= D.cap * D.cap && bottom >= D.cap * D.cap
}

/** Returns the color of a canonical-space sample, or null for transparent. */
function sampleColor(x, y) {
  if (!inRoundedRect(x, y, MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN, CORNER)) return null
  if (inD(x, y)) return GLYPH
  return y < SIZE / 2 ? BG_TOP : BG_BOTTOM
}

// CRC-32 (IEEE 802.3), as required by PNG chunk framing.
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

/** CRC-32 of buf, matching the zlib convention PNG expects (reflected, final xor). */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, CRC over type + data. */
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

// Render the supersampled RGBA buffer.
const data = Buffer.alloc(SIZE * SIZE * 4)
const samples = SAMPLE * SAMPLE
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SAMPLE; sy++) {
      for (let sx = 0; sx < SAMPLE; sx++) {
        const c = sampleColor((px * SAMPLE + sx + 0.5) / SCALE, (py * SAMPLE + sy + 0.5) / SCALE)
        if (c) {
          r += c.r
          g += c.g
          b += c.b
          a += 255
        }
      }
    }
    const i = (py * SIZE + px) * 4
    if (a > 0) {
      data[i] = Math.round(r / samples)
      data[i + 1] = Math.round(g / samples)
      data[i + 2] = Math.round(b / samples)
      data[i + 3] = Math.round(a / samples)
    }
  }
}

// Scanlines carry one filter byte (0 = none) per row before the RGBA pixels.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1)
  raw[row] = 0
  data.copy(raw, row + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
ihdr[10] = 0 // compression: deflate
ihdr[11] = 0 // filter: adaptive
ihdr[12] = 0 // interlace: none

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log(`wrote ${OUT} (${png.length} bytes, ${SIZE}x${SIZE} RGBA PNG)`)
