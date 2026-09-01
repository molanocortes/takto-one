// face_ferro.h — FACE 2: FERRO. A PORT OF THE APPROVED CANON, not a redesign.
//
// Source of truth: Fable/watch/canon/ (FERRO-SPEC.md, SELECTION.md,
// design/ferro-lang.js, design/ferro-v2.js), imported from the Claude Design
// project "Gallery review: Eight directions" (2026-07-27). Every parameter
// curve below is transcribed from STATES[] / drawFerro() / l1() with the
// numbers unchanged; the only translation is JS canvas -> RGB565 software
// rasterizer.
//
// SELECTION (canon/SELECTION.md), state by state:
//   finger      v5 Mass-lobe [A]   -> the deformation field inside rAt()
//   boot        v3 Fusion   [B]    -> [A] FALLBACK per the mission brief: no
//                                     per-droplet gather memory, fade-in +
//                                     bloom ring-out only (bounded 10 droplets)
//   idle        v3 Breathe  [A]
//   linked      L1 Moon     [A]    -> ferro-v2.js l1(), the one explicit pick
//   standalone  v3 Drift    [A]
//   teleop      v3 Channel  [A]
//   recording   recA Witness orbit [A]
//   calib       v3 Settle   [A]
//   stop        v3 Freeze+invert [A]  (the reference; never touched)
//   fault       v3 Fracture [A]
//   battery     v3 Thin/feed [A]
//
// FS_SAVED has no canon entry (the gallery never explored it). It is rendered
// as the canon's own documented RECORDING EXIT — "pinch-off / rejoin" plus a
// completion ring-out — so no new visual vocabulary is invented. Flagged in
// FACE-ENGINE.md as canon-derived rather than canon-selected.
//
// Feasibility, per FERRO-SPEC "Implementation readiness": polyline silhouette
// (140-step radius LUT), 2-stop radial shading, bounded particles (<= 10
// droplets, <= 7 feed dots), precomputed crack tree. No solver, no allocation.
//
// One structural adaptation, deliberate: the canon's BATTERY entry is an 18 s
// demo LOOP that walks thin -> critical -> feed on a timer. The device has real
// values, so the three phases are selected by (battery, charging) instead of by
// loop time. The parameter curves inside each phase are unchanged.
#pragma once
#include "watch_state.h"
#include "watch_gfx.h"

class FaceFerro : public WatchFace {
public:
  const char* id() const override { return "ferro"; }
  const char* name() const override { return "Ferro"; }
  int nColorways() const override { return 8; }
  const Colorway& colorway(int i) const override { return CW[(i < 0 || i > 7) ? 0 : i]; }

  void init(int idx) override {
    cwIdx = (idx < 0 || idx > 7) ? 0 : idx;
    if (!cracksBuilt) { buildCracks(); cracksBuilt = true; }
  }

  void render(uint16_t* fb, const DeviceState& s) override {
    wgfx::FB = fb;
    P p; params(p, s);
    draw(fb, p, s);
  }

  // Ferro is continuously animated wherever the canon says it breathes, so the
  // signature quantizes TIME (not values) at the rate the eye resolves: the
  // slowest state breathes at 0.55 Hz, the fastest (teleop) at 1.4 Hz, so
  // ~24 steps/s is smooth and still skips repaints when nothing moves. STOP
  // frozen-plus-blink and the static tail of CALIB collapse to few steps.
  uint32_t signature(const DeviceState& s) const override {
    uint32_t base = (uint32_t)s.state << 27;
    switch (s.state) {
      case FS_STOP:
        // frozen substance: only the 0.5 Hz glyph blink changes
        return base | (uint32_t)(s.t * 1.0f);
      case FS_CALIB: {
        float settle = s.stateT / 5.0f; if (settle > 1) settle = 1;
        // once settled to glass the face is static apart from the ring-out
        uint32_t phase = (s.stateT < 6.4f) ? (uint32_t)(s.stateT * 24.0f) : 0;
        return base | phase | ((uint32_t)(settle * 40.0f) << 12);
      }
      default:
        return base | (uint32_t)(s.t * 24.0f)
             | ((uint32_t)(s.emg * 24.0f) << 20)
             | ((uint32_t)(s.torque * 8.0f) << 25);
    }
  }

private:
  // ---------- the canon parameter block (ferro-lang.js BASE) ----------
  struct P {
    float mass, tempo, agit, spikeAmp, spikeSharp, spikeSpin, echo;
    float elongA, elongK, tetherA, tetherK;
    float orb, orbAng, orbRad, orbSize;
    float cracks, struggle, feed, streak, rim, gaps, disp, freeze, glass, pale;
    float wave, waveDir, fillArc;
    int   glyph;
    float blink, fieldScale;
    float moon;      // L1 Moon companion (ferro-v2 l1)
    float moonAng;
  };
  static void base(P& p) {
    p.mass=.62f; p.tempo=.55f; p.agit=.08f; p.spikeAmp=3; p.spikeSharp=1; p.spikeSpin=.35f;
    p.echo=0; p.elongA=0; p.elongK=0; p.tetherA=.7f; p.tetherK=0;
    p.orb=0; p.orbAng=0; p.orbRad=0; p.orbSize=3.4f;
    p.cracks=0; p.struggle=0; p.feed=0; p.streak=0; p.rim=.35f; p.gaps=0; p.disp=0;
    p.freeze=0; p.glass=0; p.pale=0; p.wave=-1; p.waveDir=1; p.fillArc=-1;
    p.glyph=0; p.blink=0; p.fieldScale=.5f; p.moon=0; p.moonAng=0;
  }

