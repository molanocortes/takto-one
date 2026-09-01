/*
 * tiny_dxl.h - minimal Dynamixel Protocol 2.0 master for Teensy 4.x
 * =================================================================
 * Companion to tiny_bno085.h: the same philosophy (small, reentrant,
 * zero heap, every wait bounded) applied to the servo bus.
 *
 * Physical layer: one hardware UART + a 74HC241 half-duplex buffer.
 * The direction pin is handed to the Teensy core via
 * Serial.transmitterEnable(pin): the UART driver raises it before the
 * start bit and drops it after the LAST stop bit, in the ISR, with no
 * software timing on our side. That is the fastest turnaround the
 * hardware allows and the reason a dedicated DIR pin beats bit-banging.
 *
 * Protocol 2.0 essentials implemented (and nothing else):
 *   PING (0x01), READ (0x02), WRITE (0x03),
 *   SYNC READ (0x82), SYNC WRITE (0x83)
 * with correct CRC-16 (poly 0x8005, table-driven) and full byte
 * stuffing on both directions (FF FF FD in the payload is escaped as
 * FF FF FD FD; the length field counts stuffed bytes - getting this
 * wrong is the classic "works until the position crosses 0xFDFF" bug).
 *
 * Timing model: transactions are synchronous but BOUNDED. The caller
 * gives a deadline; the receive loop polls the FIFO and gives up at
 * deadline + returns false. At 1 Mbaud a write-status is ~11 bytes
 * (~110 us) and a 10-byte sync-read status is ~25 bytes (~250 us), so
 * a full read-compute-write servo tick fits comfortably inside 1 ms.
 * Every failure is counted, never silently retried: the control loop
 * decides what a miss means.
 */
#pragma once
#include <Arduino.h>

class TinyDXL {
public:
  // ---- bus statistics (public: the sketch prints them in 'M,s') ----
  uint32_t txCount = 0;        // instruction packets sent
  uint32_t rxTimeouts = 0;     // statuses that never arrived in time
  uint32_t crcErrors = 0;      // statuses with a bad CRC
  uint32_t errStatus = 0;      // statuses carrying a hardware-error bit
  uint32_t lastTxnUs = 0;      // duration of the last transaction
  uint32_t lastTurnaroundUs = 0; // measured bus turnaround: TX end -> first RX byte
  uint16_t rxGuardUs = 250;    // hot-path RX turnaround allowance (RDT 0 + intrinsic + margin)

  // NOTE: the port type is HardwareSerialIMXRT, not the abstract HardwareSerial.
  // transmitterEnable() (the hardware-timed half-duplex DIR line this driver
  // depends on) is declared only on the IMXRT subclass; the base class is pure
  // virtual and exposes just the Stream methods. Every SerialN global on a
  // Teensy 4.x already IS a HardwareSerialIMXRT, so this costs nothing.
  TinyDXL(HardwareSerialIMXRT* port, uint8_t dirPin) : ser(port), dir(dirPin) {}

  void begin(uint32_t baud) {
    baud_ = baud;
    ser->begin(baud);
    ser->transmitterEnable(dir);   // hardware-timed half-duplex direction
  }
  void end() { ser->end(); }
  uint32_t baud() const { return baud_; }

  // Single-master safety: with the 74HC241 idle (receive), LISTEN ONLY for
  // windowUs and report whether the bus was silent. If any byte arrives, another
  // master (the U2D2 host path) is driving DATA and the Teensy must NOT transmit.
  // Bounded, no TX, no heap. Call after begin(), before the first instruction.
  bool busQuiet(uint32_t windowUs) {
    while (ser->available()) ser->read();          // drop stale bytes first
    uint32_t t0 = micros();
    while ((uint32_t)(micros() - t0) < windowUs)
      if (ser->available()) return false;          // someone else is talking
    return true;
  }

