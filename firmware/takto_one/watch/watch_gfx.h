// watch_gfx.h — dual-target (Teensy 4.1 + host) software rasterizer for the
// 240x240 RGB565 watch framebuffer.
//
// The anti-aliased primitives (blend565, aaArc, aaDisc, aaLine, aaText,
// buildBg) are extracted FORMULA-IDENTICAL from DeviceFirmware.ino so the
// THESIS face renders pixel-faithfully through the engine (verified by the
// host fidelity test, which CRC-compares a verbatim legacy copy against the
// engine port). New alpha-aware variants (…A) and the star-shape body fill
// exist for the Ferro and Rams faces and do not alter the originals.
//
// Text: MiniCanvas1 replicates Adafruit_GFX's custom-font pipeline
// (drawChar / write / charBounds — Adafruit-GFX, BSD license) bit-exactly at
// textsize 1 so device and host renders agree. Fonts are the stock Adafruit
// FreeSans headers, included by the sketch / harness before this file.
#pragma once
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include "watch_fonts.h"

#ifndef ARDUINO
// host shims for the PROGMEM idioms the font headers use (provided by the
// harness's Adafruit_GFX.h stand-in; keep the guards for safety)
#ifndef PROGMEM
#define PROGMEM
#endif
#ifndef pgm_read_byte
#define pgm_read_byte(a) (*(const uint8_t*)(a))
#define pgm_read_word(a) (*(const uint16_t*)(a))
#endif
#ifndef pgm_read_ptr
#define pgm_read_ptr(a) (*(void* const*)(a))
#endif
#endif

