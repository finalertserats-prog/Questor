#!/usr/bin/env python
"""Cut the official Questor logo into the assets the product needs.

    python scripts/build-brand-assets.py <source.png>

The source is the full lockup: the Q mark, the wordmark and the tagline, on a
white square. Everything the app uses is derived from it here rather than by
hand, so a new lockup can be dropped in and the whole set rebuilt.

Written to web/public/brand/:
    questor-logo.png      the full lockup, trimmed, transparent
    questor-mark.png      the Q on its own — sidebar rail, favicons, avatars
    questor-wordmark.png  the word and tagline, for headers with the mark beside
    favicon-16.png, favicon-32.png, apple-touch-icon.png, favicon.ico
"""
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "web" / "public" / "brand"
WHITE_TOLERANCE = 18


def drop_white_background(image):
    """The lockup ships on white; the app puts it on light and dark surfaces."""
    image = image.convert("RGBA")
    pixels = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if r >= 255 - WHITE_TOLERANCE and g >= 255 - WHITE_TOLERANCE and b >= 255 - WHITE_TOLERANCE:
                pixels[x, y] = (r, g, b, 0)
    return image


def bands(image, min_gap=12):
    """Split on fully transparent rows: mark, wordmark, tagline."""
    alpha = image.getchannel("A")
    width, height = image.size
    occupied = [any(alpha.getpixel((x, y)) > 8 for x in range(0, width, 3)) for y in range(height)]

    found, start, gap = [], None, 0
    for y, filled in enumerate(occupied):
        if filled:
            if start is None:
                start = y
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                found.append((start, y - gap))
                start, gap = None, 0
    if start is not None:
        found.append((start, height - 1))
    return found


def crop_band(image, top, bottom):
    band = image.crop((0, top, image.width, bottom + 1))
    box = band.getbbox()
    return band.crop(box) if box else band


def save(image, name, width=None):
    out = image
    if width and image.width != width:
        height = round(image.height * width / image.width)
        out = image.resize((width, height), Image.LANCZOS)
    path = OUT / name
    out.save(path, optimize=True)
    print(f"  {name:<24} {out.size[0]}x{out.size[1]}  {path.stat().st_size:,} bytes")
    return out


def square(image, size):
    """Centre the mark on a transparent square — favicons must not be lopsided."""
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2), image)
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    source = Path(sys.argv[1]).resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"source: {source}")

    logo = drop_white_background(Image.open(source))
    box = logo.getbbox()
    if box:
        logo = logo.crop(box)

    print("writing:")
    save(logo, "questor-logo.png", width=960)

    rows = bands(logo)
    if not rows:
        raise SystemExit("could not find the mark: no opaque rows in the source")
    mark = crop_band(logo, *rows[0])
    save(mark, "questor-mark.png", width=512)

    if len(rows) > 1:
        wordmark = crop_band(logo, rows[1][0], rows[-1][1])
        save(wordmark, "questor-wordmark.png", width=720)
    else:
        print("  (no wordmark band found — only the mark was written)")

    for name, size in (("favicon-16.png", 16), ("favicon-32.png", 32), ("apple-touch-icon.png", 180)):
        save(square(mark, size), name)
    ico = OUT / "favicon.ico"
    square(mark, 48).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"  {'favicon.ico':<24} 16/32/48        {ico.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
