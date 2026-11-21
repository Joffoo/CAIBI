#!/usr/bin/env python3
"""
Deterministic local image inspection & objective comparison metrics (PIL + numpy only).
Usage:
  python metrics.py slice <image_path> <out_dir>
  python metrics.py compare <orig_path> <gen_path>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ExifTags


def _srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Convert uint8 RGB (..., 3) to CIE L*a*b*."""
    arr = rgb.astype(np.float64) / 255.0
    mask = arr > 0.04045
    lin = np.where(mask, ((arr + 0.055) / 1.055) ** 2.4, arr / 12.92)
    # sRGB D65 -> XYZ
    m = np.array([
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ])
    xyz = lin @ m.T
    xyz /= np.array([0.95047, 1.00000, 1.08883])
    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16.0) / 116.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def _luminance_stats(rgb: np.ndarray) -> dict:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    n = y.size or 1
    return {
        "shadows_pct": round(float(np.sum(y < 64) / n * 100), 1),
        "midtones_pct": round(float(np.sum((y >= 64) & (y <= 191)) / n * 100), 1),
        "highlights_pct": round(float(np.sum(y > 191) / n * 100), 1),
        "mean_y": round(float(np.mean(y)), 1),
        "std_dev": round(float(np.std(y)), 1),
    }


def _read_exif(img: Image.Image) -> dict:
    raw = img.getexif()
    if not raw:
        return {}
    wanted = {"Make", "Model", "LensModel", "FocalLength", "FNumber", "ISOSpeedRatings", "ExposureTime"}
    out = {}
    for tag_id, val in raw.items():
        name = ExifTags.TAGS.get(tag_id, str(tag_id))
        if name in wanted:
            out[name] = str(val)
    return out


def cmd_slice(img_path: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    img = Image.open(img_path)
    exif = _read_exif(img)
    rgb_img = img.convert("RGB")
    w, h = rgb_img.size

    # 3x3 crops
    cw, ch = max(1, w // 3), max(1, h // 3)
    crops = []
    for row in range(3):
        for col in range(3):
            x0, y0 = col * cw, row * ch
            x1 = w if col == 2 else (col + 1) * cw
            y1 = h if row == 2 else (row + 1) * ch
            crop = rgb_img.crop((x0, y0, x1, y1))
            out_file = out_dir / f"{img_path.stem}_r{row}_c{col}.jpg"
            crop.save(out_file, quality=92)
            crops.append(str(out_file))

    small = rgb_img.copy()
    small.thumbnail((100, 100))
    lum = _luminance_stats(np.asarray(small, dtype=np.float64))
    print(json.dumps({
        "file": str(img_path),
        "width": w,
        "height": h,
        "exif": exif,
        "luminance": lum,
        "crops": crops,
    }, ensure_ascii=False, indent=2))


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _sobel_mag(gray: np.ndarray) -> np.ndarray:
    gx = np.abs(gray[:, 2:] - gray[:, :-2])[1:-1, :]
    gy = np.abs(gray[2:, :] - gray[:-2, :])[:, 1:-1]
    return np.hypot(gx, gy).ravel()


def cmd_compare(orig_path: Path, gen_path: Path) -> None:
    orig = Image.open(orig_path).convert("RGB")
    gen = Image.open(gen_path).convert("RGB")

    # 1. Luminance distribution match (100px max edge, same as imagePhysics.ts)
    o_small = orig.copy()
    o_small.thumbnail((100, 100))
    g_small = gen.copy()
    g_small.thumbnail((100, 100))
    o_lum = _luminance_stats(np.asarray(o_small, dtype=np.float64))
    g_lum = _luminance_stats(np.asarray(g_small, dtype=np.float64))
    lum_diff = {
        "shadows_delta": round(abs(o_lum["shadows_pct"] - g_lum["shadows_pct"]), 1),
        "midtones_delta": round(abs(o_lum["midtones_pct"] - g_lum["midtones_pct"]), 1),
        "highlights_delta": round(abs(o_lum["highlights_pct"] - g_lum["highlights_pct"]), 1),
        "mean_y_delta": round(abs(o_lum["mean_y"] - g_lum["mean_y"]), 1),
        "std_dev_delta": round(abs(o_lum["std_dev"] - g_lum["std_dev"]), 1),
    }

    # 2. Spatial Lab & edge structure similarity (64x64 aligned)
    size = (64, 64)
    o_arr = np.asarray(orig.resize(size, Image.Resampling.BILINEAR), dtype=np.uint8)
    g_arr = np.asarray(gen.resize(size, Image.Resampling.BILINEAR), dtype=np.uint8)
    o_lab = _srgb_to_lab(o_arr)
    g_lab = _srgb_to_lab(g_arr)

    mean_delta_e = float(np.mean(np.linalg.norm(o_lab - g_lab, axis=-1)))
    global_lab_delta_e = float(np.linalg.norm(
        np.mean(o_lab.reshape(-1, 3), axis=0) - np.mean(g_lab.reshape(-1, 3), axis=0)
    ))

    o_gray = 0.2126 * o_arr[..., 0] + 0.7152 * o_arr[..., 1] + 0.0722 * o_arr[..., 2]
    g_gray = 0.2126 * g_arr[..., 0] + 0.7152 * g_arr[..., 1] + 0.0722 * g_arr[..., 2]
    edge_sim = _cosine(_sobel_mag(o_gray), _sobel_mag(g_gray))
    lab_cos = _cosine(o_lab.ravel(), g_lab.ravel())

    print(json.dumps({
        "orig": str(orig_path),
        "gen": str(gen_path),
        "orig_lum": o_lum,
        "gen_lum": g_lum,
        "lum_delta": lum_diff,
        "global_palette_delta_e": round(global_lab_delta_e, 2),
        "spatial_mean_delta_e": round(mean_delta_e, 2),
        "edge_structure_cosine": round(edge_sim, 4),
        "lab_cosine_similarity": round(lab_cos, 4),
    }, ensure_ascii=False, indent=2))


def main() -> None:
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "slice":
        cmd_slice(Path(sys.argv[2]), Path(sys.argv[3]))
    elif cmd == "compare":
        cmd_compare(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
