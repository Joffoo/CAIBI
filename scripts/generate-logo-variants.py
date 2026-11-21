#!/usr/bin/env python3
"""
Generate Direction A (Swiss micro-textured geometric vector with rounded transparent-corner badge)
and post-process Direction B (3D optical render) into the same rounded transparent-corner format.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from importlib.machinery import SourceFileLoader

gen_icons = SourceFileLoader("gen_icons", str(ROOT / "scripts" / "generate-icons.py")).load_module()

V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12 = (
    gen_icons.V1,
    gen_icons.V2,
    gen_icons.V3,
    gen_icons.V4,
    gen_icons.V5,
    gen_icons.V6,
    gen_icons.V7,
    gen_icons.V8,
    gen_icons.V9,
    gen_icons.V10,
    gen_icons.V11,
    gen_icons.V12,
)
C_POLYGON = gen_icons.C_POLYGON
FACET_RIDGES = gen_icons.FACET_RIDGES
hex_to_rgba = gen_icons.hex_to_rgba

# Higher-contrast Swiss geometric facets so the C shape reads boldly on dark obsidian
SWISS_FACETS = [
    ([V1, V3, V7], "#2E2E3A"),
    ([V3, V4, V6, V7], "#262630"),
    ([V4, V5, V6], "#343442"),
    ([V1, V7, V8, V2], "#17171F"),
    ([V2, V8, V12], "#1F1F28"),
    ([V12, V8, V9, V11], "#272732"),
    ([V9, V10, V11], "#31313E"),
]


def rounded_rect_mask(size: int, margin: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([margin, margin, size - margin, size - margin], radius=radius, fill=255)
    return mask


def generate_direction_a() -> None:
    p0, p1, rays = gen_icons.compute_optical_rays()

    # 1. Write Direction A SVG (rounded obsidian badge + higher-contrast facets + gradient fading rays)
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in C_POLYGON)
    facets = "\n".join(
        f'    <polygon points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in poly)}" fill="{fill}" />'
        for poly, fill in SWISS_FACETS
    )
    ridges = "\n".join(
        f'    <line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="#52525B" stroke-width="3.5" />'
        for a, b in FACET_RIDGES
    )
    ray_grads = []
    exit_lines = []
    internal_lines = []
    for i, r in enumerate(rays):
        gid = f"rayGrad{i}"
        ray_grads.append(
            f'    <linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
            f'x1="{r["p2"][0]:.1f}" y1="{r["p2"][1]:.1f}" x2="{r["p3"][0]:.1f}" y2="{r["p3"][1]:.1f}">\n'
            f'      <stop offset="0%" stop-color="{r["color"]}" stop-opacity="1" />\n'
            f'      <stop offset="68%" stop-color="{r["color"]}" stop-opacity="0.95" />\n'
            f'      <stop offset="100%" stop-color="{r["color"]}" stop-opacity="0.08" />\n'
            f'    </linearGradient>'
        )
        internal_lines.append(
            f'    <line x1="{p1[0]:.1f}" y1="{p1[1]:.1f}" x2="{r["p2"][0]:.1f}" y2="{r["p2"][1]:.1f}" '
            f'stroke="{r["color"]}" stroke-opacity="0.82" stroke-width="5" stroke-linecap="round" />'
        )
        exit_lines.append(
            f'    <line x1="{r["p2"][0]:.1f}" y1="{r["p2"][1]:.1f}" x2="{r["p3"][0]:.1f}" y2="{r["p3"][1]:.1f}" '
            f'stroke="url(#{gid})" stroke-width="11" stroke-linecap="round" />'
        )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="incGrad" gradientUnits="userSpaceOnUse" x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p1[0]:.1f}" y2="{p1[1]:.1f}">
      <stop offset="0%" stop-color="#FAFAFA" stop-opacity="0.18" />
      <stop offset="35%" stop-color="#FAFAFA" stop-opacity="0.92" />
      <stop offset="100%" stop-color="#FAFAFA" stop-opacity="1" />
    </linearGradient>
{chr(10).join(ray_grads)}
  </defs>

  <!-- Rounded obsidian badge with transparent corners -->
  <rect x="32" y="32" width="960" height="960" rx="208" ry="208" fill="#09090B" stroke="#27272A" stroke-width="6" />

  <!-- High-contrast Swiss geometric C-prism -->
{facets}
{chr(10).join(ridges)}

  <!-- Internal Cauchy dispersion fan -->
{chr(10).join(internal_lines)}

  <!-- Incident beam fading in from left -->
  <line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p1[0]:.1f}" y2="{p1[1]:.1f}" stroke="url(#incGrad)" stroke-width="14" stroke-linecap="round" />

  <!-- Crisp geometric C outline -->
  <polygon points="{pts}" fill="none" stroke="#FAFAFA" stroke-width="13" stroke-linejoin="miter" />

  <!-- Exiting 5-color spectrum beams with smooth optical fade -->
{chr(10).join(exit_lines)}

  <circle cx="{p1[0]:.1f}" cy="{p1[1]:.1f}" r="8" fill="#FAFAFA" />
</svg>
"""
    (ROOT / "assets" / "logo-style-a.svg").write_text(svg, encoding="utf-8")

    # 2. Render Direction A 1024x1024 PNG with transparent rounded corners & smooth fading rays
    S = 2048
    k = S / 1024.0
    sc = lambda pt: (pt[0] * k, pt[1] * k)
    sc_poly = lambda pts: [sc(p) for p in pts]

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    badge = Image.new("RGBA", (S, S), hex_to_rgba("#09090B"))
    bdraw = ImageDraw.Draw(badge)

    for poly, fill in SWISS_FACETS:
        bdraw.polygon(sc_poly(poly), fill=hex_to_rgba(fill))
    for a, b in FACET_RIDGES:
        bdraw.line([sc(a), sc(b)], fill=hex_to_rgba("#52525B"), width=round(3.5 * k))

    for r in rays:
        bdraw.line([sc(p1), sc(r["p2"])], fill=hex_to_rgba(r["color"], 215), width=round(5 * k))

    c_pts = sc_poly(C_POLYGON)
    bdraw.line(c_pts + [c_pts[0]], fill=hex_to_rgba("#FAFAFA"), width=round(13 * k), joint="curve")

    # Draw gradient-fading beams onto a separate transparent layer and alpha-composite onto badge
    beam_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    beam_draw = ImageDraw.Draw(beam_layer)
    steps = 48
    # Incident beam (fade in from 18% -> 100%)
    for s_idx in range(steps):
        t0, t1 = s_idx / steps, (s_idx + 1) / steps
        a = int(255 * (0.18 + 0.82 * min(1.0, t0 / 0.4)))
        x0 = p0[0] + t0 * (p1[0] - p0[0])
        y0 = p0[1] + t0 * (p1[1] - p0[1])
        x1 = p0[0] + t1 * (p1[0] - p0[0])
        y1 = p0[1] + t1 * (p1[1] - p0[1])
        beam_draw.line([sc((x0, y0)), sc((x1, y1))], fill=hex_to_rgba("#FAFAFA", a), width=round(14 * k))

    # Exiting beams (100% -> 8% fade out)
    for r in rays:
        p2, p3 = r["p2"], r["p3"]
        col = hex_to_rgba(r["color"])[:3]
        for s_idx in range(steps):
            t0, t1 = s_idx / steps, (s_idx + 1) / steps
            alpha_f = 1.0 if t0 < 0.55 else max(0.06, 1.0 - (t0 - 0.55) / 0.45 * 0.94)
            x0 = p2[0] + t0 * (p3[0] - p2[0])
            y0 = p2[1] + t0 * (p3[1] - p2[1])
            x1 = p2[0] + t1 * (p3[0] - p2[0])
            y1 = p2[1] + t1 * (p3[1] - p2[1])
            beam_draw.line([sc((x0, y0)), sc((x1, y1))], fill=(*col, int(255 * alpha_f)), width=round(11 * k))

    badge = Image.alpha_composite(badge, beam_layer)
    bdraw = ImageDraw.Draw(badge)

    p1s = sc(p1)
    rad = round(8 * k)
    bdraw.ellipse([p1s[0] - rad, p1s[1] - rad, p1s[0] + rad, p1s[1] + rad], fill=hex_to_rgba("#FAFAFA"))

    # Hairline border around rounded badge
    m = round(32 * k)
    rad_box = round(208 * k)
    bdraw.rounded_rectangle([m, m, S - m, S - m], radius=rad_box, outline=hex_to_rgba("#27272A"), width=round(6 * k))

    mask = rounded_rect_mask(S, m, rad_box)
    img.paste(badge, (0, 0), mask)
    img.resize((1024, 1024), Image.Resampling.LANCZOS).save(
        ROOT / "assets" / "logo-style-a.png", format="PNG", optimize=True
    )
    print("Generated assets/logo-style-a.svg and assets/logo-style-a.png")


def apply_rounded_badge(src_path: Path, out_path: Path) -> None:
    im = Image.open(src_path).convert("RGBA").resize((1024, 1024), Image.Resampling.LANCZOS)
    m = 32
    rad = 208
    out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    mask = rounded_rect_mask(1024, m, rad)
    out.paste(im, (0, 0), mask)
    d = ImageDraw.Draw(out)
    d.rounded_rectangle([m, m, 1024 - m, 1024 - m], radius=rad, outline=(39, 39, 42, 255), width=4)
    out.save(out_path, format="PNG", optimize=True)
    print(f"Saved rounded transparent badge -> {out_path}")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--round":
        apply_rounded_badge(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        generate_direction_a()
