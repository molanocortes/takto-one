// face_rams.h — FACE 3: RAMS. A precision INSTRUMENT to Ferro's organism.
//
// Design brief (mine, then programmed): Dieter Rams / Braun instrument
// language. Functional, unobtrusive, thorough to the last detail, as little
// design as possible. Where Ferro is one continuous body that deforms, Rams is
// a panel of separate, labelled readouts, each doing exactly one job. Nothing
// decorative moves; every motion is a measurement.
//
// ============================================================================
//                            THE SYSTEM
// Sizes and spacing are not chosen per element. Everything below comes from
// four rules, and any state added later inherits them.
// ============================================================================
//
// 1. THE SPACING SCALE.  One base unit U = 4 px at 240 px (1 U is 0.54 mm on
//    the real 32.5 mm panel). Every margin, gap and inset is a member of
//    {4, 8, 12, 16, 24, 32}. There are no ad-hoc values: if a gap is not on
//    the scale it is a bug. Named GAP_S / GAP_M / GAP_L / GAP_XL below.
//
// 2. THE TYPE AND ELEMENT SCALE.  At 240 px there is room for two text sizes,
//    not three. DISPLAY is FreeSansBold24pt (measured cap height 35 px) and
//    LABEL is FreeSans9pt (measured cap height 13 px); the ratio between them
//    is 2.69, and it is the same ratio that sets the element sizes, which step
//    8 / 12 / 16 / 20 px off the spacing scale. The 12 pt face is deliberately
//    unused here: a third size at this diameter reads as an accident.
//
// 3. THE ROUND-CANVAS RULE.  R_EDGE is 120. R_SAFE is 106, an 11.7 % radial
//    inset, and NOTHING informational is drawn outside it. Composition is
//    CENTRE-OUT, never a rectangle cropped by a circle: the primary numeral
//    sits on the exact geometric centre, the mode word and caption sit on the
//    vertical axis above and below it, and every secondary readout lives on a
//    ring or an arc, because the circle is this face's natural grid. The
//    gauge's own 90-degree dead sector at the bottom is not empty space, it is
//    where the per-finger arc lives.
//
// 4. HAIRLINE REALITY.  The panel is 240 px across 32.5 mm, so 1 px is
//    0.135 mm, which at a 35 cm wrist glance subtends about 1.3 arcminutes and
//    is at the limit of what the eye resolves. No stroke is therefore thinner
//    than W_HAIR = 1.5 px, ticks are 2 px and 3 px, the index is 6 px, and the
//    smallest text is LABEL at a 13 px cap (about 17 arcminutes), which is
//    comfortably legible. Anything that would need to be finer is not drawn.
//
// 5. LESS, BUT BETTER.  Where a state was still tight after the system was
//    applied, the fix was removal, not compression. Three things went:
//      - the twelve per-joint bars became FOUR per-finger bars. Twelve bars in
//        13 mm is 1.08 mm each, which mushes into a grey block at arm's length;
//        four bars read as the hand's posture at a glance, and the per-joint
//        detail already lives in the console where it can be seen.
//      - the "EMG" caption went entirely. It cost a row of its own, and moving
//        it inline pushed the meter off the vertical axis; an axis that bends
//        for a three-letter caption is not a system. The meter's fixed position
//        under the value, its track and its mid-scale hairline identify it.
//      - the ring numerals (0 / 50 / 100) went: the five majors already state
//        the scale and the centre numeral already states the value.
//
// 6. ONE DISCIPLINED ACCENT.  The accent marks the STATE, never a routine
//    reading. It is spent on the state arc, the engaged index, the record
//    square, the fault hatch and a low battery, and on nothing else. The EMG
//    meter and the finger bars are continuous secondary readouts and are drawn
//    in INK_DIM: as full-width accent they out-shouted the primary numeral in
//    the squint test, which is the wrong hierarchy however pretty it looked.
//
// ---------------------------------------------------------------------------
// THE GRID that falls out of those rules (all measured from the centre):
//   r 106        the scale rule, a hairline arc over the 270 deg sweep. The
//                same radius carries the state arc (elapsed, progress, work
//                sector), so a filling instrument thickens its own rule
//                instead of introducing another ring.
//   r 96..106    21 scale ticks, every fifth a major.
//   r 78..94     THE INDEX, one bold radial bar riding the scale. This is the
//                needle, shortened to the ring so the dial face stays free.
//   y 50..62     five 12 px status squares (IMU ENC EMG MOT LNK). Filled =
//                present, hollow = absent: absence is a SHAPE difference, not a
//                colour. 8 px was tried first and the filled/hollow difference
//                stopped resolving at 32.5 mm, so the element grew to the next
//                step on the scale rather than staying pretty and unreadable.
//   y 80         the mode word, tracked LABEL caps. One word, always present.
//   y 120        THE PRIMARY NUMERAL, DISPLAY, on the exact centre.
//   y 160        the caption naming what the numeral is.
//   y 178..186   the EMG meter: a 96 x 8 level bar centred ON the axis, with a
//                track and a mid-scale hairline, and no caption. The one
//                cartesian instrument on a polar face, so it never reads as
//                part of the dial.
//   60..120 deg  the per-finger arc in the gauge's dead sector: four FLAT-CAPPED
//                radial bars in a dim full-length seat, growing inward from
//                r 104, index to pinky and left to right (the sector sweeps
//                right-to-left on screen, so it is indexed backwards). Round
//                caps were tried and read as teeth: a 20 px bar with a 12 px
//                round cap draws 32 px long and stops being a bar. In
//                FS_BATTERY the sector becomes ten charge segments and in a
//                major fault a hatched band, so it always answers exactly one
//                question.
//
// MOTION IS INFORMATION
//   idle      the index breathes at 0.5 Hz (alive, at rest)
//   working   the index stops breathing and goes accent (steady = engaged)
//   teleop    a second, hollow index marks commanded torque; the rule between
//             the two indices fills, and that gap IS the work
//   record    a 1 Hz accent square beside the word; the rule fills with elapsed
//   calib     the index sweeps; the captured span grows along the rule
//   fault     the failing lamp blinks; a major fault hatches the finger arc
//   stop      the panel is replaced by a solid alarm field. Absolute.
//
// COLOUR: near-monochrome (near-black ground, warm grey structure, off-white
// text) with ONE accent. STOP is the single documented exception: it uses a
// dedicated alarm red regardless of colorway, because an e-stop that changes
// appearance with a user preference is not an e-stop.
#pragma once
#include "watch_state.h"
#include "watch_gfx.h"

