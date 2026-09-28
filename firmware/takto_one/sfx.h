// sfx.h - the device's sound vocabulary on the piezo (pin 2).
//
// One short, distinct cue per key moment, so the wearer knows what the device
// just did without looking at the screen:
//
//   BOOT        rising arpeggio        powered on, sensors up
//   STANDBY     falling arpeggio       going to standby (takes closed safely)
//   WAKE        short rising pair      back from standby
//   LINK_UP     soft rising pair       a host (console / app / AR bridge) connected
//   LINK_DOWN   soft falling pair      the host went away; the device carries on alone
//   REC_START   low -> high            recording to the SD card
//   REC_STOP    high -> low            take closed and saved
//   REC_FAIL    two low buzzes         no card / card full / write failed
//   NEUTRAL_*   countdown + chime      hold-still pose capture for the IMU tare
//   SENSOR_LOST falling warble         an IMU or encoder dropped out
//   SENSOR_BACK rising warble          it came back
//   MOTOR_*     motor bus / torque     connect, torque on, torque off
//   ALARM       urgent two-tone        motor fault / emergency stop
//
// Non-blocking: play() queues a cue, service() (every loop pass) starts each
// note on time with tone(pin, f, dur). A cue replaces whatever was playing,
// except that nothing but another ALARM may interrupt an ALARM. The crown's
// detent ticks ask busy() first, so they never chop a cue in half.

#pragma once
#include <Arduino.h>

namespace sfx {

enum Cue : uint8_t {
  BOOT, STANDBY, WAKE, LINK_UP, LINK_DOWN, REC_START, REC_STOP, REC_FAIL,
  NEUTRAL_TICK, NEUTRAL_DONE, SENSOR_LOST, SENSOR_BACK,
  MOTOR_CONNECT, MOTOR_TORQUE_ON, MOTOR_TORQUE_OFF, ALARM, CUE_COUNT
};

struct Note { uint16_t f; uint16_t ms; };          // f = 0 is a rest

// note names used below (equal temperament, rounded)
enum : uint16_t { E5_ = 659, A5_ = 880, C6_ = 1047, D6_ = 1175, E6_ = 1319,
                  G6_ = 1568, A6_ = 1760, B6_ = 1976, C7_ = 2093, D7_ = 2349,
                  LOW_ = 330 };

const Note S_BOOT[]      = {{C6_,70},{0,15},{E6_,70},{0,15},{G6_,70},{0,15},{C7_,160}};
const Note S_STANDBY[]   = {{C7_,90},{0,20},{G6_,90},{0,20},{E6_,90},{0,20},{C6_,220}};
const Note S_WAKE[]      = {{E6_,60},{0,20},{C7_,90}};
const Note S_LINK_UP[]   = {{G6_,40},{0,25},{D7_,60}};
const Note S_LINK_DOWN[] = {{D7_,40},{0,25},{G6_,60}};
const Note S_REC_START[] = {{E6_,80},{0,40},{B6_,180}};
const Note S_REC_STOP[]  = {{B6_,80},{0,40},{E6_,180}};
const Note S_REC_FAIL[]  = {{LOW_,220},{0,90},{LOW_,320}};
const Note S_NTICK[]     = {{A5_,50}};
const Note S_NDONE[]     = {{C7_,70},{0,30},{C7_,70},{0,30},{G6_,40},{C7_,140}};
const Note S_LOST[]      = {{A6_,70},{E6_,70},{A6_,70},{E6_,110}};
const Note S_BACK[]      = {{E6_,60},{A6_,90}};
const Note S_M_CONN[]    = {{A5_,60},{0,15},{C6_,60},{0,15},{E6_,110}};
const Note S_M_ON[]      = {{D6_,90},{0,50},{D6_,90}};
const Note S_M_OFF[]     = {{D6_,70},{0,30},{A5_,140}};
const Note S_ALARM[]     = {{2000,120},{1400,120},{2000,120},{1400,120},{2000,120},{1400,120},
                            {2000,120},{1400,220}};

struct Seq { const Note* n; uint8_t len; };
#define SFX_SEQ(a) { a, (uint8_t)(sizeof(a) / sizeof(a[0])) }
const Seq SEQS[CUE_COUNT] = {
  SFX_SEQ(S_BOOT), SFX_SEQ(S_STANDBY), SFX_SEQ(S_WAKE), SFX_SEQ(S_LINK_UP),
  SFX_SEQ(S_LINK_DOWN), SFX_SEQ(S_REC_START), SFX_SEQ(S_REC_STOP), SFX_SEQ(S_REC_FAIL),
  SFX_SEQ(S_NTICK), SFX_SEQ(S_NDONE), SFX_SEQ(S_LOST), SFX_SEQ(S_BACK),
  SFX_SEQ(S_M_CONN), SFX_SEQ(S_M_ON), SFX_SEQ(S_M_OFF), SFX_SEQ(S_ALARM),
};
#undef SFX_SEQ

uint8_t  pin = 2;
bool     muted = false;                              // 'Q' toggles (quiet bench work)
int8_t   cur = -1;                                   // cue playing, -1 = none
uint8_t  idx = 0;
uint32_t nextMs = 0;

void begin(uint8_t p) { pin = p; pinMode(pin, OUTPUT); }

bool busy() { return cur >= 0; }

void play(Cue c) {
  if (muted || c >= CUE_COUNT) return;
  if (cur == ALARM && c != ALARM) return;            // an alarm is never talked over
  cur = (int8_t)c; idx = 0; nextMs = millis();
}

void stop() { cur = -1; noTone(pin); }

void service() {
  if (cur < 0) return;
  const uint32_t now = millis();
  if ((int32_t)(now - nextMs) < 0) return;
  const Seq& s = SEQS[cur];
  if (idx >= s.len) { cur = -1; return; }
  const Note& n = s.n[idx++];
  if (n.f) tone(pin, n.f, n.ms); else noTone(pin);
  nextMs = now + n.ms;
}

}  // namespace sfx
