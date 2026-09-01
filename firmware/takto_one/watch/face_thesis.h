// face_thesis.h — FACE 1: THESIS. A PRESERVATION PORT, not an improvement.
//
// Every painter below is moved verbatim from
// Working/Firmware-and-Code/DeviceFirmware/DeviceFirmware.ino (the on-wrist UI
// as submitted): same geometry, same constants, same quantized animation
// phases. The only mechanical changes are (a) millis() becomes the engine's
// state clock, (b) the palette is indirected through a Palette struct so a
// colorway can be selected, and (c) the paint signature moved into
// signature(). The host fidelity test (host/fidelity_test.cpp) CRC-compares a
// verbatim legacy copy of the sketch's painters against this port, state by
// state, and fails on any pixel difference.
//
// Colorway note: "Sapphire Depth" is the ORIGINAL palette and the only
// canonical one. The two extras are explicitly non-canonical recolors; they
// change nothing but the six palette entries.
//
// One honest exception: the submitted firmware has NO battery screen (the
// device has no fuel gauge). FS_BATTERY is rendered here with the thesis
// face's own vocabulary (uiRingArc + the caption pair) so the state set is
// complete. It is an engine-era addition and is labelled as such in
// FACE-ENGINE.md; it is excluded from the pixel-fidelity CRC set because
// there is no original to be faithful to.
#pragma once
#include "watch_state.h"
#include "watch_gfx.h"

// The precomputed vignette is 115 kB. The submitted firmware kept it in the
// Teensy's second RAM bank (DMAMEM) and so does the engine, which is why it is
// a file-scope buffer rather than a class member: DMAMEM cannot be applied to
// one. There is exactly one FaceThesis, so nothing is shared that should not be.
#if defined(__IMXRT1062__)
DMAMEM uint16_t thesisBgCache[240 * 240];
#else
static uint16_t thesisBgCache[240 * 240];
#endif

class FaceThesis : public WatchFace {
public:
  struct Palette {
    uint16_t bg, ring, text, dim, faint, acc, ok, warn, stop;
    uint16_t saph, saphDim, ice, gold, goldDim, coral, maroon, warm;
  };

  const char* id() const override { return "thesis"; }
  // Keep the established wire id for backward compatibility, but present this
  // single production face as TAKTO rather than as a thesis-era variant.
  const char* name() const override { return "Takto"; }
  int nColorways() const override { return 3; }
  const Colorway& colorway(int i) const override { return CW[i < 0 || i >= N_COLORWAYS ? 0 : i]; }

  void init(int idx) override {
    cwIdx = (idx < 0 || idx >= N_COLORWAYS) ? 0 : idx;
    P = PALETTES[cwIdx];
  }

  void render(uint16_t* fb, const DeviceState& s) override {
    wgfx::FB = fb;
    paintBg(fb);
    const uint32_t ms = (uint32_t)(s.t * 1000.0f);
    switch (s.state) {
      case FS_BOOT:       scConnecting(ms); break;
      // The connection field is now the one shared home screen. It reuses the
      // submitted Thesis geometry, with the panel-safe refined sweep; state
      // detail remains in the dedicated operator/calibration/capture screens.
      case FS_IDLE:
      case FS_STANDALONE: scConnecting(ms); break;
      case FS_FAULT:      scHome(ms, s.imuOk, s.encOk, s.emgOk, s.motOk, s.link); break;
      case FS_TELEOP:     scTransparent(s.emg); break;
      case FS_RECORDING:  scCapture(ms, s.capSec); break;
      case FS_LINKED:     scOperator(s.imuOk, s.encOk, s.motOk, s.link); break;
      case FS_SAVED:      scSaved(); break;
      // Calibration is an operator action, not a separate user-facing watch
      // page. Keep the display calm and consistent while it runs.
      case FS_CALIB:      scConnecting(ms); break;
      case FS_BATTERY:    scBattery(ms, s.battery, s.charging); break;
      default:            scSafe(ms); break;   // FS_STOP
    }
  }