class FaceRams : public WatchFace {
public:
  const char* id() const override { return "rams"; }
  const char* name() const override { return "Rams"; }
  int nColorways() const override { return 3; }
  const Colorway& colorway(int i) const override { return CW[(i < 0 || i > 2) ? 0 : i]; }

  void init(int idx) override {
    cwIdx = (idx < 0 || idx > 2) ? 0 : idx;
    const Colorway& c = CW[cwIdx];
    ACC = WGFX_C565(c.r, c.g, c.b);
    ACC_DIM = WGFX_C565(c.r/3, c.g/3, c.b/3);
  }

  void render(uint16_t* fb, const DeviceState& s) override {
    wgfx::FB = fb;
    if (s.state == FS_STOP) { drawStop(s); return; }
    wgfx::fillScreen565(GROUND);
    drawScale(s);
    drawLamps(s);
    drawWord(s);
    drawNumeral(s);
    drawMeter(s);
    drawSector(s);          // the dead sector: fingers, charge, or a warning
    drawIndex(s);
  }

  uint32_t signature(const DeviceState& s) const override {
    uint32_t sig = (uint32_t)s.state << 27;
    // every readout is quantized to what the panel can actually resolve: the
    // index to half a degree of deflection, the meter and the finger bars to
    // their pixel height. A still hand therefore paints nothing.
    sig ^= (uint32_t)(primary(s) * 540.0f) & 0x3FF;         // index angle
    sig ^= ((uint32_t)(s.emg * (float)METER_W) & 0x7F) << 10;
    uint32_t bars = 0;
    for (int f = 0; f < 4; f++) {
      float v = finger(s, f);
      bars = bars*31u + (uint32_t)((v < 0 ? 0 : v) * (float)BAR_LEN);
    }
    sig ^= (bars & 0xFFF) << 17;
    sig ^= ((uint32_t)s.imuOk | (uint32_t)s.encOk<<1 | (uint32_t)s.emgOk<<2
          | (uint32_t)s.motOk<<3 | (uint32_t)s.link<<4) << 4;
    switch (s.state) {
      case FS_IDLE: case FS_STANDALONE:
        sig ^= (uint32_t)(s.t * 12.0f) << 12; break;        // the breathing index
      case FS_RECORDING:
        sig ^= ((uint32_t)s.capSec << 12) ^ ((uint32_t)(s.t*2.0f) << 24); break;
      case FS_BOOT:
        sig ^= (uint32_t)(s.stateT * 30.0f) << 12; break;   // the self-test sweep
      case FS_CALIB:
        sig ^= (uint32_t)(s.stateT * 20.0f) << 12; break;
      case FS_TELEOP:
        sig ^= (uint32_t)(s.torque * 540.0f) << 12; break;
      case FS_FAULT:
        sig ^= (uint32_t)(s.t * 2.0f) << 12; break;         // the blink
      case FS_BATTERY:
        sig ^= ((uint32_t)(s.battery*100.0f) << 12) ^ ((uint32_t)s.charging << 25)
             ^ ((uint32_t)(s.t*2.0f) << 26); break;
      default: break;
    }
    return sig;
  }

private:
  // ---- 1. THE SPACING SCALE (base unit U; nothing off this scale) ----------
  static const int U     = 4;
  static const int GAP_S = 2*U;      //  8
  static const int GAP_M = 3*U;      // 12
  static const int GAP_L = 4*U;      // 16
  static const int GAP_XL= 6*U;      // 24

