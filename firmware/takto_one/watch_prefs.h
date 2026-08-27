// watch_prefs.h - the watch-face selection, persisted in Teensy EEPROM.
//
// This lives in a header rather than in the .ino because the Arduino
// preprocessor hoists generated function prototypes above every plain
// declaration in the sketch, so a function taking `const WatchPrefs&` would be
// prototyped before the struct it names exists. Headers are left alone.
//
// Teensy 4.1 EEPROM is emulated in flash and EEPROM.put only rewrites bytes
// that actually changed, so saving on every switch costs no meaningful wear.
#pragma once
#include <EEPROM.h>
#include "watch/watch_engine.h"

static const int     WATCH_EE_ADDR  = 64;      // clear of anything else stored here
static const uint8_t WATCH_EE_MAGIC = 0xA7;
static const uint8_t WATCH_EE_VER   = 1;

struct WatchPrefs { uint8_t magic, ver, face, cw0, cw1, cw2, sum; };

inline uint8_t watchSum(const WatchPrefs& p) {
  return (uint8_t)(p.magic + p.ver*3 + p.face*5 + p.cw0*7 + p.cw1*11 + p.cw2*13);
}

inline void watchSave() {
  WatchPrefs p;
  p.magic = WATCH_EE_MAGIC; p.ver = WATCH_EE_VER;
  p.face = watch::curFace;
  p.cw0 = watch::curColorway[0];
  // Keep the legacy bytes in the EEPROM record so existing storage remains
  // parseable, but the single production face owns only colorway slot zero.
  p.cw1 = 0;
  p.cw2 = 0;
  p.sum = watchSum(p);
  EEPROM.put(WATCH_EE_ADDR, p);
}

// Never written, wrong version, or corrupt -> the thesis face at its canonical
// colorway. A bad EEPROM must never leave the screen in an undefined state.
inline void watchLoad() {
  WatchPrefs p;
  EEPROM.get(WATCH_EE_ADDR, p);
  if (p.magic != WATCH_EE_MAGIC || p.ver != WATCH_EE_VER || p.sum != watchSum(p)
      || p.face >= watch::FACE_COUNT) {
    watch::initAll();
    watch::selectFace(watch::FACE_THESIS, 0);
    return;
  }
  watch::curColorway[0] = p.cw0;
  watch::initAll();
  if (!watch::selectFace(p.face, watch::curColorway[p.face]))
    watch::selectFace(watch::FACE_THESIS, 0);
}
