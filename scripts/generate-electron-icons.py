from pathlib import Path
import math
import subprocess

from PIL import Image, ImageDraw, ImageFont, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "apps" / "electron" / "assets"
ICONSET_DIR = ASSET_DIR / "app-icon.iconset"


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
    margin = int(106 * scale)
    radius = int(178 * scale)
    shadow_draw.rounded_rectangle(
        (margin, margin + int(22 * scale), size - margin, size - margin + int(22 * scale)),
        radius=radius,
        fill=(20, 42, 34, 90),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(34 * scale)))
    image.alpha_composite(shadow)

    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = rounded_rect_mask(size - 2 * margin, radius)
    base = Image.new("RGBA", (size - 2 * margin, size - 2 * margin), (47, 96, 78, 255))
    base_draw = ImageDraw.Draw(base)
    for y in range(base.height):
        t = y / max(1, base.height - 1)
        r = int(57 * (1 - t) + 35 * t)
        g = int(118 * (1 - t) + 82 * t)
        b = int(96 * (1 - t) + 67 * t)
        base_draw.line((0, y, base.width, y), fill=(r, g, b, 255))

    grid = Image.new("RGBA", base.size, (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    step = int(92 * scale)
    for x in range(-base.height, base.width, step):
        grid_draw.line((x, base.height, x + base.height, 0), fill=(255, 255, 255, 22), width=max(1, int(3 * scale)))
    base.alpha_composite(grid)

    ring_draw = ImageDraw.Draw(base)
    ring_draw.rounded_rectangle(
        (int(34 * scale), int(34 * scale), base.width - int(34 * scale), base.height - int(34 * scale)),
        radius=int(142 * scale),
        outline=(232, 244, 235, 82),
        width=max(2, int(8 * scale)),
    )
    tile.paste(base, (margin, margin), mask)
    image.alpha_composite(tile)

    draw = ImageDraw.Draw(image)
    text = "VRC"
    text_font = font(int(190 * scale))
    bbox = draw.textbbox((0, 0), text, font=text_font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    draw.text(
        ((size - text_w) / 2, int(434 * scale) - text_h / 2),
        text,
        font=text_font,
        fill=(246, 250, 242, 255),
    )

    cursor_w = int(148 * scale)
    cursor_h = max(4, int(18 * scale))
    cursor_x = int(548 * scale)
    cursor_y = int(626 * scale)
    draw.rounded_rectangle(
        (cursor_x, cursor_y, cursor_x + cursor_w, cursor_y + cursor_h),
        radius=cursor_h // 2,
        fill=(246, 250, 242, 230),
    )

    return image


def draw_tray_icon(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pad = max(1, int(size * 0.08))
    rect = (pad, pad, size - pad, size - pad)
    radius = max(3, int(size * 0.22))
    draw.rounded_rectangle(rect, radius=radius, fill=(47, 96, 78, 255), outline=(218, 234, 224, 150), width=max(1, size // 18))

    label = "VRC"
    label_font = font(max(7, int(size * 0.34)))
    bbox = draw.textbbox((0, 0), label, font=label_font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    draw.text(
        ((size - text_w) / 2, int(size * 0.48) - text_h / 2),
        label,
        font=label_font,
        fill=(246, 250, 242, 255),
    )

    cursor_h = max(1, int(size * 0.08))
    cursor_w = max(4, int(size * 0.28))
    cursor_x = int(size * 0.52)
    cursor_y = int(size * 0.68)
    draw.rounded_rectangle(
        (cursor_x, cursor_y, cursor_x + cursor_w, cursor_y + cursor_h),
        radius=max(1, cursor_h // 2),
        fill=(246, 250, 242, 235),
    )
    return image


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
    source.save(
        ASSET_DIR / "app-icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    subprocess.run(["iconutil", "-c", "icns", str(ICONSET_DIR), "-o", str(ASSET_DIR / "app-icon.icns")], check=True)


def save_tray() -> None:
    draw_tray_icon(18).save(ASSET_DIR / "tray.png")
    draw_tray_icon(36).save(ASSET_DIR / "tray@2x.png")


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    save_iconset()
    save_tray()
    print(f"Generated Electron icons in {ASSET_DIR}")


if __name__ == "__main__":
    main()
