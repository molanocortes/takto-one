// watch_engine.h — the face registry, the selection/persistence model, the
// shared finger-amplitude law, and the crown-carousel overlay.
//
// Contract with the sketch (and with the host harness, which stands in for it):
//   1. fill a DeviceState from the real signals;
//   2. call engineUpdate(state, dt) once per paint attempt — it derives the
//      per-finger amplitude envelope every face reads;
//   3. compare face->signature(state) (plus the carousel signature) against the
//      last one and return early if unchanged — this is the value-dirty rule
//      that keeps a static face at zero paint / zero SPI;
//   4. call engineRender(fb, state, carousel).
//
// The engine NEVER reads a sensor, never touches a bus, and never blocks. The
// faces are consumers of DeviceState; the sensing loop owns everything else.
#pragma once
#include "watch_state.h"
#include "watch_gfx.h"
#include "face_thesis.h"

namespace watch {

// ---------- registry ----------
// TAKTO presents one coherent visual language; archived design studies are
// intentionally absent from the production registry, catalog and firmware UI.
enum FaceId : uint8_t { FACE_THESIS = 0, FACE_COUNT = 1 };

static FaceThesis faceThesis;
static WatchFace* const REGISTRY[FACE_COUNT] = { &faceThesis };

static uint8_t curFace = FACE_THESIS;
static uint8_t curColorway[FACE_COUNT] = { 0 };

static inline WatchFace* active() { return REGISTRY[curFace]; }

// Resolve the production wire id to an index; -1 if unknown.
static inline int faceIndexById(const char* wireId) {
  if (!wireId) return -1;
  for (int i = 0; i < FACE_COUNT; i++) {
    const char* fid = REGISTRY[i]->id();
    int k = 0; while (fid[k] && wireId[k] && fid[k] == wireId[k]) k++;
    if (!fid[k] && !wireId[k]) return i;
  }
  return -1;
}
static inline int colorwayIndexById(int faceIdx, const char* wireId) {
  if (faceIdx < 0 || faceIdx >= FACE_COUNT || !wireId) return -1;
  WatchFace* f = REGISTRY[faceIdx];
  for (int i = 0; i < f->nColorways(); i++) {
    const char* cid = f->colorway(i).id;
    int k = 0; while (cid[k] && wireId[k] && cid[k] == wireId[k]) k++;
    if (!cid[k] && !wireId[k]) return i;
  }
  return -1;
}

// Apply a selection. Returns false (and changes NOTHING) if either id is
// unknown or out of range — the caller acks an error and the device keeps
// showing what it was showing.
static inline bool selectFace(int faceIdx, int colorwayIdx) {
  if (faceIdx < 0 || faceIdx >= FACE_COUNT) return false;
  WatchFace* f = REGISTRY[faceIdx];
  if (colorwayIdx < 0 || colorwayIdx >= f->nColorways()) return false;
  curFace = (uint8_t)faceIdx;
  curColorway[faceIdx] = (uint8_t)colorwayIdx;
  f->init(colorwayIdx);
  return true;
}
static inline void initAll() {
  for (int i = 0; i < FACE_COUNT; i++) REGISTRY[i]->init(curColorway[i]);
}

// ---------- finger-amplitude law (FERRO-SPEC; harmless to the other faces) ----------
// a_i = min(1, 4 * |dtheta_i/dt|) over the finger's live channels, instant
// attack, exponential decay with tau = 0.45 s. Channels reading < 0 (not live)
// contribute nothing, so a partially-populated hand simply produces fewer
// deformations rather than fake ones.
struct AmpFilter {
  float prev[12];
  bool  primed = false;
  void update(DeviceState& s, float dt) {
    if (dt <= 0) dt = 1.0f / 30.0f;
    if (dt > 0.25f) dt = 0.25f;
    if (!primed) { for (int i = 0; i < 12; i++) prev[i] = s.joints[i]; primed = true; }
    const float decay = expf(-dt / 0.45f);
    for (int f = 0; f < 4; f++) {
      float peak = 0;
      for (int j = 0; j < 3; j++) {
        int i = f * 3 + j;
        if (s.joints[i] < 0 || prev[i] < 0) { prev[i] = s.joints[i]; continue; }
        float v = fabsf(s.joints[i] - prev[i]) / dt;
        prev[i] = s.joints[i];
        float a = 4.0f * v; if (a > 1.0f) a = 1.0f;
        if (a > peak) peak = a;
      }
      float decayed = s.amps[f] * decay;
      s.amps[f] = peak > decayed ? peak : decayed;   // instant attack, slow release
    }
  }
};
static AmpFilter ampFilter;

static inline void engineUpdate(DeviceState& s, float dt) { ampFilter.update(s, dt); }

// ---------- crown carousel overlay (engine chrome, face-independent) ----------
// The mode picker belongs to the HMI, not to a face, so it is painted by the
// engine in the active face's accent. Geometry is the thesis original.
static const char* MODE_NAMES[4] = { "Transparent", "Capture", "Operator", "Calibrate" };

static inline void renderCarousel(uint16_t* fb, const CarouselState& c) {
  wgfx::FB = fb;
  const Colorway& cw = active()->colorway(curColorway[curFace]);
  const uint16_t acc   = WGFX_C565(cw.r, cw.g, cw.b);
  const uint16_t text  = WGFX_C565(237, 242, 249);
  const uint16_t faint = WGFX_C565(74, 86, 107);
  for (int i = 0; i < 240 * 240; i++) fb[i] = WGFX_C565(8, 10, 14);
  float f = c.f;
  for (int i = 0; i < 4; i++) {
    float d = i - f, ad = fabsf(d);
    if (ad > 1.4f) continue;
    int y = wgfx::SCY + (int)(d * 46);
    if (ad < 0.5f) {
      wgfx::aaText(&FreeSansBold12pt7b, MODE_NAMES[i], wgfx::SCX, y, text);
      wgfx::aaLine(wgfx::SCX - 15, y + 18, wgfx::SCX + 15, y + 18, 1.4f, acc);
    } else {
      wgfx::aaText(&FreeSans9pt7b, MODE_NAMES[i], wgfx::SCX, y, faint);
    }
  }
  for (int i = 0; i < 4; i++) {
    int x = wgfx::SCX - 20 + i * 13;
    if (i == c.focus) wgfx::aaLine(x - 5, 206, x + 5, 206, 2.2f, acc);
    else              wgfx::aaDisc(x, 206, 2.2f, faint, 0);
  }
}

// ---------- the paint entry points ----------
static inline uint32_t signature(const DeviceState& s, const CarouselState& c) {
  if (c.active) {
    return 0x80000000u | ((uint32_t)(c.f * 24.0f + 512.0f) & 0x7FFF)
         | ((uint32_t)c.focus << 15) | ((uint32_t)curFace << 18)
         | ((uint32_t)curColorway[curFace] << 21);
  }
  // the face id + colorway are mixed in (not packed into spare bits, which
  // would truncate a face's own signature) so a switch always forces a repaint
  uint32_t sig = active()->signature(s);
  return (sig * 2654435761u) ^ (uint32_t)(curFace * 131u + curColorway[curFace] + 1u);
}

static inline void engineRender(uint16_t* fb, const DeviceState& s, const CarouselState& c) {
  if (c.active) { renderCarousel(fb, c); return; }
  active()->render(fb, s);
}

} // namespace watch
