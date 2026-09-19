#!/usr/bin/env python
"""Rebuild every Questor logo asset from the owner's brand files.

    python scripts/build-brand-assets.py

Needs Pillow, numpy and scipy. Reads web/brand-source/ and writes
web/public/brand/. Nothing in the output is hand-edited: drop new source files
in and run the command again.

Sources (1254x1254 RGB, background baked in, no alpha):
    questor-logo-light-source.png   lockup on near-white, for the light theme
    questor-logo-dark-source.png    lockup on navy, for the dark theme

The background is removed by matting against its known colour rather than by
thresholding: every edge pixel gets an alpha from how far it sits between the
background and the nearest solid artwork colour, and its colour is
un-premultiplied, so the transparent files carry no white or navy halo. The
white speech bubble is enclosed by the mark, so on the light source it is kept
as artwork even though it matches the background.

Written to web/public/brand/:
    questor-logo-{light,dark}.{webp,png}     full lockup with tagline
    questor-logo.{webp,png}                  = light full lockup (older links)
    questor-lockup-{light,dark}.{webp,png}   mark left of the word, no tagline,
                                             mark 256 px tall, for headers
    questor-wordmark-{light,dark}.png        the word only, 96 px tall
    questor-wordmark.{png,webp}              = light wordmark (sent emails)
    questor-mark.{png,webp}                  the mark, 512x512, transparent
    questor-mark.svg, favicon.svg            hand-built vector mark
    favicon.ico (16/32/48), favicon-16.png, favicon-32.png
    apple-touch-icon.png (180, opaque navy), icon-192.png, icon-512.png,
    icon-maskable-512.png (opaque navy), site.webmanifest

Rasters are never scaled up past the source: the lockups and the 512 mark are
the source pixels cropped and padded, everything else is a reduction. Below
48 px the raster mark turns to mush, so 16 and 32 are drawn from the vector
geometry instead.

The medals, empty-state and login images in web/brand-source/ are not made
here; this script leaves them alone.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

import brand_mark

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "web" / "brand-source"
OUT = REPO / "web" / "public" / "brand"

LIGHT_SOURCE = "questor-logo-light-source.png"
DARK_SOURCE = "questor-logo-dark-source.png"

# Per source: (distance from the background colour under which a pixel counts
# as background, the compression ringing around the artwork to discard). The
# navy file rings up to ~25 levels beside the lettering; the white one barely.
# Matching the light file tighter matters: its handle highlight is near-white.
NOISE = {"light": (12.0, 4.0), "dark": (32.0, 22.0)}
# Half-width, in source pixels, of the strip either side of the edge that is
# matted. The sources' anti-aliasing is about two pixels wide.
EDGE_BAND = 3
# The navy the dark source is drawn on, and the backdrop for opaque icons.
BRAND_NAVY = (11, 16, 32)
# The app's own dark surface (--desk under data-theme="dark" in app.css).
APP_DARK_DESK = "#121218"
APP_LIGHT_DESK = "#f5f4f8"
LOCKUP_PAD = 24
# The horizontal lockup, for headers 22-34 px tall: the word's capitals are
# 0.58 of the mark's height (the stacked source runs 0.43, too small once the
# pair sits side by side), with 0.22 of it between them.
HORIZONTAL_MARK_HEIGHT = 256
HORIZONTAL_CAP_RATIO = 0.58
HORIZONTAL_GAP_RATIO = 0.22
HORIZONTAL_PAD = 12
WEBP_QUALITY = 90


# --- matting -----------------------------------------------------------------

def background_colour(rgb):
    edge = 16
    border = np.concatenate([
        rgb[:edge].reshape(-1, 3), rgb[-edge:].reshape(-1, 3),
        rgb[:, :edge].reshape(-1, 3), rgb[:, -edge:].reshape(-1, 3),
    ])
    return np.median(border, axis=0)


def background_mask(rgb, bg, near_background, keep_enclosed_above):
    """Pixels that are background, except enclosed ones inside the mark.

    Near-background pixels cut off from the image border are the counters of
    letters (background) or the speech bubble (artwork). Only the ones wholly
    above `keep_enclosed_above` - the mark's band - are kept as artwork.
    """
    near = np.sqrt(((rgb - bg) ** 2).sum(-1)) < near_background
    labels, _ = ndimage.label(near)
    edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    mask = near.copy()
    for index, rows in enumerate(ndimage.find_objects(labels), start=1):
        if index in edge_labels or rows is None:
            continue
        if rows[0].stop <= keep_enclosed_above:
            mask[labels == index] = False
    return mask


def matte(rgb, bg, noise, keep_enclosed_above):
    """Return float RGBA (0..1) with the background matted out."""
    near_background, ringing = noise
    is_bg = background_mask(rgb, bg, near_background, keep_enclosed_above)
    is_fg = ~is_bg
    to_bg = ndimage.distance_transform_edt(is_fg)
    to_fg = ndimage.distance_transform_edt(is_bg)
    band = (is_fg & (to_bg <= EDGE_BAND)) | (is_bg & (to_fg <= EDGE_BAND))
    core = is_fg & ~band

    # The colour each edge pixel would have if it were solid: that of the
    # nearest pixel well inside the artwork.
    _, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
    solid = rgb[iy, ix]

    towards = solid - bg
    length2 = (towards ** 2).sum(-1)
    length = np.sqrt(np.maximum(length2, 1.0))
    along = ((rgb - bg) * towards).sum(-1) / length
    projected = (along - ringing) / np.maximum(length - ringing, 1.0)
    alpha = np.where(core, 1.0, 0.0)
    alpha = np.where(band, np.clip(projected, 0.0, 1.0), alpha)
    # Artwork too close to the background colour to matte keeps its own mask.
    alpha = np.where(band & (length2 < 400), is_fg.astype(float), alpha)
    alpha = np.where(alpha < 0.02, 0.0, np.where(alpha > 0.98, 1.0, alpha))

    safe = np.maximum(alpha, 1e-3)[..., None]
    unmixed = np.clip(bg + (rgb - bg) / safe, 0, 255)
    trust = np.clip((alpha - 0.1) / 0.4, 0.0, 1.0)[..., None]
    colour = np.where(band[..., None], trust * unmixed + (1 - trust) * solid, rgb)
    return np.dstack([colour / 255.0, alpha])


def to_image(rgba):
    return Image.fromarray(np.round(rgba * 255).astype(np.uint8), "RGBA")


def cut(theme):
    source_name = LIGHT_SOURCE if theme == "light" else DARK_SOURCE
    rgb = np.asarray(Image.open(SRC / source_name).convert("RGB")).astype(np.float64)
    bg = background_colour(rgb)
    bands = row_bands(np.sqrt(((rgb - bg) ** 2).sum(-1)) > 30)
    if len(bands) != 3:
        raise SystemExit(f"{source_name}: expected mark, wordmark and tagline bands, found {bands}")
    mark_band, word_band, _ = bands
    gap = (mark_band[1] + word_band[0]) // 2
    image = to_image(matte(rgb, bg, NOISE[theme], keep_enclosed_above=gap))
    print(f"  {source_name}: background {tuple(int(v) for v in bg)}, bands {bands}")
    return image, bands


def row_bands(occupied_mask):
    """Row ranges of mark, wordmark and tagline, widened to take in their
    anti-aliased fringe (the bands are found on solid pixels only)."""
    rows = np.where(occupied_mask.any(1))[0]
    runs = np.split(rows, np.where(np.diff(rows) > 4)[0] + 1)
    fringe = EDGE_BAND + 2
    return [(int(r[0]) - fringe, int(r[-1]) + fringe) for r in runs if len(r) > 4]


# --- composition -------------------------------------------------------------

def trim(image):
    box = image.getchannel("A").point(lambda a: 255 if a > 2 else 0).getbbox()
    return image.crop(box)


def pad(image, amount):
    canvas = Image.new("RGBA", (image.width + 2 * amount, image.height + 2 * amount), (0, 0, 0, 0))
    canvas.alpha_composite(image, (amount, amount))
    return canvas


def rows(image, top, bottom):
    return trim(image.crop((0, top, image.width, bottom + 1)))


def on_square(image, side, fill=(0, 0, 0, 0), inset=0.0):
    """Centre `image` on a square, shrinking it to fit inside `inset` padding."""
    room = round(side * (1 - 2 * inset))
    scale = min(1.0, room / max(image.size))
    if scale < 1.0:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (side, side), fill)
    canvas.alpha_composite(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def maskable(mark, side, safe_radius=0.39):
    """Mark on navy with every visible pixel inside the maskable safe circle
    (radius 40% of the icon), which the handle's end would otherwise poke out of."""
    alpha = np.asarray(mark.getchannel("A")) > 8
    ys, xs = np.nonzero(alpha)
    reach = np.hypot(xs + 0.5 - mark.width / 2, ys + 0.5 - mark.height / 2).max()
    scale = safe_radius * side / reach
    shrunk = mark.resize((round(mark.width * scale), round(mark.height * scale)), Image.LANCZOS)
    return on_square(shrunk, side, fill=BRAND_NAVY + (255,))