  // the sketch's paint signature, verbatim in spirit: quantized animation
  // phases plus every displayed value
  uint32_t signature(const DeviceState& s) const override {
    const uint32_t ms = (uint32_t)(s.t * 1000.0f);
    uint32_t sig = (uint32_t)s.state << 26;
    switch (s.state) {
      // One signature per panel-safe visual sample.  Do not reduce this to a
      // 360-phase loop: the connection marker advances fractionally and must
      // never land on an old signature while visibly elsewhere on the ring.
      case FS_BOOT:      sig |= (ms / 60) & 0x03FFFFFFu; break;
      case FS_IDLE:
      case FS_STANDALONE:sig |= (ms / 60) & 0x03FFFFFFu; break;
      case FS_FAULT:     sig |= ((ms / 210) % 6)
                              | (uint32_t)s.imuOk << 4 | (uint32_t)s.encOk << 5
                              | (uint32_t)s.emgOk << 6 | (uint32_t)s.motOk << 7
                              | (uint32_t)s.link  << 8; break;
      case FS_TELEOP:    sig |= (uint32_t)(s.emg * 100.0f + 0.5f); break;
      case FS_RECORDING: sig |= ((uint32_t)s.capSec & 0xFFFF) | (((ms / 180) % 6) << 16); break;
      case FS_STOP:      sig |= (ms / 500) % 2; break;
      case FS_BATTERY:   sig |= (uint32_t)(s.battery * 100.0f + 0.5f)
                              | ((uint32_t)s.charging << 8) | (((ms / 300) % 6) << 9); break;
      case FS_CALIB:     sig |= (ms / 60) & 0x03FFFFFFu; break;
      default: break;                        // LINKED / SAVED: static
    }
    return sig;
  }

private:
  int cwIdx = 0;
  Palette P;
  int bgCachedFor = -1;

  void paintBg(uint16_t* fb) {
    if (bgCachedFor != cwIdx) { buildBgFor(cwIdx); bgCachedFor = cwIdx; }
    memcpy(fb, thesisBgCache, sizeof thesisBgCache);
  }
  // the canonical vignette is the sketch's buildBg(); recolors tint it in the
  // same shape so no hard edges appear
  void buildBgFor(int idx) {
    wgfx::buildBg(thesisBgCache);
    if (idx == 0) return;
    for (int i = 0; i < 240*240; i++) {
      uint16_t c = thesisBgCache[i];
      // work in a common 0..31 space, then re-tint by luminance so the
      // vignette keeps its exact shape and only its hue changes
      int rn = (c >> 11) & 0x1F, gn = ((c >> 5) & 0x3F) >> 1, bn = c & 0x1F;
      int lum = (rn*3 + gn*6 + bn) / 10;
      int r, g, b;
      switch (idx) {
        case 1: r = lum; g = lum * 2; b = lum; break;                   // graphite
        case 2: r = lum * 3 / 2; if (r > 31) r = 31;                    // amber
                g = lum * 2 * 9 / 10; if (g > 63) g = 63; b = lum * 2 / 5; break;
        case 3: r = lum / 2; g = lum * 2; if (g > 63) g = 63;           // sea
                b = lum * 3 / 2; if (b > 31) b = 31; break;
        case 4: r = lum * 3 / 2; if (r > 31) r = 31;                    // violet
                g = lum / 2; b = lum * 2; if (b > 31) b = 31; break;
        default:r = lum; g = lum * 2; if (g > 63) g = 63;               // ice
                b = lum * 2; if (b > 31) b = 31; break;
      }
      thesisBgCache[i] = (uint16_t)((r << 11) | (g << 5) | b);
    }
  }