namespace wgfx {

// ---------- geometry (identical to the sketch) ----------
static const int SCX = 120, SCY = 120;
static const float S_DR = 0.017453292f;

#define WGFX_C565(r,g,b) (uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))

// the active canvas: faces paint here. Set by the engine before render().
static uint16_t* FB = nullptr;

// ---------- pixel blend (verbatim) ----------
static inline uint16_t blend565(uint16_t d, uint16_t s, uint8_t a) {
  uint16_t dr=(d>>11)&0x1F, dg=(d>>5)&0x3F, db=d&0x1F, sr=(s>>11)&0x1F, sg=(s>>5)&0x3F, sb=s&0x1F;
  uint8_t ia = 255 - a;
  return (((sr*a+dr*ia)>>8)<<11) | (((sg*a+dg*ia)>>8)<<5) | ((sb*a+db*ia)>>8);
}

// ---------- soft radial vignette background (verbatim, into any buffer) ----------
static inline void buildBg(uint16_t* bg) {
  for (int y = 0; y < 240; y++) for (int x = 0; x < 240; x++) {
    int dx = x - SCX, dy = y - SCY, d2 = dx*dx + dy*dy, t = d2 / 260; if (t > 118) t = 118;
    int r = 15 - t/14, g = 21 - t/9, b = 32 - t/6;
    bg[y*240 + x] = WGFX_C565(r < 4 ? 4 : r, g < 5 ? 5 : g, b < 7 ? 7 : b);
  }
}

// ---------- anti-aliased ring/arc (verbatim) ----------
static inline void aaArc(float r, float hw, float a0, float a1, uint16_t col, float glow) {
  float outer = r + hw + glow + 1.0f;
  int x0 = SCX-outer < 0 ? 0 : (int)(SCX-outer), x1 = SCX+outer > 239 ? 239 : (int)(SCX+outer);
  int y0 = SCY-outer < 0 ? 0 : (int)(SCY-outer), y1 = SCY+outer > 239 ? 239 : (int)(SCY+outer);
  bool full = (a1 - a0) >= 359.5f;
  for (int y = y0; y <= y1; y++) for (int x = x0; x <= x1; x++) {
    float dx = x-SCX, dy = y-SCY, dist = sqrtf(dx*dx+dy*dy), dr = fabsf(dist-r);
    if (dr > hw + glow + 1.0f) continue;
    if (!full) {
      float ang = atan2f(dy,dx) * 57.29578f + 90.0f;
      if (ang < 0) ang += 360.0f; else if (ang >= 360.0f) ang -= 360.0f;
      bool in = (a0 <= a1) ? (ang >= a0 && ang <= a1) : (ang >= a0 || ang <= a1);
      if (!in) continue;
    }
    float cov;
    if (dr <= hw-0.5f) cov = 1.0f;
    else if (dr <= hw+0.5f) cov = hw+0.5f-dr;
    else if (glow > 0 && dr <= hw+0.5f+glow) cov = 0.30f*(1.0f-(dr-hw-0.5f)/glow);
    else continue;
    int i = y*240+x; FB[i] = blend565(FB[i], col, (uint8_t)(cov*255));
  }
}

// Partial version of aaArc().  A short moving segment must not scan the entire
// 200 x 200 ring box: this bounds the scan to the actual wedge while retaining
// the same distance, angle and antialias rules as aaArc().
static inline bool arcContainsDeg(float a0, float span, float a) {
  while (a0 < 0) a0 += 360.0f;
  while (a0 >= 360.0f) a0 -= 360.0f;
  while (a < 0) a += 360.0f;
  while (a >= 360.0f) a -= 360.0f;
  float rel = a - a0;
  if (rel < 0) rel += 360.0f;
  return rel <= span;
}

static inline void aaArcSegment(float r, float hw, float a0, float span,
                                uint16_t col, float glow) {
  if (span >= 359.5f) { aaArc(r, hw, 0, 360, col, glow); return; }
  const float outer = r + hw + glow + 1.0f;
  float minx = 1e9f, maxx = -1e9f, miny = 1e9f, maxy = -1e9f;
  auto include = [&](float a) {
    const float rad = (a - 90.0f) * S_DR;
    const float x = SCX + outer * cosf(rad), y = SCY + outer * sinf(rad);
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  };
  include(a0); include(a0 + span);
  for (int q = 0; q < 4; ++q) {
    const float a = q * 90.0f;
    if (arcContainsDeg(a0, span, a)) include(a);
  }
  int x0 = (int)floorf(minx) - 2, x1 = (int)ceilf(maxx) + 2;
  int y0 = (int)floorf(miny) - 2, y1 = (int)ceilf(maxy) + 2;
  if (x0 < 0) x0 = 0; if (x1 > 239) x1 = 239;
  if (y0 < 0) y0 = 0; if (y1 > 239) y1 = 239;
  for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) {
    const float dx = x-SCX, dy = y-SCY, dist = sqrtf(dx*dx+dy*dy), dr = fabsf(dist-r);
    if (dr > hw + glow + 1.0f) continue;
    float ang = atan2f(dy, dx) * 57.29578f + 90.0f;
    if (ang < 0) ang += 360.0f; else if (ang >= 360.0f) ang -= 360.0f;
    if (!arcContainsDeg(a0, span, ang)) continue;
    float cov;
    if (dr <= hw-0.5f) cov = 1.0f;
    else if (dr <= hw+0.5f) cov = hw+0.5f-dr;
    else if (glow > 0 && dr <= hw+0.5f+glow) cov = 0.30f*(1.0f-(dr-hw-0.5f)/glow);
    else continue;
    const int i = y*240+x; FB[i] = blend565(FB[i], col, (uint8_t)(cov*255));
  }
}

// ---------- anti-aliased disc (verbatim) ----------
static inline void aaDisc(int cx, int cy, float r, uint16_t col, float glow) {
  float outer = r + glow + 1.0f;
  int ylo = (int)(cy-outer), yhi = (int)(cy+outer), xlo = (int)(cx-outer), xhi = (int)(cx+outer);
  if (ylo < 0) ylo = 0; if (yhi > 239) yhi = 239;
  if (xlo < 0) xlo = 0; if (xhi > 239) xhi = 239;
  for (int y = ylo; y <= yhi; y++)
    for (int x = xlo; x <= xhi; x++) {
      float dx = x-cx, dy = y-cy, dist = sqrtf(dx*dx+dy*dy), cov;
      if (dist <= r-0.5f) cov = 1.0f;
      else if (dist <= r+0.5f) cov = r+0.5f-dist;
      else if (glow > 0 && dist <= r+0.5f+glow) cov = 0.30f*(1.0f-(dist-r-0.5f)/glow);
      else continue;
      int i = y*240+x; FB[i] = blend565(FB[i], col, (uint8_t)(cov*255));
    }
}

