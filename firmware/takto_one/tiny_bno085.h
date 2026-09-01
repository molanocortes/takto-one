// tiny_bno085.h - minimal, REENTRANT BNO085 driver over I2C. FULL SENSOR SET.
//
// Why this exists: the Adafruit_BNO08x/CEVA sh2 driver keeps its context in
// file-scope globals (one sh2 instance, one sensor-value pointer, one callback),
// so it is single-instance by construction: two sensors clobber each other and
// the blocking read hangs. This driver keeps ALL state per-object, so any number
// of BNO085s can stream simultaneously (one per I2C bus here).
//
// Scope (2026-08-06): the BNO085 fuses far more than orientation, and the rig
// was throwing all of it away. This driver now takes the whole set -
//   0x01 accelerometer        m/s^2   Q8   (includes gravity)
//   0x02 gyroscope calibrated rad/s   Q9
//   0x03 magnetic field cal.  uT      Q4
//   0x04 linear acceleration  m/s^2   Q8   (gravity REMOVED - integrable)
//   0x05 rotation vector      unit    Q14  (mag-fused, + accuracy Q12 rad)
//   0x06 gravity              m/s^2   Q8
//   0x08 game rotation vector unit    Q14  (mag-IMMUNE, no accuracy field)
// - so the host can integrate translation, watch calibration quality, and pick
// its orientation source per sensor without a reflash.
//
// Protocol: SHTP over I2C (BNO08x datasheet 1.3.1, SH-2 ref manual 6.5.18).
//   - every read transaction starts with a 4-byte header: len LSB, len MSB
//     (bit15 = continuation), channel, sequence
//   - enable a sensor: Set Feature Command (0xFD) on channel 2
//   - data arrives as input reports on channel 3: a 5-byte timebase (0xFB)
//     followed by any number of concatenated reports, in ANY order
// No warranty beyond this rig; bench-verified against the wearable's sensors.
//
// THE BUG THIS FILE USED TO HAVE, written down so it is not reintroduced:
// the old parser accepted report id 0x05 and `break`ed on anything else. That
// made the driver single-report by construction - the moment a second feature
// was enabled, a batch arriving as [timebase][0x01 accel][0x05 quat] stopped at
// the accelerometer and the quaternion was never read. The fix is the length
// table below: every known report advances `i` by its own stride, so reports
// can arrive in any order and an UNKNOWN one is skipped by its declared length
// instead of killing the rest of the batch.

#pragma once
#include <Wire.h>

struct TinyBNO085 {
  // ---- report ids ----------------------------------------------------------
  static const uint8_t RPT_ACCEL      = 0x01;
  static const uint8_t RPT_GYRO       = 0x02;
  static const uint8_t RPT_MAG        = 0x03;
  static const uint8_t RPT_LINACC     = 0x04;
  static const uint8_t RPT_ROTVEC     = 0x05;
  static const uint8_t RPT_GRAVITY    = 0x06;
  static const uint8_t RPT_GAMEROTVEC = 0x08;

  TwoWire *bus;
  uint8_t  addr;
  uint8_t  seqTx = 0;      // our tx sequence on channel 2
  bool     ok    = false;  // begin() succeeded (feature command acked by wire)

  // Orientation source for THIS instance. 0x05 (rotation vector) is magnetometer
  // fused: absolute heading, but it sits next to twelve neodymium magnets
  // (Working/Thumb-IMU/REQUIREMENTS.md S1 measured 3401 uT at 10 mm against
  // Earth's ~50 uT). 0x08 (game rotation vector) is magnet-immune, bought with
  // yaw drift. Construct per sensor; both are parsed either way, so switching is
  // a one-argument change and the OTHER quaternion stays available for compare.
  uint8_t  rotReport = RPT_ROTVEC;

  // ---- fused orientation (the selected rotReport feeds qw..qz) -------------
  float    qw = 1.0f, qx = 0.0f, qy = 0.0f, qz = 0.0f;
  float    rotAccuracyRad = 0.0f;   // 0x05 only: reported heading accuracy
  uint8_t  rotStatus = 0;           // 0..3 calibration accuracy of the selected quat

  // ---- game rotation vector, kept even when it is not the selected source ---
  float    gw = 1.0f, gx = 0.0f, gy = 0.0f, gz = 0.0f;
  bool     haveGame = false;

