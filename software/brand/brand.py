# brand.py - the TAKTO logo, generated from one geometric spec so the SVGs
# (web, console, AR) and the PNG icons (web touch icons, Expo app) never drift
# apart. Run from anywhere:  python3 software/brand/brand.py
# Scope (owner's call): the website, the companion app and the AR experience.
# The watch face keeps its own boot mark: that is firmware, and the web's
# device-screen twin mirrors the firmware pixel for pixel.
#
# Round 3 (2026-10-01). The owner found the finger-T "hard to understand,
# especially when small": at favicon size it read as a "!". So the logo is now
# plain type and one point:
#   LOGO  "TAKTO." - bold geometric capitals (the cut of the product page's
#         giant hero word) closed by a sapphire period: the point of touch.
#         The owner's own reference sets its wordmark the same way ("harmony.").
#   MARK  "T." - the logo's own first letter and its period. Bare on pages,
#         white on an ink tile for favicons, light for app icons.
import math, os, re
from PIL import Image, ImageDraw

INK, ACCENT = "#111418", "#2F76BF"
INK_D, ACCENT_D = "#F3F6FA", "#5BA8F5"
TILE_DOT = "#5BA8F5"            # the period on the ink tile: brighter, so it holds on ink
AR_INK, AR_DOT = "#D9EDFF", "#66B8FF"   # the AR veil: pale on its night sky

# ---------------- wordmark: geometric capitals ----------------
H, SW, TR = 100.0, 19.0, 24.0           # cap height, stroke, tracking
DOT_R = SW * 0.66                        # the period: a little heavier than a stroke
DOT_GAP = TR * 0.5
T_W = 78.0

def poly(pts): return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + " Z"

def line_x_at_y(p, q, y):
    (x1, y1), (x2, y2) = p, q
    return x1 + (x2 - x1) * (y - y1) / (y2 - y1)

def offset_line(p, q, d):
    (x1, y1), (x2, y2) = p, q
    dx, dy = x2 - x1, y2 - y1; L = math.hypot(dx, dy)
    nx, ny = -dy / L * d, dx / L * d
    return (x1 + nx, y1 + ny), (x2 + nx, y2 + ny)

def band(p, q, y_top, y_bot, w=SW):
    """a stroke of width w along p->q, cut by horizontal lines y_top/y_bot"""
    a1, a2 = offset_line(p, q, w / 2); b1, b2 = offset_line(p, q, -w / 2)
    return [(line_x_at_y(a1, a2, y_top), y_top), (line_x_at_y(b1, b2, y_top), y_top),
            (line_x_at_y(b1, b2, y_bot), y_bot), (line_x_at_y(a1, a2, y_bot), y_bot)]

def clip_left(pts, xc):
    """Sutherland-Hodgman against the half-plane x >= xc (convex polygons)"""
    out = []
    for i in range(len(pts)):
        p, q = pts[i], pts[(i + 1) % len(pts)]
        pin, qin = p[0] >= xc, q[0] >= xc
        if pin: out.append(p)
        if pin != qin:
            t = (xc - p[0]) / (q[0] - p[0])
            out.append((xc, p[1] + (q[1] - p[1]) * t))
    return out

def inter(p1, p2, p3, p4):
    x1, y1 = p1; x2, y2 = p2; x3, y3 = p3; x4, y4 = p4
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den
    py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den
    return px, py

def glyph_T(x):
    W = T_W
    return W, [poly([(x, 0), (x + W, 0), (x + W, SW), (x, SW)]),
               poly([(x + (W - SW) / 2, 0), (x + (W + SW) / 2, 0), (x + (W + SW) / 2, H), (x + (W - SW) / 2, H)])]

def glyph_A(x):
    W = 92
    lo, ro = (x, H), (x + W, H)                     # outer feet
    apex = (x + W / 2, -5.0)                        # pointed apex, optical overshoot
    li = offset_line(lo, apex, SW)                  # inner edges, square to the outer ones
    ri = offset_line(apex, ro, SW)
    cap = inter(li[0], li[1], ri[0], ri[1])         # apex of the counter
    lfoot_in = (line_x_at_y(li[0], li[1], H), H)
    rfoot_in = (line_x_at_y(ri[0], ri[1], H), H)
    left = [lo, apex, cap, lfoot_in]
    right = [apex, ro, rfoot_in, cap]
    yb0, yb1 = H * 0.60, H * 0.60 + SW * 0.86
    bar = [(line_x_at_y(li[0], li[1], yb0) - 0.5, yb0), (line_x_at_y(ri[0], ri[1], yb0) + 0.5, yb0),
           (line_x_at_y(ri[0], ri[1], yb1) + 0.5, yb1), (line_x_at_y(li[0], li[1], yb1) - 0.5, yb1)]
    return W, [poly(left), poly(right), poly(bar)]