// ---------- anti-aliased line (verbatim: discs along the segment) ----------
static inline void aaLine(int x0, int y0, int x1, int y1, float w, uint16_t col) {
  int adx = x1-x0; if (adx < 0) adx = -adx;
  int ady = y1-y0; if (ady < 0) ady = -ady;
  int n = adx > ady ? adx : ady; if (n < 1) n = 1;
  for (int i = 0; i <= n; i++) aaDisc(x0 + (x1-x0)*i/n, y0 + (y1-y0)*i/n, w, col, 0);
}

// ============================================================
// MiniCanvas1 — a 1-bit canvas replicating Adafruit_GFX's custom-font
// rendering (drawChar/write/charBounds) exactly, at textsize 1.
// ============================================================
struct GFXglyph_;   // (the real GFXglyph/GFXfont come from Adafruit headers)

class MiniCanvas1 {
public:
  static const int W = 220, H = 74;
  uint8_t buf[((W + 7) / 8) * H];
  const GFXfont* font = nullptr;
  int16_t cx = 0, cy = 0;

  void fillScreen(uint8_t) { memset(buf, 0, sizeof buf); }
  void setFont(const GFXfont* f) { font = f; }
  void setTextColor(uint8_t) {}
  void setCursor(int16_t x, int16_t y) { cx = x; cy = y; }

