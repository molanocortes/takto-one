// watch_presentation.h — calm, panel-rate presentation for the physical watch.
//
// Sensors and motor control continue at their native rates.  This layer only
// decides when the 240 x 240 framebuffer may be rebuilt and conditions the
// values a human reads on the GC9A01.  It is dual-target so the host test can
// verify the exact cadence and quantization used by the Teensy.
#pragma once
#include <math.h>
#include <stdint.h>
#include "watch_state.h"

// A complete GC9A01 frame is shipped as coherent tile runs.  Eight visual frames
// per second gives the panel additional settling time; the crown remains a
// slightly quicker, still calm 9.6 Hz. Urgent state and safety stay at 50 Hz.
static const uint32_t WATCH_PRESENT_SERVICE_MS  = 20;   // check urgent state at 50 Hz
static const uint32_t WATCH_PRESENT_FRAME_MS    = 130;  // normal visuals: <= 7.7 Hz
static const uint32_t WATCH_PRESENT_INTERACT_MS = 104;  // crown carousel: <= 9.6 Hz
// The only high-cadence animation is the narrow connection segment. It changes
// a handful of tiles, and still waits for the prior physical transfer to end.
static const uint32_t WATCH_PRESENT_CONNECT_MS  = 60;   // 1-degree segment step: <= 16.7 Hz

struct WatchPresentationCadence {
  enum Decision : uint8_t { WAIT_TIME, WAIT_PANEL, PRESENT };
  uint32_t lastMs = 0;
  bool primed = false;

  Decision decide(uint32_t nowMs, bool interactive, bool force, bool panelIdle) const {
    return decidePeriod(nowMs, interactive ? WATCH_PRESENT_INTERACT_MS : WATCH_PRESENT_FRAME_MS,
                        force, panelIdle);
  }

  Decision decidePeriod(uint32_t nowMs, uint32_t period, bool force, bool panelIdle) const {
    if (force) return PRESENT;                    // state/face/safety discontinuity
    if (primed && (uint32_t)(nowMs - lastMs) < period) return WAIT_TIME;
    if (!panelIdle) return WAIT_PANEL;             // never mutate a frame being shipped
    return PRESENT;
  }

  void committed(uint32_t nowMs) { lastMs = nowMs; primed = true; }
};

// The round GC9A01 can rotate its address space in quarter turns with no
// framebuffer resampling.  Track forearm roll relative to the first valid pose;
// 55-degree entry hysteresis prevents chatter near a boundary while the wearer
// holds a diagonal orientation, and a new turn must be held for DWELL_MS before
// it is committed (every turn is a full-panel repaint, so a wrist flick through
// 55 degrees must not wipe the screen). Roll is meaningless with the forearm
// near vertical, so the caller passes valid = false there and the display
// keeps its current turn.
struct WatchQuarterTurnTracker {
  static const uint32_t DWELL_MS = 400;
  bool primed = false;
  float zeroRoll = 0;
  uint8_t turn = 0;                               // 0..3, relative to zeroRoll
  int8_t  pending = -1;                           // candidate turn, -1 = none
  uint32_t pendingSince = 0;

  static float wrap(float a) { return atan2f(sinf(a), cosf(a)); }

  bool update(float handRoll, bool valid, uint32_t nowMs) {
    if (!valid) { pending = -1; return false; }
    if (!primed) { primed = true; zeroRoll = handRoll; turn = 0; return false; }
    const float quarter = 1.570796327f;
    const float enter = 0.959931089f;             // 55 degrees
    const float rel = wrap(handRoll - zeroRoll);
    const float displayed = (float)turn * quarter;
    const float err = wrap(rel - displayed);
    int8_t want = -1;
    if (err > enter) want = (int8_t)((turn + 1) & 3);
    else if (err < -enter) want = (int8_t)((turn + 3) & 3);
    if (want < 0) { pending = -1; return false; }
    if (want != pending) { pending = want; pendingSince = nowMs; return false; }
    if ((uint32_t)(nowMs - pendingSince) < DWELL_MS) return false;
    turn = (uint8_t)want; pending = -1;
    return true;
  }
};

struct WatchPresentationFilter {
  bool primed = false;
  float joint[12] = {};
  float emg = 0, torque = 0, roll = 0, calib = 0, battery = -1;
  FaceState lastState = FS_BOOT;

  static float clamp01(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  static float alpha(float dt, float tau) {
    if (dt <= 0) dt = WATCH_PRESENT_FRAME_MS * 0.001f;
    if (dt > 0.5f) dt = 0.5f;
    return 1.0f - expf(-dt / tau);
  }
  static float quant01(float v) { return floorf(clamp01(v) * 50.0f + 0.5f) / 50.0f; } // 2 %
  // A numeral changing every display sample reads as flicker on this panel.
  // Percentages are a human-facing trend, not a control input: settle them
  // more slowly and expose only five-percent steps.
  static float quantPercent(float v) { return floorf(clamp01(v) * 20.0f + 0.5f) / 20.0f; } // 5 %
  static float quantRoll(float v) {
    const float step = 0.034906585f;               // two degrees
    const float q = v / step;
    return (q >= 0 ? floorf(q + 0.5f) : ceilf(q - 0.5f)) * step;
  }

  void reset() { primed = false; }

  // Mutates only display-bearing fields. Health/state/time and all control
  // values outside this copy remain untouched.
  void apply(DeviceState& s, float dt) {
    const bool stateChanged = primed && s.state != lastState;
    if (!primed) {
      for (int i = 0; i < 12; i++) joint[i] = s.joints[i];
      emg = clamp01(s.emg); torque = clamp01(s.torque); roll = s.roll;
      calib = clamp01(s.calibProgress); battery = s.battery;
      primed = true;
    } else {
      const float aj = alpha(dt, 0.30f);            // finger numerals/bars: calm, responsive
      for (int i = 0; i < 12; i++) {
        const float raw = s.joints[i];
        if (raw < 0) joint[i] = -1;                 // absence must show immediately
        else if (joint[i] < 0) joint[i] = raw;      // live channel returns without a sweep
        else joint[i] += (clamp01(raw) - joint[i]) * aj;
      }
      emg += (clamp01(s.emg) - emg) * alpha(dt, 0.75f);
      torque += (clamp01(s.torque) - torque) * alpha(dt, 0.25f);
      float dr = atan2f(sinf(s.roll - roll), cosf(s.roll - roll));
      roll += dr * alpha(dt, 0.35f);                // shortest path across +/- pi
      if (stateChanged && s.state == FS_CALIB) calib = clamp01(s.calibProgress);
      else calib += (clamp01(s.calibProgress) - calib) * alpha(dt, 0.20f);
      if (s.battery < 0) battery = -1;
      else if (battery < 0) battery = s.battery;
      else battery += (clamp01(s.battery) - battery) * alpha(dt, 0.75f);
    }

    for (int i = 0; i < 12; i++) s.joints[i] = joint[i] < 0 ? -1 : quant01(joint[i]);
    s.emg = quantPercent(emg);
    s.torque = quant01(torque);
    s.roll = quantRoll(roll);
    s.calibProgress = quant01(calib);
    s.battery = battery < 0 ? -1 : quantPercent(battery);
    lastState = s.state;
  }
};