def cap_height(word):
    """Rows from the top of the capital Q to the baseline, in `word` pixels.

    The baseline is the lowest inked row of most columns; only the Q's tail
    and the letters' overshoot fall below it."""
    ink = np.asarray(word.getchannel("A")) > 128
    inked = np.nonzero(ink.any(0))[0]
    bottoms = [np.nonzero(ink[:, x])[0][-1] for x in inked]
    return int(np.median(bottoms)) + 1


def horizontal_lockup(mark, word, mark_height=HORIZONTAL_MARK_HEIGHT):
    """Mark on the left, word on the right, the word's cap height centred on
    the mark. Both are reductions of the source pixels."""
    mark = fit_height(mark, mark_height)
    scale = HORIZONTAL_CAP_RATIO * mark_height / cap_height(word)
    if scale > 1.0:
        raise SystemExit("horizontal lockup would enlarge the wordmark past the source")
    cap = cap_height(word) * scale
    word = fit_height(word, round(word.height * scale))
    gap = round(HORIZONTAL_GAP_RATIO * mark_height)
    centre = mark.height / 2
    word_top = round(centre - cap / 2)
    top = min(0, word_top)
    bottom = max(mark.height, word_top + word.height)
    pad_px = HORIZONTAL_PAD
    canvas = Image.new("RGBA", (mark.width + gap + word.width + 2 * pad_px, bottom - top + 2 * pad_px), (0, 0, 0, 0))
    canvas.alpha_composite(mark, (pad_px, pad_px - top))
    canvas.alpha_composite(word, (pad_px + mark.width + gap, pad_px + word_top - top))
    return canvas


