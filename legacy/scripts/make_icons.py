#!/usr/bin/env python3
"""Render the app icon PNGs into App/Shared/Assets.xcassets/AppIcon.appiconset (needs Pillow)."""
import glob, json, os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "App/Shared/Assets.xcassets/AppIcon.appiconset")
S = 1024

def font(size):
    cands = ["/System/Library/Fonts/Supplemental/Georgia Bold.ttf", "/Library/Fonts/Georgia Bold.ttf",
             "/usr/share/fonts/truetype/msttcorefonts/Georgia_Bold.ttf"]
    cands += glob.glob("/usr/share/fonts/**/Georgia*Bold*.ttf", recursive=True)
    cands += glob.glob("/usr/share/fonts/**/*Serif-Bold*.ttf", recursive=True)
    for c in cands:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()

def artwork():
    img = Image.new("RGBA", (S, S))
    dr = ImageDraw.Draw(img)
    for y in range(S):
        t = y / S
        dr.line([(0, y), (S, y)], fill=(int(40 + 20 * t), int(40 + 20 * t), int(46 + 24 * t), 255))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=225, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    dr = ImageDraw.Draw(out)
    dr.rounded_rectangle([262, 190, 762, 834], radius=48, fill=(250, 250, 248, 255))
    dr.text((512, 520), "B", font=font(420), fill=(55, 53, 47, 255), anchor="mm")
    return out

def main():
    os.makedirs(D, exist_ok=True)
    full = artwork()
    full.convert("RGB").save(os.path.join(D, "icon-ios-1024.png"))
    images = [{"filename": "icon-ios-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}]
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    small = full.resize((824, 824), Image.LANCZOS)
    canvas.paste(small, (100, 100), small)
    for pt in [16, 32, 128, 256, 512]:
        for sc in [1, 2]:
            name = f"icon-mac-{pt}@{sc}x.png"
            canvas.resize((pt * sc, pt * sc), Image.LANCZOS).save(os.path.join(D, name))
            images.append({"filename": name, "idiom": "mac", "scale": f"{sc}x", "size": f"{pt}x{pt}"})
    json.dump({"images": images, "info": {"author": "xcode", "version": 1}}, open(os.path.join(D, "Contents.json"), "w"), indent=2)
    print("icons written to", D)

if __name__ == "__main__":
    main()
