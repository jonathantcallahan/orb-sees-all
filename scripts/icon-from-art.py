import sys
from PIL import Image
src = Image.open(sys.argv[1]).convert("RGBA")
x, y, s = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
crop = src.crop((x, y, x + s, y + s))
bg = Image.new("RGBA", crop.size, sys.argv[6])
bg.alpha_composite(crop)
bg.convert("RGB").resize((1024, 1024), Image.LANCZOS).save(sys.argv[2])