  // ---- primitive transactions ------------------------------------------
  bool ping(uint8_t id, uint16_t* model = nullptr) {
    uint8_t core[1] = {0x01};
    sendPacket(id, core, 1);
    uint8_t prm[3];
    if (!readStatus(id, prm, 3, statusDeadlineUs(3))) return false;
    if (model) *model = (uint16_t)prm[0] | ((uint16_t)prm[1] << 8);
    return true;
  }

  // WRITE with status wait (use for configuration; reliable, slower)
  bool write(uint8_t id, uint16_t addr, const uint8_t* data, uint8_t n) {
    uint8_t core[3 + 16];
    if (n > 16) return false;
    core[0] = 0x03; core[1] = addr & 0xFF; core[2] = addr >> 8;
    memcpy(core + 3, data, n);
    sendPacket(id, core, 3 + n);
    return readStatus(id, nullptr, 0, statusDeadlineUs(0));
  }
  bool writeU8(uint8_t id, uint16_t addr, uint8_t v)  { return write(id, addr, &v, 1); }
  bool writeU16(uint8_t id, uint16_t addr, uint16_t v) {
    uint8_t b[2] = {(uint8_t)(v & 0xFF), (uint8_t)(v >> 8)};
    return write(id, addr, b, 2);
  }
  bool writeU32(uint8_t id, uint16_t addr, uint32_t v) {
    uint8_t b[4] = {(uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24)};
    return write(id, addr, b, 4);
  }

  bool read(uint8_t id, uint16_t addr, uint8_t n, uint8_t* out) {
    uint8_t core[5] = {0x02, (uint8_t)(addr & 0xFF), (uint8_t)(addr >> 8),
                       (uint8_t)(n & 0xFF), (uint8_t)(n >> 8)};
    sendPacket(id, core, 5);
    return readStatus(id, out, n, statusDeadlineUs(n));
  }

  // SYNC WRITE: same address/len to many ids, NO status returns (fast path)
  bool syncWrite(uint16_t addr, uint8_t len, const uint8_t* ids, uint8_t count,
                 const uint8_t* data /* count*len, id-major */) {
    uint8_t core[7 + 8 * 5];                       // up to 8 ids x (id + 4 bytes)
    if (count * (len + 1) > (int)sizeof(core) - 7) return false;
    uint8_t k = 0;
    core[k++] = 0x83;
    core[k++] = addr & 0xFF; core[k++] = addr >> 8;
    core[k++] = len; core[k++] = 0;
    for (uint8_t i = 0; i < count; i++) {
      core[k++] = ids[i];
      memcpy(core + k, data + i * len, len);
      k += len;
    }
    sendPacket(0xFE, core, k);                     // broadcast: no status
    return true;
  }

  // SYNC READ: one instruction, one status PER id, in id order.
  // out is count*len, id-major. All-or-nothing: false if any status is bad.
  bool syncRead(uint16_t addr, uint8_t len, const uint8_t* ids, uint8_t count,
                uint8_t* out) {
    uint8_t core[5 + 8];
    if (count > 8) return false;
    core[0] = 0x82;
    core[1] = addr & 0xFF; core[2] = addr >> 8;
    core[3] = len; core[4] = 0;
    memcpy(core + 5, ids, count);
    sendPacket(0xFE, core, 5 + count);
    for (uint8_t i = 0; i < count; i++)
      if (!readStatus(ids[i], out + i * len, len, statusDeadlineUs(len)))
        return false;
    return true;
  }

