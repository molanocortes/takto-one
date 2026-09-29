// emg.h - research-grade surface EMG acquisition for the MyoWare 2.0 (v19).
//
// WHY: v16-v18 read the MyoWare's ENV output with a loop-timed analogRead at a
// nominal 1 kHz and averaged it per frame. ENV is an analog envelope
// (rectified + smoothed on the sensor): the waveform, its spectrum, the mains
// pickup that tells electrode contact, and a sharp onset are all gone by the
// time it reaches the pin, and loop timing jittered with every paint.
//
// WHAT (ISEK / SENIAM practice, within one Teensy 4.1):
//   * a 2 kHz IntervalTimer samples BOTH MyoWare outputs on ADC1 (12 bit,
//     4x hardware averaging): ENV on pin 14 (A0) and RAW on pin 15 (A1). The
//     crown pot lives on ADC2 (pin 27 has no ADC1 channel), so the ISR and the
//     loop's analogRead never share a converter. The ISR spins on the
//     conversion-complete flag directly: the core analogRead() calls yield()
//     and must never run in an interrupt.
//   * pins 14/15 are pulled DOWN, so an unconnected output reads ~0 and
//     "present" is a measurement, not an assumption.
//   * RAW chain per sample: 4th-order Butterworth high-pass 20 Hz (motion
//     artefact and the Vs/2 offset out), notches at 50 and 100 Hz (mains and
//     its first harmonic, Q 25), 2nd-order Butterworth low-pass 450 Hz (the
//     sEMG band ends there). Before the notches a Goertzel detector measures
//     the 50 Hz power: mains pickup relative to the band is THE electrode-
//     contact indicator (a lifted electrode is an antenna).
//   * per frame (10 ms, 20 samples): RMS, MAV, waveform length, zero crossings
//     with hysteresis, saturation count; for ENV: mean and SD.
//   * spectrum: 256-point real FFT (CMSIS-DSP) on the filtered RAW with a Hann
//     window, a hop of 128 samples (64 ms): mean and median frequency (MNF,
//     MDF) of the 20-450 Hz band - the classical fatigue markers (MDF falls as
//     a sustained contraction fatigues).
#pragma once
#include <Arduino.h>
#include <arm_math.h>

