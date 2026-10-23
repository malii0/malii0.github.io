#!/usr/bin/env python3
"""One-time helper: inspect / optimize img/photos/*.jpg and fill width/height in data/photos.json.

Modes:
  (default)    Dry run. Prints size, dimensions, EXIF/GPS presence and what --apply would do.
  --dims-only  ONLY fills width/height (post-orientation) in data/photos.json. No image is touched.
  --apply      Backs up originals to ../photos-backup/ (outside the repo), then re-encodes
               (EXIF orientation applied, longest edge <= 2048 px, JPEG q85 optimized+progressive,
               ICC profile kept, no EXIF) and fills width/height as --dims-only does.

Requires Pillow: pip install Pillow
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageOps

REPO = Path(__file__).resolve().parent.parent
PHOTOS_DIR = REPO / "img" / "photos"
PHOTOS_JSON = REPO / "data" / "photos.json"
BACKUP_DIR = REPO.parent / "photos-backup"

MAX_EDGE = 2048
MAX_BYTES = 800 * 1024
QUALITY = 85
GPS_IFD = 0x8825
ORIENTATION = 0x0112


def has_real_gps(exif):
    """True only if the GPS IFD holds a non-empty, non-zero coordinate."""
    try:
        gps = exif.get_ifd(GPS_IFD)
    except Exception:
        return False
    if not gps:
        return False
    for tag in (2, 4):  # GPSLatitude, GPSLongitude
        val = gps.get(tag)
        if not val:
            return False
        try:
            if not any(float(v) != 0 for v in val):
                return False
        except (TypeError, ValueError):
            return False
    return True


def displayed_size(im, exif):
    w, h = im.size
    if exif.get(ORIENTATION, 1) in (5, 6, 7, 8):
        w, h = h, w
    return w, h


def inspect(path):
    with Image.open(path) as im:
        exif = im.getexif()
        w, h = displayed_size(im, exif)
        has_exif = bool(len(exif)) or bool(im.info.get("exif"))
        return {
            "size": path.stat().st_size,
            "width": w,
            "height": h,
            "exif": has_exif,
            "gps": has_real_gps(exif),
        }


def needs_work(info):
    return not (
        max(info["width"], info["height"]) <= MAX_EDGE
        and info["size"] <= MAX_BYTES
        and not info["exif"]
    )


def plan(info):
    if not needs_work(info):
        return "skip (already <= 2048 px, <= 800 KB, no EXIF)"
    steps = []
    if info["exif"]:
        steps.append("strip EXIF" + (" incl. GPS" if info["gps"] else ""))
    if max(info["width"], info["height"]) > MAX_EDGE:
        steps.append(f"resize to <= {MAX_EDGE}px")
    steps.append(f"re-encode q{QUALITY} progressive")
    return "; ".join(steps)


def fmt_kb(n):
    return f"{n / 1024:.0f} KB"


def optimize(path):
    with Image.open(path) as im:
        icc = im.info.get("icc_profile")
        out = ImageOps.exif_transpose(im)
        if out.mode not in ("RGB", "L"):
            out = out.convert("RGB")
        out.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        tmp = path.with_name(path.name + ".tmp")
        save_kwargs = dict(quality=QUALITY, optimize=True, progressive=True)
        if icc:
            save_kwargs["icc_profile"] = icc
        out.save(tmp, "JPEG", **save_kwargs)
    tmp.replace(path)


def load_entries():
    with open(PHOTOS_JSON, encoding="utf-8") as f:
        data = json.load(f)
    entries = []
    for item in data:
        if isinstance(item, str):
            item = {"filename": item}
        entries.append(
            {
                "filename": item.get("filename", ""),
                "alt": item.get("alt", ""),
                "location": item.get("location", ""),
                **{k: item[k] for k in ("width", "height") if k in item},
            }
        )
    return entries


def fill_dims():
    entries = load_entries()
    missing = 0
    for e in entries:
        path = PHOTOS_DIR / e["filename"]
        if not path.is_file():
            print(f"  ! {e['filename']}: file not found, dimensions not set")
            missing += 1
            continue
        with Image.open(path) as im:
            e["width"], e["height"] = displayed_size(im, im.getexif())
    with open(PHOTOS_JSON, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Updated {len(entries) - missing}/{len(entries)} entries in {PHOTOS_JSON}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--dims-only", action="store_true", help="only fill width/height in data/photos.json")
    group.add_argument("--apply", action="store_true", help="back up, optimize images and fill width/height")
    args = ap.parse_args()

    if args.dims_only:
        fill_dims()
        return

    files = sorted(PHOTOS_DIR.glob("*.jpg"))
    if not files:
        print("No JPEG files found in", PHOTOS_DIR)
        return

    if args.apply:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        for p in files:
            dest = BACKUP_DIR / p.name
            if not dest.exists():  # never overwrite an existing backup
                shutil.copy2(p, dest)
        print(f"Backed up originals to {BACKUP_DIR}")

    total_before = total_after = 0
    for p in files:
        info = inspect(p)
        before = info["size"]
        total_before += before
        line = (
            f"{p.name}: {fmt_kb(before)}, {info['width']}x{info['height']}, "
            f"EXIF={'yes' if info['exif'] else 'no'}, GPS={'YES' if info['gps'] else 'no'}"
        )
        if args.apply:
            if needs_work(info):
                optimize(p)
                after = p.stat().st_size
                line += f" -> optimized, {fmt_kb(after)}"
            else:
                after = before
                line += " -> skipped"
            total_after += after
        else:
            line += f"\n    would: {plan(info)}"
        print(line)

    if args.apply:
        print(f"Total: {fmt_kb(total_before)} -> {fmt_kb(total_after)}")
        fill_dims()
    else:
        n_exif = sum(1 for p in files if inspect(p)["exif"])
        n_gps = sum(1 for p in files if inspect(p)["gps"])
        print(f"\n{len(files)} files, {fmt_kb(total_before)} total, {n_exif} with EXIF, {n_gps} with real GPS.")
        print("Dry run only. Use --dims-only or --apply to make changes.")


if __name__ == "__main__":
    sys.exit(main())