  static float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
  static float smooth(float u) { u = clampf(u,0,1); return u*u*(3-2*u); }
  static float outBack(float u) { const float c=1.70158f; u=clampf(u,0,1);
    return 1 + (c+1)*(u-1)*(u-1)*(u-1) + c*(u-1)*(u-1); }
  // the canon's deterministic hash — double precision so the crack tree and
  // the droplet placement match the JS reference exactly
  static float hashf(double k) { double x = sin(k*127.31)*43758.545; return (float)(x - floor(x)); }

  // ---------- state -> params (STATES[] in ferro-lang.js, verbatim curves) ----------
  void params(P& p, const DeviceState& s) const {
    base(p);
    const float lt = s.stateT, emg = s.emg, tq = s.torque;
    switch (s.state) {
      case FS_BOOT: {                                   // boot v3 Fusion, [A] fallback
        float pr = smooth(clampf(lt/2.2f,0,1));
        float ov = lt > 2.2f ? outBack(clampf((lt-2.2f)/0.8f,0,1)) : 0;
        p.disp = 1-pr; p.mass = .1f+pr*.42f+ov*.1f; p.rim = pr*.4f; p.tempo = .3f+pr*.25f;
        p.spikeAmp = pr*3; p.agit = pr*.08f; p.wave = lt > 2.6f ? lt-2.6f : -1;
        p.fieldScale = .3f; break; }
      case FS_IDLE:                                     // idle v3 Breathe
        p.spikeAmp = 2+emg*12; p.rim = .28f+emg*.35f; p.agit = .08f+emg*.15f;
        p.fieldScale = .5f; break;
      case FS_LINKED: {                                 // L1 Moon (ferro-v2 l1)
        p.spikeAmp = 2+emg*8; p.rim = .3f+emg*.25f; p.agit = .08f;
        p.moon = smooth(clampf(lt/1.4f,0,1));           // the moon arrives
        p.moonAng = s.t*0.5f; p.fieldScale = .5f; break; }
      case FS_STANDALONE:                               // standalone v3 Drift
        p.disp = .3f; p.mass = .55f; p.rim = .14f; p.tempo = .4f;
        p.spikeAmp = 1+emg*6; p.agit = .05f; p.fieldScale = .4f; break;
      case FS_TELEOP: {                                 // teleop v3 Channel
        float la = -1.5707963f + s.roll*1.2f;
        p.tempo = 1.4f; p.agit = .35f+tq*.3f; p.spikeAmp = 3+tq*14; p.spikeSharp = 1.5f;
        p.elongA = la; p.elongK = .35f+tq*.65f; p.streak = .5f+tq*.5f;
        p.rim = .6f+tq*.4f; p.fieldScale = 1; break; }
      case FS_RECORDING: {                              // recA Witness orbit
        float born = smooth(clampf(lt/1.4f,0,1));
        p.spikeAmp = 2+emg*10; p.rim = .3f+emg*.3f; p.agit = .1f;
        p.orb = 1; p.orbAng = -1.5707963f + lt*.55f; p.orbRad = 40+born*46;
        p.orbSize = 2.5f+born*1.4f;
        p.fillArc = clampf(lt/24.0f, 0, 1); p.wave = lt < 1.2f ? lt : -1;
        p.fieldScale = .5f; break; }
      case FS_SAVED: {                                  // canon-derived: the rejoin
        float u = smooth(clampf(lt/1.4f,0,1));          // witness pinches back in
        p.spikeAmp = 2+emg*8; p.rim = .3f+u*.25f; p.agit = .1f*(1-u);
        p.orb = u < 0.98f ? 1 : 0; p.orbAng = -1.5707963f + lt*.55f;
        p.orbRad = 86*(1-u); p.orbSize = 3.9f-1.4f*u;
        p.fillArc = 1; p.wave = lt < 1.2f ? lt : -1; p.waveDir = 1;
        p.fieldScale = .5f; break; }
      case FS_CALIB: {                                  // calib v3 Settle
        float settle = smooth(clampf(lt/5.0f,0,1));
        p.agit = .5f*(1-settle); p.spikeAmp = (2+emg*10)*(1-settle); p.glass = settle;
        p.tempo = .55f-settle*.42f; p.rim = .2f+settle*.25f;
        p.wave = (lt > 5 && lt < 6.2f) ? lt-5 : -1;
        p.fieldScale = .35f*(1-settle); break; }
      case FS_STOP:                                     // stop v3 Freeze + invert
        p.freeze = 1; p.pale = 1; p.spikeAmp = 9; p.spikeSharp = 1.4f; p.tempo = 0;
        p.rim = .5f; p.glyph = 1; p.blink = 1; p.wave = lt < 1.2f ? lt : -1;
        p.waveDir = -1; p.fieldScale = 0; break;
      case FS_FAULT: {                                  // fault v3 Fracture
        bool major = s.faultSev > 0;
        p.spikeAmp = 1+emg*6; p.agit = major ? .3f : .12f; p.tempo = major ? .85f : .6f;
        p.cracks = major ? .9f : .35f; p.rim = .55f; p.gaps = major ? .5f : .18f;
        p.glyph = major ? 2 : 0; p.fieldScale = .4f; break; }
      case FS_BATTERY: {                                // battery v3 Thin / struggle / feed
        float pct = s.battery < 0 ? 0.5f : s.battery;
        if (s.charging) {                               // the feed phase
          float ch = smooth(clampf(pct, 0, 1));
          p.mass = .18f+ch*.44f; p.tempo = .35f+ch*.2f; p.rim = .3f+ch*.15f;
          p.feed = 1-ch*.5f; p.struggle = .3f*(1-ch); p.fillArc = ch;
          p.spikeAmp = 1+ch*2; p.fieldScale = .3f;
        } else if (pct < 0.10f) {                       // the critical phase
          p.mass = .18f; p.tempo = .3f; p.rim = .4f; p.blink = 1; p.disp = .22f;
          p.struggle = .8f; p.spikeAmp = 1; p.glyph = 3; p.fieldScale = .2f;
        } else {                                        // the thinning phase
          float d = smooth(clampf(1.0f - pct, 0, 1));
          p.mass = .62f-d*.42f; p.tempo = .55f-d*.25f; p.rim = .3f-d*.15f;
          p.spikeAmp = 2*(1-d)+emg*5; p.fieldScale = .4f;
        }
        break; }
      default: break;
    }
  }