  // ---- Sapphire Depth painters (verbatim from the sketch) ----
  void uiDial(uint8_t bright) {
    for (int i = 0; i < 16; i++) {
      float a = i * 22.5f;
      float rad = (a - 90.0f) * wgfx::S_DR;
      float c = cosf(rad), s = sinf(rad);
      uint16_t col = (i % 4 == 0) ? P.saph : P.saphDim;
      if (bright < 200 && (i % 4)) col = P.saphDim;
      wgfx::aaLine((int)(wgfx::SCX + 102*c), (int)(wgfx::SCY + 102*s),
                   (int)(wgfx::SCX + 108*c), (int)(wgfx::SCY + 108*s), 0.9f, col);
    }
  }
  void uiRingArc(float frac, uint16_t col, uint16_t dim, uint16_t hot, float hw) {
    if (frac < 0.004f) frac = 0.004f;
    if (frac > 1.0f) frac = 1.0f;
    wgfx::aaArc(98, hw, 0, 360, dim, 0);
    float sweep = frac * 360.0f;
    wgfx::aaArc(98, hw, 0, sweep, col, 4.5f);
    float hotFrom = sweep > 26 ? sweep - 26 : 0;
    wgfx::aaArc(98, hw * 0.55f, hotFrom, sweep, hot, 3.0f);
    float rad = (sweep - 90.0f) * wgfx::S_DR;
    wgfx::aaDisc((int)(wgfx::SCX + 98*cosf(rad)), (int)(wgfx::SCY + 98*sinf(rad)),
                 hw * 0.6f + 1.2f, P.ice, 5);
  }
  void takoMark(int cx, int cy, uint16_t col) {
    int bars[5] = {9, 17, 24, 17, 9}, bw = 4, gap = 5, tw = 5*bw + 4*gap, bx = cx - tw/2;
    for (int i = 0; i < 5; i++) {
      int h = bars[i], x = bx + bw/2, y0 = cy - h/2, y1 = cy + h/2;
      wgfx::aaLine(x, y0, x, y1, bw/2.0f, i == 3 ? P.acc : col);
      bx += bw + gap;
    }
  }
  void scConnecting(uint32_t ms) {
    // The physical panel receives this at 16.7 Hz.  A full degree per sample
    // displaced the tip ~1.7 px at r=98 and read as a series of jumps.  At
    // 0.6 degree/sample it advances ~1 px per displayed frame: visibly alive,
    // but continuous rather than a stuttering sweep.  The 62-degree wedge is
    // still all we repaint; the renderer never touches a full animated ring.
    const float a = fmodf((float)ms * 0.010f, 360.0f);
    wgfx::aaArcSegment(98, 1.5f, a, 62, P.saph, 2);
    float rad = (a + 62 - 90.0f) * wgfx::S_DR;
    wgfx::aaDisc((int)(wgfx::SCX + 98*cosf(rad)), (int)(wgfx::SCY + 98*sinf(rad)), 2.2f, P.acc, 2);
    wgfx::aaLine(wgfx::SCX, wgfx::SCY-42, wgfx::SCX+42, wgfx::SCY, 1.1f, P.saph);
    wgfx::aaLine(wgfx::SCX+42, wgfx::SCY, wgfx::SCX, wgfx::SCY+42, 1.1f, P.saph);
    wgfx::aaLine(wgfx::SCX, wgfx::SCY+42, wgfx::SCX-42, wgfx::SCY, 1.1f, P.saph);
    wgfx::aaLine(wgfx::SCX-42, wgfx::SCY, wgfx::SCX, wgfx::SCY-42, 1.1f, P.saph);
    wgfx::aaDisc(wgfx::SCX, wgfx::SCY-42, 6.5f, P.saph, 3);
    wgfx::aaDisc(wgfx::SCX+42, wgfx::SCY, 6.5f, P.saph, 3);
    wgfx::aaDisc(wgfx::SCX, wgfx::SCY+42, 6.5f, P.saph, 3);
    wgfx::aaDisc(wgfx::SCX-42, wgfx::SCY, 6.5f, P.saph, 3);
    wgfx::aaDisc(wgfx::SCX, wgfx::SCY, 9, P.saph, 3.0f);
  }
  void scHome(uint32_t ms, bool imu, bool enc, bool emg, bool mot, bool lnk) {
    bool healthy = imu && enc && lnk;
    uiDial(255);
    takoMark(wgfx::SCX, wgfx::SCY - 64, P.saph);
    uint8_t ph = (ms / 210) % 6;
    wgfx::aaDisc(wgfx::SCX, wgfx::SCY, 10, healthy ? P.acc : P.gold, 7.0f + 2.0f * (ph < 3 ? ph : 6 - ph));
    bool ok[5] = { imu, enc, emg, mot, lnk };
    const char* L[5] = { "IMU", "ENC", "EMG", "MOT", "LNK" };
    const uint8_t slot[5] = { 2, 3, 1, 0, 4 };
    char down[16]; down[0] = 0;
    for (int i = 0; i < 5; i++) {
      float a = 1.5708f + slot[i] * 1.2566f;
      int x = (int)(wgfx::SCX + 44 * cosf(a)), y = (int)(wgfx::SCY + 44 * sinf(a));
      if (ok[i]) { wgfx::aaDisc(x, y, 4.4f, P.acc, 7); }
      else if (i == 3) {
        wgfx::aaDisc(x, y, 4.4f, P.gold, 2); wgfx::aaDisc(x, y, 2.4f, P.bg, 0);
      } else {
        wgfx::aaDisc(x, y, 4.4f, P.coral, 2); wgfx::aaDisc(x, y, 2.4f, P.maroon, 0);
        if (down[0]) strncat(down, "  ", sizeof(down) - strlen(down) - 1);
        strncat(down, L[i], sizeof(down) - strlen(down) - 1);
      }
    }
    if (down[0]) wgfx::aaText(&FreeSans9pt7b, down, wgfx::SCX, wgfx::SCY + 70, P.coral);
  }
  void scTransparent(float eff) {
    uiRingArc(eff, P.saph, P.saphDim, P.acc, 5.0f);
    char buf[8]; snprintf(buf, sizeof buf, "%d", (int)roundf(eff * 100));
    wgfx::aaText(&FreeSansBold24pt7b, buf, wgfx::SCX - 8, wgfx::SCY, P.text);
    wgfx::aaText(&FreeSansBold12pt7b, "%", wgfx::SCX + (eff >= 0.995f ? 52 : 40), wgfx::SCY + 12, P.acc);
  }
  void scCapture(uint32_t ms, long sec) {
    uiRingArc((sec % 60) / 60.0f, P.saph, P.saphDim, P.acc, 1.5f);
    uint8_t ph = (ms / 180) % 6;
    wgfx::aaDisc(wgfx::SCX - 62, wgfx::SCY, 8, P.acc, 7.0f + 2.0f * (ph < 3 ? ph : 6 - ph));
    char buf[16]; snprintf(buf, sizeof buf, "%02ld:%02ld", sec/60, sec%60);
    wgfx::aaText(&FreeSansBold24pt7b, buf, wgfx::SCX + 12, wgfx::SCY, P.text);
  }
  // The console and wrist screen share this single connection state: a clear
  // word for the wearer, plus four quiet lamps for the streams that make that
  // claim true (IMU, encoders, motors, link).
  void scOperator(bool imu, bool enc, bool mot, bool lnk) {
    uiRingArc(1.0f, P.saph, P.saphDim, P.saph, 1.5f);
    wgfx::aaText(&FreeSansBold12pt7b, "CONNECTED", wgfx::SCX, wgfx::SCY - 8, P.text);
    const bool ok[4] = { imu, enc, mot, lnk };
    for (int i = 0; i < 4; i++) {
      const int x = wgfx::SCX - 30 + i * 20;
      wgfx::aaDisc(x, wgfx::SCY + 28, 4.0f, ok[i] ? P.ok : P.stop, ok[i] ? 4 : 1);
    }
  }
  void scSaved() {
    uiRingArc(1.0f, P.saph, P.saphDim, P.acc, 5.0f);
    wgfx::aaLine(wgfx::SCX-14, wgfx::SCY-14, wgfx::SCX-3, wgfx::SCY-3, 2.2f, P.saph);
    wgfx::aaLine(wgfx::SCX-3, wgfx::SCY-3, wgfx::SCX+17, wgfx::SCY-27, 2.2f, P.saph);
    wgfx::aaText(&FreeSansBold12pt7b, "Done", wgfx::SCX, wgfx::SCY + 30, P.text);
  }
  void scCalib() {
    uiRingArc(0.34f, P.gold, P.goldDim, P.gold, 5.0f);
    wgfx::aaText(&FreeSansBold12pt7b, "Open", wgfx::SCX, wgfx::SCY - 12, P.text);
    wgfx::aaText(&FreeSans9pt7b, "then close", wgfx::SCX, wgfx::SCY + 18, P.dim);
  }
  void scSafe(uint32_t ms) {
    bool on = (ms / 500) % 2 == 0;
    uiRingArc(1.0f, on ? P.coral : P.maroon, P.maroon, P.coral, 1.5f);
    float pts[8][2];
    for (int k = 0; k < 8; k++) {
      float a = 22.5f + k * 45.0f;
      pts[k][0] = wgfx::SCX + 34*cosf(a*wgfx::S_DR); pts[k][1] = wgfx::SCY - 14 + 34*sinf(a*wgfx::S_DR);
    }
    for (int k = 0; k < 8; k++) {
      int n = (k + 1) % 8;
      wgfx::aaLine((int)pts[k][0], (int)pts[k][1], (int)pts[n][0], (int)pts[n][1], 1.6f, P.coral);
    }
    wgfx::aaText(&FreeSansBold12pt7b, "Stop", wgfx::SCX, wgfx::SCY + 42, P.text);
  }
  // engine-era addition (no original): the ring IS the charge, gold below 20 %,
  // the azure feed dot climbs while charging
  void scBattery(uint32_t ms, float pct, bool charging) {
    if (pct < 0) pct = 0;
    bool low = pct < 0.2f;
    uiRingArc(pct, low ? P.gold : P.saph, low ? P.goldDim : P.saphDim,
              low ? P.gold : P.acc, 5.0f);
    char buf[8]; snprintf(buf, sizeof buf, "%d", (int)roundf(pct * 100));
    wgfx::aaText(&FreeSansBold24pt7b, buf, wgfx::SCX - 8, wgfx::SCY, P.text);
    wgfx::aaText(&FreeSansBold12pt7b, "%", wgfx::SCX + (pct >= 0.995f ? 52 : 40), wgfx::SCY + 12,
                 low ? P.gold : P.acc);
    if (charging) {
      uint8_t ph = (ms / 300) % 6;
      wgfx::aaDisc(wgfx::SCX, wgfx::SCY + 52, 4.0f, P.acc, 4.0f + 2.0f * (ph < 3 ? ph : 6 - ph));
    }
  }

