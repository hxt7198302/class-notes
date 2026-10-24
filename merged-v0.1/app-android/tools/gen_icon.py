# -*- coding: utf-8 -*-
# gen_icon.py —— 生成演示壳图标（Pillow）
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'app', 'res')
SIZES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}
MASTER = 1024

def lerp(a, b, t):
    return int(a + (b - a) * t)

def make_master():
    img = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 圆角矩形渐变底
    radius = int(MASTER * 0.22)
    grad = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(MASTER):
        t = y / float(MASTER - 1)
        r = lerp(59, 29, t)
        g = lerp(130, 78, t)
        b = lerp(246, 216, t)
        gd.line([(0, y), (MASTER, y)], fill=(r, g, b, 255))
    mask = Image.new('L', (MASTER, MASTER), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, MASTER - 1, MASTER - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    # 顶部高光
    hi = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hi)
    hd.rounded_rectangle([int(MASTER*0.08), int(MASTER*0.06), int(MASTER*0.92), int(MASTER*0.52)], radius=int(MASTER*0.2), fill=(255, 255, 255, 26))
    img = Image.alpha_composite(img, Image.composite(hi, Image.new('RGBA', (MASTER, MASTER), (0,0,0,0)), mask))
    # 白色 AI 字
    d = ImageDraw.Draw(img)
    font = None
    for path in [r'C:\Windows\Fonts\arialbd.ttf', r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\segoeuib.ttf']:
        try:
            font = ImageFont.truetype(path, int(MASTER * 0.5))
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = 'AI'
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (MASTER - tw) // 2 - bbox[0]
    y = (MASTER - th) // 2 - bbox[1] - int(MASTER * 0.03)
    # 轻阴影
    d.text((x + 6, y + 6), text, font=font, fill=(10, 30, 90, 70))
    d.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    # 底部小圆点装饰
    cy = int(MASTER * 0.78)
    for i, cx in enumerate([0.38, 0.5, 0.62]):
        rr = int(MASTER * 0.018)
        cx_px = int(MASTER * cx)
        d.ellipse([cx_px - rr, cy - rr, cx_px + rr, cy + rr], fill=(255, 255, 255, 210 if i == 1 else 130))
    return img

def main():
    master = make_master()
    master.save(os.path.join(ROOT, 'dist', 'icon-1024.png'))
    for folder, px in SIZES.items():
        out_dir = os.path.join(RES, folder)
        os.makedirs(out_dir, exist_ok=True)
        img = master.resize((px, px), Image.LANCZOS)
        img.save(os.path.join(out_dir, 'ic_launcher.png'))
        print(folder, px, 'ok')
    print('done')

if __name__ == '__main__':
    main()