  // ---------- the shape: a 140-step radius LUT about a moving centre ----------
  static const int NLUT = 140;
  struct Shape {
    float cx, cy, R;
    float lut[NLUT + 1];
    float inside(float x, float y) const {         // signed px distance (>0 inside)
      float u = x - cx, v = (y - cy) / 0.94f;
      float d = sqrtf(u*u + v*v);
      float a = atan2f(v, u);
      return radiusAt(a) - d;
    }
    float radiusAt(float a) const {
      const float TAUf = 6.2831853f;
      float u = a / TAUf; u -= floorf(u);
      float f = u * NLUT;
      int i = (int)f; if (i >= NLUT) i = NLUT - 1;
      float fr = f - i;
      return lut[i] + (lut[i+1] - lut[i]) * fr;
    }
  };

  // ---------- the body pass: fill + rim + core glow + specular, one sweep ----------
  void drawBody(uint16_t* fb, const Shape& sh, const P& p, uint8_t ar, uint8_t ag, uint8_t ab,
                float t) const {
    // 2-stop radial shading (canvas createRadialGradient(cx-14,cy-18,4, cx,cy,R+14))
    uint8_t c0r,c0g,c0b, c1r,c1g,c1b, c2r,c2g,c2b;
    if (p.pale > 0.5f) { c0r=0xE4;c0g=0xE9;c0b=0xEF; c1r=0xB9;c1g=0xC2;c1b=0xCC; c2r=0x7E;c2g=0x89;c2b=0x94; }
    else               { c0r=0x15;c0g=0x18;c0b=0x1C; c1r=0x0A;c1g=0x0C;c1b=0x0E; c2r=0x04;c2g=0x05;c2b=0x06; }
    const float gx = sh.cx - 14, gy = sh.cy - 18, gR = sh.R + 14 + p.elongK*20;
    const float rimA = p.rim * (p.blink > 0 ? (sinf(t * 6.2831853f * 0.5f) > 0 ? 1.0f : 0.15f) : 1.0f);
    // accent placement is canon "rim"; STOP's pale inversion overrides the hue
    uint8_t rr = ar, rg = ag, rb = ab;
    if (p.pale > 0.5f) { rr = 228; rg = 236; rb = 244; }
    const uint16_t rimCol = WGFX_C565(rr, rg, rb);
    const float coreK = (p.pale > 0.5f) ? 0 : 0;   // placement "core" not selected

    float maxR = 0;
    for (int i = 0; i < NLUT; i++) if (sh.lut[i] > maxR) maxR = sh.lut[i];
    const float pad = 3.0f;
    int x0 = (int)(sh.cx - maxR - pad), x1 = (int)(sh.cx + maxR + pad) + 1;
    int y0 = (int)(sh.cy - (maxR + pad) * 0.94f), y1 = (int)(sh.cy + (maxR + pad) * 0.94f) + 1;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > 239) x1 = 239; if (y1 > 239) y1 = 239;

