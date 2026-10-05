# Noisy (poorly compressible) PNGs sized like typical bot backgrounds/sprites; the heavy bot references 12 of them.
# usage: python gen_assets.py <out_dir>
import os, random, sys
from PIL import Image

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
random.seed(1)
for i in range(12):
    w, h = (1920, 1080) if i < 4 else (1024, 1024)
    img = Image.effect_noise((w, h), 64).convert('RGB')
    tint = Image.new('RGB', (w, h), (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))
    p = os.path.join(out, f'img{i:02d}.png')
    Image.blend(img, tint, 0.5).save(p, optimize=False)
    print(p, os.path.getsize(p) // 1024, 'KB')