  // ---- raw / derived vectors ----------------------------------------------
  float    ax = 0.0f, ay = 0.0f, az = 0.0f;   // accelerometer, m/s^2 (with gravity)
  float    gyroX = 0.0f, gyroY = 0.0f, gyroZ = 0.0f;  // rad/s
  float    mx = 0.0f, my = 0.0f, mz = 0.0f;   // magnetic field, uT
  float    lx = 0.0f, ly = 0.0f, lz = 0.0f;   // linear acceleration, m/s^2 (no gravity)
  float    grx = 0.0f, gry = 0.0f, grz = 0.0f; // gravity vector, m/s^2

  // per-family calibration accuracy (0 unreliable .. 3 high), straight from the
  // status byte. The host shows these; a drifting rig is usually a 0/1 here.
  uint8_t  accAccuracy = 0, gyroAccuracy = 0, magAccuracy = 0;

  bool     fresh = false;  // a quaternion arrived; the consumer CLEARS it after
                           // reading (read-and-clear), enabling staleness watch
  bool     freshVec = false;  // any non-orientation vector arrived (same contract)

  TinyBNO085(TwoWire *w, uint8_t a, uint8_t rotRpt = RPT_ROTVEC)
    : bus(w), addr(a), rotReport(rotRpt) {}

  bool present() {
    bus->beginTransmission(addr);
    return bus->endTransmission() == 0;
  }

  // ---- SHTP write: 4-byte header + payload in one transaction ------------
  bool sendPacket(uint8_t channel, const uint8_t *data, uint8_t len) {
    uint16_t total = (uint16_t)len + 4;
    bus->beginTransmission(addr);
    bus->write((uint8_t)(total & 0xFF));
    bus->write((uint8_t)(total >> 8));
    bus->write(channel);
    bus->write(seqTx++);
    bus->write(data, len);
    return bus->endTransmission() == 0;
  }

  // Set Feature Command for one report id at `interval_us` per report.
  bool enableReport(uint8_t reportId, uint32_t interval_us) {
    uint8_t p[17] = {0};
    p[0] = 0xFD;                       // SET_FEATURE_COMMAND
    p[1] = reportId;
    p[5] = (uint8_t)(interval_us & 0xFF);
    p[6] = (uint8_t)((interval_us >> 8) & 0xFF);
    p[7] = (uint8_t)((interval_us >> 16) & 0xFF);
    p[8] = (uint8_t)((interval_us >> 24) & 0xFF);
    return sendPacket(2, p, sizeof(p)); // channel 2 = SH-2 control
  }

  // Back-compat shim: the old one-report entry point.
  bool enableRotationVector(uint32_t interval_us = 10000) {
    return enableReport(rotReport, interval_us);
  }

  // How many of the last enableAll()'s feature commands were accepted by the
  // wire, and which one (if any) was refused. The host prints this: a sensor
  // that came up with six of seven reports must not look identical to a healthy
  // one, or a missing channel gets blamed on the parser for an afternoon.
  uint8_t featuresOk = 0, featuresAsked = 0;
  uint8_t lastFeatureFail = 0;

