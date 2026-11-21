#!/usr/bin/env python3
"""
Deterministic C-Prism physical dispersion logo & icon generator for 传彩笔 CAIBI.

Uses exact 2-interface Snell's Law refraction + Cauchy dispersion equation:
  n(lambda) = A + B / lambda^2
  n1 * sin(theta1) = n2(lambda) * sin(theta2)

Outputs:
  - assets/logo.svg
  - assets/logo-reference-1024.png
  - src/public/icon-128.png
  - src/public/icon-48.png
  - src/public/icon-16.png
"""
from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

# 1024x1024 normalized geometry of the 12-vertex faceted C optical crystal
V1 = (316.0, 293.0)
V2 = (174.0, 731.0)
V3 = (410.0, 175.0)
V4 = (670.0, 175.0)
V5 = (735.0, 255.0)
V6 = (655.0, 325.0)
V7 = (330.0, 325.0)
V8 = (480.0, 662.0)
V9 = (675.0, 662.0)
V10 = (745.0, 745.0)
V11 = (670.0, 835.0)
V12 = (275.0, 835.0)

C_POLYGON = [V1, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V2]
FACET_RIDGES = [
    (V1, V7),
    (V3, V7),
    (V4, V6),
    (V2, V8),
    (V12, V8),
    (V11, V9),
]
# Exact non-overlapping crystal facets partitioned by FACET_RIDGES
CRYSTAL_FACETS = [
    ([V1, V3, V7], "#202029"),
    ([V3, V4, V6, V7], "#1A1A22"),
    ([V4, V5, V6], "#252530"),
    ([V1, V7, V8, V2], "#111117"),
    ([V2, V8, V12], "#16161D"),
    ([V12, V8, V9, V11], "#1B1B23"),
    ([V9, V10, V11], "#22222C"),
]

# Optical parameters (Cauchy glass dispersion + Snell's law)
CAUCHY_A = 1.22
CAUCHY_B = 0.115
INC_ANG = math.radians(-14.0)
ENTRY_T = 0.25
INCIDENT_X_START = 72.0
EXIT_X_END = 936.0

# 5 dispersion bands matching K-Means k=5 color spectrum (sorted top -> bottom by wavelength)
SPECTRUM = [
    ("Red", 0.650, "#EF4444"),
    ("Amber", 0.558, "#EAB308"),
    ("Green", 0.502, "#22C55E"),
    ("Cyan", 0.463, "#06B6D4"),
    ("Violet", 0.433, "#8B5CF6"),
]


