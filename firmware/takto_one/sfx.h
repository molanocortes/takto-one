// sfx.h - the device's sound: one clean, struck chime per key moment.
//
// A piezo driven by tone() can only make a flat, full-volume square beep, and a
// melody of those reads as a toy. Here the piezo is driven by hardware PWM at
// the note's pitch, and the pulse WIDTH is shaped by a 2 kHz timer interrupt:
// the fundamental's amplitude follows sin(pi * duty), so the width traces a
// real envelope - a 3 ms attack, then an exponential decay, like a small bell
// struck once. Each event is a single chime; events are told apart by pitch
// (bright = something good happened, low = attention) and by how long they
// ring. Only the motor-fault alarm repeats, because it must not be missed.
//
//   BOOT        C7, long ring            powered on
//   STANDBY     G6, long ring            going to standby (takes closed safely)
//   WAKE        C7, short                back from standby
//   LINK_UP     E7, soft                 a computer opened the link
//   LINK_DOWN   A6, soft                 the link closed; the device carries on
//   REC_START   D7                       recording to the SD card
//   REC_STOP    A6, longer               take closed and saved
//   REC_FAIL    E6, low                  no card / card full / write failed
//   NEUTRAL_*   E7 tick / G7 ring        countdown second / pose captured
//   SENSOR_LOST F6, low                  an IMU stopped reporting
//   SENSOR_BACK D7, short                it came back
//   MOTOR_*     B6 / E7 / G6             bus connected / torque on / torque off
//   ALARM       G7 struck 6x, 4 per s    motor fault: the safety path acted
//
// Timing lives in the interrupt, so a chime rings evenly however busy the
// loop is (the I2C sensor reads block for milliseconds at a time).

#pragma once
#include <Arduino.h>
#include <IntervalTimer.h>