  // ---- palettes ----
  static const uint8_t N_COLORWAYS = 6;
  static const Colorway CW[N_COLORWAYS];
  static const Palette PALETTES[N_COLORWAYS];
};

#define WGFX_T565(r,g,b) WGFX_C565(r,g,b)
const Colorway FaceThesis::CW[N_COLORWAYS] = {
  { "sapphire", "Sapphire Depth", 102, 184, 255, true,
    "The palette as submitted. The only canonical thesis colorway." },
  { "graphite", "Graphite",       150, 165, 180, false,
    "Non-canonical recolor. Not the documented look." },
  { "amber",    "Amber",          226, 160,  80, false,
    "Non-canonical recolor. Not the documented look." },
  { "sea",      "Sea Glass",       79, 168, 160, false,
    "Muted teal, tuned for restrained contrast on the round panel." },
  { "violet",   "Violet",         158, 110, 255, false,
    "Deep violet with a high-contrast connection marker." },
  { "ice",      "Ice",            210, 235, 255, false,
    "Cool white-blue for bright, clean legibility." },
};
const FaceThesis::Palette FaceThesis::PALETTES[N_COLORWAYS] = {
  // Sapphire Depth — the thesis original, byte for byte
  { WGFX_T565(14,20,30), WGFX_T565(30,38,55), WGFX_T565(237,242,249), WGFX_T565(128,145,168),
    WGFX_T565(74,86,107), WGFX_T565(102,184,255), WGFX_T565(76,201,141), WGFX_T565(232,177,78),
    WGFX_T565(244,86,77), WGFX_T565(40,104,184), WGFX_T565(18,45,80), WGFX_T565(217,237,255),
    WGFX_T565(212,164,88), WGFX_T565(90,70,38), WGFX_T565(255,138,128), WGFX_T565(92,43,46),
    WGFX_T565(163,156,141) },
  // Graphite (non-canonical)
  { WGFX_T565(18,19,21), WGFX_T565(44,46,50), WGFX_T565(238,240,243), WGFX_T565(140,146,154),
    WGFX_T565(84,88,94), WGFX_T565(196,204,214), WGFX_T565(120,190,160), WGFX_T565(222,186,110),
    WGFX_T565(238,110,100), WGFX_T565(120,128,138), WGFX_T565(48,52,58), WGFX_T565(240,244,248),
    WGFX_T565(200,178,120), WGFX_T565(78,70,52), WGFX_T565(240,150,140), WGFX_T565(86,52,50),
    WGFX_T565(168,164,156) },
  // Amber (non-canonical)
  { WGFX_T565(24,17,10), WGFX_T565(58,42,26), WGFX_T565(250,242,230), WGFX_T565(178,152,118),
    WGFX_T565(104,84,60), WGFX_T565(255,178,72), WGFX_T565(150,196,120), WGFX_T565(240,196,96),
    WGFX_T565(244,110,72), WGFX_T565(196,124,44), WGFX_T565(84,52,18), WGFX_T565(255,236,206),
    WGFX_T565(226,180,96), WGFX_T565(96,74,34), WGFX_T565(255,150,110), WGFX_T565(96,48,34),
    WGFX_T565(182,166,140) },
  // Sea Glass
  { WGFX_T565(8,22,24), WGFX_T565(18,54,56), WGFX_T565(232,247,246), WGFX_T565(126,160,160),
    WGFX_T565(62,98,100), WGFX_T565(79,168,160), WGFX_T565(116,208,174), WGFX_T565(224,186,94),
    WGFX_T565(242,104,92), WGFX_T565(26,104,104), WGFX_T565(12,48,50), WGFX_T565(205,244,239),
    WGFX_T565(190,172,94), WGFX_T565(64,64,38), WGFX_T565(255,144,130), WGFX_T565(86,42,42),
    WGFX_T565(150,168,156) },
  // Violet
  { WGFX_T565(18,11,29), WGFX_T565(48,31,72), WGFX_T565(245,240,255), WGFX_T565(166,144,196),
    WGFX_T565(98,78,128), WGFX_T565(158,110,255), WGFX_T565(110,206,166), WGFX_T565(238,182,88),
    WGFX_T565(246,102,100), WGFX_T565(74,44,148), WGFX_T565(36,22,72), WGFX_T565(228,214,255),
    WGFX_T565(212,172,100), WGFX_T565(80,60,44), WGFX_T565(255,142,150), WGFX_T565(94,42,62),
    WGFX_T565(176,156,194) },
  // Ice
  { WGFX_T565(12,20,28), WGFX_T565(34,54,70), WGFX_T565(246,250,255), WGFX_T565(156,178,196),
    WGFX_T565(88,112,132), WGFX_T565(210,235,255), WGFX_T565(118,204,174), WGFX_T565(236,190,92),
    WGFX_T565(246,106,96), WGFX_T565(92,132,170), WGFX_T565(24,54,82), WGFX_T565(232,247,255),
    WGFX_T565(210,184,110), WGFX_T565(72,66,48), WGFX_T565(255,150,142), WGFX_T565(86,46,54),
    WGFX_T565(174,186,194) },
};