  bool getPixel(int16_t x, int16_t y) const {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    return buf[(x / 8) + y * ((W + 7) / 8)] & (0x80 >> (x & 7));
  }
  void drawPixel(int16_t x, int16_t y) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    buf[(x / 8) + y * ((W + 7) / 8)] |= (0x80 >> (x & 7));
  }

  // Adafruit_GFX::drawChar, custom-font path, size 1 (BSD; Adafruit Industries)
  void drawChar(int16_t x, int16_t y, unsigned char c) {
    c -= (uint8_t)pgm_read_byte(&font->first);
    const GFXglyph* glyph = &(((GFXglyph*)pgm_read_ptr(&font->glyph))[c]);
    const uint8_t* bitmap = (const uint8_t*)pgm_read_ptr(&font->bitmap);
    uint16_t bo = pgm_read_word(&glyph->bitmapOffset);
    uint8_t w = pgm_read_byte(&glyph->width), h = pgm_read_byte(&glyph->height);
    int8_t xo = pgm_read_byte(&glyph->xOffset), yo = pgm_read_byte(&glyph->yOffset);
    uint8_t xx, yy, bits = 0, bit = 0;
    for (yy = 0; yy < h; yy++)
      for (xx = 0; xx < w; xx++) {
        if (!(bit++ & 7)) bits = pgm_read_byte(&bitmap[bo++]);
        if (bits & 0x80) drawPixel(x + xo + xx, y + yo + yy);
        bits <<= 1;
      }
  }

  // Adafruit_GFX::write, custom-font path, size 1, wrap on (default)
  void write(uint8_t c) {
    if (c == '\n') { cx = 0; cy += (uint8_t)pgm_read_byte(&font->yAdvance); }
    else if (c != '\r') {
      uint8_t first = pgm_read_byte(&font->first);
      if ((c >= first) && (c <= (uint8_t)pgm_read_byte(&font->last))) {
        const GFXglyph* glyph = &(((GFXglyph*)pgm_read_ptr(&font->glyph))[c - first]);
        uint8_t w = pgm_read_byte(&glyph->width), h = pgm_read_byte(&glyph->height);
        if ((w > 0) && (h > 0)) {
          int16_t xo = (int8_t)pgm_read_byte(&glyph->xOffset);
          if ((cx + (xo + w)) > W) { cx = 0; cy += (uint8_t)pgm_read_byte(&font->yAdvance); }
          drawChar(cx, cy, c);
        }
        cx += (uint8_t)pgm_read_byte(&glyph->xAdvance);
      }
    }
  }
  void print(const char* s) { while (*s) write((uint8_t)*s++); }

  // Adafruit_GFX::charBounds + getTextBounds, custom-font path, size 1
  void charBounds(unsigned char c, int16_t* x, int16_t* y, int16_t* minx,
                  int16_t* miny, int16_t* maxx, int16_t* maxy) const {
    if (c == '\n') { *x = 0; *y += (uint8_t)pgm_read_byte(&font->yAdvance); }
    else if (c != '\r') {
      uint8_t first = pgm_read_byte(&font->first), last = pgm_read_byte(&font->last);
      if ((c >= first) && (c <= last)) {
        const GFXglyph* glyph = &(((GFXglyph*)pgm_read_ptr(&font->glyph))[c - first]);
        uint8_t gw = pgm_read_byte(&glyph->width), gh = pgm_read_byte(&glyph->height),
                xa = pgm_read_byte(&glyph->xAdvance);
        int8_t xo = pgm_read_byte(&glyph->xOffset), yo = pgm_read_byte(&glyph->yOffset);
        if ((*x + ((int16_t)xo + gw)) > W) { *x = 0; *y += (uint8_t)pgm_read_byte(&font->yAdvance); }
        int16_t x1 = *x + xo, y1 = *y + yo, x2 = x1 + gw - 1, y2 = y1 + gh - 1;
        if (x1 < *minx) *minx = x1;
        if (y1 < *miny) *miny = y1;
        if (x2 > *maxx) *maxx = x2;
        if (y2 > *maxy) *maxy = y2;
        *x += xa;
      }
    }
  }
  void getTextBounds(const char* str, int16_t x, int16_t y, int16_t* x1,
                     int16_t* y1, uint16_t* w, uint16_t* h) const {
    uint8_t c;
    int16_t minx = 0x7FFF, miny = 0x7FFF, maxx = -1, maxy = -1;
    *x1 = x; *y1 = y; *w = *h = 0;
    while ((c = *str++)) charBounds(c, &x, &y, &minx, &miny, &maxx, &maxy);
    if (maxx >= minx) { *x1 = minx; *w = maxx - minx + 1; }
    if (maxy >= miny) { *y1 = miny; *h = maxy - miny + 1; }
  }
};

static MiniCanvas1 txt;   // shared 1-bit scratch, same 220x74 as the sketch's

// blit whatever is in the 1-bit scratch, 3x3 coverage -> grayscale blend
static inline void aaTextBlit(int cx, int cy, uint16_t col) {
  int ox = cx-110, oy = cy-37;
  for (int j = 1; j < 73; j++) for (int i = 1; i < 219; i++) {
    int X = ox+i, Y = oy+j; if (X < 1 || X > 238 || Y < 1 || Y > 238) continue;
    int sum = 0;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) if (txt.getPixel(i+dx, j+dy)) sum++;
    if (!sum) continue;
    int k = Y*240+X; FB[k] = blend565(FB[k], col, (uint8_t)(sum*255/9));
  }
}

// ---------- anti-aliased text (verbatim: 1-bit render + 3x3 coverage) ----------
static inline void aaText(const GFXfont* f, const char* s, int cx, int cy, uint16_t col) {
  txt.fillScreen(0); txt.setFont(f); txt.setTextColor(1);
  int16_t bx, by; uint16_t bw, bh; txt.getTextBounds(s, 0, 0, &bx, &by, &bw, &bh);
  txt.setCursor((220-bw)/2 - bx, (74-bh)/2 - by); txt.print(s);
  aaTextBlit(cx, cy, col);
}

