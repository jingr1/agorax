#!/usr/bin/env node
/**
 * Generate PWA / avatar marks from public/agorax-image.png.
 *
 * Source art is a circular mark on a transparent square. We crop to opaque
 * content, cover-scale to the canvas, then apply a circular alpha mask so
 * corners stay transparent (no white square halo under UI `rounded-full`).
 *
 * Uses Pillow (Python) — no Playwright browser download required for icons.
 */
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const root = join(__dirname, '..')
const outputDir = join(root, 'public')

const py = `
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(${JSON.stringify(outputDir)})
src = Image.open(root / 'agorax-image.png').convert('RGBA')
bbox = src.split()[-1].getbbox() or (0, 0, src.width, src.height)
cropped = src.crop(bbox)

def make_icon(size: int) -> Image.Image:
    scale = max(size / cropped.width, size / cropped.height)
    dw = max(1, int(round(cropped.width * scale)))
    dh = max(1, int(round(cropped.height * scale)))
    resized = cropped.resize((dw, dh), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - dw) // 2, (size - dh) // 2), resized)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask)
    return out

for size, name in [
    (32, 'agorax-favicon.png'),
    (180, 'agorax-apple-touch-icon.png'),
    (192, 'agorax-icon-192.png'),
    (512, 'agorax-icon-512.png'),
]:
    make_icon(size).save(root / name, optimize=True)
    print(f'✓ Generated {size}x{size} {name} (circular alpha)')

icon192 = Image.open(root / 'agorax-icon-192.png')
icon192.save(root / 'agent-avatars/agorax-rounded.png', optimize=True)
icon192.save(root / 'agent-avatars/fallback.png', optimize=True)
print('✓ Synced agent-avatars/agorax-rounded.png + fallback.png')

# OG cover from wordmark (letterbox on brand paper).
logo = Image.open(root / 'agorax.png').convert('RGBA')
cover = Image.new('RGB', (1200, 630), (247, 248, 246))
max_w, max_h = int(1200 * 0.92), int(630 * 0.92)
scale = min(max_w / logo.width, max_h / logo.height)
dw, dh = max(1, int(logo.width * scale)), max(1, int(logo.height * scale))
resized = logo.resize((dw, dh), Image.Resampling.LANCZOS)
cover.paste(resized, ((1200 - dw) // 2, (630 - dh) // 2), resized)
cover.save(root / 'cover.png', optimize=True)
print('✓ Generated 1200x630 cover')
print('✓ All icons generated successfully!')
`

const result = spawnSync('python3', ['-c', py], {
  cwd: root,
  encoding: 'utf8',
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.status !== 0) {
  console.error(
    'Icon generation failed. Install Pillow: python3 -m pip install Pillow',
  )
  process.exit(result.status ?? 1)
}

// Touch package entry so CI can assert outputs exist.
for (const f of [
  'agorax-favicon.png',
  'agorax-apple-touch-icon.png',
  'agorax-icon-192.png',
  'agorax-icon-512.png',
  'agent-avatars/agorax-rounded.png',
  'agent-avatars/fallback.png',
  'cover.png',
]) {
  readFileSync(join(outputDir, f))
}
