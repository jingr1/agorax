#!/usr/bin/env node
/**
 * Generate PWA / Identity marks from public/agorax-image.png.
 *
 * Look: **white soft rounded-square plate + black mark** (深色 UI 可读).
 * - Source may be colored; script flattens non-background pixels to pure black + alpha.
 * - All sizes (favicon / apple-touch / 192 / 512 / Identity) share the same plate shape:
 *   design corner radius R = 18.75% of edge (36 @ 192), transparent outside.
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
from PIL import Image, ImageDraw, ImageFilter

root = Path(${JSON.stringify(outputDir)})
src = Image.open(root / 'agorax-image.png').convert('RGBA')

# Identity / app-icon contract: R = 0.1875 × edge (36 @ 192).
DESIGN_R_FRAC = 36 / 192
# Pillow rounded_rectangle under-reads vs CSS/design; 42/36 ≈ 7/6 at 192.
PILLOW_R_SCALE = 42 / 36


def to_black_mark(im: Image.Image) -> Image.Image:
    """Flatten source → pure black glyph on transparent.

    - Transparent corners + black/colored strokes (preferred): keep stroke alpha;
      drop near-white. Do NOT drop black — that is the glyph.
    - Opaque black fill + colored mark (legacy): drop near-black fill, keep chroma.
    """
    px = im.load()
    w, h = im.size
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    transparent_plate = all(px[x, y][3] < 16 for x, y in corners)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 10:
                continue
            if r >= 245 and g >= 245 and b >= 245:
                continue
            if transparent_plate:
                op[x, y] = (0, 0, 0, a)
            elif r <= 10 and g <= 10 and b <= 10:
                continue
            else:
                op[x, y] = (0, 0, 0, a)
    return out


mark_full = to_black_mark(src)
bbox = mark_full.split()[-1].getbbox() or (0, 0, mark_full.width, mark_full.height)
cropped = mark_full.crop(bbox)


def paste_mark_centered(canvas: Image.Image, box: int) -> None:
    scale = min(box / cropped.width, box / cropped.height)
    dw = max(1, int(round(cropped.width * scale)))
    dh = max(1, int(round(cropped.height * scale)))
    mark = cropped.resize((dw, dh), Image.Resampling.LANCZOS)
    ox = (canvas.width - dw) // 2
    oy = (canvas.height - dh) // 2
    canvas.paste(mark, (ox, oy), mark)


def make_soft_rounded(size: int) -> Image.Image:
    """White soft rounded-square + black mark; transparent outside."""
    design_r = max(1, int(round(size * DESIGN_R_FRAC)))
    draw_r = max(1, int(round(design_r * PILLOW_R_SCALE)))

    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=draw_r, fill=255
    )

    # Soft drop shadow (scaled lightly with size).
    shadow_blur = max(1.5, size * (3.5 / 192))
    shadow_off = max(1, int(round(size * (4 / 192))))
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (2, shadow_off, size - 3, size - 1),
        radius=max(1, draw_r - 2),
        fill=(0, 0, 0, 36),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=shadow_blur))

    card = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(card).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=draw_r, fill=(255, 255, 255, 255)
    )
    shade = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    mid = size // 2
    for y in range(mid, size):
        t = (y - mid) / max(1, size - mid)
        sd.line([(0, y), (size - 1, y)], fill=(0, 0, 0, int(14 * t * t)))
    shade_a = shade.split()[-1]
    shade.putalpha(Image.composite(shade_a, Image.new('L', (size, size), 0), mask))
    card = Image.alpha_composite(card, shade)
    card.putalpha(mask)

    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out = Image.alpha_composite(out, shadow)
    out = Image.alpha_composite(out, card)
    paste_mark_centered(out, int(round(size * 0.76)))
    out.putalpha(
        Image.composite(out.split()[-1], Image.new('L', (size, size), 0), mask)
    )
    return out


for size, name in [
    (32, 'agorax-favicon.png'),
    (180, 'agorax-apple-touch-icon.png'),
    (192, 'agorax-icon-192.png'),
    (512, 'agorax-icon-512.png'),
]:
    make_soft_rounded(size).save(root / name, optimize=True)
    print(f'✓ Generated {size}x{size} {name} (white soft rounded-square + black mark)')

identity = make_soft_rounded(192)
identity_path = root / 'agent-avatars' / 'agorax-rounded.png'
identity_path.parent.mkdir(parents=True, exist_ok=True)
identity.save(identity_path, optimize=True)
print('✓ Generated 192x192 agent-avatars/agorax-rounded.png (same plate as PWA 192)')
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

for (const f of [
  'agorax-favicon.png',
  'agorax-apple-touch-icon.png',
  'agorax-icon-192.png',
  'agorax-icon-512.png',
  'agent-avatars/agorax-rounded.png',
]) {
  readFileSync(join(outputDir, f))
}
