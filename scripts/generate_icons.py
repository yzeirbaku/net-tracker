"""Generate the PWA app-icons. One-shot script — re-run to refresh.

Produces two PNGs in `frontend/icons/`:
  - icon-192.png  (Android home-screen / general PWA)
  - icon-512.png  (high-DPI / Android splash / iOS where supported)

Design: brand-green vertical gradient (#16a34a → #22c55e) with a centered
white "$" glyph. Slight rounded-square mask so the icon reads as a "tile"
on Android home screens; iOS overrides corners with its own mask anyway.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_OUT_DIR = Path(__file__).resolve().parent.parent / "frontend" / "icons"
_TOP_COLOR = (52, 211, 153)        # #34d399 — lighter accent for the gradient top
_BOTTOM_COLOR = (22, 163, 74)      # #16a34a — primary brand green for the bottom
_GLYPH = "$"
_GLYPH_COLOR = (255, 255, 255)

# Sizes to emit (PWA manifest references these two).
_SIZES = (192, 512)

# Candidate font files to try, in order of preference. We want a bold, geometric
# face for the "$" so it reads cleanly at small sizes.
_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\segoeuib.ttf",         # Segoe UI Bold (Windows)
    r"C:\Windows\Fonts\arialbd.ttf",          # Arial Bold (Windows)
    "/System/Library/Fonts/SFNS.ttf",         # macOS
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    # Last-resort fallback — Pillow's bundled bitmap font. Worse-looking but
    # works on any platform.
    return ImageFont.load_default()


def _gradient(size: int) -> Image.Image:
    """Vertical gradient _TOP_COLOR (top) → _BOTTOM_COLOR (bottom)."""
    img = Image.new("RGB", (size, size), _BOTTOM_COLOR)
    pixels = img.load()
    assert pixels is not None
    for y in range(size):
        t = y / max(size - 1, 1)
        r = round(_TOP_COLOR[0] + (_BOTTOM_COLOR[0] - _TOP_COLOR[0]) * t)
        g = round(_TOP_COLOR[1] + (_BOTTOM_COLOR[1] - _TOP_COLOR[1]) * t)
        b = round(_TOP_COLOR[2] + (_BOTTOM_COLOR[2] - _TOP_COLOR[2]) * t)
        for x in range(size):
            pixels[x, y] = (r, g, b)
    return img


def _rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """Soft rounded-square alpha mask. Android home screens render the icon
    as-is, so we ship rounded corners ourselves; iOS applies its own mask."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = round(size * radius_ratio)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def render_icon(size: int) -> Image.Image:
    base = _gradient(size)
    mask = _rounded_mask(size)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(base, (0, 0), mask)

    # Pick a font size that fills ~62% of the canvas height with the "$" glyph.
    target_glyph_height = round(size * 0.62)
    font = _load_font(target_glyph_height)
    draw = ImageDraw.Draw(canvas)
    # textbbox returns ink bounds relative to the anchor — use it to center
    # the glyph optically (not just by its baseline).
    bbox = draw.textbbox((0, 0), _GLYPH, font=font)
    glyph_w = bbox[2] - bbox[0]
    glyph_h = bbox[3] - bbox[1]
    x = (size - glyph_w) // 2 - bbox[0]
    y = (size - glyph_h) // 2 - bbox[1]
    # Light drop shadow for a tiny bit of depth.
    shadow_offset = max(1, size // 96)
    draw.text(
        (x + shadow_offset, y + shadow_offset),
        _GLYPH,
        font=font,
        fill=(0, 0, 0, 60),
    )
    draw.text((x, y), _GLYPH, font=font, fill=_GLYPH_COLOR)
    return canvas


def main() -> None:
    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in _SIZES:
        icon = render_icon(size)
        out = _OUT_DIR / f"icon-{size}.png"
        icon.save(out, format="PNG", optimize=True)
        print(f"wrote {out} ({size}x{size})")


if __name__ == "__main__":
    main()