    for (int y = y0; y <= y1; y++) {
      for (int x = x0; x <= x1; x++) {
        float u = x - sh.cx, v = (y - sh.cy) / 0.94f;
        float d = sqrtf(u*u + v*v);
        if (d > maxR + pad) continue;
        float a = atan2f(v, u);
        float R_a = sh.radiusAt(a);
        float sd = R_a - d;                       // >0 inside
        int idx = y*240 + x;
        if (sd > -0.5f) {                         // body fill with coverage
          float cov = sd >= 0.5f ? 1.0f : (sd + 0.5f);
          // gradient parameter: distance from the highlight focus, normalized
          float hx = x - gx, hy = y - gy;
          float hd = sqrtf(hx*hx + hy*hy);
          float g = (hd - 4.0f) / (gR - 4.0f);
          g = clampf(g, 0, 1);
          uint8_t cr, cg, cb;
          if (p.pale > 0.5f) {                    // stops at 0 / 0.6 / 1
            if (g < 0.6f) { float k = g/0.6f;
              cr = (uint8_t)(c0r + (c1r-c0r)*k); cg = (uint8_t)(c0g + (c1g-c0g)*k); cb = (uint8_t)(c0b + (c1b-c0b)*k);
            } else { float k = (g-0.6f)/0.4f;
              cr = (uint8_t)(c1r + (c2r-c1r)*k); cg = (uint8_t)(c1g + (c2g-c1g)*k); cb = (uint8_t)(c1b + (c2b-c1b)*k); }
          } else {                                // stops at 0 / 0.5 / 1
            if (g < 0.5f) { float k = g/0.5f;
              cr = (uint8_t)(c0r + (c1r-c0r)*k); cg = (uint8_t)(c0g + (c1g-c0g)*k); cb = (uint8_t)(c0b + (c1b-c0b)*k);
            } else { float k = (g-0.5f)/0.5f;
              cr = (uint8_t)(c1r + (c2r-c1r)*k); cg = (uint8_t)(c1g + (c2g-c1g)*k); cb = (uint8_t)(c1b + (c2b-c1b)*k); }
          }
          fb[idx] = wgfx::blendOver(fb[idx], WGFX_C565(cr,cg,cb), (uint8_t)(cov*255));
        }
        // the rim light, same sweep: |d - R(a)| within half the 1.6 px stroke
        float dr = fabsf(sd);
        if (dr <= 1.3f) {
          float cov = dr <= 0.3f ? 1.0f : (1.3f - dr);
          float al = rimA;
          if (p.gaps > 0) {                       // fracture: 8 rim segments flicker
            const float TAUf = 6.2831853f;
            float ua = a / TAUf; ua -= floorf(ua);
            int seg = (int)(ua * 8.0f) & 7;
            bool broken = seg < p.gaps*8 && hashf(seg + floorf(t*7)) > 0.4f;
            if (broken) al *= 0.12f;
          }
          if (al > 0) fb[idx] = wgfx::blendOver(fb[idx], rimCol, (uint8_t)(clampf(cov*al,0,1)*255));
        }
      }
    }
    (void)coreK;
    // the specular ellipse (canvas: rgba(150,190,255, 0.08 + rim*0.10))
    if (p.pale < 0.5f) {
      uint8_t al = (uint8_t)(clampf(0.08f + p.rim*0.10f, 0, 1) * 255);
      wgfx::aaEllipseA(sh.cx - sh.R*0.32f, sh.cy - sh.R*0.42f, sh.R*0.2f, sh.R*0.09f,
                       -0.5f, WGFX_C565(150,190,255), al);
    }
  }

  // ---------- the whole frame ----------
  void draw(uint16_t* fb, const P& p, const DeviceState& s) const {
    const Colorway& cw = CW[cwIdx];
    const uint8_t ar = cw.r, ag = cw.g, ab = cw.b;
    const uint16_t AC = WGFX_C565(ar, ag, ab);
    const float t = s.t;
    const float TAUf = 6.2831853f;

    wgfx::fillScreen565(WGFX_C565(5, 6, 7));               // the near-black field

    // centre + breath (drawFerro, verbatim)
    float cx = 120 + cosf(p.elongA)*p.elongK*14;
    float cy = 122 + sinf(p.elongA)*p.elongK*13;
    const float breath = 1 + 0.045f*(1-p.glass)*(1-p.freeze)*sinf(t*p.tempo*TAUf);
    const float mass = p.mass*(1-p.disp*0.45f);
    const float R = (26 + mass*36)*breath;

    float fAmps[4];
    for (int i = 0; i < 4; i++) fAmps[i] = s.amps[i]*p.fieldScale*(1-p.freeze);
    // ANCHORS: index->pinky across the top arc
    float anchA[4];
    for (int i = 0; i < 4; i++) anchA[i] = -1.5707963f + (i-1.5f)*0.55f;
    for (int i = 0; i < 4; i++) {
      if (fAmps[i] < 0.04f) continue;
      cx += cosf(anchA[i])*fAmps[i]*7;                     // LEAN, <= 7 px per finger
      cy += sinf(anchA[i])*fAmps[i]*7;
    }

    // dispersed droplets (bounded 10) — behind the mass
    if (p.disp > 0.02f) {
      for (int i = 0; i < 10; i++) {
        float a = (float)i/10*TAUf + hashf(i)*2;
        float d = R + 8 + p.disp*(28 + hashf(i+9)*40);
        float dx = cx + cosf(a + t*0.1f*(1-p.freeze))*d;
        float dy = cy + sinf(a + t*0.1f*(1-p.freeze))*d*0.94f;
        float rr = (2 + hashf(i+3)*4)*clampf(p.disp*2,0,1);
        wgfx::aaDiscA(dx, dy, rr, WGFX_C565(0x10,0x13,0x18), 255);
        wgfx::aaCircleA(dx, dy, rr, 0.8f, AC, (uint8_t)(clampf(p.rim*0.3f,0,1)*255));
      }
    }
    // the charge feed (battery)
    if (p.feed > 0.02f) {
      wgfx::aaQuadA(120, 234, 126, 190, cx+2, cy+R-4, 3+p.feed*2, WGFX_C565(16,19,24), 255);
      for (int i = 0; i < 4; i++) {
        float u = fmodf(t*0.5f + (float)i/4, 1.0f);
        float px = 120 + (cx+2-120)*u + 6*sinf(u*6+i);
        float py = 234 - (234-(cy+R-6))*u;
        wgfx::aaDiscA(px, py, 2.5f-u, WGFX_C565(20,25,32), 255);
        wgfx::aaCircleA(px, py, 2.5f-u, 0.8f, AC, (uint8_t)(clampf(0.25f*p.feed*(1-u),0,1)*255));
      }
    }

    // ---- the radius function (rAt in drawFerro), sampled into the LUT ----
    Shape sh; sh.cx = cx; sh.cy = cy; sh.R = R;
    const float spin = p.freeze > 0 ? 1.3f : t*(p.spikeSpin > 0 ? p.spikeSpin : 0.35f);
    for (int k = 0; k <= NLUT; k++) {
      float a = (float)k/NLUT*TAUf;
      float r = R + powf(fabsf(sinf(a*4.5f + spin)), p.spikeSharp*2)*p.spikeAmp*(1-p.glass);
      if (p.agit > 0 && p.freeze <= 0) r += sinf(a*7 + t*6)*p.agit*3*(1-p.glass);
      if (p.freeze > 0) r += (hashf((float)(int)roundf(a/TAUf*140))*2-1)*4.5f*p.freeze;
      if (p.elongK > 0) {
        float d = a - p.elongA;
        float cd = cosf(d);
        float pos = cd > 0 ? cd : 0, neg = cd < 0 ? -cd : 0;
        r += p.elongK*(34*pos*pos + 12*neg*neg);
      }
      if (p.struggle > 0) r += (6*sinf(a*3 - t*2.2f) + 4*sinf(a*5 + t*3.7f))*p.struggle*(1-p.glass);
      // v5 Mass-lobe finger field: gaussian bulge toward the mover, counter-lobe opposite
      float h = 0;
      for (int i = 0; i < 4; i++) {
        float ai = fAmps[i]; if (ai < 0.04f) continue;
        float d = a - anchA[i];
        d = atan2f(sinf(d), cosf(d));
        h += ai*15*expf(-(d*d)/0.55f)*(0.8f + 0.2f*sinf(t*3.2f + i));
        float dop = atan2f(sinf(d+3.14159265f), cosf(d+3.14159265f));
        h -= ai*4*expf(-(dop*dop)/0.8f);
      }
      sh.lut[k] = r + clampf(h, -7, 16)*(1-p.glass);       // SUPERPOSE, clamped
    }

    drawBody(fb, sh, p, ar, ag, ab, t);

    // ---- clipped interior detail: streaks (teleop) and cracks (fault) ----
    if (p.streak > 0) {
      float d = p.elongA;
      for (int i = -1; i <= 1; i++) {
        float ox = -sinf(d)*i*9, oy = cosf(d)*i*9;
        float ph = fmodf(t*1.6f + i*0.33f, 1.0f);
        float u0 = -0.9f + ph*1.4f, u1 = u0 + 0.35f;
        uint8_t al = (uint8_t)(clampf(0.16f*p.streak*(1-fabsf((float)i)*0.3f),0,1)*255);
        clippedSeg(fb, sh,
                   cx + cosf(d)*R*u0 + ox, cy + sinf(d)*R*u0*0.94f + oy,
                   cx + cosf(d)*R*u1 + ox, cy + sinf(d)*R*u1*0.94f + oy, 1.6f, AC, al);
      }
    }
    if (p.cracks > 0) {
      for (int c = 0; c < nCracks; c++) {
        const Crack& cr = cracks[c];
        if (cr.lvl > 0 && p.cracks < 0.45f + cr.lvl*0.2f) continue;
        float flick = hashf(cr.lvl*31 + floorf(t*6)) > 0.25f ? 1.0f : 0.4f;
        float lw = (2.6f - cr.lvl*0.7f)*(0.4f + p.cracks*0.8f);
        for (int k = 1; k < cr.n; k++) {
          float x0 = cx + cr.px[k-1]*R*1.05f, y0 = cy + cr.py[k-1]*R*0.99f;
          float x1 = cx + cr.px[k]*R*1.05f,   y1 = cy + cr.py[k]*R*0.99f;
          clippedSeg(fb, sh, x0, y0, x1, y1, lw, WGFX_C565(3,4,5), (uint8_t)(0.9f*flick*255));
          clippedSeg(fb, sh, x0, y0, x1, y1, 0.8f, AC,
                     (uint8_t)(clampf(0.10f*p.cracks*flick,0,1)*255));
        }
      }
    }

    // ---- the echo ring (breath ghost) ----
    if (p.echo > 0.02f) {
      float eo = 8 + 3*sinf(t*p.tempo*TAUf - 0.9f);
      uint8_t al = (uint8_t)(clampf(0.16f*p.echo,0,1)*255);
      for (int k = 0; k < 90; k++) {
        float a0 = (float)k/90*TAUf, a1 = (float)(k+1)/90*TAUf;
        float r0 = sh.radiusAt(a0)+eo, r1 = sh.radiusAt(a1)+eo;
        wgfx::aaSegA(cx+cosf(a0)*r0, cy+sinf(a0)*r0*0.94f,
                     cx+cosf(a1)*r1, cy+sinf(a1)*r1*0.94f, 1.0f, AC, al);
      }
    }

    // ---- the L1 Moon companion (LINKED) ----
    if (p.moon > 0.01f) {
      float mbr = 1 + 0.045f*sinf(t*0.55f*TAUf);
      float oa = p.moonAng;
      float ox = cx + cosf(oa)*88*p.moon, oy = cy + sinf(oa)*88*0.94f*p.moon;
      float mr = 7*mbr*p.moon;
      wgfx::aaDiscA(ox, oy, mr, WGFX_C565(0x10,0x13,0x18), 255);
      wgfx::aaCircleA(ox, oy, mr, 1.2f, AC, (uint8_t)(0.55f*255));
    }

    // ---- the witness orb (RECORDING / SAVED) ----
    if (p.orb > 0) {
      float oa = p.orbAng, orad = p.orbRad;
      float ox = cx + cosf(oa)*orad, oy = cy + sinf(oa)*orad*0.94f;
      float edge = sh.radiusAt(oa), gap = orad - edge;
      if (gap < 12 && gap > -2) {                          // the pinch-off neck
        float nx = cx + cosf(oa)*edge, ny = cy + sinf(oa)*edge*0.94f;
        wgfx::aaSegA(nx, ny, ox, oy, p.orbSize*1.6f*(1-gap/12), WGFX_C565(0x0A,0x0C,0x0E), 255);
      }
      wgfx::aaDiscA(ox, oy, p.orbSize, WGFX_C565(0x10,0x13,0x18), 255);
      wgfx::aaCircleA(ox, oy, p.orbSize, 1.1f, AC,
                      (uint8_t)(clampf(0.55f + 0.35f*sinf(t*TAUf),0,1)*255));
    }

    // ---- the announcement ring (out = engaging, in = ceasing) ----
    if (p.wave >= 0 && p.wave < 1.2f) {
      float pr = p.wave/1.2f;
      float wr = p.waveDir > 0 ? R + pr*(120-R) : 118 - pr*(118-R);
      wgfx::aaCircleA(120, 120, wr, 2-pr, AC, (uint8_t)(clampf(0.7f*(1-pr),0,1)*255));
    }
    // ---- the progress arc (take length / charge) ----
    if (p.fillArc >= 0) {
      wgfx::aaArcA(120, 120, 112, 2, -1.5707963f, -1.5707963f + p.fillArc*TAUf, AC,
                   (uint8_t)(0.55f*255));
    }
    // ---- the bezel hairline ----
    wgfx::aaCircleA(120, 120, 108, 1, AC, (uint8_t)(0.08f*255));

    // ---- the sanctioned glyph layer (STOP / major FAULT / battery critical) ----
    bool on = p.blink > 0 ? (sinf(t*TAUf*0.5f) > 0) : true;
    if (p.glyph == 1 && on)
      wgfx::aaText(&FreeSansBold12pt7b, "S T O P", 120, 196, WGFX_C565(230,238,246));
    if (p.glyph == 2 && on) {                              // fault triangle
      wgfx::aaSegA(120,184, 128,198, 1.6f, AC, (uint8_t)(0.85f*255));
      wgfx::aaSegA(128,198, 112,198, 1.6f, AC, (uint8_t)(0.85f*255));
      wgfx::aaSegA(112,198, 120,184, 1.6f, AC, (uint8_t)(0.85f*255));
      wgfx::fillRectA(119, 189, 2, 5, AC, (uint8_t)(0.85f*255));
    }
    if (p.glyph == 3 && on) {                              // battery cell
      wgfx::aaSegA(110,190, 128,190, 1.4f, AC, (uint8_t)(0.8f*255));
      wgfx::aaSegA(110,199, 128,199, 1.4f, AC, (uint8_t)(0.8f*255));
      wgfx::aaSegA(110,190, 110,199, 1.4f, AC, (uint8_t)(0.8f*255));
      wgfx::aaSegA(128,190, 128,199, 1.4f, AC, (uint8_t)(0.8f*255));
      wgfx::fillRectA(128, 192, 3, 4, AC, (uint8_t)(0.8f*255));
    }
  }

  // stroke a segment only where it falls inside the body (canvas ctx.clip())
  static void clippedSeg(uint16_t* fb, const Shape& sh, float x0, float y0, float x1, float y1,
                         float lw, uint16_t col, uint8_t alpha) {
    if (alpha == 0) return;
    float hw = lw*0.5f;
    int xlo = (int)((x0<x1?x0:x1) - hw - 1), xhi = (int)((x0>x1?x0:x1) + hw + 1) + 1;
    int ylo = (int)((y0<y1?y0:y1) - hw - 1), yhi = (int)((y0>y1?y0:y1) + hw + 1) + 1;
    if (xlo < 0) xlo = 0; if (ylo < 0) ylo = 0;
    if (xhi > 239) xhi = 239; if (yhi > 239) yhi = 239;
    float vx = x1-x0, vy = y1-y0, vv = vx*vx + vy*vy;
    for (int y = ylo; y <= yhi; y++)
      for (int x = xlo; x <= xhi; x++) {
        if (sh.inside(x, y) < 0) continue;                 // outside the mass: clipped
        float px = x-x0, py = y-y0;
        float u = vv > 0 ? (px*vx + py*vy)/vv : 0;
        u = clampf(u, 0, 1);
        float dx = px - u*vx, dy = py - u*vy, d = sqrtf(dx*dx + dy*dy);
        if (d > hw + 0.5f) continue;
        float cov = d <= hw-0.5f ? 1.0f : (hw+0.5f-d);
        int i = y*240+x;
        fb[i] = wgfx::blendOver(fb[i], col, (uint8_t)(cov*alpha));
      }
  }

  // ---------- the precomputed crack tree (ferro-lang.js CRACKS, verbatim) ----------
  struct Crack { float px[5], py[5]; int n; int lvl; };
  static const int MAXCRACKS = 96;
  static Crack cracks[MAXCRACKS];
  static int nCracks;
  static bool cracksBuilt;
  static int crackId;

  // NOTE: in the JS the counter is a shared closure variable, so a recursive
  // child bumps the id its parent reads on the NEXT loop iteration. crackId is
  // therefore read live (never snapshotted) and incremented after the loop,
  // exactly as `id++` does there — snapshotting it would grow a different tree.
  static void grow(float a0, float r0, int lvl) {
    if (lvl > 2) return;
    float a = a0, r = r0;
    Crack c; c.lvl = lvl; c.n = 0;
    c.px[c.n] = r*cosf(a); c.py[c.n] = r*sinf(a); c.n++;
    for (int i = 0; i < 4; i++) {
      a += (hashf(crackId*13 + i) - .5f)*1.1f;
      r += .22f;
      c.px[c.n] = r*cosf(a); c.py[c.n] = r*sinf(a); c.n++;
      if (hashf(crackId*7 + i) > .62f)
        grow(a + (hashf(crackId + i) > .5f ? .9f : -.9f), r, lvl + 1);
    }
    if (nCracks < MAXCRACKS) cracks[nCracks++] = c;
    crackId++;
  }
  static void buildCracks() {
    nCracks = 0; crackId = 0;
    grow(0.4f, .05f, 0); grow(2.5f, .05f, 0); grow(4.6f, .05f, 0);
  }

  int cwIdx = 0;
  static const Colorway CW[8];
};