  // FAST SYNC READ (0x8A): one instruction, ONE concatenated status packet with
  // ONE bus turnaround. Regular Sync Read (0x82) pays a header + a servo
  // turnaround PER id; 0x8A returns every device's feedback back-to-back in a
  // single frame, so the tick shrinks toward the servo turnaround floor and the
  // saving GROWS with the motor count.
  //
  // Response (Protocol 2.0, verified against DynamixelSDK GroupFastSyncRead):
  //   FF FF FD 00  FE  LEN_L LEN_H  0x55  [ERR ID DATA*len CRC16]xN  CRC16
  // The Fast Sync Read status is NOT byte-stuffed, so we read the LEN-driven
  // frame and slice each device block at the fixed stride (len + 4). We trust
  // the on-wire LEN and verify the overall packet CRC, so the parse is correct
  // regardless of whether the trailing packet CRC is separate from the last
  // device's block CRC. out is count*len, id-major, DATA only; errOut (optional)
  // receives each device's status-error byte. All-or-nothing, every failure
  // counted. The wait is bounded and yield-free: this is the hot control path.
  bool fastSyncRead(uint16_t addr, uint8_t len, const uint8_t* ids, uint8_t count,
                    uint8_t* out, uint8_t* errOut = nullptr) {
    if (count == 0 || count > 8 || len > 16) return false;
    uint8_t core[5 + 8];
    core[0] = 0x8A;
    core[1] = addr & 0xFF; core[2] = addr >> 8;
    core[3] = len; core[4] = 0;
    memcpy(core + 5, ids, count);
    sendPacket(0xFE, core, 5 + count);

    // upper bound: hdr+id+len+instr(8) + count*(err+id+data+devcrc) + pkt crc(2)
    const uint16_t expect = 8u + (uint16_t)count * ((uint16_t)len + 4u) + 2u;
    uint8_t buf[8 + 8 * (16 + 4) + 2];             // max count 8, max len 16
    uint32_t deadline = ((uint32_t)expect * 10u * 1000000u) / baud_ + rxGuardUs;

    uint32_t t0 = micros();
    uint16_t got = 0, need = 10;                   // grows once LEN is known
    while ((uint32_t)(micros() - t0) < deadline) {
      while (ser->available() && got < need && got < sizeof(buf)) {
        if (got == 0) lastTurnaroundUs = micros() - txEndUs_;   // first byte back
        buf[got++] = ser->read();
      }
      while (got >= 4 && !(buf[0] == 0xFF && buf[1] == 0xFF &&
                           buf[2] == 0xFD && buf[3] == 0x00))
        memmove(buf, buf + 1, --got);
      if (got >= 7) {
        uint16_t length = (uint16_t)buf[5] | ((uint16_t)buf[6] << 8);
        need = 7u + length;
        if (need > sizeof(buf)) { rxTimeouts++; return false; }
      }
      if (got >= need && need >= 10) {
        uint16_t crc = crc16(0, buf, need - 2);
        if ((uint16_t)(buf[need - 2] | (buf[need - 1] << 8)) != crc) { crcErrors++; return false; }
        if (buf[4] != 0xFE || buf[7] != 0x55) { crcErrors++; return false; }  // broadcast talker, status instr
        bool anyErr = false;
        for (uint8_t i = 0; i < count; i++) {
          uint16_t base = 8u + (uint16_t)i * ((uint16_t)len + 4u);
          if (base + 2u + len > need - 2u) { crcErrors++; return false; }     // truncated frame
          if (buf[base + 1] != ids[i]) { crcErrors++; return false; }         // id / ordering mismatch
          if (errOut) errOut[i] = buf[base];
          if (buf[base] & 0x7F) anyErr = true;
          memcpy(out + (uint16_t)i * len, buf + base + 2u, len);
        }
        if (anyErr) errStatus++;
        return true;
      }
    }
    rxTimeouts++;
    return false;
  }

private:
  HardwareSerialIMXRT* ser;      // see the ctor note: transmitterEnable() is IMXRT-only
  uint8_t dir;
  uint32_t baud_ = 57600;
  uint32_t txEndUs_ = 0;        // micros() when the last instruction's stop bit left (for turnaround)

  // Status deadline for n parameter bytes: wire time of the status frame
  // (n + 11 protocol bytes, x10 bits) + servo return delay + scheduling
  // margin. RDT is configured to 8 us by the sketch; budget 520 us covers
  // even the factory 500 us default, so a mis-configured servo still answers.
  uint32_t statusDeadlineUs(uint8_t n) const {
    return ((n + 11u) * 10u * 1000000u) / baud_ + 520u + 150u;
  }

