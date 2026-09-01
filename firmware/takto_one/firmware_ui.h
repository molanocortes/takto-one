// firmware_ui.h - on-device round-display UI engine for Teensy 4.1 + GC9A01.
//
// Complete implementation (the earlier skeleton, finished):
//   * conservative dirty-tile renderer: the sketch paints into a 240x240
//     RGB565 framebuffer; a shadow mirrors the panel; each task scans for the
//     next dirty tile run and sends ONE small run synchronously. This deliberately
//     trades peak refresh rate for a completion guarantee on the physical panel.
//     A transfer has returned before the shadow is committed, so the renderer
//     never believes a half-sent band reached the GC9A01;
//   * the full-frame blocking drawRGBBitmap (~30 ms stall) is gone: a full
//     repaint is spread over atomic 64x16 (max) bands, with no DMA callback,
//     timeout, or in-flight transaction that can leave half a face stranded;
//   * crown HMI: pot (A13) -> continuous focus with EMA smoothing, a spring-
//     snapped detent model with hysteresis (never machine-guns on ADC noise),
//     one piezo tick per detent crossing; button (pin 5, INPUT_PULLUP) with
//     debounce -> PRESS (<600 ms) / LONG (>=600 ms, fired while held);
//   * events surface as Ev {NONE,CW,CCW,PRESS,LONG}; the sketch consumes them,
//     drives its local state and mirrors them to the host as "E,<action>[,dir]"
//     lines (the bridge feeds device_command(source="device") -> console + AR).
//
// Budget: ui_tick() does one <=2 kB synchronous band plus a bounded scan. The
// paint pass (into the framebuffer) is unchanged. In exchange for a sub-ms
// panel write per loop pass, every completed band is coherent and recoverable.
//
// Units: px, us, ms. RGB565. Tile grid: 16 x 16 px, 15 x 15 = 225 tiles.

#pragma once
#include <Arduino.h>
#include <SPI.h>

// ---------- geometry ----------
static const int UI_W = 240, UI_H = 240;
static const int UI_TILE = 16, UI_NTX = UI_W / UI_TILE, UI_NTY = UI_H / UI_TILE;
static const int UI_NTILES = UI_NTX * UI_NTY;                 // 225

// ---------- budget ----------
static const int      UI_DIFF_TILES = 8;    // retained diagnostic/documentation value
static const uint32_t UI_WRITE_BUDGET_US = 2500; // report slow panel writes; never abort them

// ---------- input events ----------
enum class Ev : uint8_t { NONE, CW, CCW, PRESS, LONG };

// ============================================================
//                    CROWN + BUTTON + PIEZO
// ============================================================
struct UiInput {
  uint8_t potPin, btnPin, pzPin;
  int     detents = 4;              // carousel slots; sketch may change per screen
  float   raw = 0;                  // EMA-smoothed pot [0..1]
  float   f = 0;                    // continuous focus [0..detents-1]
  float   vel = 0;
  int     lastDetent = 0;
  uint32_t lastUs = 0;
  // button
  bool    btnState = false;         // debounced held
  uint32_t btnEdgeMs = 0, btnDownMs = 0;
  bool    longFired = false;
  bool    moved = false;            // crown moved since last consume (wake cue)

  void begin(uint8_t pot, uint8_t btn, uint8_t pz) {
    potPin = pot; btnPin = btn; pzPin = pz;
    pinMode(btnPin, INPUT_PULLUP);
    pinMode(pzPin, OUTPUT);
    analogReadResolution(10);
    raw = analogRead(potPin) / 1023.0f;
    f = raw * (detents - 1);
    lastDetent = (int)roundf(f);
    lastUs = micros();
  }

  void tick(uint16_t freq, uint8_t ms) { tone(pzPin, freq, ms); }

  // call every loop pass; returns one event or NONE
  Ev poll() {
    const uint32_t nowUs = micros();
    float dt = (nowUs - lastUs) * 1e-6f;
    if (dt > 0.05f) dt = 0.05f;
    lastUs = nowUs;

    // ---- crown: EMA on the ADC, spring + detent magnet on the focus ----
    const float adc = analogRead(potPin) / 1023.0f;
    const float prevRaw = raw;
    raw += (adc - raw) * 0.18f;                        // light smoothing
    if (fabsf(raw - prevRaw) > 0.004f) moved = true;   // real motion, not noise
    const float target = raw * (detents - 1);
    const int   near = (int)roundf(f);
    const float acc = 90.0f * (target - f) + 34.0f * (near - f) - 16.0f * vel;
    vel += acc * dt;  f += vel * dt;
    if (f < -0.35f) f = -0.35f;
    if (f > detents - 1 + 0.35f) f = detents - 1 + 0.35f;

    Ev ev = Ev::NONE;
    const int slot = (int)roundf(f);
    // hysteresis: only latch a detent once we are well inside the new slot
    if (slot != lastDetent && fabsf(f - slot) < 0.32f) {
      ev = (slot > lastDetent) ? Ev::CW : Ev::CCW;
      lastDetent = slot;
      tick(3400 + slot * 180, 8);                      // the crown's click
    }

    // ---- button: debounce + press/long, sampled like the browser twin ----
    const bool rawBtn = (digitalRead(btnPin) == LOW);
    const uint32_t nowMs = millis();
    if (rawBtn != btnState && nowMs - btnEdgeMs > 25) {
      btnEdgeMs = nowMs;
      btnState = rawBtn;
      if (btnState) { btnDownMs = nowMs; longFired = false; }
      else if (!longFired && nowMs - btnDownMs < 600) {
        tick(2600, 14);
        return Ev::PRESS;                              // release < 600 ms
      }
    }
    if (btnState && !longFired && nowMs - btnDownMs >= 600) {
      longFired = true;
      tick(1800, 24);
      return Ev::LONG;                                 // fires while held
    }
    return ev;
  }

