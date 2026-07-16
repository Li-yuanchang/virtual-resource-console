#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "apps" / "chrome-extension" / "src" / "icons"
FONT_PATHS = [
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/System/Library/Fonts/Helvetica.ttc"),
]
NARROW_FONT_PATHS = [
    Path("/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf"),
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/System/Library/Fonts/Helvetica.ttc"),
]


def load_font(size: int, *, narrow: bool = False) -> ImageFont.FreeTypeFont:
    for path in NARROW_FONT_PATHS if narrow else FONT_PATHS:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def rounded_rectangle(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], radius: int, fill: tuple[int, int, int, int]) -> None:
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


def text_center(draw: ImageDraw.ImageDraw, center: tuple[int, int], text: str, font: ImageFont.FreeTypeFont, fill: tuple[int, int, int, int]) -> None:
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0]
    height = box[3] - box[1]
    x = center[0] - width / 2 - box[0]
    y = center[1] - height / 2 - box[1]
    draw.text((x, y), text, font=font, fill=fill)


def make_icon(size: int) -> Image.Image:
    scale = 6 if size <= 48 else 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    white = (246, 250, 242, 255)

    def s(value: float) -> int:
        return round(value * scale)

    margin = {16: 1.5, 32: 3.8, 48: 6.4, 128: 17.0}[size]
    radius = {16: 3.8, 32: 5.8, 48: 7.5, 128: 20.0}[size]
    rect = (s(margin), s(margin), s(size - margin), s(size - margin))
    rounded_rectangle(draw, rect, s(radius), (47, 96, 78, 255))

    base = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    base_draw = ImageDraw.Draw(base)
    for y_pos in range(s(margin), s(size - margin)):
        t = (y_pos - s(margin)) / max(1, s(size - 2 * margin))
        r = int(82 * (1 - t) + 47 * t)
        g = int(124 * (1 - t) + 89 * t)
        b = int(103 * (1 - t) + 68 * t)
        base_draw.line((s(margin), y_pos, s(size - margin), y_pos), fill=(r, g, b, 255))
    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle(rect, radius=s(radius), fill=255)
    image = Image.composite(base, image, mask)
    draw = ImageDraw.Draw(image)

    if size >= 48:
        step = s(size * 0.086)
        for x in range(-canvas, canvas, step):
            draw.line((x, canvas, x + canvas, 0), fill=(255, 255, 255, 18), width=max(1, s(size * 0.003)))

    font_size = {16: 5.6, 32: 9.2, 48: 13.2, 128: 30}[size] * scale
    font = load_font(font_size, narrow=size <= 32)
    y = {16: 7.4, 32: 13.6, 48: 20.8, 128: 60.0}[size] * scale
    text_center(draw, (canvas // 2, y), "VRC", font, white)

    if size >= 32:
        underline_width = {32: 4.6, 48: 7.0, 128: 19.0}[size]
        underline_height = 1 if size < 48 else 2 if size < 96 else 4
        underline_x = {32: 18.2, 48: 27.0, 128: 70.0}[size]
        underline_y = {32: 20.4, 48: 30.6, 128: 78.0}[size]
        draw.rounded_rectangle(
            (
                s(underline_x),
                s(underline_y),
                s(underline_x + underline_width),
                s(underline_y + underline_height),
            ),
            radius=s(max(0.5, underline_height / 2)),
            fill=(255, 255, 255, 235),
        )

    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        make_icon(size).save(ICON_DIR / f"vrc-{size}.png")


if __name__ == "__main__":
    main()
