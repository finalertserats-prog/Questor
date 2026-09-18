"""The Questor mark as vector geometry: one description, drawn two ways.

`svg()` writes it as an SVG for the browser; `render()` rasterises the same
shapes with numpy for the 16 and 32 px favicons, where the raster artwork
blurs into a purple dot. Coordinates are the pixels of the 1254 px brand
sources (web/brand-source/questor-logo-*-source.png), so every number here can
be checked against the artwork; they are mapped onto a 64-unit square on the
way out.

What was measured from the source: the disc (centre, radius), the bubble
(circle, tail tip), the three dots, the handle's axis, width, split and end,
and the colours along several lines through it. What is an approximation: the
disc's lighting is one radial gradient and the darker hollow of the Q behind
the bubble is one circle with another, where the artwork is painted freehand.
"""
import math

import numpy as np
from PIL import Image, ImageDraw

DISC = (627.2, 451.5, 214.6)
HOLLOW = (585.0, 510.0, 147.0)
BUBBLE = (626.5, 455.2, 123.4)
TAIL = [(527.0, 505.0), (512.0, 582.0), (578.0, 560.0), (600.0, 520.0)]
DOTS = [(564.0, 454.1), (626.0, 454.2), (687.9, 454.1)]
DOT_RADIUS = 19.6
# The handle runs at 45 degrees out of the disc centre. In its own frame u is
# the distance along it and w across it (positive towards the lower left).
HANDLE_U = (100.0, 309.2)
HANDLE_W = (-33.4, 80.4)
HANDLE_SPLIT_W = 23.5
HANDLE_END_RADIUS = 46.0

DISC_LIGHT = [(0.0, "#b6b1fc"), (0.11, "#ada7f9"), (0.33, "#8a82ea"), (0.55, "#5d52d6"),
              (0.72, "#544bc6"), (0.9, "#6353d6"), (1.0, "#6a58dc")]
DISC_LIGHT_CENTRE = (800.0, 260.0, 520.0)
# The hollow is lit from its lower left and deepest beside the handle.
HOLLOW_SHADE = ((505.0, 625.0, 230.0), [(0.0, "#6456d8"), (0.2, "#5a4fcf"), (0.45, "#463fae"),
                                        (0.62, "#2d2f85"), (1.0, "#3c3aa0")])
HANDLE_SHADOW = [(0.0, "#7c75de"), (0.34, "#5f56cc"), (0.75, "#4944b6"), (1.0, "#4540b0")]
HANDLE_SHADOW_U = (150.0, 309.0)
HANDLE_LIGHT = [(0.0, "#ffffff"), (0.35, "#d3d1fa"), (0.71, "#9a92ef"), (1.0, "#8b83ea")]
HANDLE_LIGHT_U = (150.0, 309.0)
DOT_COLOUR = "#594ec6"

# The square the mark is drawn in, in source pixels: the artwork's bounds
# (x 408-851, y 240-708) centred with a little air.
FULL_BOX = (389.5, 234.0, 480.0)
# The favicon is cropped tighter so the mark fills the tab.
FAVICON_BOX = (400.0, 245.0, 458.0)
VIEW = 64.0


# --- geometry ----------------------------------------------------------------

def along_handle(u, w):
    """Handle frame -> source pixels."""
    cx, cy, _ = DISC
    return (cx + (u - w) / math.sqrt(2), cy + (u + w) / math.sqrt(2))


def handle_outline(w_from, w_to, steps=24):
    """The handle between two w lines, with its far end's corners rounded."""
    u0, u1 = HANDLE_U
    w0, w1 = HANDLE_W
    r = HANDLE_END_RADIUS
    points = [(u0, w_from)]
    for corner_w, sweep in ((w0, (-90, 0)), (w1, (0, 90))):
        centre_w = corner_w + r if corner_w == w0 else corner_w - r
        for i in range(steps + 1):
            angle = math.radians(sweep[0] + (sweep[1] - sweep[0]) * i / steps)
            w = centre_w + r * math.sin(angle)
            if w_from - 1e-9 <= w <= w_to + 1e-9:
                points.append((u1 - r + r * math.cos(angle), w))
        if corner_w == w0:
            points.append((u1, min(w_to, w1 - r)))
    points.append((u0, w_to))
    return [along_handle(u, w) for u, w in points]


def layers(simple):
    """(shape, paint) pairs, back to front."""
    out = [(("circle", DISC), ("radial", DISC_LIGHT_CENTRE, DISC_LIGHT))]
    if not simple:
        out.append((("circle", HOLLOW), ("radial",) + HOLLOW_SHADE))
    w0, w1 = HANDLE_W
    shadow_axis = (along_handle(HANDLE_SHADOW_U[0], 0), along_handle(HANDLE_SHADOW_U[1], 0))
    light_axis = (along_handle(HANDLE_LIGHT_U[0], 0), along_handle(HANDLE_LIGHT_U[1], 0))
    out.append((("poly", handle_outline(w0, w1)), ("linear",) + shadow_axis + (HANDLE_SHADOW,)))
    out.append((("poly", handle_outline(w0, HANDLE_SPLIT_W)), ("linear",) + light_axis + (HANDLE_LIGHT,)))
    out.append((("circle", BUBBLE), ("solid", "#ffffff")))
    out.append((("poly", TAIL), ("solid", "#ffffff")))
    dot_radius = DOT_RADIUS * (1.3 if simple else 1.0)
    spread = 1.08 if simple else 1.0
    for x, y in DOTS:
        centre_x = DOTS[1][0] + (x - DOTS[1][0]) * spread
        out.append((("circle", (centre_x, y, dot_radius)), ("solid", DOT_COLOUR)))
    return out