  int focus() const {
    int s = (int)roundf(f);
    if (s < 0) s = 0;
    if (s > detents - 1) s = detents - 1;
    return s;
  }
};

// ============================================================
//                COHERENT DIRTY-RUN PANEL PUSH
// ============================================================
// The physical display fault was caused by an async transaction being treated
// as complete before its callback had actually fired. Do not keep an SPI
// transaction open across loop passes here. Runs are intentionally limited to
// four 16 px tiles (64 x 16 px), written synchronously, and committed only
// after writePixels() returns.
//
// Idle design: the panel scan only runs while `pending` is set (armed by
// notifyPainted() after a real repaint). A static face costs zero scans,
// zero pushes, zero SPI traffic.
static const int UI_RUN_TILES = 4;                   // 64x16 px / 2 kB maximum
struct UiRenderer {
  Adafruit_GC9A01A* tft = nullptr;
  uint16_t* fb = nullptr;             // the sketch's canvas buffer (paint here)
  uint16_t* shadow = nullptr;         // DMAMEM mirror of the panel
  uint8_t*  staging = nullptr;        // retained ABI buffer; synchronous path does not use it
  bool pending = false;               // a repaint happened; scan until clean
  uint16_t cursor = 0;                // resume point of the grid scan
  uint32_t pushed = 0;                // tiles shipped (diagnostics)
  uint32_t runs = 0;                  // coherent panel runs completed
  uint32_t lastWriteUs = 0, maxWriteUs = 0;
  uint32_t slowWrites = 0;            // writes above UI_WRITE_BUDGET_US, diagnostic only

  void begin(Adafruit_GC9A01A* t, uint16_t* framebuf,
             uint16_t* shadowbuf, uint8_t* stagingbuf) {
    tft = t; fb = framebuf; shadow = shadowbuf; staging = stagingbuf;
    // force every tile out once (shadow starts unknown)
    memset(shadow, 0xA5, UI_W * UI_H * 2);
    pending = true;
  }

  // The sketch calls this right after painting the framebuffer. Do NOT rewind
  // cursor: a live face repaints before the lower bands can be scanned, and a
  // reset-to-zero policy starves those bands forever (the observed half panel).
  void notifyPainted() { pending = true; }

  // Reship EVERY tile, whatever the shadow believes.
  //
  // Switching faces is a discontinuity. Invalidate every shadow tile so the
  // next coherent passes rebuild the entire visible panel from the framebuffer.
  void forceFullRepaint() {
    memset(shadow, 0xA5, (size_t)UI_W * UI_H * 2);   // no tile can match this
    pending = true;
    cursor = 0;
  }

  bool tileDiffers(uint16_t t) const {
    const int tx = t % UI_NTX, ty = t / UI_NTX;
    for (int y = 0; y < UI_TILE; ++y) {
      const size_t off = (size_t)(ty * UI_TILE + y) * UI_W + tx * UI_TILE;
      if (memcmp(&fb[off], &shadow[off], UI_TILE * 2) != 0) return true;
    }
    return false;
  }

  // Ship a horizontal run synchronously. The shadow write comes AFTER all rows
  // return from the panel driver: no optimistic bookkeeping, no timeout-based
  // abort, and no opportunity to start a second flush through a live transfer.
  void pushRun(int tx, int ty, int n) {
    const int x0 = tx * UI_TILE, y0 = ty * UI_TILE, wpx = n * UI_TILE;
    const uint32_t t0 = micros();
    tft->startWrite();
    tft->setAddrWindow(x0, y0, wpx, UI_TILE);
    for (int y = 0; y < UI_TILE; ++y) {
      const size_t off = (size_t)(y0 + y) * UI_W + x0;
      // block=true: do not return until this row is physically queued/completed
      // by the driver's synchronous SPI path. false would reintroduce the bug.
      tft->writePixels(&fb[off], wpx, true, false);
    }
    tft->endWrite();
    for (int y = 0; y < UI_TILE; ++y) {
      const size_t off = (size_t)(y0 + y) * UI_W + x0;
      memcpy(&shadow[off], &fb[off], (size_t)wpx * sizeof(uint16_t));
    }
    lastWriteUs = micros() - t0;
    if (lastWriteUs > maxWriteUs) maxWriteUs = lastWriteUs;
    if (lastWriteUs > UI_WRITE_BUDGET_US) slowWrites++;
    pushed += n;
    runs++;
  }

  // Call every loop pass. One bounded coherent run per pass at most.
  void task() {
    if (!pending) return;                      // static face: zero cost
    for (int k = 0; k < UI_NTILES; ++k) {      // full-grid scan (~60 us worst)
      const uint16_t t = (uint16_t)((cursor + k) % UI_NTILES);
      if (!tileDiffers(t)) continue;
      const int tx = t % UI_NTX, ty = t / UI_NTX;
      int n = 1;                               // extend the run along the row
      while (tx + n < UI_NTX && n < UI_RUN_TILES && tileDiffers(t + n)) n++;
      pushRun(tx, ty, n);
      cursor = (uint16_t)((t + n) % UI_NTILES);
      return;
    }
    pending = false;                           // clean: sleep until next paint
  }

  bool idle() const { return !pending; }
};