  // ---- CRC-16 (IBM/ANSI, poly 0x8005), the Protocol 2.0 checksum -------
  static uint16_t crc16(uint16_t crc, const uint8_t* d, uint16_t n) {
    for (uint16_t i = 0; i < n; i++) {
      uint16_t idx = ((crc >> 8) ^ d[i]) & 0xFF;
      crc = (crc << 8) ^ tbl_[idx];
    }
    return crc;
  }
  static const uint16_t tbl_[256];

  // Build + transmit one instruction packet: header, stuffed core, CRC.
  // core = instruction byte + parameters (unstuffed).
  void sendPacket(uint8_t id, const uint8_t* core, uint8_t coreLen) {
    uint8_t pkt[16 + 2 * 64];
    uint8_t k = 0;
    pkt[k++] = 0xFF; pkt[k++] = 0xFF; pkt[k++] = 0xFD; pkt[k++] = 0x00;
    pkt[k++] = id;
    uint8_t lenPos = k; k += 2;                    // length backfilled below
    // byte-stuff the core: an FF FF FD run gains an extra FD
    uint8_t ff = 0;
    for (uint8_t i = 0; i < coreLen; i++) {
      uint8_t b = core[i];
      pkt[k++] = b;
      if (ff >= 2 && b == 0xFD) { pkt[k++] = 0xFD; ff = 0; }
      else ff = (b == 0xFF) ? ff + 1 : 0;
    }
    uint16_t stuffed = k - lenPos - 2;
    uint16_t length = stuffed + 2;                 // + CRC16
    pkt[lenPos] = length & 0xFF; pkt[lenPos + 1] = length >> 8;
    uint16_t crc = crc16(0, pkt, k);
    pkt[k++] = crc & 0xFF; pkt[k++] = crc >> 8;
    while (ser->available()) ser->read();          // drop stale bus bytes
    uint32_t t0 = micros();
    ser->write(pkt, k);
    ser->flush();                                  // returns when the last stop bit left
    txEndUs_ = micros();
    lastTxnUs = txEndUs_ - t0;
    txCount++;
  }

  // Receive one status packet for `id`; destuff; verify CRC; copy n params.
  bool readStatus(uint8_t id, uint8_t* out, uint8_t n, uint32_t deadlineUs) {
    uint32_t t0 = micros();
    uint8_t buf[16 + 2 * 64];
    uint16_t got = 0, need = 10;                   // need grows once LEN known
    while (micros() - t0 < deadlineUs) {
      // read only THIS packet's bytes (bounded by need): a fast bus can already
      // have the NEXT id's SyncRead status in the FIFO, and pulling it into this
      // local buffer would drop it. Leave the surplus for the next readStatus.
      while (ser->available() && got < need && got < sizeof(buf)) {
        if (got == 0) lastTurnaroundUs = micros() - txEndUs_;   // first byte back
        buf[got++] = ser->read();
      }
      // hunt for the header (tolerates line noise before it)
      while (got >= 4 && !(buf[0] == 0xFF && buf[1] == 0xFF &&
                           buf[2] == 0xFD && buf[3] == 0x00)) {
        memmove(buf, buf + 1, --got);
      }
      if (got >= 7) {
        uint16_t length = (uint16_t)buf[5] | ((uint16_t)buf[6] << 8);
        need = 7 + length;
        if (need > sizeof(buf)) { rxTimeouts++; return false; }
      }
      if (got >= need && need > 10 - 1) {
        uint16_t crc = crc16(0, buf, need - 2);
        if ((buf[need - 2] | (buf[need - 1] << 8)) != crc) { crcErrors++; return false; }
        if (buf[4] != id) { crcErrors++; return false; }     // wrong talker
        if (buf[8] & 0x7F) errStatus++;            // hardware error flagged (still parse)
        // destuff parameters (between error byte and CRC)
        uint8_t k = 0, ff = 0;
        for (uint16_t i = 9; i < need - 2 && k < n; i++) {
          uint8_t b = buf[i];
          if (ff >= 2 && b == 0xFD) {              // stuffed FD: keep one, drop one
            uint16_t j = i + 1;
            if (j < need - 2 && buf[j] == 0xFD) { if (out) out[k] = b; k++; i = j; ff = 0; continue; }
          }
          if (out) out[k] = b;
          k++;
          ff = (b == 0xFF) ? ff + 1 : 0;
        }
        if (k < n) { crcErrors++; return false; }
        return true;
      }
      yield();
    }
    rxTimeouts++;
    return false;
  }
};