// the ink width a tracked label will occupy, so callers can place things
// RELATIVE to text instead of hardcoding offsets that drift when a word changes
static inline int textWidthTracked(const GFXfont* f, const char* s, int track) {
  txt.setFont(f);
  int16_t x = 0, y = 0, minx = 0x7FFF, miny = 0x7FFF, maxx = -1, maxy = -1;
  for (const char* p = s; *p; ++p) { txt.charBounds((unsigned char)*p, &x, &y, &minx, &miny, &maxx, &maxy); x += track; }
  return (maxx < minx) ? 0 : (maxx - minx + 1);
}

// letterspaced caps (Braun/Rams labels): the same pipeline with `track` extra
// pixels after every glyph advance, measured then centred the same way.
static inline void aaTextTracked(const GFXfont* f, const char* s, int cx, int cy,
                                 uint16_t col, int track) {
  txt.fillScreen(0); txt.setFont(f); txt.setTextColor(1);
  int16_t x = 0, y = 0, minx = 0x7FFF, miny = 0x7FFF, maxx = -1, maxy = -1;
  for (const char* p = s; *p; ++p) { txt.charBounds((unsigned char)*p, &x, &y, &minx, &miny, &maxx, &maxy); x += track; }
  if (maxx < minx) return;
  int16_t bw = maxx - minx + 1, bh = maxy - miny + 1;
  txt.setCursor((220 - bw)/2 - minx, (74 - bh)/2 - miny);
  for (const char* p = s; *p; ++p) { txt.write((uint8_t)*p); txt.cx += track; }
  aaTextBlit(cx, cy, col);
}

// ============================================================
// Alpha-aware additions (Ferro / Rams only — the originals above
// stay untouched for thesis-face pixel fidelity)
// ============================================================

// blend565 computes (s*a + d*(255-a)) >> 8, so at a = 255 it returns
// (s*255)>>8, one 565 level BELOW s. On the thesis face that only ever touches
// thin anti-aliased edges and is invisible (and is part of what the fidelity
// test pins), but Ferro fills its whole body this way, and its darkest stops
// live at 565 level 1 — where losing a level rounds the mass to pure black and
// the body disappears into the field. Opaque coverage therefore writes the
// source directly. The verbatim primitives above keep calling blend565.
static inline uint16_t blendOver(uint16_t d, uint16_t s, uint8_t a) {
  return a >= 255 ? s : blend565(d, s, a);
}

static inline void fillScreen565(uint16_t col) {
  for (int i = 0; i < 240*240; i++) FB[i] = col;
}

static inline void aaDiscA(float cx, float cy, float r, uint16_t col, uint8_t alpha, float glow = 0) {
  float outer = r + glow + 1.0f;
  int ylo = (int)(cy-outer), yhi = (int)(cy+outer)+1, xlo = (int)(cx-outer), xhi = (int)(cx+outer)+1;
  if (ylo < 0) ylo = 0; if (yhi > 239) yhi = 239;
  if (xlo < 0) xlo = 0; if (xhi > 239) xhi = 239;
  for (int y = ylo; y <= yhi; y++)
    for (int x = xlo; x <= xhi; x++) {
      float dx = x-cx, dy = y-cy, dist = sqrtf(dx*dx+dy*dy), cov;
      if (dist <= r-0.5f) cov = 1.0f;
      else if (dist <= r+0.5f) cov = r+0.5f-dist;
      else if (glow > 0 && dist <= r+0.5f+glow) cov = 0.30f*(1.0f-(dist-r-0.5f)/glow);
      else continue;
      int i = y*240+x; FB[i] = blendOver(FB[i], col, (uint8_t)(cov*alpha));
    }
}