  // ---- 2. TYPE + ELEMENT SCALE (measured cap heights) ---------------------
  static const int CAP_DISPLAY = 35; // FreeSansBold24pt7b
  static const int CAP_LABEL   = 13; // FreeSans9pt7b
  static const int TRACK       = 2;  // label letterspacing, 0.5 U
  static const int E_LAMP      = 3*U;      // 12; at 8 the filled/hollow
                                           // distinction stops resolving at 32.5 mm
  static const int E_METER_H   = 2*U;      //  8
  static const int BAR_W       = 3*U;      // 12, per-finger bar width
  static const int BAR_LEN     = 5*U;      // 20, per-finger bar full scale
  static const int METER_W     = 24*U;     // 96

  // ---- 3. THE ROUND CANVAS ------------------------------------------------
  static const int R_EDGE      = 120;
  static const int R_SAFE      = 106;      // 11.7 % inset; nothing beyond this
  static const int R_RULE      = 106;      // scale rule + the state arc
  static const int R_TICK_OUT  = 106;
  static const int R_TICK_MIN  = 100;      // minor tick inner
  static const int R_TICK_MAJ  = 96;       // major tick inner
  static const int R_INDEX_OUT = 94;
  static const int R_INDEX_IN  = 78;
  static const int R_SECTOR_OUT= 104;      // the dead-sector arc
  static const int R_SECTOR_IN = R_SECTOR_OUT - BAR_LEN;   // 84

  // the centre-out column, derived from the numeral on the exact centre
  static const int Y_NUM     = 120;
  static const int Y_NUM_TOP = Y_NUM - CAP_DISPLAY/2;                 // 103
  static const int Y_NUM_BOT = Y_NUM + CAP_DISPLAY/2;                 // 137
  static const int Y_WORD    = Y_NUM_TOP - GAP_L - CAP_LABEL/2;       //  80
  static const int Y_LAMPS   = Y_WORD - CAP_LABEL/2 - GAP_M - E_LAMP; //  54 (top)
  static const int Y_CAPTION = Y_NUM_BOT + GAP_L + CAP_LABEL/2;       // 159
  static const int Y_METER   = Y_CAPTION + CAP_LABEL/2 + GAP_M;       // 178 (top)

  // ---- 4. HAIRLINE REALITY (minimum legible strokes at 32.5 mm) -----------
  static constexpr float W_HAIR     = 1.5f;
  static constexpr float W_TICK     = 2.0f;
  static constexpr float W_TICK_MAJ = 3.0f;
  static constexpr float W_INDEX    = 6.0f;
  static constexpr float W_RULE     = 1.5f;
  static constexpr float W_STATE    = 3.5f;   // the rule filling in