  // Enable the whole set. Orientation runs fastest because the twin is driven
  // from it; the vectors run at `vec_us` (default 100 Hz too - hand and forearm
  // sit on separate buses, so each sensor has a bus to itself). Raise vec_us if
  // the I2C budget ever gets tight: at 100 Hz one sensor emits
  // ~5 + 5*10 + 14 + 12 = 81 payload bytes per batch, about 8 kB/s against
  // ~40 kB/s usable on a 400 kHz bus.
  //
  // PACING IS NOT OPTIONAL. These are SH-2 control writes on channel 2, and the
  // BNO085 needs a moment between them: firing seven back to back gets some of
  // them dropped, silently. That is exactly what happened on the first v7 bench
  // run - the gyroscope never arrived and, because this used to return false on
  // any single failure, begin() reported the whole sensor dead while its
  // quaternion was in fact streaming fine.
  bool enableAll(uint32_t rot_us = 10000, uint32_t vec_us = 10000) {
    const uint8_t alt = (rotReport == RPT_GAMEROTVEC) ? RPT_ROTVEC : RPT_GAMEROTVEC;
    const uint8_t ids[7]  = { rotReport, alt, RPT_LINACC, RPT_ACCEL,
                              RPT_GYRO, RPT_GRAVITY, RPT_MAG };
    const uint32_t iv[7]  = { rot_us, rot_us, vec_us, vec_us, vec_us, vec_us, vec_us };
    featuresOk = 0; featuresAsked = 7; lastFeatureFail = 0;
    for (uint8_t i = 0; i < 7; i++) {
      bool got = false;
      for (uint8_t attempt = 0; attempt < 3 && !got; attempt++) {
        got = enableReport(ids[i], iv[i]);
        if (!got) delay(4);                   // let the chip catch up, then retry
      }
      if (got) featuresOk++;
      else lastFeatureFail = ids[i];
      delay(2);                               // pacing between control writes
    }
    // Success is defined by the ORIENTATION report alone. A missing gravity or
    // magnetometer row is a degraded sensor, not a dead one, and marking it dead
    // stops poll() entirely - which loses the quaternion too. The host reads
    // featuresOk to report the degradation honestly.
    return featuresOk > 0 && lastFeatureFail != rotReport;
  }

  // ---- SHTP read: one packet if available; parse every report in it -------
  // Returns true if it consumed a packet (of any kind).
  bool poll() {
    // read the 4-byte header alone first to learn the packet length
    if (bus->requestFrom((int)addr, 4) != 4) return false;
    uint8_t h0 = bus->read(), h1 = bus->read();
    uint8_t chan = bus->read(); (void)bus->read();      // seq, unused
    uint16_t len = ((uint16_t)h0 | ((uint16_t)h1 << 8)) & 0x7FFF;
    if (len == 0 || len == 0x7FFF) return false;        // nothing pending

    // A full batch is bigger than one rotation vector: timebase + seven reports
    // is ~90 B, and Teensy's Wire buffer takes it in one go. 160 covers the set
    // with headroom; anything larger is boot chatter and gets discarded below.
    if (len <= 160) {
      if (bus->requestFrom((int)addr, (int)len) != (int)len) return false;
      uint8_t buf[160];
      for (uint16_t i = 0; i < len; i++) buf[i] = bus->read();
      if (chan == 3) parseInput(buf + 4, len - 4);      // skip the 4-byte header
      return true;
    }
    // oversized packet (boot advertisement ~272 B): discard in chunks.
    // Each chunked transaction re-sends a 4-byte continuation header.
    uint16_t consumed = 0;
    while (consumed < len) {
      int n = bus->requestFrom((int)addr, 32);
      if (n <= 4) break;
      for (int i = 0; i < n; i++) (void)bus->read();
      consumed += (uint16_t)(n - 4);
    }
    return true;
  }

  // Byte length of a known input report, or 0 if we do not know it. This table
  // is what lets the parser walk a mixed batch: an unknown report id can be
  // stepped over only if its length is known, so anything genuinely unrecognised
  // still stops the walk (better than mis-parsing the remainder as garbage).
  static uint8_t reportLen(uint8_t id) {
    switch (id) {
      case 0xFB: return 5;    // timebase reference
      case 0xFA: return 5;    // timestamp rebase
      case RPT_ACCEL:
      case RPT_GYRO:
      case RPT_MAG:
      case RPT_LINACC:
      case RPT_GRAVITY:      return 10;   // 4-byte head + 3x int16
      case RPT_GAMEROTVEC:   return 12;   // 4-byte head + 4x int16, no accuracy
      case RPT_ROTVEC:       return 14;   // 4-byte head + 4x int16 + accuracy
      case 0x09:             return 14;   // geomagnetic rotation vector
      case 0x07:             return 10;   // magnetic field uncalibrated (partial)
      default:               return 0;
    }
  }

  static inline int16_t rd16(const uint8_t *p) {
    return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
  }