// stroked circle outline (ellipse-squashed optionally on y), alpha-aware
static inline void aaCircleA(float cx, float cy, float r, float lw, uint16_t col,
                             uint8_t alpha, float ysq = 1.0f) {
  float hw = lw * 0.5f, outer = r + hw + 1.0f;
  int ylo = (int)(cy-outer*ysq), yhi = (int)(cy+outer*ysq)+1, xlo = (int)(cx-outer), xhi = (int)(cx+outer)+1;
  if (ylo < 0) ylo = 0; if (yhi > 239) yhi = 239;
  if (xlo < 0) xlo = 0; if (xhi > 239) xhi = 239;
  for (int y = ylo; y <= yhi; y++)
    for (int x = xlo; x <= xhi; x++) {
      float dx = x-cx, dy = (y-cy)/ysq, dist = sqrtf(dx*dx+dy*dy), dr = fabsf(dist-r);
      if (dr > hw + 0.5f) continue;
      float cov = dr <= hw-0.5f ? 1.0f : (hw+0.5f-dr);
      int i = y*240+x; FB[i] = blendOver(FB[i], col, (uint8_t)(cov*alpha));
    }
}

// arc stroke: a0..a1 in RADIANS, screen convention (0 = +x, CCW positive in
// math terms but y grows downward), alpha-aware, flat caps
static inline void aaArcA(float cx, float cy, float r, float lw, float a0, float a1,
                          uint16_t col, uint8_t alpha) {
  float hw = lw * 0.5f, outer = r + hw + 1.0f;
  int ylo = (int)(cy-outer), yhi = (int)(cy+outer)+1, xlo = (int)(cx-outer), xhi = (int)(cx+outer)+1;
  if (ylo < 0) ylo = 0; if (yhi > 239) yhi = 239;
  if (xlo < 0) xlo = 0; if (xhi > 239) xhi = 239;
  const float TAUf = 6.2831853f;
  float span = a1 - a0;
  bool full = span >= TAUf - 0.001f;
  for (int y = ylo; y <= yhi; y++)
    for (int x = xlo; x <= xhi; x++) {
      float dx = x-cx, dy = y-cy, dist = sqrtf(dx*dx+dy*dy), dr = fabsf(dist-r);
      if (dr > hw + 0.5f) continue;
      if (!full) {
        float ang = atan2f(dy, dx);
        float rel = ang - a0;
        rel -= TAUf * floorf(rel / TAUf);
        if (rel > span) continue;
      }
      float cov = dr <= hw-0.5f ? 1.0f : (hw+0.5f-dr);
      int i = y*240+x; FB[i] = blendOver(FB[i], col, (uint8_t)(cov*alpha));
    }
}

// alpha-aware capsule segment with proper coverage (no disc-chain beading)
static inline void aaSegA(float x0, float y0, float x1, float y1, float lw,
                          uint16_t col, uint8_t alpha) {
  float hw = lw * 0.5f;
  float minx = (x0 < x1 ? x0 : x1) - hw - 1, maxx = (x0 > x1 ? x0 : x1) + hw + 1;
  float miny = (y0 < y1 ? y0 : y1) - hw - 1, maxy = (y0 > y1 ? y0 : y1) + hw + 1;
  int xlo = (int)minx, xhi = (int)maxx + 1, ylo = (int)miny, yhi = (int)maxy + 1;
  if (ylo < 0) ylo = 0; if (yhi > 239) yhi = 239;
  if (xlo < 0) xlo = 0; if (xhi > 239) xhi = 239;
  float vx = x1-x0, vy = y1-y0, vv = vx*vx + vy*vy;
  for (int y = ylo; y <= yhi; y++)
    for (int x = xlo; x <= xhi; x++) {
      float px = x-x0, py = y-y0;
      float u = vv > 0 ? (px*vx + py*vy) / vv : 0;
      if (u < 0) u = 0; if (u > 1) u = 1;
      float dx = px - u*vx, dy = py - u*vy, d = sqrtf(dx*dx + dy*dy);
      if (d > hw + 0.5f) continue;
      float cov = d <= hw-0.5f ? 1.0f : (hw+0.5f-d);
      int i = y*240+x; FB[i] = blendOver(FB[i], col, (uint8_t)(cov*alpha));
    }
}

