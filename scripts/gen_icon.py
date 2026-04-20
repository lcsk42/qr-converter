"""
Generate a 1024×1024 app icon for QR Converter.

Design:
  - Dark slate background (#0f172a) with macOS-style rounded corners
  - Three classic QR finder-pattern squares (white) at top-left, top-right, bottom-left
  - Timing dots connecting the finders
  - Stylised data-dot grid at bottom-right
  - Accent colour (#3b82f6, blue) on the center dot of each finder
"""

from PIL import Image, ImageDraw, ImageFilter
import math, os, sys

SIZE       = 1024
BG         = (15, 23, 42)       # #0f172a  – dark navy
WHITE      = (255, 255, 255)
ACCENT     = (59, 130, 246)     # #3b82f6  – blue
CORNER_R   = 220                # icon rounded-corner radius (~22%)

# QR layout ──────────────────────────────────────────────────────────────────
# Content box: 680×680, centred → top-left at (172, 172)
OFFSET  = 172
QR_SIZE = 680
FINDER  = 240          # finder-pattern square size (≈ 7 modules × 34 px)
MOD     = FINDER // 7  # ~34 px per module

# finder positions (top-left corner)
FINDERS = {
    "tl": (OFFSET,                 OFFSET),
    "tr": (OFFSET + QR_SIZE - FINDER, OFFSET),
    "bl": (OFFSET,                 OFFSET + QR_SIZE - FINDER),
}
# bottom-right data area
DATA_X = OFFSET + QR_SIZE - FINDER
DATA_Y = OFFSET + QR_SIZE - FINDER

# ── helpers ──────────────────────────────────────────────────────────────────

def rr(draw, x, y, w, h, r, fill):
    draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill)


def finder_pattern(draw, fx, fy, bg):
    """Draw a QR finder pattern (7×7 modules) at (fx, fy)."""
    # outer white frame (7 modules)
    rr(draw, fx, fy, FINDER, FINDER, MOD, WHITE)
    # dark inner (5 modules, 1-module border)
    m = MOD
    rr(draw, fx + m, fy + m, FINDER - 2*m, FINDER - 2*m, MOD - 4, bg)
    # white centre (3 modules)
    rr(draw, fx + 2*m, fy + 2*m, FINDER - 4*m, FINDER - 4*m, MOD - 8, WHITE)
    # accent overlay on centre dot
    inner_size = FINDER - 4*m
    rr(draw, fx + 2*m, fy + 2*m, inner_size, inner_size, MOD - 8, ACCENT)
    # tiny white highlight inside accent
    hi = inner_size // 3
    hi_off = (inner_size - hi) // 2
    rr(draw, fx + 2*m + hi_off, fy + 2*m + hi_off, hi, hi, hi // 3, WHITE)


def timing_dots(draw, axis, fixed, start, end, dot=MOD, step=MOD*2):
    """Draw alternating white timing dots along one axis."""
    pos = start
    i = 0
    while pos + dot <= end:
        if i % 2 == 0:
            if axis == "h":
                rr(draw, pos, fixed - dot//2, dot, dot, dot//4, WHITE)
            else:
                rr(draw, fixed - dot//2, pos, dot, dot, dot//4, WHITE)
        pos += step
        i += 1


# ── build image ──────────────────────────────────────────────────────────────

img  = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Background
rr(draw, 0, 0, SIZE, SIZE, CORNER_R, (*BG, 255))

# Finder patterns
for key, (fx, fy) in FINDERS.items():
    finder_pattern(draw, fx, fy, BG)

# Timing strips (between top-left ↔ top-right, and top-left ↔ bottom-left)
t_cx = FINDERS["tl"][0] + FINDER // 2   # vertical timing x
t_cy = FINDERS["tl"][1] + FINDER // 2   # horizontal timing y
t_start = OFFSET + FINDER + MOD
t_end_h = FINDERS["tr"][0] - MOD
t_end_v = FINDERS["bl"][1] - MOD

timing_dots(draw, "h", t_cy, t_start, t_end_h)
timing_dots(draw, "v", t_cx, t_start, t_end_v)

# ── data-dot grid (bottom-right quadrant) ───────────────────────────────────
# 5×5 aesthetic pattern (visually balanced, symmetric-ish)
DATA_PATTERN = [
    [1, 0, 1, 0, 1],
    [0, 1, 1, 1, 0],
    [1, 1, 0, 1, 1],
    [0, 1, 1, 1, 0],
    [1, 0, 1, 0, 1],
]

CELL   = FINDER // 5        # 48 px
DOT    = int(CELL * 0.70)   # 33 px
MARGIN = (CELL - DOT) // 2  # 7 px

for row, cols in enumerate(DATA_PATTERN):
    for col, on in enumerate(cols):
        if on:
            x = DATA_X + col * CELL + MARGIN
            y = DATA_Y + row * CELL + MARGIN
            # vary shade slightly for depth
            shade = 240 if (row + col) % 2 == 0 else 210
            rr(draw, x, y, DOT, DOT, DOT // 4, (shade, shade, shade))

# ── soft shadow / vignette (purely additive, applied to bg before flatten) ──
shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
rr(sd, 8, 8, SIZE - 16, SIZE - 16, CORNER_R, (0, 0, 0, 60))
shadow = shadow.filter(ImageFilter.GaussianBlur(radius=18))
final = Image.alpha_composite(shadow, img)

# ── save ─────────────────────────────────────────────────────────────────────
out_dir = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
out_path = os.path.join(out_dir, "source.png")
final.save(out_path)
print(f"Saved {out_path}  ({SIZE}×{SIZE})")