  void parseInput(const uint8_t *p, uint16_t n) {
    uint16_t i = 0;
    while (i < n) {
      const uint8_t id  = p[i];
      const uint8_t len = reportLen(id);
      if (len == 0 || i + len > n) break;      // unknown or truncated: stop here
      if (id == 0xFB || id == 0xFA) { i += len; continue; }

      const uint8_t status = p[i + 2] & 0x03;  // calibration accuracy, 0..3
      const uint8_t *v = p + i + 4;            // first data byte of the report

      switch (id) {
        case RPT_ACCEL: {                      // Q8, m/s^2
          const float s = 1.0f / 256.0f;
          ax = rd16(v) * s; ay = rd16(v + 2) * s; az = rd16(v + 4) * s;
          accAccuracy = status; freshVec = true;
          break;
        }
        case RPT_GYRO: {                       // Q9, rad/s
          const float s = 1.0f / 512.0f;
          gyroX = rd16(v) * s; gyroY = rd16(v + 2) * s; gyroZ = rd16(v + 4) * s;
          gyroAccuracy = status; freshVec = true;
          break;
        }
        case RPT_MAG: {                        // Q4, uT
          const float s = 1.0f / 16.0f;
          mx = rd16(v) * s; my = rd16(v + 2) * s; mz = rd16(v + 4) * s;
          magAccuracy = status; freshVec = true;
          break;
        }
        case RPT_LINACC: {                     // Q8, m/s^2, gravity removed
          const float s = 1.0f / 256.0f;
          lx = rd16(v) * s; ly = rd16(v + 2) * s; lz = rd16(v + 4) * s;
          freshVec = true;
          break;
        }
        case RPT_GRAVITY: {                    // Q8, m/s^2
          const float s = 1.0f / 256.0f;
          grx = rd16(v) * s; gry = rd16(v + 2) * s; grz = rd16(v + 4) * s;
          freshVec = true;
          break;
        }
        case RPT_ROTVEC:
        case RPT_GAMEROTVEC: {                 // Q14 unit quaternion
          const float s = 1.0f / 16384.0f;     // 2^-14
          const float i_ = rd16(v) * s, j_ = rd16(v + 2) * s,
                      k_ = rd16(v + 4) * s, r_ = rd16(v + 6) * s;
          if (id == RPT_GAMEROTVEC) {
            gx = i_; gy = j_; gz = k_; gw = r_; haveGame = true;
          }
          if (id == rotReport) {               // the selected orientation source
            qx = i_; qy = j_; qz = k_; qw = r_;
            rotStatus = status;
            // 0x05 carries a heading-accuracy field in Q12 radians; 0x08 does not.
            rotAccuracyRad = (id == RPT_ROTVEC) ? (rd16(v + 8) / 4096.0f) : 0.0f;
            fresh = true;
          }
          break;
        }
        default: break;                        // known length, no use for it yet
      }
      i += len;
    }
  }

  // [BENCH 2026-08-06] Why the last begin() failed. "Absent" and "ACKs but will
  // not configure" are DIFFERENT faults with different fixes, and a scan that
  // prints MISSING for both costs hours: absent means look for a wire, refusing
  // means the chip is powered and on the bus but not running its SH-2 firmware
  // (BOOTN/DFU held low, or held in reset). Tell them apart in the report.
  enum BeginFail : uint8_t { BF_NONE = 0, BF_ABSENT, BF_NO_FEATURES };
  uint8_t beginFail = BF_NONE;

  // SH-2 executable channel (1), command 1 = RESET. A chip left mid-advertisement
  // by an internal reset will refuse feature writes until it is reset cleanly;
  // this is the documented way back and is harmless on a healthy sensor.
  bool softReset() { const uint8_t p[1] = { 0x01 }; return sendPacket(1, p, 1); }

  // Drain boot chatter (bounded), then enable the full report set.
  // Two attempts: the second follows a soft reset, because a single failed
  // enableAll() is often a chip that needs re-starting rather than a dead one.
  bool begin(bool fullSet = true) {
    ok = false; fresh = false; freshVec = false; beginFail = BF_NONE;
    if (!present()) { beginFail = BF_ABSENT; return false; }
    for (uint8_t attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        softReset();
        // settle by polling (and discarding) rather than a bare delay, so the
        // bus keeps being serviced while the chip re-advertises
        uint32_t s = millis();
        while (millis() - s < 120) poll();
      }
      uint32_t t0 = millis();
      while (millis() - t0 < 150) { if (!poll()) break; }  // discard advertisements
      if (fullSet ? enableAll() : enableRotationVector()) { ok = true; return true; }
    }
    beginFail = BF_NO_FEATURES;
    return false;
  }
};
