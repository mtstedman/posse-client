#!/usr/bin/env python3
"""Image conversion and processing tool.

Usage:
    python tools/convert_image.py <input> <output> [options]
    python tools/convert_image.py batch <input_dir> <output_dir> --to png [options]

Supported formats: PNG, JPG/JPEG, WEBP, GIF, BMP, TIFF, ICO

Options:
    --resize WxH        Resize to exact dimensions (e.g. 800x600)
    --max-size N        Resize longest side to N pixels, preserving aspect ratio
    --quality N         JPEG/WEBP quality 1-100 (default: 85)
    --to FORMAT         Target format for batch conversion
    --strip-metadata    Remove EXIF/metadata
    --background COLOR  Background color for transparent->opaque (e.g. white, #FF0000)
    --grayscale         Convert to grayscale
    --thumbnail N       Create square thumbnail of N pixels
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    print("Error: Pillow not installed. Run: pip install Pillow", file=sys.stderr)
    sys.exit(1)


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".ico"}


def convert_image(src, dst, resize=None, max_size=None, quality=85,
                  strip_metadata=False, background=None, grayscale=False, thumbnail=None):
    img = Image.open(src)

    # Handle animated GIFs — only process first frame for format conversion
    if getattr(img, "is_animated", False) and dst.suffix.lower() != ".gif":
        img.seek(0)

    # Apply transformations
    if thumbnail:
        img = ImageOps.fit(img, (thumbnail, thumbnail), method=Image.LANCZOS)
    elif resize:
        w, h = resize
        img = img.resize((w, h), Image.LANCZOS)
    elif max_size:
        img.thumbnail((max_size, max_size), Image.LANCZOS)

    if grayscale:
        img = ImageOps.grayscale(img)

    # Handle transparency for formats that don't support it
    dst_ext = dst.suffix.lower()
    if dst_ext in (".jpg", ".jpeg", ".bmp") and img.mode in ("RGBA", "LA", "PA"):
        bg_color = background or "white"
        bg = Image.new("RGB", img.size, bg_color)
        if img.mode == "RGBA":
            bg.paste(img, mask=img.split()[3])
        else:
            bg.paste(img)
        img = bg
    elif background and img.mode in ("RGBA", "LA", "PA"):
        bg = Image.new("RGBA", img.size, background)
        bg.paste(img, mask=img.split()[-1])
        img = bg

    # Convert mode for compatibility
    if dst_ext in (".jpg", ".jpeg") and img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    # Strip metadata
    if strip_metadata:
        data = list(img.getdata())
        clean = Image.new(img.mode, img.size)
        clean.putdata(data)
        img = clean

    # Save with format-specific options
    save_kwargs = {}
    if dst_ext in (".jpg", ".jpeg"):
        save_kwargs["quality"] = quality
        save_kwargs["optimize"] = True
    elif dst_ext == ".webp":
        save_kwargs["quality"] = quality
        save_kwargs["method"] = 4
    elif dst_ext == ".png":
        save_kwargs["optimize"] = True

    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(dst), **save_kwargs)

    # Report
    src_size = src.stat().st_size
    dst_size = dst.stat().st_size
    ratio = dst_size / src_size * 100 if src_size > 0 else 0
    print(f"{src} -> {dst}  ({_fmt_size(src_size)} -> {_fmt_size(dst_size)}, {ratio:.0f}%)")
    return dst


def batch_convert(src_dir, dst_dir, target_format, **kwargs):
    src_dir = Path(src_dir)
    dst_dir = Path(dst_dir)
    dst_dir.mkdir(parents=True, exist_ok=True)

    target_ext = f".{target_format.lstrip('.')}"
    converted = 0

    for f in sorted(src_dir.iterdir()):
        if f.suffix.lower() in IMAGE_EXTENSIONS:
            out = dst_dir / f"{f.stem}{target_ext}"
            try:
                convert_image(f, out, **kwargs)
                converted += 1
            except Exception as e:
                print(f"  Error: {f.name}: {e}", file=sys.stderr)

    print(f"\nBatch complete: {converted} image(s) converted to {target_ext}")


def get_info(path):
    """Print image metadata."""
    img = Image.open(path)
    info = {
        "path": str(path),
        "format": img.format,
        "mode": img.mode,
        "size": {"width": img.width, "height": img.height},
        "file_size": _fmt_size(path.stat().st_size),
        "animated": getattr(img, "is_animated", False),
    }
    if hasattr(img, "n_frames"):
        info["frames"] = img.n_frames

    # EXIF
    exif = img.getexif()
    if exif:
        info["exif_tags"] = len(exif)

    import json
    print(json.dumps(info, indent=2))


def _fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def _parse_resize(s):
    parts = s.lower().split("x")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"Invalid resize format: {s} (expected WxH)")
    return (int(parts[0]), int(parts[1]))


def _normalize_argv(argv):
    subcommands = {"convert", "batch", "info"}
    if argv and argv[0] not in subcommands and not argv[0].startswith("-"):
        return ["convert", *argv]
    return argv


def main(argv=None):
    argv = _normalize_argv(list(sys.argv[1:] if argv is None else argv))
    parser = argparse.ArgumentParser(description="Image conversion and processing")
    sub = parser.add_subparsers(dest="command")

    # Single file conversion (default)
    conv = sub.add_parser("convert", help="Convert a single image")
    conv.add_argument("input", help="Input image path")
    conv.add_argument("output", help="Output image path")

    # Batch conversion
    batch = sub.add_parser("batch", help="Batch convert a directory")
    batch.add_argument("input_dir", help="Input directory")
    batch.add_argument("output_dir", help="Output directory")
    batch.add_argument("--to", required=True, help="Target format (png, jpg, webp, etc.)")

    # Info
    info = sub.add_parser("info", help="Show image info")
    info.add_argument("input", help="Image file path")

    # Shared options (add to all subparsers)
    for p in (conv, batch):
        p.add_argument("--resize", type=_parse_resize, help="Resize to WxH")
        p.add_argument("--max-size", type=int, help="Max dimension (preserves aspect ratio)")
        p.add_argument("--quality", type=int, default=85, help="Quality 1-100 (default: 85)")
        p.add_argument("--strip-metadata", action="store_true", help="Remove EXIF data")
        p.add_argument("--background", help="Background color for transparency")
        p.add_argument("--grayscale", action="store_true", help="Convert to grayscale")
        p.add_argument("--thumbnail", type=int, help="Square thumbnail size in pixels")

    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    if args.command == "info":
        path = Path(args.input)
        if not path.exists():
            print(f"Error: file not found: {path}", file=sys.stderr)
            sys.exit(1)
        get_info(path)
        return

    if args.command == "batch":
        src_dir = Path(args.input_dir)
        if not src_dir.is_dir():
            print(f"Error: not a directory: {src_dir}", file=sys.stderr)
            sys.exit(1)
        batch_convert(
            src_dir, args.output_dir, args.to,
            resize=args.resize, max_size=args.max_size, quality=args.quality,
            strip_metadata=args.strip_metadata, background=args.background,
            grayscale=args.grayscale, thumbnail=args.thumbnail,
        )
        return

    # convert
    src = Path(args.input)
    dst = Path(args.output)
    if not src.exists():
        print(f"Error: file not found: {src}", file=sys.stderr)
        sys.exit(1)

    try:
        convert_image(
            src, dst,
            resize=args.resize, max_size=args.max_size, quality=args.quality,
            strip_metadata=args.strip_metadata, background=args.background,
            grayscale=args.grayscale, thumbnail=args.thumbnail,
        )
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