  // ---- the palette: near-monochrome, one accent ----
  static const uint16_t GROUND  = WGFX_C565(12, 12, 13);
  static const uint16_t STRUCT_ = WGFX_C565(112, 112, 108);   // ticks, rules
  static const uint16_t STRUCT_DIM = WGFX_C565(52, 52, 50);
  static const uint16_t INK     = WGFX_C565(238, 237, 231);   // numerals, words
  static const uint16_t INK_DIM = WGFX_C565(150, 150, 144);
  static const uint16_t ALARM   = WGFX_C565(208,  52,  44);   // STOP only
  uint16_t ACC = WGFX_C565(242, 176, 30), ACC_DIM = WGFX_C565(80, 58, 10);
  int cwIdx = 0;

  // the gauge sweep: lower-left -> left -> top -> right -> lower-right,
  // leaving a 90 degree dead sector at the bottom for the finger arc
  static constexpr float A0 = 2.35619449f;    // 3pi/4
  static constexpr float SW = 4.71238898f;    // 3pi/2
  // the dead sector, inset one bar-width at each end so nothing touches the
  // scale's first and last tick
  static constexpr float SEC0 = 1.04719755f;  // 60 deg
  static constexpr float SEC1 = 2.09439510f;  // 120 deg

  static float clamp01(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // the value the dial reads, per state (0..1)
  static float primary(const DeviceState& s) {
    switch (s.state) {
      case FS_BOOT: {                                  // the self-test sweep
        float u = s.stateT;
        if (u < 0.9f) return u / 0.9f;                 // 0 -> full scale
        if (u < 1.8f) return 1.0f - (u - 0.9f) / 0.9f; // full -> 0
        return grip(s) * clamp01((u - 1.8f) / 0.6f);   // settle onto the real value
      }
      case FS_RECORDING: return (float)(s.capSec % 60) / 60.0f;
      case FS_CALIB:     return clamp01(s.calibProgress);
      case FS_BATTERY:   return s.battery < 0 ? 0 : clamp01(s.battery);
      case FS_SAVED:     return 1.0f;
      default:           return grip(s);
    }
  }
  static float grip(const DeviceState& s) {            // mean flexion, live channels only
    float sum = 0; int n = 0;
    for (int i = 0; i < 12; i++) if (s.joints[i] >= 0) { sum += s.joints[i]; n++; }
    return n ? clamp01(sum / n) : 0.0f;
  }
  // one finger's flexion: the mean of its live channels, or <0 if it has none
  static float finger(const DeviceState& s, int f) {
    float sum = 0; int n = 0;
    for (int j = 0; j < 3; j++) {
      float v = s.joints[f*3 + j];
      if (v >= 0) { sum += v; n++; }
    }
    return n ? clamp01(sum / n) : -1.0f;
  }

  // ---- the scale ring: one rule, 21 ticks, and the state arc on the rule ----
  void drawScale(const DeviceState& s) {
    const bool dashed = (s.state == FS_STANDALONE);     // no host: a broken track
    if (!dashed) wgfx::aaArcA(120, 120, R_RULE, W_RULE, A0, A0 + SW, STRUCT_DIM, 255);
    for (int i = 0; i <= 20; i++) {
      if (dashed && (i & 1)) continue;
      float a = A0 + SW * i / 20.0f;
      bool maj = (i % 5) == 0;
      float r0 = maj ? (float)R_TICK_MAJ : (float)R_TICK_MIN;
      wgfx::aaSegA(120 + cosf(a)*r0, 120 + sinf(a)*r0,
                   120 + cosf(a)*R_TICK_OUT, 120 + sinf(a)*R_TICK_OUT,
                   maj ? W_TICK_MAJ : W_TICK, maj ? STRUCT_ : STRUCT_DIM, 255);
    }
    // No numerals on the ring. The five majors already state the scale and the
    // centre numeral already states the value; printing 0/50/100 as well would
    // be the third telling of the same thing.

    // the state arc rides the rule itself, so a filling instrument thickens a
    // line that is already there instead of adding a ring
    if (s.state == FS_RECORDING || s.state == FS_SAVED) {
      float frac = s.state == FS_SAVED ? 1.0f : clamp01((float)(s.capSec % 60) / 60.0f);
      wgfx::aaArcA(120, 120, R_RULE, W_STATE, A0, A0 + SW*frac, ACC, 255);
    }
    if (s.state == FS_CALIB)
      wgfx::aaArcA(120, 120, R_RULE, W_STATE, A0, A0 + SW*clamp01(s.calibProgress), ACC, 210);
    if (s.state == FS_TELEOP) {                        // the work sector
      float g = grip(s), q = clamp01(s.torque);
      float lo = g < q ? g : q, hi = g < q ? q : g;
      if (hi - lo > 0.004f)
        wgfx::aaArcA(120, 120, R_RULE, W_STATE, A0 + SW*lo, A0 + SW*hi, ACC, 140);
    }
  }

  // ---- the index (the needle, shortened to the ring) ----
  void drawIndex(const DeviceState& s) {
    const float v = clamp01(primary(s));
    const float a = A0 + SW * v;
    bool resting = (s.state == FS_IDLE || s.state == FS_STANDALONE);
    // breathing = at rest; steady = engaged. The alpha IS the state.
    uint8_t al = 255;
    if (resting) al = (uint8_t)(190 + 65 * (0.5f + 0.5f * sinf(s.t * 3.14159265f)));
    uint16_t col = resting ? INK : ACC;
    wgfx::aaSegA(120 + cosf(a)*R_INDEX_IN,  120 + sinf(a)*R_INDEX_IN,
                 120 + cosf(a)*R_INDEX_OUT, 120 + sinf(a)*R_INDEX_OUT, W_INDEX, col, al);
    if (s.state == FS_TELEOP) {                        // the commanded index, hollow
      float aq = A0 + SW * clamp01(s.torque);
      wgfx::aaSegA(120 + cosf(aq)*(R_INDEX_IN + U), 120 + sinf(aq)*(R_INDEX_IN + U),
                   120 + cosf(aq)*R_INDEX_OUT,      120 + sinf(aq)*R_INDEX_OUT,
                   W_HAIR, INK, 230);
    }
  }

  // ---- five status squares: filled = present, hollow = absent ----
  void drawLamps(const DeviceState& s) {
    const bool ok[5] = { s.imuOk, s.encOk, s.emgOk, s.motOk, s.link };
    const int pitch = E_LAMP + GAP_S, total = 4*pitch + E_LAMP;
    int x = 120 - total/2;
    bool blink = (s.state == FS_FAULT) && (fmodf(s.t, 1.0f) < 0.5f);
    for (int i = 0; i < 5; i++, x += pitch) {
      if (ok[i]) wgfx::fillRectA(x, Y_LAMPS, E_LAMP, E_LAMP, INK_DIM, 255);
      else if (blink) wgfx::fillRectA(x, Y_LAMPS, E_LAMP, E_LAMP, ACC, 255);
      else strokeRect(x, Y_LAMPS, E_LAMP, E_LAMP, STRUCT_DIM);   // absence is a shape
    }
  }

  // a hollow rectangle at the minimum legible stroke
  void strokeRect(int x, int y, int w, int h, uint16_t col) {
    const int t = 2;                                   // >= W_HAIR, integer pixels
    wgfx::fillRectA(x, y, w, t, col, 255);
    wgfx::fillRectA(x, y + h - t, w, t, col, 255);
    wgfx::fillRectA(x, y, t, h, col, 255);
    wgfx::fillRectA(x + w - t, y, t, h, col, 255);
  }

  // ---- the mode word, on the vertical axis ----
  void drawWord(const DeviceState& s) {
    const char* w = "READY";
    switch (s.state) {
      case FS_BOOT:       w = s.stateT < 1.8f ? "SELF TEST" : "STARTING"; break;
      case FS_IDLE:       w = "READY"; break;
      case FS_LINKED:     w = "LINKED"; break;
      case FS_STANDALONE: w = "LOCAL"; break;
      case FS_TELEOP:     w = "TELEOP"; break;
      case FS_RECORDING:  w = "REC"; break;
      case FS_SAVED:      w = "SAVED"; break;
      case FS_CALIB:      w = "CALIBRATE"; break;
      case FS_FAULT:      w = "FAULT"; break;
      case FS_BATTERY:    w = s.charging ? "CHARGING" : "BATTERY"; break;
      default: break;
    }
    bool hot = (s.state == FS_RECORDING || s.state == FS_FAULT);
    wgfx::aaTextTracked(&FreeSans9pt7b, w, 120, Y_WORD, hot ? ACC : INK_DIM, TRACK);
    // marks that belong to the word are placed off its MEASURED width, so they
    // never collide when the word changes length
    const int half = wgfx::textWidthTracked(&FreeSans9pt7b, w, TRACK) / 2;
    if (s.state == FS_LINKED) {                         // the link brackets
      wgfx::fillRectA(120 - half - GAP_M - 2, Y_WORD - CAP_LABEL/2 - 2, 2, CAP_LABEL + 4, ACC, 255);
      wgfx::fillRectA(120 + half + GAP_M,     Y_WORD - CAP_LABEL/2 - 2, 2, CAP_LABEL + 4, ACC, 255);
    }
    if (s.state == FS_RECORDING && fmodf(s.t, 1.0f) < 0.5f)
      wgfx::fillRectA(120 - half - GAP_M - E_LAMP, Y_WORD - E_LAMP/2, E_LAMP, E_LAMP, ACC, 255);
  }

  // ---- the primary numeral, on the exact centre, with its caption ----
  void drawNumeral(const DeviceState& s) {
    char buf[16];
    const char* unit = nullptr;
    switch (s.state) {
      case FS_RECORDING:
      case FS_SAVED:
        snprintf(buf, sizeof buf, "%02ld:%02ld", s.capSec/60, s.capSec%60);
        break;
      case FS_BATTERY:
        snprintf(buf, sizeof buf, "%d", (int)(clamp01(s.battery < 0 ? 0 : s.battery)*100 + 0.5f));
        unit = "%"; break;
      default:
        snprintf(buf, sizeof buf, "%d", (int)(primary(s)*100 + 0.5f));
        unit = "%"; break;
    }
    if (unit) {
      // the numeral and its unit are ONE optical block, centred together, so a
      // 6 % reading and a 100 % reading both sit on the axis
      const int nw = wgfx::textWidthTracked(&FreeSansBold24pt7b, buf, 0);
      const int uw = wgfx::textWidthTracked(&FreeSans9pt7b, unit, 0);
      const int total = nw + GAP_S + uw;
      const int cx = 120 - total/2;
      wgfx::aaText(&FreeSansBold24pt7b, buf, cx + nw/2, Y_NUM, INK);
      // the unit sits on the numeral's baseline, not its centre
      wgfx::aaText(&FreeSans9pt7b, unit, cx + nw + GAP_S + uw/2,
                   Y_NUM + CAP_DISPLAY/2 - CAP_LABEL/2, INK_DIM);
    } else {
      wgfx::aaText(&FreeSansBold24pt7b, buf, 120, Y_NUM, INK);
    }
    const char* cap = (s.state == FS_RECORDING || s.state == FS_SAVED) ? "TAKE"
                    : (s.state == FS_BATTERY) ? "CHARGE"
                    : (s.state == FS_CALIB)   ? "PROGRESS" : "GRIP";
    wgfx::aaTextTracked(&FreeSans9pt7b, cap, 120, Y_CAPTION, STRUCT_, TRACK);
  }

  // ---- the EMG meter: the only cartesian element, ON the vertical axis ----
  // It carries no text. A label to its left pushed the bar off the axis, and
  // an axis that bends for a three-letter caption is not a system; the meter's
  // fixed position under the value, its track, fill and mid-scale hairline
  // identify it unambiguously after the first glance.
  void drawMeter(const DeviceState& s) {
    const int bx = 120 - METER_W/2;
    wgfx::fillRectA(bx, Y_METER, METER_W, E_METER_H, STRUCT_DIM, 255);      // the track
    if (s.emgOk) {
      int fill = (int)(clamp01(s.emg) * METER_W + 0.5f);
      // INK_DIM, not ACC: a full-width accent bar out-shouted the numeral in
      // the squint test. The accent is reserved for state signals.
      if (fill > 0) wgfx::fillRectA(bx, Y_METER, fill, E_METER_H, INK_DIM, 255);
    }
    // mid-scale hairline, at the minimum legible width
    wgfx::fillRectA(120, Y_METER - U, 2, E_METER_H + 2*U, STRUCT_, 255);
  }

  // ---- the dead sector: fingers, charge, or a warning. Always one question. ----
  void drawSector(const DeviceState& s) {
    if (s.state == FS_FAULT && s.faultSev > 0) { drawWarnArc(); return; }
    if (s.state == FS_BATTERY) { drawChargeArc(s); return; }

    // four per-finger bars, index to pinky, left to right across the sector
    const float span = SEC1 - SEC0;
    for (int f = 0; f < 4; f++) {
      // SEC0..SEC1 runs right-to-left on screen; count down from SEC1 so
      // finger 0 (index) is leftmost and the row reads in hand order
      const float a = SEC1 - span * (f + 0.5f) / 4.0f;
      float v = finger(s, f);
      // the seat: every bar sits in the same dim full-length track, so the row
      // reads as a profile even when a finger is at zero or absent
      wgfx::aaBarA(120, 120, a, (float)R_SECTOR_IN, (float)R_SECTOR_OUT,
                   (float)BAR_W, STRUCT_DIM, 255);
      if (v < 0) continue;                             // finger not instrumented
      if (s.state == FS_BOOT) {                        // the self-test fills in order
        v *= clamp01((s.stateT - f*0.12f) / 0.4f);
      }
      const float len = v * BAR_LEN;
      if (len >= 1.0f)
        wgfx::aaBarA(120, 120, a, (float)R_SECTOR_OUT - len, (float)R_SECTOR_OUT,
                     (float)BAR_W, INK_DIM, 255);
    }
  }

  // ten charge segments, same sector, same seat
  void drawChargeArc(const DeviceState& s) {
    const int n = 10;
    const float span = SEC1 - SEC0, step = span / n;
    const float pct = s.battery < 0 ? 0 : clamp01(s.battery);
    const int lit = (int)(pct * n + 0.5f);
    const int anim = s.charging ? ((int)(s.t * 2.0f) % (n - lit > 0 ? n - lit : 1)) + lit : -1;
    for (int i = 0; i < n; i++) {
      const float a = SEC1 - step * (i + 0.5f);   // segment 0 leftmost
      wgfx::aaBarA(120, 120, a, (float)R_SECTOR_IN, (float)R_SECTOR_OUT,
                   (float)(2*U), STRUCT_DIM, 255);            // the seat
      if (i < lit || i == anim) {
        uint16_t col = (i < lit) ? (pct < 0.2f ? ACC : INK_DIM) : ACC_DIM;
        wgfx::aaBarA(120, 120, a, (float)R_SECTOR_IN, (float)R_SECTOR_OUT,
                     (float)(2*U), col, 255);
      }
    }
  }

  // a major fault hatches the sector: the same place, an unmistakable texture
  void drawWarnArc() {
    wgfx::hatchWedgeA(120, 120, (float)R_SECTOR_IN, (float)R_SECTOR_OUT,
                      SEC0, SEC1, ACC_DIM, ACC, 255, U);
  }

  // ---- STOP: the panel is gone. One field, one word. ----
  void drawStop(const DeviceState& s) {
    bool on = fmodf(s.t, 1.0f) < 0.6f;                 // a slow, certain pulse
    wgfx::fillScreen565(on ? ALARM : WGFX_C565(150, 34, 28));
    wgfx::aaTextTracked(&FreeSansBold24pt7b, "STOP", 120, Y_NUM, GROUND, GAP_S);
    wgfx::fillRectA(120 - METER_W/2, Y_NUM + CAP_DISPLAY/2 + GAP_L, METER_W, U, GROUND, 255);
    wgfx::aaTextTracked(&FreeSans9pt7b, "MOTION DISABLED", 120,
                        Y_NUM + CAP_DISPLAY/2 + GAP_L + U + GAP_M + CAP_LABEL/2,
                        GROUND, TRACK);
  }

  static const Colorway CW[3];
};

const Colorway FaceRams::CW[3] = {
  { "signal", "Signal Yellow", 242, 176,  30, true,
    "The designed default. Braun signal yellow on near-black; highest legibility." },
  { "mono",   "Monochrome",    236, 235, 229, false,
    "The austere reading: no accent hue at all, emphasis carried by weight alone." },
  { "sea",    "Sea Green",      79, 168, 160, false,
    "Muted instrument teal. Quieter than signal; keep the display brightness up." },
};