def hex_to_rgba(h: str, alpha: int = 255) -> tuple[int, int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def inward_right_normal_angle(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Return angle of normal pointing generally toward +x for downward segment a -> b."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    nx, ny = dy, -dx
    if nx < 0:
        nx, ny = -nx, -ny
    return math.atan2(ny, nx)


def intersect_ray_segment(
    origin: tuple[float, float],
    angle: float,
    seg_a: tuple[float, float],
    seg_b: tuple[float, float],
) -> tuple[float, float]:
    dx, dy = math.cos(angle), math.sin(angle)
    wx, wy = seg_b[0] - seg_a[0], seg_b[1] - seg_a[1]
    det = dx * (-wy) - dy * (-wx)
    if abs(det) < 1e-9:
        raise ValueError("Ray is parallel to prism exit interface")
    rx, ry = seg_a[0] - origin[0], seg_a[1] - origin[1]
    s = (rx * (-wy) - ry * (-wx)) / det
    return (origin[0] + s * dx, origin[1] + s * dy)


def compute_optical_rays() -> tuple[tuple[float, float], tuple[float, float], list[dict]]:
    """Compute exact P0 -> P1 -> P2 -> P3 ray coordinates via Snell's Law."""
    p1 = (
        V1[0] + ENTRY_T * (V2[0] - V1[0]),
        V1[1] + ENTRY_T * (V2[1] - V1[1]),
    )
    p0 = (
        INCIDENT_X_START,
        p1[1] - (p1[0] - INCIDENT_X_START) * math.tan(INC_ANG),
    )

    n1_ang = inward_right_normal_angle(V1, V2)
    n2_ang = inward_right_normal_angle(V7, V8)

    rays = []
    for name, wl, color in SPECTRUM:
        n = CAUCHY_A + CAUCHY_B / (wl ** 2)
        theta1_i = INC_ANG - n1_ang
        theta1_t = math.asin(math.sin(theta1_i) / n)
        ang1 = n1_ang + theta1_t

        p2 = intersect_ray_segment(p1, ang1, V7, V8)

        theta2_i = ang1 - n2_ang
        theta2_t = math.asin(n * math.sin(theta2_i))
        ang2 = n2_ang + theta2_t

        s_out = (EXIT_X_END - p2[0]) / math.cos(ang2)
        p3 = (EXIT_X_END, p2[1] + s_out * math.sin(ang2))

        rays.append(
            {
                "name": name,
                "wavelength_nm": round(wl * 1000),
                "color": color,
                "n": round(n, 4),
                "p2": p2,
                "p3": p3,
                "ang1_deg": round(math.degrees(ang1), 2),
                "ang2_deg": round(math.degrees(ang2), 2),
            }
        )
    return p0, p1, rays


def write_svg(out_path: Path, p0: tuple[float, float], p1: tuple[float, float], rays: list[dict]) -> None:
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in C_POLYGON)
    facets = "\n".join(
        f'  <polygon points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in poly)}" fill="{fill}" />'
        for poly, fill in CRYSTAL_FACETS
    )
    ridges = "\n".join(
        f'    <line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="#3F3F46" stroke-width="4" />'
        for a, b in FACET_RIDGES
    )
    internal_rays = "\n".join(
        f'    <line x1="{p1[0]:.1f}" y1="{p1[1]:.1f}" x2="{r["p2"][0]:.1f}" y2="{r["p2"][1]:.1f}" stroke="{r["color"]}" stroke-opacity="0.78" stroke-width="5" stroke-linecap="round" />'
        for r in rays
    )
    exit_glows = "\n".join(
        f'    <line x1="{r["p2"][0]:.1f}" y1="{r["p2"][1]:.1f}" x2="{r["p3"][0]:.1f}" y2="{r["p3"][1]:.1f}" stroke="{r["color"]}" stroke-opacity="0.28" stroke-width="26" stroke-linecap="round" />'
        for r in rays
    )
    exit_cores = "\n".join(
        f'    <line x1="{r["p2"][0]:.1f}" y1="{r["p2"][1]:.1f}" x2="{r["p3"][0]:.1f}" y2="{r["p3"][1]:.1f}" stroke="{r["color"]}" stroke-width="11" stroke-linecap="round" />'
        for r in rays
    )
    exit_dots = "\n".join(
        f'    <circle cx="{r["p2"][0]:.1f}" cy="{r["p2"][1]:.1f}" r="5.5" fill="{r["color"]}" />'
        for r in rays
    )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <filter id="beamGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <!-- Swiss brutalist obsidian base + 1px hairline border -->
  <rect x="0" y="0" width="1024" height="1024" fill="#09090B" />
  <rect x="24" y="24" width="976" height="976" fill="none" stroke="#27272A" stroke-width="6" />

  <!-- Soft spectrum bloom behind exit rays -->
  <g filter="url(#beamGlow)">
{exit_glows}
  </g>

  <!-- Faceted C-Prism crystal facets & ridges -->
{facets}
  <g>
{ridges}
  </g>

  <!-- Internal Cauchy dispersion fan (P1 -> P2) -->
  <g>
{internal_rays}
  </g>

  <!-- Incident white light beam (P0 -> P1) -->
  <line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p1[0]:.1f}" y2="{p1[1]:.1f}" stroke="#FAFAFA" stroke-opacity="0.25" stroke-width="28" stroke-linecap="round" />
  <line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p1[0]:.1f}" y2="{p1[1]:.1f}" stroke="#FAFAFA" stroke-width="14" stroke-linecap="round" />

  <!-- Crisp crystal outline over ray intersection -->
  <polygon points="{pts}" fill="none" stroke="#FAFAFA" stroke-width="14" stroke-linejoin="miter" />

  <!-- Exiting Snell-refracted 5-color spectrum beams (P2 -> P3) -->
  <g>
{exit_cores}
  </g>

  <!-- Refraction interface nodes -->
  <circle cx="{p1[0]:.1f}" cy="{p1[1]:.1f}" r="9" fill="#FAFAFA" />
  <g>
{exit_dots}
  </g>
</svg>
"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(svg, encoding="utf-8")


