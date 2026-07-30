import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "apps" / "electron" / "assets"
ICONSET_DIR = ASSET_DIR / "app-icon.iconset"
WINDOWS_ICON_SCALE = 1.13


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def draw_app_icon(size: int) -> Image.Image:
    scale = size / 1024
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    margin = int(92 * scale)
    radius = int(190 * scale)
    shadow_draw.rounded_rectangle(
        (margin, margin + int(24 * scale), size - margin, size - margin + int(24 * scale)),
        radius=radius,
        fill=(20, 42, 34, 90),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(34 * scale)))
    image.alpha_composite(shadow)

    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = rounded_rect_mask(size - 2 * margin, radius)
    base = Image.new("RGBA", (size - 2 * margin, size - 2 * margin), (47, 89, 68, 255))
    base_draw = ImageDraw.Draw(base)
    for y in range(base.height):
        t = y / max(1, base.height - 1)
        r = int(82 * (1 - t) + 47 * t)
        g = int(124 * (1 - t) + 89 * t)
        b = int(103 * (1 - t) + 68 * t)
        base_draw.line((0, y, base.width, y), fill=(r, g, b, 255))

    grid = Image.new("RGBA", base.size, (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    step = int(88 * scale)
    for x in range(-base.height, base.width, step):
        grid_draw.line((x, base.height, x + base.height, 0), fill=(255, 255, 255, 18), width=max(1, int(3 * scale)))
    base.alpha_composite(grid)
    tile.paste(base, (margin, margin), mask)
    image.alpha_composite(tile)

    draw = ImageDraw.Draw(image)
    text = "VRC"
    text_font = font(int(238 * scale))
    bbox = draw.textbbox((0, 0), text, font=text_font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    draw.text(
        ((size - text_w) / 2, int(444 * scale) - text_h / 2),
        text,
        font=text_font,
        fill=(246, 250, 242, 255),
    )

    cursor_w = int(158 * scale)
    cursor_h = max(4, int(32 * scale))
    cursor_x = int(570 * scale)
    cursor_y = int(668 * scale)
    draw.rounded_rectangle(
        (cursor_x, cursor_y, cursor_x + cursor_w, cursor_y + cursor_h),
        radius=cursor_h // 2,
        fill=(246, 250, 242, 230),
    )

    return image


def draw_tray_icon(size: int) -> Image.Image:
    scale = 6
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pad = max(1, int(size * 0.12)) * scale
    rect = (pad, pad, canvas - pad, canvas - pad)
    radius = max(3, int(size * 0.2)) * scale
    draw.rounded_rectangle(rect, radius=radius, fill=(47, 89, 68, 255))

    label = "VRC"
    label_font = font(max(7, int(size * 0.32)) * scale)
    bbox = draw.textbbox((0, 0), label, font=label_font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    draw.text(
        ((canvas - text_w) / 2, int(canvas * 0.42) - text_h / 2),
        label,
        font=label_font,
        fill=(246, 250, 242, 255),
    )

    cursor_h = max(1, int(size * 0.08)) * scale
    cursor_w = max(4, int(size * 0.22)) * scale
    cursor_x = int(canvas * 0.58)
    cursor_y = int(canvas * 0.72)
    draw.rounded_rectangle(
        (cursor_x, cursor_y, cursor_x + cursor_w, cursor_y + cursor_h),
        radius=max(1, cursor_h // 2),
        fill=(246, 250, 242, 235),
    )
    return image.resize((size, size), Image.Resampling.LANCZOS)


def draw_macos_template_icon(size: int) -> Image.Image:
    """Render the macOS menu bar mark as a single-color VRC template image."""
    supersample = 8
    canvas = size * supersample
    unit = canvas / 18
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    outer = tuple(round(value * unit) for value in (1.4, 1.4, 16.6, 16.6))
    draw.rounded_rectangle(
        outer,
        radius=round(2.9 * unit),
        outline=(0, 0, 0, 255),
        width=max(1, round(0.8 * unit)),
    )

    glyph_width = max(1, round(1.0 * unit))
    glyph_color = (0, 0, 0, 255)
    glyph = lambda points: [(round(x * unit), round(y * unit)) for x, y in points]

    draw.line(glyph([(2.7, 6.1), (4.25, 10.8), (5.8, 6.1)]), fill=glyph_color, width=glyph_width, joint="curve")
    draw.line(glyph([(6.65, 10.8), (6.65, 6.1), (8.15, 6.1)]), fill=glyph_color, width=glyph_width)
    draw.arc(tuple(round(value * unit) for value in (6.45, 6.1, 9.85, 8.85)), 270, 90, fill=glyph_color, width=glyph_width)
    draw.line(glyph([(8.15, 8.55), (9.95, 10.8)]), fill=glyph_color, width=glyph_width)
    draw.arc(tuple(round(value * unit) for value in (10.35, 6.0, 15.25, 10.9)), 45, 315, fill=glyph_color, width=glyph_width)

    cursor = tuple(round(value * unit) for value in (10.35, 12.5, 13.9, 13.3))
    draw.rounded_rectangle(cursor, radius=max(1, round(0.4 * unit)), fill=(0, 0, 0, 255))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def optically_scale_icon(source: Image.Image, factor: float) -> Image.Image:
    """Increase the visible body while preserving the platform icon canvas size."""
    width, height = source.size
    scaled = source.resize((round(width * factor), round(height * factor)), Image.Resampling.LANCZOS)
    left = (scaled.width - width) // 2
    top = (scaled.height - height) // 2
    return scaled.crop((left, top, left + width, top + height))


def save_macos_template_svg() -> None:
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" role="img" aria-label="VRC">
  <rect x="1.4" y="1.4" width="15.2" height="15.2" rx="2.9" fill="none" stroke="#000" stroke-width="0.8"/>
  <g fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2.7 6.1 4.25 10.8 5.8 6.1"/>
    <path d="M6.65 10.8V6.1h1.5a1.45 1.38 0 0 1 0 2.75h-1.5m1.5-.3 1.8 2.25"/>
    <path d="M14.72 6.62a2.45 2.45 0 1 0 0 3.66"/>
  </g>
  <rect x="10.35" y="12.5" width="3.55" height="0.8" rx="0.4" fill="#000"/>
</svg>
"""
    (ASSET_DIR / "tray-template.svg").write_text(svg, encoding="ascii")


def save_iconset() -> None:
    ICONSET_DIR.mkdir(parents=True, exist_ok=True)
    specs = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    source = draw_app_icon(1024)
    for filename, size in specs:
        source.resize((size, size), Image.Resampling.LANCZOS).save(ICONSET_DIR / filename)
    source.save(ASSET_DIR / "app-icon-1024.png")
    windows_source = optically_scale_icon(source, WINDOWS_ICON_SCALE)
    windows_source.save(
        ASSET_DIR / "app-icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    subprocess.run(["iconutil", "-c", "icns", str(ICONSET_DIR), "-o", str(ASSET_DIR / "app-icon.icns")], check=True)


def save_tray() -> None:
    draw_tray_icon(18).save(ASSET_DIR / "tray.png")
    draw_tray_icon(36).save(ASSET_DIR / "tray@2x.png")
    save_macos_template_svg()
    draw_macos_template_icon(18).save(ASSET_DIR / "tray-template.png")
    draw_macos_template_icon(36).save(ASSET_DIR / "tray-template@2x.png")


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    save_iconset()
    save_tray()
    print(f"Generated Electron icons in {ASSET_DIR}")


if __name__ == "__main__":
    main()