// FLAT-CAPPED radial bar: a rectangle of `width` centred on the ray at `ang`,
// spanning radius r0..r1. aaSegA would be wrong here because its round caps
// add half a width beyond each end, so a 20 px instrument bar draws 32 px long
// and reads as a capsule instead of a bar. Instrument scales need square ends.
static inline void aaBarA(float cx, float cy, float ang, float r0, float r1,
                          float width, uint16_t col, uint8_t alpha) {
  if (r1 < r0) { float t = r0; r0 = r1; r1 = t; }
  const float ca = cosf(ang), sa = sinf(ang), hw = width * 0.5f;
  // bbox: the four corners of the rotated rectangle
  const float px = -sa * hw, py = ca * hw;
  float xs[4] = { cx + ca*r0 + px, cx + ca*r0 - px, cx + ca*r1 + px, cx + ca*r1 - px };
  float ys[4] = { cy + sa*r0 + py, cy + sa*r0 - py, cy + sa*r1 + py, cy + sa*r1 - py };
  float mnx = xs[0], mxx = xs[0], mny = ys[0], mxy = ys[0];
  for (int i = 1; i < 4; i++) {
    if (xs[i] < mnx) mnx = xs[i]; if (xs[i] > mxx) mxx = xs[i];
    if (ys[i] < mny) mny = ys[i]; if (ys[i] > mxy) mxy = ys[i];
  }
  int x0 = (int)(mnx - 1), x1 = (int)(mxx + 1), y0 = (int)(mny - 1), y1 = (int)(mxy + 1);
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > 239) x1 = 239; if (y1 > 239) y1 = 239;
  for (int y = y0; y <= y1; y++)
    for (int x = x0; x <= x1; x++) {
      const float dx = x - cx, dy = y - cy;
      const float u = dx*ca + dy*sa;          // along the ray
      const float v = -dx*sa + dy*ca;         // across it
      // coverage as the distance inside each of the four edges, 1 px soft
      float cu = (u - r0 < r1 - u) ? (u - r0) : (r1 - u);
      float cv = hw - (v < 0 ? -v : v);
      if (cu < -0.5f || cv < -0.5f) continue;
      float c = cu < cv ? cu : cv;
      float cov = c >= 0.5f ? 1.0f : (c + 0.5f);
      if (cov <= 0) continue;
      int i = y*240+x;
      FB[i] = blendOver(FB[i], col, (uint8_t)(cov*alpha));
    }
}

// diagonally hatched annulus wedge: an unmistakable warning texture that
// cannot be mistaken for the bars that normally occupy the same sector
static inline void hatchWedgeA(float cx, float cy, float r0, float r1,
                               float a0, float a1, uint16_t back, uint16_t line,
                               uint8_t alpha, int pitch) {
  const float TAUf = 6.2831853f;
  // Bound the WEDGE, not its circle. A 60 degree wedge inside a full-circle
  // bbox wastes ~92 % of the scan on pixels that fail the angle test, and this
  // runs every frame of a major fault. Corners first, then extend to r1 along
  // any axis direction the wedge actually contains.
  float mnx = cx, mxx = cx, mny = cy, mxy = cy;
  bool first = true;
  for (int i = 0; i < 4; i++) {
    const float a = (i & 1) ? a1 : a0, r = (i & 2) ? r1 : r0;
    const float px = cx + cosf(a)*r, py = cy + sinf(a)*r;
    if (first) { mnx = mxx = px; mny = mxy = py; first = false; }
    else {
      if (px < mnx) mnx = px; if (px > mxx) mxx = px;
      if (py < mny) mny = py; if (py > mxy) mxy = py;
    }
  }
  for (int q = 0; q < 4; q++) {
    const float aq = q * (TAUf / 4.0f);
    float rel = aq - a0;
    rel -= TAUf * floorf(rel / TAUf);
    if (rel > a1 - a0) continue;                 // the wedge does not reach this axis
    const float px = cx + cosf(aq)*r1, py = cy + sinf(aq)*r1;
    if (px < mnx) mnx = px; if (px > mxx) mxx = px;
    if (py < mny) mny = py; if (py > mxy) mxy = py;
  }
  int x0 = (int)(mnx - 1), x1 = (int)(mxx + 1);
  int y0 = (int)(mny - 1), y1 = (int)(mxy + 1);
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > 239) x1 = 239; if (y1 > 239) y1 = 239;
  for (int y = y0; y <= y1; y++)
    for (int x = x0; x <= x1; x++) {
      const float dx = x - cx, dy = y - cy;
      const float d = sqrtf(dx*dx + dy*dy);
      if (d < r0 - 0.5f || d > r1 + 0.5f) continue;
      float ang = atan2f(dy, dx);
      float rel = ang - a0;
      rel -= TAUf * floorf(rel / TAUf);
      if (rel > a1 - a0) continue;
      float edge = (d - r0 < r1 - d) ? (d - r0) : (r1 - d);
      float cov = edge >= 0.5f ? 1.0f : (edge + 0.5f);
      if (cov <= 0) continue;
      const bool on = (((x + y) / pitch) & 1) == 0;
      int i = y*240+x;
      FB[i] = blendOver(FB[i], on ? line : back, (uint8_t)(cov*alpha));
    }
}