def fit_width(image, max_width):
    if image.width <= max_width:
        return image
    height = round(image.height * max_width / image.width)
    return image.resize((max_width, height), Image.LANCZOS)


def fit_height(image, height):
    width = round(image.width * height / image.height)
    return image.resize((width, height), Image.LANCZOS)


# --- writing -----------------------------------------------------------------

def report(name, size):
    path = OUT / name
    print(f"  {name:<30} {size:<10} {path.stat().st_size:>9,} bytes")


def save(image, name):
    path = OUT / name
    # Invisible pixels keep whatever colour the matte left; zero them so the
    # PNG compresses and nothing stale bleeds in when a browser resamples.
    pixels = np.asarray(image.convert("RGBA")).copy()
    pixels[pixels[..., 3] == 0] = 0
    image = Image.fromarray(pixels, "RGBA") if image.mode == "RGBA" else image
    if name.endswith(".webp"):
        image.save(path, quality=WEBP_QUALITY, method=6)
    elif name.endswith(".png"):
        image.save(path, optimize=True)
    else:
        image.save(path)
    report(name, f"{image.width}x{image.height}")


def save_both(image, stem):
    save(image, f"{stem}.webp")
    save(image, f"{stem}.png")


def write_text(name, text):
    (OUT / name).write_text(text, encoding="utf-8", newline="\n")
    report(name, "text")


def manifest():
    return json.dumps({
        "name": "Questor",
        "short_name": "Questor",
        "icons": [
            {"src": "/brand/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/brand/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/brand/icon-maskable-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
        # Light is the product's default theme, so the installed app's splash
        # and title bar match it rather than the dark desk.
        "theme_color": APP_LIGHT_DESK,
        "background_color": APP_LIGHT_DESK,
        "display": "standalone",
        "start_url": "/",
    }, indent=2) + "\n"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("matting:")
    light, light_bands = cut("light")
    dark, dark_bands = cut("dark")

    print("writing:")
    for theme, image, (mark_band, word_band, _) in (
        ("light", light, light_bands), ("dark", dark, dark_bands),
    ):
        full = pad(trim(image), LOCKUP_PAD)
        save_both(fit_width(full, 1200), f"questor-logo-{theme}")
        lockup = horizontal_lockup(rows(image, *mark_band), rows(image, *word_band))
        save_both(lockup, f"questor-lockup-{theme}")
        word = fit_height(rows(image, word_band[0], word_band[1]), 96)
        save(word, f"questor-wordmark-{theme}.png")
        if theme == "light":
            save_both(fit_width(full, 1200), "questor-logo")
            save_both(word, "questor-wordmark")

    # The mark is the same artwork in both files; the light source's is used
    # everywhere so there is one mark, not two slightly different purples.
    mark = rows(light, *light_bands[0])
    save_both(on_square(mark, 512), "questor-mark")
    save(on_square(mark, 512), "icon-512.png")
    save(on_square(mark, 192), "icon-192.png")
    save(on_square(mark, 180, fill=BRAND_NAVY + (255,), inset=0.12), "apple-touch-icon.png")
    save(maskable(mark, 512), "icon-maskable-512.png")

    write_text("questor-mark.svg", brand_mark.svg(detailed=True))
    write_text("favicon.svg", brand_mark.svg(detailed=False))
    small = {size: brand_mark.render(size) for size in (16, 32)}
    save(small[16], "favicon-16.png")
    save(small[32], "favicon-32.png")
    ico = OUT / "favicon.ico"
    # Pillow takes each size from append_images when one matches, so the tab
    # sizes are the vector drawings and only 48 is reduced from the artwork.
    on_square(mark, 48).save(ico, sizes=[(16, 16), (32, 32), (48, 48)], append_images=[small[16], small[32]])
    report("favicon.ico", "16/32/48")
    write_text("site.webmanifest", manifest())


if __name__ == "__main__":
    main()