def render_png(
    out_path: Path,
    target_size: int,
    c_boost: float,
    ray_boost: float,
    p0: tuple[float, float],
    p1: tuple[float, float],
    rays: list[dict],
) -> None:
    """Render on a 2048x2048 supersampled canvas with LOD stroke scaling, then LANCZOS downsample."""
    S = 2048
    k = S / 1024.0
    sc = lambda pt: (pt[0] * k, pt[1] * k)
    sc_poly = lambda pts: [sc(p) for p in pts]

    img = Image.new("RGBA", (S, S), hex_to_rgba("#09090B"))

    # Soft optical bloom on beams for >=128px sizes; keep small icons razor-sharp without haze
    if target_size >= 128:
        glow_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        glow_draw = ImageDraw.Draw(glow_layer)
        bloom_w = max(4, round(26 * k * ray_boost))
        inc_bloom_w = max(4, round(28 * k * ray_boost))
        glow_draw.line([sc(p0), sc(p1)], fill=hex_to_rgba("#FAFAFA", 90), width=inc_bloom_w)
        for r in rays:
            glow_draw.line(
                [sc(r["p2"]), sc(r["p3"])],
                fill=hex_to_rgba(r["color"], 110),
                width=bloom_w,
            )
        glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=round(16 * k)))
        img = Image.alpha_composite(img, glow_layer)

    draw = ImageDraw.Draw(img)

    if target_size >= 48:
        bw = max(2, round(6 * k * min(c_boost, 1.3)))
        m = round(24 * k)
        draw.rectangle([m, m, S - m, S - m], outline=hex_to_rgba("#27272A"), width=bw)

    if target_size <= 16:
        # 16x16 toolbar LOD: solid high-contrast white C-prism silhouette + crisp 5-color spectrum fan
        draw.polygon(sc_poly(C_POLYGON), fill=hex_to_rgba("#FAFAFA"))
        # Subtle dark optical glass chamber on the left prism wedge so incident -> exit stays readable
        draw.polygon(sc_poly([V1, V7, V8, V2]), fill=hex_to_rgba("#27272A"))
        c_stroke = max(4, round(14 * k * c_boost))
        c_pts = sc_poly(C_POLYGON)
        draw.line(c_pts + [c_pts[0]], fill=hex_to_rgba("#FAFAFA"), width=c_stroke, joint="curve")
    else:
        # Faceted crystal fill
        for poly, fill in CRYSTAL_FACETS:
            draw.polygon(sc_poly(poly), fill=hex_to_rgba(fill))
        if target_size >= 128:
            ridge_w = max(2, round(4 * k))
            for a, b in FACET_RIDGES:
                draw.line([sc(a), sc(b)], fill=hex_to_rgba("#3F3F46"), width=ridge_w)

        # Internal dispersion fan (P1 -> P2)
        int_w = max(2, round(5.5 * k * ray_boost))
        for r in rays:
            draw.line([sc(p1), sc(r["p2"])], fill=hex_to_rgba(r["color"], 215), width=int_w)

        # Crisp C crystal border
        c_stroke = max(4, round(14 * k * c_boost))
        c_pts = sc_poly(C_POLYGON)
        draw.line(c_pts + [c_pts[0]], fill=hex_to_rgba("#FAFAFA"), width=c_stroke, joint="curve")

    # Incident white beam (P0 -> P1)
    inc_w = max(4, round(14 * k * ray_boost))
    draw.line([sc(p0), sc(p1)], fill=hex_to_rgba("#FAFAFA"), width=inc_w)

    # Exiting 5-color spectrum rays (P2 -> P3)
    exit_w = max(4, round(11 * k * ray_boost))
    for r in rays:
        draw.line([sc(r["p2"]), sc(r["p3"])], fill=hex_to_rgba(r["color"]), width=exit_w)

    # Refraction interface hotspots
    if target_size >= 48:
        rad1 = max(3, round(9 * k * min(ray_boost, 1.35)))
        p1s = sc(p1)
        draw.ellipse([p1s[0] - rad1, p1s[1] - rad1, p1s[0] + rad1, p1s[1] + rad1], fill=hex_to_rgba("#FAFAFA"))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    resized = img.resize((target_size, target_size), Image.Resampling.LANCZOS)
    resized.convert("RGB").save(out_path, format="PNG", optimize=True)


def main() -> None:
    p0, p1, rays = compute_optical_rays()
    print("Computed C-Prism Snell/Cauchy rays:")
    print(f"  Incident: P0={p0} -> P1={p1}")
    for r in rays:
        print(
            f"  {r['name']:6s} ({r['wavelength_nm']}nm, n={r['n']:.3f}): "
            f"in={r['ang1_deg']:+.2f} deg -> P2=({r['p2'][0]:.1f},{r['p2'][1]:.1f}) "
            f"-> out={r['ang2_deg']:+.2f} deg -> P3=({r['p3'][0]:.1f},{r['p3'][1]:.1f})"
        )

    write_svg(ROOT / "assets" / "logo.svg", p0, p1, rays)
    render_png(ROOT / "assets" / "logo-reference-1024.png", 1024, 1.0, 1.0, p0, p1, rays)
    render_png(ROOT / "src" / "public" / "icon-128.png", 128, 1.2, 1.2, p0, p1, rays)
    render_png(ROOT / "src" / "public" / "icon-48.png", 48, 1.7, 1.6, p0, p1, rays)
    render_png(ROOT / "src" / "public" / "icon-16.png", 16, 2.6, 2.8, p0, p1, rays)
    print("Generated assets/logo.svg, assets/logo-reference-1024.png, src/public/icon-{128,48,16}.png")


if __name__ == "__main__":
    main()