namespace sfx {

enum Cue : uint8_t {
  BOOT, STANDBY, WAKE, LINK_UP, LINK_DOWN, REC_START, REC_STOP, REC_FAIL,
  NEUTRAL_TICK, NEUTRAL_DONE, SENSOR_LOST, SENSOR_BACK,
  MOTOR_CONNECT, MOTOR_TORQUE_ON, MOTOR_TORQUE_OFF, ALARM, CUE_COUNT
};

// one strike: pitch (Hz), peak loudness (0..100 %), decay time constant (ms),
// and how long until the next strike / the end (ms)
struct Strike { uint16_t f; uint8_t peak; uint16_t tauMs; uint16_t durMs; };

const Strike S_BOOT[]      = {{2093, 70, 420, 1300}};
const Strike S_STANDBY[]   = {{1568, 70, 480, 1400}};
const Strike S_WAKE[]      = {{2093, 60, 160, 500}};
const Strike S_LINK_UP[]   = {{2637, 40, 110, 350}};
const Strike S_LINK_DOWN[] = {{1760, 40, 110, 350}};
const Strike S_REC_START[] = {{2349, 75, 230, 700}};
const Strike S_REC_STOP[]  = {{1760, 75, 330, 900}};
const Strike S_REC_FAIL[]  = {{1319, 80, 380, 1000}};
const Strike S_NTICK[]     = {{2637, 35, 45, 180}};
const Strike S_NDONE[]     = {{3136, 70, 320, 900}};
const Strike S_LOST[]      = {{1397, 70, 260, 750}};
const Strike S_BACK[]      = {{2349, 55, 150, 450}};
const Strike S_M_CONN[]    = {{1976, 65, 220, 650}};
const Strike S_M_ON[]      = {{2637, 70, 160, 500}};
const Strike S_M_OFF[]     = {{1568, 65, 180, 550}};
const Strike S_ALARM[]     = {{3136, 90, 70, 250}, {3136, 90, 70, 250}, {3136, 90, 70, 250},
                              {3136, 90, 70, 250}, {3136, 90, 70, 250}, {3136, 90, 70, 400}};

struct Seq { const Strike* s; uint8_t len; };
#define SFX_SEQ(a) { a, (uint8_t)(sizeof(a) / sizeof(a[0])) }
const Seq SEQS[CUE_COUNT] = {
  SFX_SEQ(S_BOOT), SFX_SEQ(S_STANDBY), SFX_SEQ(S_WAKE), SFX_SEQ(S_LINK_UP),
  SFX_SEQ(S_LINK_DOWN), SFX_SEQ(S_REC_START), SFX_SEQ(S_REC_STOP), SFX_SEQ(S_REC_FAIL),
  SFX_SEQ(S_NTICK), SFX_SEQ(S_NDONE), SFX_SEQ(S_LOST), SFX_SEQ(S_BACK),
  SFX_SEQ(S_M_CONN), SFX_SEQ(S_M_ON), SFX_SEQ(S_M_OFF), SFX_SEQ(S_ALARM),
};
#undef SFX_SEQ

const uint32_t TICK_US   = 500;          // envelope rate: 2 kHz
const uint32_t ATTACK_US = 3000;         // no click at the onset
const uint16_t PWM_MAX   = 4095;         // 12-bit duty

uint8_t  pin = 2;
bool     muted = false;                  // 'Q' toggles (quiet bench work)
IntervalTimer timer;

// state shared with the ISR
volatile int8_t  cur = -1;               // cue playing (-1 none, CUE_COUNT = a UI click)
volatile uint8_t idx = 0;
volatile uint32_t tUs = 0;               // time since the current strike began
Strike clickStrike = {0, 0, 1, 1};       // the one-off UI click

static inline const Strike* strikeAt(int8_t c, uint8_t i) {
  return (c == CUE_COUNT) ? &clickStrike : &SEQS[c].s[i];
}
static inline uint8_t seqLen(int8_t c) { return (c == CUE_COUNT) ? 1 : SEQS[c].len; }

static void startStrike(const Strike* st) {
  analogWriteFrequency(pin, st->f);
  analogWrite(pin, 0);
  tUs = 0;
}

static void isr() {
  const int8_t c = cur;
  if (c < 0) return;
  const Strike* st = strikeAt(c, idx);
  tUs += TICK_US;
  if (tUs >= (uint32_t)st->durMs * 1000u) {
    if (++idx >= seqLen(c)) { analogWrite(pin, 0); cur = -1; return; }
    startStrike(strikeAt(c, idx));
    return;
  }
  // envelope: linear attack, exponential decay
  float a = (st->peak * 0.01f) * expf(-(float)tUs / (st->tauMs * 1000.0f));
  if (tUs < ATTACK_US) a *= (float)tUs / ATTACK_US;
  if (a < 0.004f) { analogWrite(pin, 0); return; }   // inaudible: keep the pin quiet
  if (a > 1.0f) a = 1.0f;
  // fundamental amplitude ~ sin(pi * duty)  =>  duty = asin(a) / pi (<= 50 %)
  const float duty = asinf(a) * 0.318309886f;
  analogWrite(pin, (uint16_t)(duty * (PWM_MAX + 1)));
}

void begin(uint8_t p) {
  pin = p;
  analogWriteResolution(12);             // nothing else on this board uses analogWrite
  analogWrite(pin, 0);
  timer.begin(isr, TICK_US);
}

bool busy() { return cur >= 0; }

static void launch(int8_t c) {
  noInterrupts();
  cur = c; idx = 0;
  startStrike(strikeAt(c, 0));
  interrupts();
}

void play(Cue c) {
  if (muted || c >= CUE_COUNT) return;
  if (cur == ALARM && c != ALARM) return;          // an alarm is never talked over
  launch((int8_t)c);
}

// A barely-there UI click (crown detent, button): a very short, soft strike.
void click(uint16_t f, uint8_t ms) {
  if (muted || cur >= 0) return;                   // never chop a cue
  clickStrike = { f, 22, (uint16_t)max(4, ms / 2), (uint16_t)max(12, ms * 3) };
  launch(CUE_COUNT);
}

void stop() { noInterrupts(); cur = -1; analogWrite(pin, 0); interrupts(); }

void service() {}                                  // timing lives in the ISR

}  // namespace sfx
