"""Draws the app's default icon: a glossy orb on a deep blue field, full-bleed so macOS
doesn't frame it. Original artwork, safe to share. Run: python scripts/default-icon.py out.png"""
import math
import sys

from PIL import Image, ImageDraw, ImageFilter

S = 1024
img = Image.new("RGB", (S, S))
px = img.load()
cx, cy, r = S * 0.5, S * 0.52, S * 0.34
for y in range(S):
    for x in range(S):
        # Background: deep blue-violet, lighter toward the orb.
        d = math.hypot(x - cx, y - cy) / S
        bg = (int(18 + 30 * max(0, 0.6 - d)), int(20 + 26 * max(0, 0.6 - d)), int(48 + 90 * max(0, 0.6 - d)))
        dx, dy = (x - cx) / r, (y - cy) / r
        rr = dx * dx + dy * dy
        if rr <= 1:
            # Orb: cyan at the lower left, through blue, to violet at the upper right; shaded as a sphere.
            z = math.sqrt(1 - rr)
            t = min(max((dx - dy) * 0.35 + 0.5, 0), 1)
            stops = [(40, 200, 255), (30, 80, 235), (130, 80, 230)]
            a, b, k = (stops[0], stops[1], t * 2) if t < 0.5 else (stops[1], stops[2], t * 2 - 1)
            base = [a[i] + (b[i] - a[i]) * k for i in range(3)]
            light = 0.35 + 0.65 * max(0, (-dx * 0.35 - dy * 0.6 + z * 0.7))
            rim = (1 - z) ** 3 * 0.6
            px[x, y] = tuple(int(min(255, base[i] * light + 255 * rim * 0.5)) for i in range(3))
        else:
            px[x, y] = bg

# Soft glow around the orb and a glossy highlight.
glow = Image.new("L", (S, S), 0)
ImageDraw.Draw(glow).ellipse((cx - r * 1.15, cy - r * 1.15, cx + r * 1.15, cy + r * 1.15), fill=90)
glow = glow.filter(ImageFilter.GaussianBlur(60))
img = Image.composite(Image.new("RGB", (S, S), (90, 140, 255)), img, glow.point(lambda v: v // 3))
hl = Image.new("L", (S, S), 0)
ImageDraw.Draw(hl).ellipse((cx - r * 0.55, cy - r * 0.78, cx - r * 0.05, cy - r * 0.42), fill=200)
hl = hl.filter(ImageFilter.GaussianBlur(28))
img = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), img, hl)
# Redraw the orb's outline crisply over the glow.
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
img.save(sys.argv[1])