def glyph_K(x):
    W = 76
    stem = [(x, 0), (x + SW, 0), (x + SW, H), (x, H)]
    # upper arm: from the stem at 60% height to the top-right corner, cut flat on
    # top; lower arm leaves it a third of the way up. Both are clipped at the
    # stem's centre line, so nothing pokes out of the stem's left side (the old
    # cut left a spur there that showed at display sizes)
    p0, p1 = (x + SW * 0.5, H * 0.60), (x + W - SW * 0.62, 0)
    up = clip_left(band(p0, p1, 0, H * 0.60 + SW * 0.8), x + SW * 0.5)
    t = 0.30
    m = (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t)
    q = (x + W - SW * 0.6, H)
    lo = clip_left(band(m, q, m[1] - SW * 0.42, H), x + SW * 0.5)
    return W, [poly(stem), poly(up), poly(lo)]

def glyph_O(x):
    r = H / 2 + 1.5
    cx, cy = x + r, H / 2
    ri = r - SW * 1.04
    ring = (f"M{cx - r:.2f} {cy:.2f} a{r:.2f} {r:.2f} 0 1 0 {2 * r:.2f} 0 a{r:.2f} {r:.2f} 0 1 0 {-2 * r:.2f} 0 Z "
            f"M{cx - ri:.2f} {cy:.2f} a{ri:.2f} {ri:.2f} 0 1 1 {2 * ri:.2f} 0 a{ri:.2f} {ri:.2f} 0 1 1 {-2 * ri:.2f} 0 Z")
    return 2 * r, [ring]

def wordmark(word="TAKTO"):
    G = {"T": glyph_T, "A": glyph_A, "K": glyph_K, "O": glyph_O}
    x, paths = 0.0, []
    for ch in word:
        w, ps = G[ch](x)
        paths += ps
        x += w + TR
    return x - TR, paths

def paths_svg(paths):
    # one element per stroke: overlapping strokes (the A's legs, the K's arms)
    # must UNION, which one evenodd path would turn into holes; only the O's
    # ring needs evenodd
    return "".join(f'<path d="{d}"/>' if "a" not in d else f'<path fill-rule="evenodd" d="{d}"/>' for d in paths)

def logo_svg(ink, accent, title=True):
    ww, paths = wordmark()
    cx = ww + DOT_GAP + DOT_R
    w = cx + DOT_R
    t = "<title>TAKTO</title>" if title else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -7 {w + 4:.1f} {H + 9:.1f}" role="img">{t}'
            f'<g fill="{ink}">{paths_svg(paths)}</g>'
            f'<circle cx="{cx:.2f}" cy="{H - DOT_R:.2f}" r="{DOT_R:.2f}" fill="{accent}"/></svg>')

# ---------------- the mark: "T." ----------------
MARK_W = T_W + DOT_GAP + 2 * DOT_R      # the pair's width in glyph units

def mark_geo(box_x, box_y, side, t_frac):
    """the T. pair in a square box: T height = t_frac * side, the PAIR centred.
    Returns (crossbar rect, stem rect, dot (cx, cy, r)) in box coordinates."""
    k = side * t_frac / H
    w, h = MARK_W * k, H * k
    x0 = box_x + (side - w) / 2
    y0 = box_y + (side - h) / 2
    bar = (x0, y0, x0 + T_W * k, y0 + SW * k)
    stem = (x0 + (T_W - SW) / 2 * k, y0, x0 + (T_W + SW) / 2 * k, y0 + h)
    dot = (x0 + (T_W + DOT_GAP + DOT_R) * k, y0 + (H - DOT_R) * k, DOT_R * k)
    return bar, stem, dot

def mark_svg(ink, accent, tile=None, title=True, t_frac=None):
    """64-unit square. tile = fill of a rounded-square ground (None = bare)."""
    t = "<title>TAKTO</title>" if title else ""
    ground = f'<rect width="64" height="64" rx="14.5" fill="{tile}"/>' if tile else ""
    bar, stem, (cx, cy, r) = mark_geo(0, 0, 64, t_frac or (0.5 if tile else 0.62))
    rect = lambda b: f'<rect x="{b[0]:.2f}" y="{b[1]:.2f}" width="{b[2] - b[0]:.2f}" height="{b[3] - b[1]:.2f}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">{t}{ground}'
            f'<g fill="{ink}">{rect(bar)}{rect(stem)}</g>'
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="{accent}"/></svg>')

