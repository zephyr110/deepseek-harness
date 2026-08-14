// App icon generator: renders the official fish logo from
// apps/web/public/favicon.svg in its dark-theme variant — white fish on a
// rounded deep-blue-gray square — into build/icon.png for electron-builder
// (which converts the PNG into icns/ico at packaging time).
//
// The source SVG paints the fish black by default and switches to white via a
// <style> media query under prefers-color-scheme: dark. librsvg, the SVG
// renderer behind sharp, never evaluates that media query, so instead of
// relying on it the script rewrites the path's fill="#000" to fill="#fff" in
// the SVG text and drops the <style> block — the attribute then unambiguously
// owns the glyph color.
//
// Background and glyph are composited in a single SVG layer rendered straight
// to PNG: a 1024x1024 rounded rect (180px radius, the macOS icon style) with
// the fish as a nested 560px tile. The fish's 50x50 viewBox is nearly square
// and the glyph bbox sits within ~0.2% of the tile center, so centering the
// tile on the canvas centers the glyph without further math. Idempotent: the
// output depends only on favicon.svg, so re-runs overwrite deterministically.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const CANVAS = 1024
const CORNER_RADIUS = 180
const FISH_SIZE = 560
const BACKGROUND = '#1F2430'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// apps/desktop/scripts -> repo root -> apps/web/public/favicon.svg
const faviconPath = resolve(scriptDir, '../../web/public/favicon.svg')
const outputPath = resolve(scriptDir, '../build/icon.png')

const source = await readFile(faviconPath, 'utf8')
const withoutMediaQuery = source.replace(/<style>[\s\S]*?<\/style>/, '')
const whiteFish = withoutMediaQuery.replace('fill="#000"', 'fill="#fff"')
if (!whiteFish.includes('fill="#fff"')) {
  throw new Error(`favicon.svg no longer carries the expected fill="#000" glyph fill: ${faviconPath}`)
}

const offset = (CANVAS - FISH_SIZE) / 2
const sizedFish = whiteFish.replace(
  'width="50.000000" height="50.000000"',
  `width="${FISH_SIZE}" height="${FISH_SIZE}" x="${offset}" y="${offset}"`,
)
if (sizedFish === whiteFish) {
  throw new Error(`favicon.svg no longer declares the expected width/height: ${faviconPath}`)
}

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}">` +
  `<rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}" fill="${BACKGROUND}"/>` +
  sizedFish +
  '</svg>'

const icon = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer()
await writeFile(outputPath, icon)
console.log(`wrote ${outputPath} (${icon.length} bytes, ${CANVAS}x${CANVAS} RGBA PNG)`)