# --- SVG -----------------------------------------------------------------------

def _fmt(value):
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text == "-0" else text


def svg(detailed=True):
    ox, oy, side = FULL_BOX if detailed else FAVICON_BOX
    k = VIEW / side

    def x(value):
        return _fmt((value - ox) * k)

    def y(value):
        return _fmt((value - oy) * k)

    def length(value):
        return _fmt(value * k)

    def stops(pairs):
        return "".join(f'<stop offset="{_fmt(o)}" stop-color="{c}"/>' for o, c in pairs)

    # Ids are prefixed per variant so both can be inlined in one page.
    prefix = "qm" if detailed else "qf"
    defs, body = [], []
    for index, (shape, paint) in enumerate(layers(simple=not detailed)):
        fill = paint[1] if paint[0] == "solid" else f"url(#{prefix}{index})"
        if paint[0] == "radial":
            (gx, gy, gr), pairs = paint[1], paint[2]
            defs.append(f'<radialGradient id="{prefix}{index}" gradientUnits="userSpaceOnUse" cx="{x(gx)}" '
                        f'cy="{y(gy)}" r="{length(gr)}">{stops(pairs)}</radialGradient>')
        elif paint[0] == "linear":
            (x1, y1), (x2, y2), pairs = paint[1], paint[2], paint[3]
            defs.append(f'<linearGradient id="{prefix}{index}" gradientUnits="userSpaceOnUse" x1="{x(x1)}" '
                        f'y1="{y(y1)}" x2="{x(x2)}" y2="{y(y2)}">{stops(pairs)}</linearGradient>')
        if shape[0] == "circle":
            sx, sy, sr = shape[1]
            body.append(f'<circle cx="{x(sx)}" cy="{y(sy)}" r="{length(sr)}" fill="{fill}"/>')
        else:
            points = " ".join(f"{x(px)},{y(py)}" for px, py in shape[1])
            body.append(f'<polygon points="{points}" fill="{fill}"/>')
    title = "Questor"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_fmt(VIEW)} {_fmt(VIEW)}" '
        f'role="img" aria-label="{title}">\n'
        f'<title>{title}</title>\n<defs>{"".join(defs)}</defs>\n' + "\n".join(body) + "\n</svg>\n"
    )


# --- raster --------------------------------------------------------------------

def _rgb(hex_colour):
    return np.array([int(hex_colour[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float64)


def _ramp(t, pairs):
    t = np.clip(t, 0.0, 1.0)
    offsets = np.array([o for o, _ in pairs])
    colours = np.array([_rgb(c) for _, c in pairs])
    return np.stack([np.interp(t, offsets, colours[:, i]) for i in range(3)], axis=-1)


def _paint(paint, gx, gy):
    if paint[0] == "solid":
        return np.broadcast_to(_rgb(paint[1]), gx.shape + (3,))
    if paint[0] == "radial":
        (cx, cy, r), pairs = paint[1], paint[2]
        return _ramp(np.hypot(gx - cx, gy - cy) / r, pairs)
    (x1, y1), (x2, y2), pairs = paint[1], paint[2], paint[3]
    dx, dy = x2 - x1, y2 - y1
    return _ramp(((gx - x1) * dx + (gy - y1) * dy) / (dx * dx + dy * dy), pairs)


def render(size, detailed=False, supersample=16):
    """Rasterise the mark to a transparent `size` square."""
    ox, oy, side = FULL_BOX if detailed else FAVICON_BOX
    big = size * supersample
    k = big / side
    ys, xs = np.mgrid[0:big, 0:big].astype(np.float64)
    gx, gy = ox + (xs + 0.5) / k, oy + (ys + 0.5) / k
    colour = np.zeros((big, big, 3))
    alpha = np.zeros((big, big))
    for shape, paint in layers(simple=not detailed):
        mask_image = Image.new("L", (big, big), 0)
        draw = ImageDraw.Draw(mask_image)
        if shape[0] == "circle":
            cx, cy, r = shape[1]
            draw.ellipse([(cx - r - ox) * k, (cy - r - oy) * k, (cx + r - ox) * k, (cy + r - oy) * k], fill=255)
        else:
            draw.polygon([((px - ox) * k, (py - oy) * k) for px, py in shape[1]], fill=255)
        cover = np.asarray(mask_image, dtype=np.float64) / 255.0
        paint_rgb = _paint(paint, gx, gy)
        # Premultiplied "over": colour already carries its coverage.
        colour = paint_rgb * cover[..., None] + colour * (1 - cover[..., None])
        alpha = cover + alpha * (1 - cover)
    small = np.dstack([colour, alpha]).reshape(size, supersample, size, supersample, 4).mean(axis=(1, 3))
    a = small[..., 3]
    rgb = small[..., :3] / np.maximum(a[..., None], 1e-9)
    pixels = np.dstack([rgb, a * 255.0]).round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(pixels, "RGBA")