# ---------------- raster: the mark as icons ----------------
def hex2rgb(h): h = h.lstrip("#"); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def draw_mark(size, side, t_frac, ink, accent, ground=None, ground_rx=None, ss=4):
    """the T. centred in a size x size canvas; the pair sized against `side`.
    ground: a rounded square behind it (full canvas, radius ground_rx)."""
    S = size * ss
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if ground is not None:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=(ground_rx or 0) * ss, fill=ground)
    off = (size - side) / 2 * ss
    bar, stem, (cx, cy, r) = mark_geo(off, off, side * ss, t_frac)
    d.rectangle(bar, fill=ink)
    d.rectangle(stem, fill=ink)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=accent)
    return im.resize((size, size), Image.LANCZOS)

def gradient_bg(size, top=(255, 255, 255), bottom=(233, 236, 240)):
    im = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(im)
    for y in range(size):
        f = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * f) for a, b in zip(top, bottom)))
    return im

def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(path, mode) as f:
        f.write(data)

def patch_ar(path):
    """the AR page inlines the mark twice: its favicon and the veil's ring"""
    if not os.path.exists(path):
        return False
    s = open(path).read()
    ico = mark_svg("#FFFFFF", TILE_DOT, tile=INK, title=False).replace('role="img"', "")
    ico_uri = "data:image/svg+xml," + ico.replace("<", "%3C").replace(">", "%3E").replace('"', "'").replace("#", "%23").replace(" ", "%20")
    s = re.sub(r'<link rel="icon" type="image/svg\+xml" href="data:image/svg\+xml,[^"]*" />',
               f'<link rel="icon" type="image/svg+xml" href="{ico_uri}" />', s, count=1)
    ring = mark_svg(AR_INK, AR_DOT, title=False, t_frac=0.62).replace('role="img"', 'aria-hidden="true"')
    s = re.sub(r'<div class="ring"><svg[^>]*>.*?</svg></div>', f'<div class="ring">{ring}</div>', s, count=1, flags=re.S)
    s = re.sub(r"/\* TAKTO mark inside the ring:[^*]*\*/",
               "/* TAKTO mark inside the ring: the T. of the logo (software/brand/brand.py) */", s, count=1)
    write(path, s)
    return True

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    web = os.path.join(here, "..", "web", "assets")
    con = os.path.join(here, "..", "console", "app", "assets")
    app = os.path.join(here, "..", "app", "assets")
    ink, acc = hex2rgb(INK) + (255,), hex2rgb(ACCENT) + (255,)
    white, tdot = (255, 255, 255, 255), hex2rgb(TILE_DOT) + (255,)
    # ---- vectors: the tile mark is the favicon and the console's badge;
    # the logo is the wordmark with its period ----
    tile_l = mark_svg("#FFFFFF", TILE_DOT, tile=INK) + "\n"
    tile_d = mark_svg(INK, ACCENT, tile=INK_D) + "\n"
    for root in (web, con):
        write(os.path.join(root, "brand", "takto-mark.svg"), tile_l)
        write(os.path.join(root, "brand", "takto-mark-dark.svg"), tile_d)
        write(os.path.join(root, "brand", "takto-logo.svg"), logo_svg(INK, ACCENT) + "\n")
        write(os.path.join(root, "brand", "takto-logo-dark.svg"), logo_svg(INK_D, ACCENT_D) + "\n")
        write(os.path.join(root, "takto_mark.svg"), tile_l)          # legacy path, same mark
    # ---- web touch icons: the 32 px favicon is the ink tile (holds on any tab
    # strip); the large ones are light, like the app icon ----
    draw_mark(32, 32, 0.5, white, tdot, ground=ink, ground_rx=7).save(os.path.join(web, "brand", "icon-32.png"))
    for n in (180, 512):
        bg = gradient_bg(n).convert("RGBA")
        bg.alpha_composite(draw_mark(n, n, 0.36, ink, acc))
        bg.convert("RGB").save(os.path.join(web, "brand", f"icon-{n}.png"))
    # ---- app (Expo): iOS icon, Android adaptive set, favicon, splash ----
    ic = gradient_bg(1024).convert("RGBA")
    ic.alpha_composite(draw_mark(1024, 1024, 0.36, ink, acc))
    ic.convert("RGB").save(os.path.join(app, "icon.png"))
    # adaptive foreground: the pair inside the 66/108 safe circle
    draw_mark(512, 512, 0.26, ink, acc).save(os.path.join(app, "android-icon-foreground.png"))
    gradient_bg(512).convert("RGBA").save(os.path.join(app, "android-icon-background.png"))
    draw_mark(432, 432, 0.26, white, white).save(os.path.join(app, "android-icon-monochrome.png"))
    draw_mark(48, 48, 0.5, white, tdot, ground=ink, ground_rx=11).save(os.path.join(app, "favicon.png"))
    draw_mark(1024, 1024, 0.3, ink, acc).save(os.path.join(app, "splash-icon.png"))
    ar = patch_ar(os.path.join(here, "..", "ar", "index.html"))
    print("wrote web + console brand/*, takto_mark.svg, web icons, app icons" + (", ar/index.html" if ar else ""))