// CRC-16 lookup table, poly 0x8005 (the table from the Protocol 2.0 spec)
const uint16_t TinyDXL::tbl_[256] = {
  0x0000,0x8005,0x800F,0x000A,0x801B,0x001E,0x0014,0x8011,0x8033,0x0036,0x003C,0x8039,0x0028,0x802D,0x8027,0x0022,
  0x8063,0x0066,0x006C,0x8069,0x0078,0x807D,0x8077,0x0072,0x0050,0x8055,0x805F,0x005A,0x804B,0x004E,0x0044,0x8041,
  0x80C3,0x00C6,0x00CC,0x80C9,0x00D8,0x80DD,0x80D7,0x00D2,0x00F0,0x80F5,0x80FF,0x00FA,0x80EB,0x00EE,0x00E4,0x80E1,
  0x00A0,0x80A5,0x80AF,0x00AA,0x80BB,0x00BE,0x00B4,0x80B1,0x8093,0x0096,0x009C,0x8099,0x0088,0x808D,0x8087,0x0082,
  0x8183,0x0186,0x018C,0x8189,0x0198,0x819D,0x8197,0x0192,0x01B0,0x81B5,0x81BF,0x01BA,0x81AB,0x01AE,0x01A4,0x81A1,
  0x01E0,0x81E5,0x81EF,0x01EA,0x81FB,0x01FE,0x01F4,0x81F1,0x81D3,0x01D6,0x01DC,0x81D9,0x01C8,0x81CD,0x81C7,0x01C2,
  0x0140,0x8145,0x814F,0x014A,0x815B,0x015E,0x0154,0x8151,0x8173,0x0176,0x017C,0x8179,0x0168,0x816D,0x8167,0x0162,
  0x8123,0x0126,0x012C,0x8129,0x0138,0x813D,0x8137,0x0132,0x0110,0x8115,0x811F,0x011A,0x810B,0x010E,0x0104,0x8101,
  0x8303,0x0306,0x030C,0x8309,0x0318,0x831D,0x8317,0x0312,0x0330,0x8335,0x833F,0x033A,0x832B,0x032E,0x0324,0x8321,
  0x0360,0x8365,0x836F,0x036A,0x837B,0x037E,0x0374,0x8371,0x8353,0x0356,0x035C,0x8359,0x0348,0x834D,0x8347,0x0342,
  0x03C0,0x83C5,0x83CF,0x03CA,0x83DB,0x03DE,0x03D4,0x83D1,0x83F3,0x03F6,0x03FC,0x83F9,0x03E8,0x83ED,0x83E7,0x03E2,
  0x83A3,0x03A6,0x03AC,0x83A9,0x03B8,0x83BD,0x83B7,0x03B2,0x0390,0x8395,0x839F,0x039A,0x838B,0x038E,0x0384,0x8381,
  0x0280,0x8285,0x828F,0x028A,0x829B,0x029E,0x0294,0x8291,0x82B3,0x02B6,0x02BC,0x82B9,0x02A8,0x82AD,0x82A7,0x02A2,
  0x82E3,0x02E6,0x02EC,0x82E9,0x02F8,0x82FD,0x82F7,0x02F2,0x02D0,0x82D5,0x82DF,0x02DA,0x82CB,0x02CE,0x02C4,0x82C1,
  0x8243,0x0246,0x024C,0x8249,0x0258,0x825D,0x8257,0x0252,0x0270,0x8275,0x827F,0x027A,0x826B,0x026E,0x0264,0x8261,
  0x0220,0x8225,0x822F,0x022A,0x823B,0x023E,0x0234,0x8231,0x8213,0x0216,0x021C,0x8219,0x0208,0x820D,0x8207,0x0202
};