FaceFerro::Crack FaceFerro::cracks[FaceFerro::MAXCRACKS];
int  FaceFerro::nCracks = 0;
bool FaceFerro::cracksBuilt = false;
int  FaceFerro::crackId = 0;

// The eight explored colorways, canon order preserved except that Electric
// Blue is first so index 0 is the canon default accent (FERRO-SPEC "Accent
// rule"). Notes are the gallery's own panel observations.
const Colorway FaceFerro::CW[8] = {
  { "electric-blue", "Electric Blue", 46,123,255, true,
    "Canon accent. Proven contrast; thin 1 px lines shimmer slightly at 240 px." },
  { "ember",         "Ember",        255,122, 46, false,
    "Strong vs black; STOP ring reads alarm-adjacent. Panel-safe." },
  { "pale-gold",     "Pale Gold",    232,196,120, false,
    "Elegant, quiet; low-alpha strokes wash out on a cheap LCD. [panel-risk]" },
  { "deep-red",      "Deep Red",     206, 44, 40, false,
    "Reads alarm everywhere: STOP superb, RECORDING ominous. Semantic tension." },
  { "acid-green",    "Acid Green",   154,235, 60, false,
    "Maximum contrast, lab-instrument feel; loud, spends the calm budget fast." },
  { "violet",        "Violet",       158,110,255, false,
    "Deep tones die near black on cheap panels; keep alpha high. [panel-risk]" },
  { "ice",           "Ice",          224,238,248, false,
    "Always legible, but the accent reads structural and STOP's pale inversion loses contrast." },
  { "copper-rose",   "Copper Rose",  226,138,116, false,
    "Wildcard: warm, humane, mid contrast; makes the machine feel inhabited." },
};