namespace emg {

constexpr uint32_t FS = 2000;                 // Hz, per channel
constexpr uint8_t  PIN_ENV = 14, PIN_RAW = 15;
constexpr uint8_t  ADC1_CH_ENV = 7, ADC1_CH_RAW = 8;   // pin_to_channel (ADC1) for pins 14 / 15
constexpr uint16_t RING = 1024;               // power of two: ~0.5 s of both channels
constexpr float    MV_PER_COUNT = 3300.0f / 4095.0f;
constexpr uint16_t NFFT = 256, HOP = 128;

// ---- the ISR side -----------------------------------------------------------
static volatile uint16_t ringEnv[RING], ringRaw[RING];
static volatile uint32_t head = 0;            // samples written (wraps harmlessly)
static uint32_t tail = 0;                     // samples consumed (loop side)
static volatile uint32_t isrMaxUs = 0;
static IntervalTimer timer;
static bool running = false;

static inline uint16_t convert(uint8_t ch) {
  ADC1_HC0 = ch;
  while (!(ADC1_HS & ADC_HS_COCO0)) {}
  return (uint16_t)ADC1_R0;
}
static void isr() {
  const uint32_t t0 = ARM_DWT_CYCCNT;
  const uint32_t h = head;
  ringEnv[h & (RING - 1)] = convert(ADC1_CH_ENV);
  ringRaw[h & (RING - 1)] = convert(ADC1_CH_RAW);
  head = h + 1;
  const uint32_t us = (ARM_DWT_CYCCNT - t0) / (F_CPU_ACTUAL / 1000000);
  if (us > isrMaxUs) isrMaxUs = us;
}

// ---- filters (RBJ biquads, direct form I, float) ------------------------------
struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  inline float step(float x) {
    const float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  }
  void set(float b0_, float b1_, float b2_, float a0, float a1_, float a2_) {
    b0 = b0_ / a0; b1 = b1_ / a0; b2 = b2_ / a0; a1 = a1_ / a0; a2 = a2_ / a0;
  }
  void highpass(float f, float q) {
    const float w = 2.0f * PI * f / FS, c = cosf(w), al = sinf(w) / (2.0f * q);
    set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  void lowpass(float f, float q) {
    const float w = 2.0f * PI * f / FS, c = cosf(w), al = sinf(w) / (2.0f * q);
    set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  void notch(float f, float q) {
    const float w = 2.0f * PI * f / FS, c = cosf(w), al = sinf(w) / (2.0f * q);
    set(1, -2 * c, 1, 1 + al, -2 * c, 1 - al);
  }
  void prime(float x) { x1 = x2 = x; }        // start on the signal, not on a step
};

static Biquad hp1, hp2, n50, n100, lp;

// Goertzel at 50 Hz over 200 ms (400 samples: exactly 10 mains periods)
constexpr uint16_t GN = 400;
static float gk = 0, gs1 = 0, gs2 = 0, gEnergy = 0;
static uint16_t gi = 0;
static float linePct = 0;                     // 50 Hz power / band power, %

// spectrum
static float fftIn[NFFT], fftOut[NFFT], win[NFFT];
static float ringY[NFFT];
static uint16_t yPos = 0, sinceFft = 0;
static arm_rfft_fast_instance_f32 rfft;
static float mnf = 0, mdf = 0;

// presence (slow means of the raw pin levels)
static float envLong = 0, rawLong = 0;

// ---- per-frame features (read by the sketch after frame()) ---------------------
struct Frame {
  uint16_t n = 0;               // samples in this frame (20 nominal)
  float envMean = 0, envSd = 0; // counts (12 bit)
  float rawRms = 0, rawMav = 0, rawWl = 0;   // counts, band-passed
  uint16_t rawZc = 0, sat = 0;
  float mnf = 0, mdf = 0, linePct = 0;
  bool envPresent = false, rawPresent = false;
  uint32_t overruns = 0, isrMaxUs = 0;
};
static Frame fr;
static uint32_t overruns = 0;
static float zcThr = 4.0f;          // counts; adapts to the band's noise floor
static float yPrev = 0;
static bool yArmed = false;

inline void begin() {
  // ADC1: 12 bit, 4x hardware averaging, long sample time (the MyoWare output
  // is low impedance, the pulldown is 100k: ample settling). ADC2 (crown) is
  // left exactly as the core configured it.
  uint32_t cfg = ADC1_CFG & ~(0x0Cu | 0x300u | 0x10u | 0xC000u);   // MODE, ADSTS, ADLSMP, AVGS
  cfg |= ADC_CFG_MODE(2) | ADC_CFG_ADSTS(3) | ADC_CFG_ADLSMP | ADC_CFG_AVGS(0);
  ADC1_CFG = cfg;
  ADC1_GC |= ADC_GC_AVGE;
  pinMode(PIN_ENV, INPUT_PULLDOWN);
  pinMode(PIN_RAW, INPUT_PULLDOWN);
  // band-pass: 4th-order Butterworth HP = two biquads with Q 0.5412 / 1.3066
  hp1.highpass(20.0f, 0.5412f); hp2.highpass(20.0f, 1.3066f);
  n50.notch(50.0f, 25.0f); n100.notch(100.0f, 25.0f);
  lp.lowpass(450.0f, 0.7071f);
  gk = 2.0f * cosf(2.0f * PI * 50.0f / FS);
  for (uint16_t i = 0; i < NFFT; i++) win[i] = 0.5f - 0.5f * cosf(2.0f * PI * i / (NFFT - 1));
  arm_rfft_fast_init_f32(&rfft, NFFT);
  const uint16_t e0 = convert(ADC1_CH_ENV), r0 = convert(ADC1_CH_RAW);
  envLong = e0; rawLong = r0;
  hp1.prime(r0);
  timer.priority(96);           // above the loop, below USB/serial and the IMU I2C
  running = timer.begin(isr, 1000000.0f / FS);
}

static void spectrum() {
  // oldest-first copy with the window
  for (uint16_t i = 0; i < NFFT; i++) fftIn[i] = ringY[(yPos + i) & (NFFT - 1)] * win[i];
  arm_rfft_fast_f32(&rfft, fftIn, fftOut, 0);
  // fftOut: [re0, reN/2, re1, im1, ...]; bin k = k * FS / NFFT (7.8125 Hz)
  const uint16_t k0 = (uint16_t)ceilf(20.0f * NFFT / FS), k1 = (uint16_t)floorf(450.0f * NFFT / FS);
  float p[64];
  float tot = 0, mom = 0;
  for (uint16_t k = k0; k <= k1 && k - k0 < 64; k++) {
    const float re = fftOut[2 * k], im = fftOut[2 * k + 1];
    const float pk = re * re + im * im;
    p[k - k0] = pk; tot += pk; mom += pk * (k * (float)FS / NFFT);
  }
  if (tot <= 0) { mnf = mdf = 0; return; }
  mnf = mom / tot;
  float acc = 0;
  for (uint16_t k = k0; k <= k1 && k - k0 < 64; k++) {
    acc += p[k - k0];
    if (acc >= 0.5f * tot) { mdf = k * (float)FS / NFFT; break; }
  }
}

// Consume everything the ISR produced since the last frame. Call once per frame.
inline const Frame &frame() {
  uint32_t h = head;
  if (h - tail > RING) { overruns++; tail = h - RING; }     // the loop stalled > 0.5 s
  float es = 0, ess = 0, ss = 0, sa = 0, wl = 0;
  uint16_t n = 0, zc = 0, sat = 0;
  while (tail != h) {
    const uint16_t e = ringEnv[tail & (RING - 1)], r = ringRaw[tail & (RING - 1)];
    tail++; n++;
    es += e; ess += (float)e * e;
    if ((rawLong > 600.0f && (r < 16 || r > 4079)) || e > 4079) sat++;   // clipping of a CONNECTED channel
    envLong += (e - envLong) * 0.002f;       // ~0.25 s
    rawLong += (r - rawLong) * 0.002f;
    const float x = hp2.step(hp1.step((float)r));
    // mains detector BEFORE the notches
    const float s0 = x + gk * gs1 - gs2; gs2 = gs1; gs1 = s0;
    gEnergy += x * x;
    if (++gi >= GN) {
      const float pw = gs1 * gs1 + gs2 * gs2 - gk * gs1 * gs2;      // |X(50 Hz)|^2
      // a sinusoid of amplitude A over N samples: |X|^2 = (A N / 2)^2,
      // its energy N A^2 / 2 -> 50 Hz share of the band = 2 |X|^2 / (N E)
      linePct = gEnergy > 1e-6f ? 100.0f * 2.0f * pw / ((float)GN * gEnergy) : 0.0f;
      if (linePct > 100.0f) linePct = 100.0f;
      gs1 = gs2 = 0; gEnergy = 0; gi = 0;
    }
    const float y = lp.step(n100.step(n50.step(x)));
    ss += y * y; sa += fabsf(y);
    if (yArmed) {
      wl += fabsf(y - yPrev);
      if ((y > zcThr && yPrev < -zcThr) || (y < -zcThr && yPrev > zcThr) ||
          ((y >= 0) != (yPrev >= 0) && fabsf(y - yPrev) > 2 * zcThr)) zc++;
    }
    yPrev = y; yArmed = true;
    ringY[yPos] = y; yPos = (yPos + 1) & (NFFT - 1);
    if (++sinceFft >= HOP) { sinceFft = 0; spectrum(); }
  }
  fr.n = n;
  if (n) {
    fr.envMean = es / n;
    const float var = ess / n - fr.envMean * fr.envMean;
    fr.envSd = var > 0 ? sqrtf(var) : 0;
    fr.rawRms = sqrtf(ss / n); fr.rawMav = sa / n; fr.rawWl = wl;
    // zero-crossing hysteresis tracks the quiet band level (never below 3 counts)
    zcThr += (max(3.0f, 1.5f * fr.rawRms) - zcThr) * 0.01f;
  }
  fr.rawZc = zc; fr.sat = sat;
  fr.mnf = mnf; fr.mdf = mdf; fr.linePct = linePct;
  // present: a pulled-down, unconnected pin sits at ~0; the MyoWare ENV rests
  // at tens of mV and RAW is centred on Vs/2
  fr.envPresent = envLong > 8.0f;                           // > ~6.5 mV (a pulled-down open pin reads 0-2)
  fr.rawPresent = rawLong > 600.0f && rawLong < 3500.0f;    // mid-rail
  if (!fr.rawPresent) {           // no RAW wired: no spectrum, no mains figure to report
    fr.mnf = fr.mdf = 0; fr.linePct = 0;
  }
  fr.overruns = overruns;
  fr.isrMaxUs = isrMaxUs;
  return fr;
}

}  // namespace emg