// quadratic bezier polyline stroke (for the Ferro feed / tether curves)
static inline void aaQuadA(float x0, float y0, float qx, float qy, float x1, float y1,
                           float lw, uint16_t col, uint8_t alpha, int steps = 14) {
  float px = x0, py = y0;
  for (int i = 1; i <= steps; i++) {
    float u = (float)i / steps, w0 = (1-u)*(1-u), w1 = 2*u*(1-u), w2 = u*u;
    float nx = w0*x0 + w1*qx + w2*x1, ny = w0*y0 + w1*qy + w2*y1;
    aaSegA(px, py, nx, ny, lw, col, alpha);
    px = nx; py = ny;
  }
}

// filled rotated ellipse, alpha-aware (Ferro specular highlight)
static inline void aaEllipseA(float cx, float cy, float rx, float ry, float rot,
                              uint16_t col, uint8_t alpha) {
  float m = (rx > ry ? rx : ry) + 1.5f;
  int ylo = (int)(cy-m), yhi = (int)(cy+m)+1, xlo = (int)(cx-m), xhi = (int)(cx+m)+1;
  if (ylo < 0) ylo = 0; if (yhi > 239) yhi = 239;
  if (xlo < 0) xlo = 0; if (xhi > 239) xhi = 239;
  float cr = cosf(rot), sr = sinf(rot);
  for (int y = ylo; y <= yhi; y++)
    for (int x = xlo; x <= xhi; x++) {
      float dx = x-cx, dy = y-cy;
      float u = (dx*cr + dy*sr) / rx, v = (-dx*sr + dy*cr) / ry;
      float d = sqrtf(u*u + v*v);
      if (d > 1.0f + 1.0f/ (rx < ry ? rx : ry)) continue;
      float edge = (1.0f - d) * (rx < ry ? rx : ry);   // approx px distance
      float cov = edge >= 0.5f ? 1.0f : (edge + 0.5f);
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      int i = y*240+x; FB[i] = blendOver(FB[i], col, (uint8_t)(cov*alpha));
    }
}

// axis-aligned filled rect, alpha-aware (Rams windows / bars)
static inline void fillRectA(int x0, int y0, int w, int h, uint16_t col, uint8_t alpha) {
  int x1 = x0 + w - 1, y1 = y0 + h - 1;
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > 239) x1 = 239; if (y1 > 239) y1 = 239;
  for (int y = y0; y <= y1; y++)
    for (int x = x0; x <= x1; x++) {
      int i = y*240+x;
      FB[i] = alpha == 255 ? col : blend565(FB[i], col, alpha);
    }
}

} // namespace wgfx
