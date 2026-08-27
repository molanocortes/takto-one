/*
 * takto_one - TAKTO ONE device firmware (Teensy 4.1)
 * ==================================================
 * The single merged firmware. It replaces the two divergent 2026-07-30
 * branches, which could not both be flashed onto the one Teensy:
 *
 *   Bringup-12ch/bringup_12ch.ino  (v5) -> 14 encoder channels behind two
 *       TCA9548A muxes, THREE BNO085s (hand / forearm / thumb tip), MyoWare
 *       EMG, SD logging, the transparency crown, and the Dynamixel XC330 bus
 *       through the 74HC241 on Serial1: the Teensy owns the motors and runs
 *       the control law itself.
 *   DeviceFirmware/DeviceFirmware.ino  -> the GC9A01A round display, the
 *       dirty-tile DMA renderer, the crown/button/piezo HMI, and the three
 *       the production TAKTO watch interface in watch/.
 *
 * Nothing was dropped in the merge. What CHANGED, and why, is marked
 * "[MERGE]" throughout; the four decisions that matter are:
 *
 *   1. ONE POT, TWO MEANINGS. The crown (pin 27) was the motor blend in one
 *      branch and the carousel's rotary nav in the other. Live at once, a
 *      wearer scrolling the menu would have slewed the assist blend from
 *      transparent to full assist. They are now arbitrated (see "crown
 *      arbitration"), and the crown is presence-checked so an unwired pin can
 *      never fabricate assist authority.
 *   2. THE ASSIST SETPOINT IS SEEDED FROM MEASURED POSITION whenever the
 *      assist law engages, so enabling the motors is always a no-op instead of
 *      a saturated PD step toward servo centre.
 *   3. THE PAINT NEVER STARVES THE CONTROL TICK. The display and the servo
 *      loop share one core, so motorService() is interleaved through every
 *      blocking stretch (encoder sweep, paint, SD, scans). 'M,s' reports the
 *      overruns honestly; the servo-side 100 ms Bus Watchdog is the backstop.
 *   4. THE STREAM NOW MATCHES ITS OWN HEADER. v5 advertised servo telemetry
 *      it never emitted. v6 emits it, plus a crown-presence flag. Appending
 *      only: every pre-existing field index is unchanged.
 *
 * ARCHITECTURE (see Bringup-12ch/WIRING_MASTER_PLAN.md; verify J41 against KiCad):
 *   Encoders : up to 14 AS5600 (addr 0x36) behind 2x TCA9548A muxes
 *              MUX_A @ 0x70 channels 0..7  -> encoder channels 0..7
 *              MUX_B @ 0x71 channels 0..5  -> encoder channels 8..13
 *              Mux main I2C bus  -> Teensy Wire  (SDA 18 / SCL 19), 400 kHz
 *   IMUs     : 3x BNO085. Hand 0x4A on Wire1 (17/16); forearm 0x4B on Wire2
 *              (25/24); THUMB TIP 0x4B on Wire1,
 *              routed through the palm PCB
 *              (the BNO085 has only two addresses, so the thumb shares the
 *              hand's bus at the other address - the reentrant driver was
 *              built for exactly this; adjust IMU_WIRE/IMU_ADDR index 2 if the
 *              bench routing differs).
 *   Motors   : 2x XC330-M181-T, Protocol 2.0, half-duplex through a 74HC241 on
 *              Serial1 (pins 0/1), direction on pin 7 (HIGH = transmit).
 *   Display  : GC9A01A 240x240 round panel on SPI0, CS 10 / DC 9 / RST 8.
 *   HMI      : crown pot pin 27 (A13), button pin 5, piezo pin 2.
 *   EMG      : MyoWare envelope on pin 14 (A0).
 *   SD       : Teensy 4.1 built-in socket (BUILTIN_SDCARD, SDIO - not SPI).
 *
 * PIN MAP - checked for conflicts across the merge (this is the whole board):
 *   0,1   Serial1 RX/TX (Dynamixel)      | 2   piezo
 *   5     button                          | 7   74HC241 direction
 *   8,9,10 display RST/DC/CS              | 11,12,13 SPI0 MOSI/MISO/SCK
 *   14    EMG (A0)                        | 16,17 Wire1 SCL/SDA (hand + thumb)
 *   18,19 Wire SDA/SCL (encoder muxes)    | 24,25 Wire2 SCL/SDA (forearm)
 *   27    crown pot (A13)                 | SDIO built-in SD
 *   No pin is claimed twice. SPI0 carries the panel only; SD is SDIO.
 *
 * SERIAL MENU (115200 baud, send a single letter):
 *   s = re-scan the buses and print the wiring report
 *   A = full I2C scan (what actually ACKs, and where)
 *   c = run a 12 s range-of-motion calibration (flex everything, slowly)
 *   r = start / stop an SD recording (toggles - bench-human convenience)
 *   b = START recording  (explicit, idempotent - what the host bridge sends)
 *   e = STOP  recording  (explicit, idempotent - what the host bridge sends)
 *   v = print the version banner "# ver bringup_12ch <n>" (host handshake)
 *   j = live stream ON   k = live stream OFF
 *   R = quiet hot-plug rescan (the host bridge sends this)
 *   T = paint-cost + loop-rate report (the display's frame budget)
 *   ? = help
 *   D,<screen>,<elapsedSec>,<mot>\n   host-pushed device-screen state
 *   W,<face>,<colorway>\n             host-pushed watch-face selection
 *   M,...\n                           motor commands (see below)
 * Every one of D/W/M is buffered as a WHOLE LINE and dispatched on '\n', so
 * payload bytes can never alias the single-letter commands above and no
 * parseInt() can stall the servo tick.
 *
 * MOTOR COMMANDS (all optional; the bus is untouched until M,t,1):
 *   M,t,<0|1>        release / TAKE the servo bus. TAKE first LISTENS and refuses
 *                    if another master is driving DATA (single-master: disconnect
 *                    the U2D2); then auto-baud scans (4 Mbps first), requires BOTH
 *                    motors present, qualifies the link (repeated round-trips),
 *                    checks the model, and connects torque OFF (compliant)
 *   M,e,<0|1>        torque off / ON (on-path configures current mode, RDT 0 us,
 *                    current limit, arms the Indirect feedback block, SEEDS the
 *                    assist setpoints from measured position, then energizes)
 *   M,m,<0|1|2>      mode: 0 idle, 1 RUN (blended transparency<->assist), 2 direct
 *   M,a,<-1|0..1000> assist blend override; -1 = follow the physical crown
 *   M,c,<id>,<mA>    direct current setpoint (mode 2), clamped to +/-44 mA (= 10 N)
 *   M,p,<id>,<deg>   assist position setpoint (mode 1), servo horn degrees
 *   M,k,<kp>,<kd>    assist gains [mA/rad, mA/(rad s^-1)]
 *   M,f,<visc>,<coul> transparency friction feed-forward [mA/(rad s^-1), mA]
 *   M,s              print servo-loop + bus statistics (human)
 *   M,u              one-time servo EEPROM upgrade: baud -> 4 Mbps, RDT -> 0 us
 *   M,b[,N]          bus benchmark: N ticks with 0x82 then 0x8A at the current baud
 *   Feedback per tick: ONE Fast Sync Read 0x8A (position + current + velocity +
 *   hardware-error, one turnaround) + ONE Sync Write (goal current); inner loop
 *   up to 2 kHz at 4 Mbaud. Watchdog: 600 ms without any M COMMAND line (v14:
 *   the 50 Hz 'M,j' joint telemetry no longer counts as liveness) demotes
 *   direct-current and jog to RUN, re-seeds the assist setpoint from measured
 *   position, and returns blend authority to the crown - the device degrades to
 *   the compliant (transparent-leaning) state, never to a locked one.
 *   MODE 4 IS THE EXCEPTION (v14): it drives a worn finger from a host-computed
 *   target, so host silence DE-ENERGIZES it (faultCause 7) rather than demoting
 *   it to a crown-blended hold that would keep pushing after the host died.
 *   Safety: any Hardware Error Status bit or MOTOR_ERR_TRIP consecutive missed
 *   reads -> torque off (counted, recoverable with M,e,1).
 *
 * LIVE STREAM (for the web console bridge): while streaming is ON the sketch
 * emits, at SAMPLE_HZ, one line per sample:
 *   S,<t_ms>,<enc00>..<enc13>,<h_qw,h_qx,h_qy,h_qz>,<f_qw,f_qx,f_qy,f_qz>,
 *     <imu0live>,<imu1live>,<emg_env>,<emg_rms>,<emg_present>,<crown_0..1000>,
 *     <t_qw,t_qx,t_qy,t_qz>,<imu2live>,<mflags>,<m0_pos>,<m0_vel>,<m0_ma>,
 *     <m1_pos>,<m1_vel>,<m1_ma>,<crown_live>
 * (fields are append-only across firmware versions: v3 ended at crown, v4
 *  appends the thumb-tip quaternion + live flag, v5 DOCUMENTED servo telemetry,
 *  v6 actually EMITS it and appends crown_live, v7 the full IMU set, v9 the
 *  motor fault diagnostics, v14 one seaState byte at the very end. mflags =
 *  taken | torque<<1 | mode<<2 | fault<<5 (bit 4 is mode 4, the SEA loop);
 *  seaState = zeroed | armed<<1 | directions<<2 | jointFresh<<3; pos deg /
 *  vel dps / mA; crown_live = 1 present, -1 no crown wired. Hosts parse by
 *  index and must tolerate a short line.)
 * Encoders that did not answer at the last scan stream -1. Re-scan ('s') after
 * you wire a new channel so it starts streaming. Scan/calib/record still work.
 *
 * Libraries: Wire, SD, EEPROM, SPI are built in; install "Adafruit GFX" and
 * "Adafruit GC9A01A" via Library Manager. The BNO085 driver is tiny_bno085.h
 * here (reentrant, three instances) - the Adafruit library is single-instance
 * and cannot do this.
 * No warranty: compile, flash, then work through
 * Working/Final-Hardening-2026-07/BENCH-RUNBOOK-FIRMWARE.md with the device on
 * the bench before trusting a joint.
 */

#include <Wire.h>
#include <SD.h>
#include <EEPROM.h>        // watch-face selection survives a power cycle
#include "tiny_bno085.h"   // reentrant per-instance driver (Adafruit lib is single-instance)
#include "tiny_dxl.h"      // minimal Protocol 2.0 master (74HC241 half-duplex on Serial1)
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_GC9A01A.h>
#include <Fonts/FreeSansBold24pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSans9pt7b.h>
#include "firmware_ui.h"   // dirty-tile + DMA panel push, crown/button/piezo HMI

// ---- configuration ---------------------------------------------------------
#define MUX_BUS      Wire          // encoders' mux main bus (pins 18/19)
// Each BNO085 gets its OWN I2C bus where it can (kills the two-device clock-
// stretch contention). The thumb is the second address on Wire1.
// The verified wearable, open release and Bringup-12ch firmware all use the
// strapped forearm module at 0x4B. A later 0x4A edit probed an empty address
// after flashing and left the forearm stream zero-filled/offline.
TwoWire* const IMU_WIRE[3] = { &Wire1, &Wire2, &Wire1 };   // hand, forearm, thumb
const uint8_t  MUX_ADDR[2] = {0x70, 0x71};
const uint8_t  CH_PER_MUX  = 8;        // TCA9548A has 8 channels
const uint8_t  N_CHANNELS  = 14;       // encoder channels in use (0..13)
const uint8_t  AS5600_ADDR = 0x36;
const uint8_t  REG_STATUS  = 0x0B;
const uint8_t  REG_AGC     = 0x1A;     // automatic gain, rails when the magnet is wrong
const uint8_t  REG_MAG_HI  = 0x1B;     // CORDIC magnitude (0x1B:0x1C)
const uint8_t  AS_MD       = 0x20;     // STATUS bit 5: magnet detected
const uint8_t  AS_ML       = 0x10;     // STATUS bit 4: magnet too weak
const uint8_t  AS_MH       = 0x08;     // STATUS bit 3: magnet too strong
// Declared up here on purpose: the .ino auto-prototype pass hoists function
// prototypes to the top of the file, so a struct used in a signature must be
// visible before them or the build fails with "does not name a type".
struct MagStat { bool ok; uint8_t status; uint8_t agc; uint16_t mag; };
const uint8_t  REG_ANGLE_HI= 0x0E;
// NOTE: these addresses are duplicated in the bno[] constructors below. The
// scan report reads IMU_ADDR and the driver reads its own copy, so if the two
// ever disagree the wiring report lies about what the driver is talking to.
// Change both or neither.
uint8_t        IMU_ADDR[3] = {0x4A, 0x4B, 0x4B};   // forearm default 0x4B on Wire2;
                                                   // runtime probe also accepts 0x4A
const char*    IMU_NAME[3] = {"hand", "forearm", "thumb"};
const float    SAMPLE_HZ   = 50.0f;
const uint8_t  EMG_PIN     = 14;       // MyoWare ENVELOPE output on A0; oversampled -> env + rms
// [MERGE] v6: the S-line finally carries the servo telemetry v5 documented, plus
// crown_live. Both are APPENDED, so every pre-existing field index is unchanged
// and an old host simply does not look at them.
const uint8_t  FW_VERSION  = 15;       // v15 adds the bounded mode-2 breakaway kick
                                       // (M,K) so direction identification can exceed
                                       // the sustained cap briefly; the follow law cannot
                                       // v14 reports SEA readiness so the host cannot
                                       // claim an arm the device refused; mode 4 now
                                       // de-energizes on host silence instead of
                                       // demoting to a crown-blended hold
                                       // v13 adds the calibration-gated two-DOF SEA mode
                                       // v7: full IMU set appended to the S-line
                                       // (linear accel, accel, gyro, mag, gravity,
                                       // game rotation vector, calibration accuracies)
                                       // v8: watch-face/display changes of 2026-08-10;
                                       // bumped so the host can tell this build from v7
const uint8_t  N_IMU       = 3;        // hand, forearm, thumb tip
const uint32_t IMU_STALE_MS = 500;     // no rotation report this long = the sensor silently died

// Crown potentiometer (pin 27 = A13, same wiring + calibrated active band as
// the v9 dashboard: the pot's usable travel is 300..720 of the 10-bit range).
// Continuous transparency control, Apple-crown style: low = fully transparent
// (device renders zero force), high = fully assisted. Streamed as 0..1000.
const uint8_t  POT_PIN         = 27;
const int      POT_ACTIVE_LOW  = 300;
const int      POT_ACTIVE_HIGH = 720;
// [MERGE] crown PRESENCE. An unwired analog pin floats, and a floating pin fed
// into the motor blend is fabricated authority: the console would show a crown
// that is not there and the assist term would follow ADC noise. The crown counts
// as present only after the raw ADC has sat inside the active band (plus a
// margin for pot tolerance) for CROWN_PRESENT_FRAMES consecutive frames, and
// leaves that state the instant it goes out of band. Absent -> crownFilt = -1 ->
// blend 0. The fail-safe direction is ALWAYS toward transparency, never assist.
// Honest limit: a floating pin that happens to sit inside the band still reads
// as present. This gate removes the obvious failure, not every conceivable one -
// the real protection is that assist requires an explicit M,e,1 and is capped.
const int      POT_PRESENT_LO  = 250;
const int      POT_PRESENT_HI  = 790;
const uint8_t  CROWN_PRESENT_FRAMES = 10;   // 0.2 s at 50 Hz

// ---- state -----------------------------------------------------------------
bool     chLive[N_CHANNELS];           // did this encoder answer at scan?
float    chMin[N_CHANNELS], chMax[N_CHANNELS];
float    frameDeg[N_CHANNELS];         // ONE acquisition per frame, shared by SD row + S-line + faces
float    romLo[N_CHANNELS], romHi[N_CHANNELS];   // running range, for face normalization
bool     chSampled = false;
// The rig surrounds the BNO085s with neodymium magnets, so the absolute
// rotation vector (0x05) can stall or jump while trying to reconcile an
// impossible magnetic field.  Game rotation vector (0x08) uses gyro + accel
// only.  Selecting it here also makes imuFreshMs/liveness follow the quaternion
// the twin actually consumes, rather than letting a stale 0x05 pose stay live.
TinyBNO085 bno[3] = {
  TinyBNO085(&Wire1, 0x4A, TinyBNO085::RPT_GAMEROTVEC),  // hand    - Wire1 (17/16)
  TinyBNO085(&Wire2, 0x4B, TinyBNO085::RPT_GAMEROTVEC),  // forearm - own bus (25/24)
  TinyBNO085(&Wire1, 0x4B, TinyBNO085::RPT_GAMEROTVEC)   // thumb tip - Wire1, 0x4B
};
bool     imuLive[3] = {false, false, false};
float    imuQ[3][4];                   // w,x,y,z per IMU
// FULL SENSOR SET (v7, 2026-08-06). The BNO085 fuses all of this and the rig
// used to read only the quaternion. imuLin is the one that makes translation
// possible at all: linear acceleration is the fused estimate with GRAVITY
// ALREADY REMOVED, so it can be rotated to world and integrated. The rest is
// kept because it is free once the reports are enabled, and because the host
// needs the accuracies to know whether to trust any of it.
float    imuLin[3][3];                 // linear acceleration, m/s^2 (no gravity)
float    imuAcc[3][3];                 // accelerometer, m/s^2 (with gravity)
float    imuGyr[3][3];                 // gyroscope, rad/s
float    imuMag[3][3];                 // magnetic field, uT
float    imuGrv[3][3];                 // gravity vector, m/s^2
float    imuGame[3][4];                // game rotation vector (magnetometer-immune)
uint8_t  imuAccu[3][3];                // calibration accuracy 0..3: accel, gyro, mag
float    imuRotAcc[3] = {0, 0, 0};     // rotation-vector heading accuracy, rad
uint32_t imuFreshMs[3] = {0, 0, 0};    // last rotation report (staleness watchdog)
uint32_t imuSvcMs = 0;                 // last imuService pass (self-stall forgiveness)
bool     sdOK = false;
File     recFile;
bool     recording = false;
uint32_t recStart = 0, recRows = 0;
uint16_t recSeq = 0;                   // next REC file number (collision-free names)
uint32_t lastSample = 0;
bool     streaming = false;            // live serial stream for the web-console bridge
// EMG (MyoWare envelope on pin 14): oversampled ~1 kHz between 50 Hz frames, reduced
// to mean (envelope) + RMS and appended to the S-line. The host runs the
// activation module (effort_control BayesianAmplitude + normalization) on this.
uint32_t emgSum = 0, emgSumSq = 0;
uint16_t emgCount = 0;
uint32_t emgLastU = 0;
float    emgEnv = 0.0f, emgRms = 0.0f;
bool     emgHave = false;
float    crownFilt = -1.0f;            // EMA of the crown pot, 0..1000 (-1 = absent/unknown)
uint8_t  crownInBand = 0;              // consecutive in-band frames (presence debounce)
bool     crownPresent = false;
// calibration progress, so the CALIB face means something during the 12 s sweep
bool     calibRunning = false;
float    calibProg = 0.0f;

// [MERGE] line-oriented host commands. D (screen), W (watch face) and M (motor)
// are each buffered whole and dispatched on '\n'. The old screen firmware read D
// and W with Serial.parseInt(), which blocks up to the stream timeout - with a
// servo loop running that is a stalled control tick, so it is gone.
char     lnBuf[64];
uint8_t  lnLen = 0;
char     lnTag = 0;                    // 0 = not in a line; else 'D' | 'W' | 'M'
bool     discardLine = false;          // swallowing an over-long line's tail

// ---- on-device screen (GC9A01 240x240 round; CS=10 DC=9 RST=8) --------------
#define TFT_CS 10
#define TFT_DC  9
#define TFT_RST 8
// Board silkscreen / cable routing differs between panel batches. Keep the
// GC9A01 MADCTL orientation explicit and build-selectable; do not guess this
// from a photo. Test 0,1,2,3 on the physical round panel and retain the value
// that makes the TAKTO wordmark upright and the screen bounds continuous.
#ifndef TFT_ROTATION
#define TFT_ROTATION 0
#endif
// The approved neutral is 180 degrees from the former fixed image. The UI
// follows the FOREARM IMU (not the hand IMU): the forearm is the stable body
// reference for a wrist-mounted display. Hardware quarter-turns are instant
// and avoid a costly, laggy software rotation of a 240x240 RGB565 framebuffer.
#define UI_DEFAULT_TURNS 2
#define UI_ORIENTATION_IMU 1
Adafruit_GC9A01A tft(TFT_CS, TFT_DC, TFT_RST);
GFXcanvas16 cv(240, 240);
// Screens show STATUS, not sensor telemetry: link/health, active mode, capture timer, save.
// The screen numbers below are the HOST WIRE FORMAT of the "D" command and are
// frozen for compatibility; internally they map onto FaceState (mapScreen()).
enum { UI_CONNECTING, UI_READY, UI_TRANSPARENT, UI_CAPTURE, UI_OPERATOR, UI_SAVED, UI_CALIB, UI_SAFE };
uint32_t scBootT0 = 0, scLastPush = 0, scLastService = 0;
int      hostScreen = -1;                     // set by the bridge: "D,<screen>,<elapsedSec>,<mot>\n"
long     hostElapsed = 0;
int      hostMot = 0;                         // motor status as the HOST sees it (advisory only now)
uint32_t hostRecvT = 0;
uint16_t* FB = nullptr;                       // active canvas buffer (cv)
// ---- premium UI engine: dirty-tile DMA push + crown HMI (firmware_ui.h) ----
DMAMEM uint16_t uiShadow[240 * 240];          // what the panel currently shows
DMAMEM uint8_t  uiStaging[240 * 16 * 2];      // one byte-swapped row band in flight
UiRenderer uiR;
UiInput    uiIn;                              // pot 27/A13, button 5, piezo 2
#define BTN_PIN 5
#define PZ_PIN  2
// crown carousel (local mode picker over HOME; host D still authoritative)
const char* MODE_IDS[4]   = { "transparent", "capture", "operator", "calibrate" };
uint32_t carouselUntil = 0;                   // carousel visible until this ms
int      localScreen = -1;                    // local selection until host D overrides
uint32_t localUntil = 0;
// self-normalizing on-device effort (real envelope, honest running range)
float effLo = 1e9f, effHi = -1e9f;

// ============================================================
//   THE FACE ENGINE
// ============================================================
// Three switchable faces draw the screen. They are pure CONSUMERS of
// DeviceState: they never read a sensor, never touch a bus, never block.
#include "watch/watch_engine.h"
#include "watch/watch_presentation.h"
#include "watch_prefs.h"   // face selection saved in EEPROM

DeviceState   dstate;
CarouselState carousel;
FaceState     curState = FS_BOOT;
uint32_t      stateEnterMs = 0;
bool          everLinked = false;             // a host link has existed at least once
// paint-cost instrumentation. A face that starves the sensing loop is a
// failure however good it looks, and the only numbers that count are measured
// on the panel, so the firmware measures itself: 'T' prints them.
uint32_t      paintLastUs = 0, paintMaxUs = 0, paintCount = 0, paintSumUs = 0;
uint32_t      loopPasses = 0, statsT0 = 0;
uint32_t      scLastSig = 0xFFFFFFFF;
WatchPresentationCadence screenCadence;
WatchPresentationFilter  screenFilter;
WatchQuarterTurnTracker  screenOrientation;
uint8_t       screenOrientationApplied = 0;
bool          screenForcePaint = true;            // first frame / face discontinuity
uint32_t      screenSamples = 0;                   // presentation ticks, not sensor ticks
uint32_t      screenDeferredBusy = 0;              // due frames held for coherent panel flush

// Forward declarations: the display service and the servo tick call each other's
// neighbourhood, and the Arduino preprocessor's generated prototypes are not
// enough once a function is used above its definition inside another function.
void motorService();
void screenService();

// the frozen host screen numbers -> the engine's state model
FaceState mapScreen(int s) {
  switch (s) {
    case UI_CONNECTING:  return FS_BOOT;
    case UI_READY:       return FS_IDLE;
    case UI_TRANSPARENT: return FS_TELEOP;
    case UI_CAPTURE:     return FS_RECORDING;
    case UI_OPERATOR:    return FS_LINKED;
    case UI_SAVED:       return FS_SAVED;
    case UI_CALIB:       return FS_CALIB;
    case -2:             return FS_STANDALONE;   // link existed, then went away
    default:             return FS_STOP;
  }
}

// ---- mux + encoder helpers (raw I2C, matches as5600_dual_reader) -----------
void muxSelect(uint8_t muxAddr, uint8_t ch) {
  MUX_BUS.beginTransmission(muxAddr);
  MUX_BUS.write(1 << ch);
  MUX_BUS.endTransmission();
}
void muxDisable(uint8_t muxAddr) {       // deselect all channels
  MUX_BUS.beginTransmission(muxAddr);
  MUX_BUS.write((uint8_t)0);
  MUX_BUS.endTransmission();
}
// map encoder channel 0..13 -> (mux, channel)
void chToMux(uint8_t ch, uint8_t &muxAddr, uint8_t &muxCh) {
  muxAddr = MUX_ADDR[ch / CH_PER_MUX];
  muxCh   = ch % CH_PER_MUX;
}
uint16_t readAngleRaw() {                // on the currently-selected channel
  MUX_BUS.beginTransmission(AS5600_ADDR);
  MUX_BUS.write(REG_ANGLE_HI);
  if (MUX_BUS.endTransmission(false) != 0) return 0xFFFF;
  if (MUX_BUS.requestFrom(AS5600_ADDR, (uint8_t)2) != 2) return 0xFFFF;
  uint8_t hi = MUX_BUS.read(), lo = MUX_BUS.read();
  return ((uint16_t)hi << 8) | lo;
}
bool encoderPresent() {                  // on the currently-selected channel
  MUX_BUS.beginTransmission(AS5600_ADDR);
  MUX_BUS.write(REG_STATUS);
  return (MUX_BUS.endTransmission(false) == 0 &&
          MUX_BUS.requestFrom(AS5600_ADDR, (uint8_t)1) == 1);
}
// [BENCH 2026-08-06] encoderPresent() proves the CHIP answers, not that a MAGNET
// is over it. An AS5600 with no magnet ACKs perfectly and streams noise, so the
// old "OK 0x36" wiring line read as healthy for a channel that cannot produce an
// angle. The AS5600 already knows: STATUS bit 5 = MD (magnet detected), bit 4 =
// ML (too weak / AGC railed high), bit 3 = MH (too strong / AGC railed low).
// AGC (0x1A) and MAGNITUDE (0x1B:0x1C) quantify the gap. Read-only registers, so
// this is safe to call from any scan.
MagStat readMagnetStatus() {             // on the currently-selected channel
  MagStat s = {false, 0, 0, 0};
  MUX_BUS.beginTransmission(AS5600_ADDR);
  MUX_BUS.write(REG_STATUS);
  if (MUX_BUS.endTransmission(false) != 0) return s;
  if (MUX_BUS.requestFrom(AS5600_ADDR, (uint8_t)1) != 1) return s;
  s.status = MUX_BUS.read();
  MUX_BUS.beginTransmission(AS5600_ADDR);
  MUX_BUS.write(REG_AGC);
  if (MUX_BUS.endTransmission(false) != 0) return s;
  if (MUX_BUS.requestFrom(AS5600_ADDR, (uint8_t)1) != 1) return s;
  s.agc = MUX_BUS.read();
  MUX_BUS.beginTransmission(AS5600_ADDR);
  MUX_BUS.write(REG_MAG_HI);
  if (MUX_BUS.endTransmission(false) != 0) return s;
  if (MUX_BUS.requestFrom(AS5600_ADDR, (uint8_t)2) != 2) return s;
  uint8_t hi = MUX_BUS.read(), lo = MUX_BUS.read();
  s.mag = ((uint16_t)hi << 8) | lo;
  s.ok = true;
  return s;
}
// One honest word for the wiring report.
const char* magnetVerdict(const MagStat& s) {
  if (!s.ok)                 return "status unreadable";
  if (!(s.status & AS_MD))   return "NO MAGNET (angle is noise)";
  if (s.status & AS_ML)      return "magnet TOO WEAK / too far";
  if (s.status & AS_MH)      return "magnet TOO STRONG / too close";
  return "magnet ok";
}
// Read every live channel in one batched sweep. Both muxes answer the same
// slave address (0x36), so the invariant is: never two muxes active at once.
// The old per-channel pattern (select + read + disable = 3 transactions each)
// honored that with 42 transactions per frame; this honors it with one disable
// per MUX SWITCH instead of per channel (selecting a channel on the same mux
// atomically replaces its channel mask), cutting frame I2C time ~30 %.
// Dead channels (chLive false) are skipped without touching the bus, as before.
// [MERGE] motorService() is called between channels. The sweep is the longest
// I2C blocker in the frame and the servo tick can be as short as 500 us, so
// without this the control loop would miss most of its ticks every frame.
// Interleaving is safe: the servo path touches Serial1 and pin 7 only, never
// I2C, so an active mux channel selection is undisturbed.
void readAllChannels(float out[N_CHANNELS]) {
  for (uint8_t m = 0; m < 2; m++) {
    muxDisable(MUX_ADDR[1 - m]);                    // the other mux stays silent
    const uint8_t chLo = m * CH_PER_MUX;
    uint8_t chHi = chLo + CH_PER_MUX;
    if (chHi > N_CHANNELS) chHi = N_CHANNELS;
    for (uint8_t ch = chLo; ch < chHi; ch++) {
      if (!chLive[ch]) { out[ch] = -1.0f; continue; }
      muxSelect(MUX_ADDR[m], ch % CH_PER_MUX);
      uint16_t raw = readAngleRaw();
      out[ch] = (raw == 0xFFFF) ? -1.0f : (raw & 0x0FFF) * 360.0f / 4096.0f;
      motorService();                               // keep the control tick alive
    }
    muxDisable(MUX_ADDR[m]);
  }
}

// Track the running range the faces normalize against. Split out of the sweep so
// the SD/stream path and the face path share one acquisition.
void noteChannelRange() {
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
    if (frameDeg[ch] < 0) continue;
    if (frameDeg[ch] < romLo[ch]) romLo[ch] = frameDeg[ch];
    if (frameDeg[ch] > romHi[ch]) romHi[ch] = frameDeg[ch];
  }
  chSampled = true;
}

// ---- servo bus: 74HC241 half-duplex on Serial1, XC330 in current mode --------
// Design: the CONTROL LAW RUNS HERE, next to the actuator, at up to 2 kHz.
// The host only sends setpoints and mode requests; if it dies, the watchdog
// demotes toward the compliant transparent state (never a locked one).
// Per tick: ONE Fast Sync Read 0x8A (position + current + velocity + hardware-
// error concatenated in a single status packet with ONE bus turnaround, via an
// Indirect Data block) + ONE Sync Write (goal current). At 4 Mbaud with RDT = 0
// the read+write is ~0.2 ms, so a 500 us tick (2 kHz) holds with margin; at
// slower buses the tick period stretches honestly (see motorTake). Lower loop
// latency -> lower phase lag -> the transparency term stays stable at higher
// gain -> lower felt back-drive force. Measure it all with M,b.
const uint8_t  DXL_DIR_PIN   = 7;      // 74HC241 1OE+2OE (HIGH = transmit)
const uint8_t  DXL_IDS[2]    = {1, 2};
const uint8_t  N_MOTOR       = 2;
// CURRENT CEILINGS RE-DERIVED 2026-08-10 for the XC330-T288-T actually fitted.
// These are FORCE limits expressed in amps: the wearer feels i*k_tau/r_spool,
// and with r_spool = 5 mm the old numbers were sized for an M181's 0.333 N.m/A:
//   150 mA -> 10.0 N felt, 350 mA -> 23.3 N backstop.
// A T288 makes 1.136 N.m/A, so the SAME 150 mA is 34 N and 350 mA is 79 N. The
// caps are therefore restated at the force they always meant. Nothing about the
// intended behaviour changes; the old values were correct arithmetic about the
// wrong motor. Keep host-side current limits synchronized with these values.
const float    I_CAP_MA      = 44.0f;  // = the same 10.0 N ceiling as before
const uint16_t I_LIMIT_REG   = 97;     // servo Current Limit (reg 38) = 22 N backstop
// [v15] BREAKAWAY KICK. Measured on this bench 2026-08-10 and confirmed
// 2026-08-16: these gearboxes need ~80 mA COMMANDED to start turning, but only
// ~25 mA to keep turning. Every sustained cap here is deliberately below that
// breakaway, which is correct for a worn device and also means the direction
// identification could never move the joint: it drew its full 30 mA and the
// encoder saw 0.01 deg.
//
// So the answer is not a higher sustained cap. It is a SHORT, BOUNDED window in
// which current may exceed I_CAP_MA, with four hard limits enforced HERE rather
// than trusted to the host:
//   1. ceiling  I_KICK_MAX_MA, still under the reg-38 hardware backstop
//   2. duration KICK_MAX_MS per arming, and it must be re-armed to continue
//   3. MODE 2 ONLY - the blended law and the SEA follow law can never use it
//   4. it expires on its own; there is no way to hold it open
const float    I_KICK_MAX_MA = 95.0f;  // < I_LIMIT_REG (97) so the servo's own limit still backs it
const uint32_t KICK_MAX_MS   = 250;
const float    CNT2DEG       = 0.087891f;              // 4096 counts / rev
const float    CNT2RAD       = 0.087891f * PI / 180.0f;
const float    VELU2DPS      = 0.229f * 6.0f;          // 0.229 rpm/unit -> deg/s
const float    QD_LP_ALPHA   = 0.222f; // 1-pole derivative filter, fc ~= 40 Hz @ 1 kHz
const uint32_t MOTOR_WD_MS   = 600;    // host-silence watchdog (demote, don't lock)
const uint8_t  MOTOR_ERR_TRIP= 25;     // consecutive bus misses before torque-off
// [MERGE] blend slew limit. The crown is now also the menu dial, and a fast
// twist (or the moment the carousel closes and the blend re-acquires the pot)
// would otherwise step the commanded current. Full 0->1 travel takes >= 0.5 s.
const float    ALPHA_SLEW_PER_S = 2.0f;
// Manual jog is position-regulated on the Teensy, not over the 10 Hz host
// round-trip.  The host loop was too slow to brake an unloaded spool once
// stiction broke: it saw 161.3 deg, while the next samples ran on to 197 deg.
// This dedicated law runs at the motor tick, affects one selected motor only,
// and remains below the global 44 mA (~10 N) ceiling.
const float    JOG_KP_MA_RAD = 700.0f;  // 12.2 mA/deg
const float    JOG_KD_MA_RAD_S = 4.0f;
const float    JOG_STICTION_MA = 6.0f;
const float    JOG_CAP_MA = 30.0f;      // ~6.8 N at T288 + 5 mm spool
const float    JOG_DEADBAND_RAD = 0.15f * PI / 180.0f;
// A 1 deg request produces ~18 mA from P + static feed-forward, which the live
// spool proved was still below breakaway.  Do not make every small request a
// hard 30 mA step: integrate a bounded extra only while the motor is stationary,
// and bleed it rapidly the instant motion begins.  If even 30 mA cannot move,
// the host's timed stall guard drops torque rather than increasing force.
const float    JOG_BOOST_MAX_MA = 12.0f;
const float    JOG_BOOST_UP_MA_S = 8.0f;       // 18 -> 30 mA takes about 1.5 s
const float    JOG_BOOST_DOWN_MA_S = 30.0f;    // unload boost within 0.4 s of motion
const float    JOG_STILL_RAD_S = 1.0f * PI / 180.0f;

// --- fast-bus operating point (verified against the XC330-M181 control table) --
// 4 Mbps is the XC330-M181 MAXIMUM (baud reg 8 value 6); reg value 7 / 4.5 Mbps
// belongs to the larger XM/XH series, not this actuator, so 4 Mbaud is the
// fastest HONEST operating point here. RDT 0 shaves the servo's return delay off
// every status frame. Both are one-time EEPROM writes via 'M,u'.
const uint32_t DXL_TARGET_BAUD = 4000000; // XC330-M181 ceiling
const uint8_t  DXL_BAUD_CODE   = 6;       // reg 8 = 6 -> 4 Mbps
const uint8_t  DXL_RDT_UNITS   = 0;       // reg 9, unit 2 us -> 0 us return delay
// Feedback registers folded into ONE contiguous Indirect Data block so a single
// Fast Sync Read grabs position + current + velocity + the (non-contiguous)
// hardware-error byte in one turnaround. Indirect Address 1 = 168 (stride 2),
// Indirect Data 1 = 224 (stride 1); both RAM on the XC330, so re-armed each
// enable (no EEPROM wear). Order = position first (control-critical), then
// current, velocity, hardware-error.
const uint16_t IND_ADDR_BASE = 168, IND_DATA_BASE = 224;
const uint16_t A_PRES_CUR = 126, A_HW_ERR = 70;
const uint8_t  IND_SRC[11] = {132,133,134,135, 126,127, 128,129,130,131, 70};
const uint8_t  IND_LEN      = 11;         // pos(4)+cur(2)+vel(4)+hwErr(1)
const uint8_t  HW_FAULT_MASK = 0x3F;      // any Hardware Error Status bit -> fail safe

// --- detection / connection robustness (correct + safe + reliable) -----------
const uint8_t  DETECT_PING_TRIES = 3;     // per-id ping attempts at a candidate baud
const uint8_t  LINK_QUAL_ROUNDS  = 16;    // round-trip probes used to qualify a baud
const uint8_t  LINK_QUAL_MIN     = 15;    // require >= this many (tolerate 1 warm-up miss)
const uint32_t BUS_QUIET_US      = 120000;// single-master listen window before we EVER transmit
// Model Numbers (reg 0) a PING may return. Both are XC330 and share this control
// table; they differ in gearbox and voltage class, which the firmware does not care
// about but the torque math does: M181 = 180.62:1, 5 V, 0.333 N.m/A;
// T288 = 288.35:1, 11.1 V, 1.15 N.m/A. Warn only on a model that is neither.
const uint16_t XC330_MODELS[2]   = {1230, 1220};  // XC330-M181-T, XC330-T288-T
// Seeding the assist setpoint used to get ONE shot at the feedback frame, issued
// microseconds after the EEPROM writes (reg 11, reg 38) and the 44 indirect-arming
// transactions in motorEnable(). A servo still settling from that burst answers
// neither read, and a perfectly healthy bus then reported "no feedback" and refused
// to energize. Walk the documented degradation ladder instead, with a settle between
// rounds. Bench evidence 2026-08-10: 'M,b' scored 600/600 on both 0x82 and 0x8A
// while motorEnable() failed 3/3 microseconds after the same config block.
const uint8_t  SEED_ROUNDS       = 4;     // probe attempts before we refuse to enable
const uint8_t  SEED_SETTLE_MS    = 5;     // settle between probe rounds
// Servo-side dead-man (Bus Watchdog, reg 98, unit 20 ms). If the servo sees no
// packet within this window it zeroes goal current ON ITS OWN - the one thing
// that protects the wearer if the TEENSY hangs (the host- and bus-watchdogs
// cannot run then). Every Sync Write pets it; it re-arms after a legitimate stall
// so transient blocks self-heal, but a true hang stays latched-safe (it latches
// by design and needs an explicit clear).
const uint8_t  BUS_WATCHDOG_UNITS = 5;    // 5 * 20 ms = 100 ms
const uint32_t BUS_WATCHDOG_US    = 100000;
const uint16_t A_BUS_WATCHDOG      = 98;

TinyDXL dxl(&Serial1, DXL_DIR_PIN);
struct {
  bool     taken = false, torque = false, fault = false;
  uint8_t  mode = 0;                   // 0 idle, 1 RUN, 2 direct current, 3 jog, 4 two-DOF SEA
  // T288-rescaled 2026-08-10 (see I_CAP_MA): every one of these produces a
  // CURRENT that the motor turns into torque through k_tau, so each was divided
  // by 3.41 to keep the torque it was tuned to deliver. Still runtime-settable
  // with M,k and M,f, and all four remain bench-tunable estimates.
  float    kp = 117.0f, kd = 2.35f;    // assist PD [mA/rad, mA/(rad/s)]
  float    frV = 0.88f, frC = 5.87f;   // transparency friction ff [mA/(rad/s), mA]
  float    frW = 0.5f;                 // Coulomb tanh width [rad/s]
  float    aOverride = -1.0f;          // blend 0..1; <0 = follow the crown pot
  float    alphaF = 0.0f;              // slew-limited blend actually applied
  float    qSet[2] = {0, 0};           // assist setpoints [rad]
  float    iSet[2] = {0, 0};           // direct current setpoints [mA]
  int8_t   jogIndex = -1;               // mode 3: selected motor only; -1 commands zero
  float    jogBoostMa = 0.0f;            // bounded breakaway adaptation, selected motor
  int8_t   jogErrSign = 0;               // reset boost rather than kick across target
  // Two independent SEA/impedance loops.  This is deliberately NOT an
  // antagonistic two-motor controller: motor 1 owns MCP's flex/ext cable pair,
  // and motor 2 owns PIP's flex/ext cable pair.  The bridge supplies calibrated
  // anatomical angles at 50 Hz; the current loop remains here at the motor bus.
  bool     seaZeroed = false, seaArmed = false, seaHaveJoint = false;
  float    seaJoint[2] = {0, 0}, seaJointPrev[2] = {0, 0}; // MCP, PIP [deg]
  float    seaJointVel[2] = {0, 0};                        // [deg/s]
  float    seaJointZero[2] = {0, 0}, seaTarget[2] = {0, 0}; // relative joint [deg]
  int8_t   seaDir[2] = {0, 0};   // must be explicitly identified: -1 / +1
  uint32_t seaJointMs = 0;
  float    q[2] = {0, 0}, qdF[2] = {0, 0}, qPrev[2] = {0, 0};
  float    posDeg[2] = {0, 0}, velDps[2] = {0, 0}, iMeas[2] = {0, 0};
  bool     havePrev = false;
  uint8_t  errRun = 0;
  uint32_t tickUs = 1000;              // period, set from the bus baud
  uint32_t nextTick = 0, lastCmdMs = 0;
  uint32_t nTicks = 0, nMiss = 0, nOverrun = 0, worstUs = 0;
  uint64_t sumUs = 0;                  // [MERGE] 64-bit: a uint32 wrapped after ~2.4 h
                                       // and printed a fake-fast mean on long runs
  // fast-bus feedback layout (chosen at enable; see motorEnable)
  bool     useFast = true;             // 0x8A Fast Sync Read available (else 0x82)
  bool     useIndirect = true;         // one-shot indirect block armed (else direct 126..135)
  uint16_t readAddr = A_PRES_CUR;      // 224 (indirect) or 126 (direct fallback)
  uint8_t  readLen  = 10;              // 11 (indirect) or 10 (direct)
  int8_t   offPos = 6, offCur = 0, offVel = 2, offErr = -1; // byte offsets in a device block
  uint8_t  hwErr[2] = {0, 0};          // last Hardware Error Status per motor
  uint32_t lastHwPollMs = 0;           // low-rate hw-error poll (only in the direct fallback)
  bool     wdRearm = false;            // re-arm the servo Bus Watchdog after a stall (self-heal)
  // Latched reason for the most recent fail-safe torque drop.  The old wire
  // contract exposed only a boolean `fault`, which made a cable dropout, a
  // servo hardware alarm and a control-loop stall indistinguishable.
  float    kickMa = 0.0f;              // [v15] breakaway allowance, mode 2 only
  uint32_t kickUntilMs = 0;            // and only until this instant
  uint8_t  faultCause = 0;             // 0 none, 1 cfg, 2 seed, 3 torque, 4 bus, 5 hw, 6 watchdog,
                                       // 7 host silence while driving (mode 4)
  uint32_t recoverFast = 0;             // Fast Sync Read -> regular Sync Read recoveries
  uint32_t recoverDirect = 0;           // indirect block -> direct register recoveries
} mc;

// [v15] The current ceiling in force RIGHT NOW. Everything except an armed,
// unexpired, mode-2 breakaway window gets the ordinary sustained cap.
float motorCapMa() {
  if (mc.mode == 2 && mc.kickUntilMs && (int32_t)(millis() - mc.kickUntilMs) < 0)
    return mc.kickMa;
  return I_CAP_MA;
}

uint8_t motorFlags() {
  return (mc.taken ? 1 : 0) | (mc.torque ? 2 : 0) | ((mc.mode & 7) << 2) |
         (mc.fault ? 32 : 0);          // bit 4 is SEA mode, so faults moved to bit 5
}

// [v14] The SEA/camera-follow prerequisites, as the DEVICE sees them.
// Until this existed the host could only report its own optimism: it sent the
// arm sequence and assumed it worked. An arm the firmware REFUSED (a stale
// joint sample, an unidentified direction, a missing zero) looked exactly like
// a successful one on screen, so the console could show "following" while the
// controller sat at zero current. These four bits make the refusal visible.
uint8_t seaStateBits() {
  const bool fresh = mc.seaHaveJoint && (millis() - mc.seaJointMs <= 150);
  return (mc.seaZeroed ? 1 : 0) | (mc.seaArmed ? 2 : 0) |
         ((mc.seaDir[0] != 0 && mc.seaDir[1] != 0) ? 4 : 0) | (fresh ? 8 : 0);
}

// Park the 74HC241 in RECEIVE. Called before the bus is ever taken and after it
// is released: a floating OE could otherwise enable the Teensy's transmit buffer
// onto the shared DXL data line while the U2D2 is master, which is a bus
// collision, not a nuisance. [MERGE] the old sketch left pin 7 undriven until
// the first dxl.begin().
void dxlParkReceive() {
  pinMode(DXL_DIR_PIN, OUTPUT);
  digitalWrite(DXL_DIR_PIN, LOW);      // HIGH = transmit, so LOW = listen
}

void motorTorqueOff() {
  if (mc.taken)
    for (uint8_t i = 0; i < N_MOTOR; i++) dxl.writeU8(DXL_IDS[i], 64, 0);
  mc.torque = false;
  mc.mode = 0;
  mc.alphaF = 0.0f;                    // re-engaging always starts transparent
  mc.jogIndex = -1;
  mc.jogBoostMa = 0.0f;
  mc.jogErrSign = 0;
  mc.seaArmed = false;
  mc.kickMa = 0.0f;                    // [v15] a breakaway window never survives torque-off
  mc.kickUntilMs = 0;
}

// [MERGE] Seed the assist setpoints from where the motors ACTUALLY are.
// mc.qSet defaults to 0 rad = servo centre (2048 counts). If the assist law
// engages while the horn sits anywhere else, the PD (kp = 117 mA/rad) saturates
// instantly and drives hard toward centre - the one path in this firmware that
// could yank a finger. Seeded, engaging assist is always a no-op, and the
// wearer feels the setpoint move only when the host actually commands it.
void motorSeedSetpoints() {
  for (uint8_t i = 0; i < N_MOTOR; i++) {
    mc.qSet[i] = mc.q[i];
    mc.qPrev[i] = mc.q[i];
    mc.qdF[i] = 0.0f;
  }
  mc.havePrev = false;                 // clean derivative restart
}

// Tick period tracks the wire budget so every baud stays correct, just slower:
// 4/3 Mbaud -> 2 kHz, >=1 Mbaud -> 1 kHz, 115200 -> 250 Hz, 57600 -> 100 Hz.
uint32_t tickUsForBaud(uint32_t baud) {
  return (baud >= 3000000) ? 500 : (baud >= 1000000 ? 1000 : (baud >= 115200 ? 4000 : 10000));
}
bool motorPing(uint8_t id, uint16_t* model) {   // bounded retries for the first, warm-up transaction
  for (uint8_t t = 0; t < DETECT_PING_TRIES; t++) if (dxl.ping(id, model)) return true;
  return false;
}

// An XC330 EEPROM setting persists across power cycles and can briefly keep the
// servo busy after a write.  Rewriting mode/limits on every Engage, then making
// one missing acknowledgement fatal, produced the observed `cause=configuration
// write` even though both motors remained readable.  These helpers first accept
// an already-correct value, otherwise write with bounded retries and trust only
// a read-back proof.  Torque is already off throughout the caller.
bool motorEnsureU8(uint8_t id, uint16_t addr, uint8_t want, bool eeprom) {
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    uint8_t got = 0xFF;
    if (dxl.read(id, addr, 1, &got) && got == want) return true;
    dxl.writeU8(id, addr, want);                    // a lost ACK may still have applied
    delay(eeprom ? 20 : 2);                         // let EEPROM/RAM commit before proof
    if (dxl.read(id, addr, 1, &got) && got == want) return true;
  }
  return false;
}

bool motorEnsureU16(uint8_t id, uint16_t addr, uint16_t want, bool eeprom) {
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    uint8_t rb[2] = {0xFF, 0xFF};
    if (dxl.read(id, addr, 2, rb) && (uint16_t)(rb[0] | (rb[1] << 8)) == want) return true;
    dxl.writeU16(id, addr, want);
    delay(eeprom ? 20 : 2);
    if (dxl.read(id, addr, 2, rb) && (uint16_t)(rb[0] | (rb[1] << 8)) == want) return true;
  }
  return false;
}

// Take the bus = DETECT the motors correctly, then CONNECT safely + reliably.
// Order matters:
//   1) single-master check: LISTEN first; refuse to transmit if the U2D2 (or any
//      other master) is already driving DATA. We never collide on the bus.
//   2) scan bauds fastest-first; at each, ping EVERY expected id (with retries).
//      Require ALL present - a half-populated bus is a fault, not a connection.
//   3) qualify the link: many round-trips must succeed before we trust the baud,
//      so a marginal 4 Mbaud (signal integrity) falls back to a solid slower one.
//   4) verify identity (model number) and force torque OFF (compliant, safe) on
//      connect. Only then is the bus "taken".
void motorTake() {
  static const uint32_t CAND[6] = {4000000, 1000000, 2000000, 3000000, 115200, 57600};
  // [v14] IDEMPOTENT on an already-healthy bus. The camera-follow arm sequence
  // sends M,t,1 every single time, and re-running the full detect here costs
  // 120 ms of quiet-listen plus a baud scan plus 16 qualification round-trips,
  // all with loop() blocked. During that block the host's 50 Hz M,j joint stream
  // is not read, so mc.seaJointMs goes stale - and the M,x,1 arm request that
  // arrives immediately afterwards then fails its own 150 ms freshness check.
  // The arm silently did nothing while every surface reported success. Re-scan
  // only when the bus is not already ours, or when a fault means it must be
  // re-established.
  if (mc.taken && !mc.fault) {
    Serial.println(F("# motor: bus already taken and healthy - no re-scan"));
    return;
  }
  // (1) single-master safety: is anyone else driving DATA right now?
  dxl.begin(CAND[0]);
  if (!dxl.busQuiet(BUS_QUIET_US)) {
    dxl.end();
    dxlParkReceive();
    mc.taken = false;
    Serial.println(F("# motor: DATA is BUSY - another master is driving the bus. Disconnect the "
                     "U2D2 before the Teensy takes the bus (single-master rule). Not taken."));
    return;
  }
  bool sawPartial = false;
  for (uint8_t b = 0; b < 6; b++) {
    dxl.begin(CAND[b]);
    delayMicroseconds(300);
    // (2) require EVERY expected motor at this baud
    uint16_t model[N_MOTOR]; bool present[N_MOTOR]; uint8_t nPresent = 0;
    for (uint8_t i = 0; i < N_MOTOR; i++) {
      model[i] = 0;
      present[i] = motorPing(DXL_IDS[i], &model[i]);
      if (present[i]) nPresent++;
    }
    if (nPresent == 0) continue;                       // nothing here; try the next baud
    if (nPresent < N_MOTOR) {                          // partial bus: report, keep looking
      sawPartial = true;
      Serial.printf("# motor @ %lu baud: only %u/%u present (", (unsigned long)CAND[b], nPresent, N_MOTOR);
      for (uint8_t i = 0; i < N_MOTOR; i++)
        Serial.printf("id%u %s%s", DXL_IDS[i], present[i] ? "OK" : "MISSING", i + 1 < N_MOTOR ? ", " : "");
      Serial.println(F(")"));
      continue;
    }
    // (3) qualify the link: repeated full round-trips must (almost) all succeed
    uint8_t good = 0;
    for (uint8_t r = 0; r < LINK_QUAL_ROUNDS; r++) {
      bool all = true;
      for (uint8_t i = 0; i < N_MOTOR; i++) if (!dxl.ping(DXL_IDS[i])) { all = false; break; }
      if (all) good++;
    }
    if (good < LINK_QUAL_MIN) {
      Serial.printf("# motor @ %lu baud: link UNRELIABLE (%u/%u round-trips) - trying a slower baud\n",
                    (unsigned long)CAND[b], good, LINK_QUAL_ROUNDS);
      continue;
    }
    // (4) identity check (warn, do not brick) + SAFE connect (torque OFF)
    for (uint8_t i = 0; i < N_MOTOR; i++) {
      bool known = false;
      for (uint8_t m = 0; m < 2; m++) if (model[i] == XC330_MODELS[m]) known = true;
      if (!known)
        Serial.printf("# motor WARN: id%u model %u is not a known XC330 (%u M181-T / %u T288-T)\n",
                      DXL_IDS[i], model[i], XC330_MODELS[0], XC330_MODELS[1]);
    }
    for (uint8_t i = 0; i < N_MOTOR; i++) dxl.writeU8(DXL_IDS[i], 64, 0);  // compliant on connect
    mc.taken = true; mc.torque = false; mc.mode = 0; mc.fault = false; mc.errRun = 0;
    mc.faultCause = 0;
    mc.alphaF = 0.0f;
    mc.tickUs = tickUsForBaud(CAND[b]);
    mc.nextTick = micros();
    Serial.printf("# motor CONNECTED @ %lu baud: id%u model %u, id%u model %u; link %u/%u; "
                  "tick %lu us (%lu Hz); torque OFF (compliant). Enable with M,e,1\n",
                  (unsigned long)CAND[b], DXL_IDS[0], model[0], DXL_IDS[1], model[1],
                  good, LINK_QUAL_ROUNDS, (unsigned long)mc.tickUs,
                  (unsigned long)(1000000UL / mc.tickUs));
    if (CAND[b] != DXL_TARGET_BAUD)
      Serial.printf("# motor hint: run M,u to move the servos to %lu baud (4 Mbps = XC330 max)\n",
                    (unsigned long)DXL_TARGET_BAUD);
    return;
  }
  dxl.end();
  dxlParkReceive();
  mc.taken = false;
  if (sawPartial)
    Serial.println(F("# motor: bus reachable but NOT fully populated - a servo is missing/unpowered. "
                     "Check the daisy-chain, the 5 V motor supply, and both IDs. Not taken."));
  else
    Serial.println(F("# motor: no servo answered on any baud (check 74HC241, wiring, 5 V motor supply). Not taken."));
}

void motorRelease() {
  motorTorqueOff();
  mc.taken = false;
  dxl.end();
  dxlParkReceive();
  Serial.println(F("# motor bus released"));
}

// Map the feedback registers into Indirect Data 1..11 so ONE Fast Sync Read
// grabs position + current + velocity + the non-contiguous hardware-error byte.
// Each Indirect Address k (2 B, at 168 + 2k) holds the source register address
// mirrored into Indirect Data k (1 B, at 224 + k). Written with torque off, then
// READ BACK and verified: if the map does not take (odd firmware / model), the
// caller falls back to the proven direct 126..135 read. RAM on the XC330, so
// this is a per-enable arm, not an EEPROM-wear item.
bool motorConfigIndirect(uint8_t id) {
  for (uint8_t k = 0; k < IND_LEN; k++)
    if (!dxl.writeU16(id, IND_ADDR_BASE + 2 * k, IND_SRC[k])) return false;
  for (uint8_t k = 0; k < IND_LEN; k++) {   // read-back verify (no blind trust)
    uint8_t rb[2];
    if (!dxl.read(id, IND_ADDR_BASE + 2 * k, 2, rb)) return false;
    if ((uint16_t)(rb[0] | (rb[1] << 8)) != IND_SRC[k]) return false;
  }
  return true;
}

// Arm (or re-arm) the servo-side Bus Watchdog: clear any latched error (write 0),
// then set the timeout. RAM register, valid with torque on or off.
bool motorArmWatchdog(uint8_t id) {
  // Clearing a latched watchdog and re-arming are RAM writes. Verify the final
  // value instead of relying on a single status acknowledgement.
  if (!motorEnsureU8(id, A_BUS_WATCHDOG, 0, false)) return false;
  return motorEnsureU8(id, A_BUS_WATCHDOG, BUS_WATCHDOG_UNITS, false);
}

// Decode one device's feedback block into mc.q / posDeg / velDps / iMeas.
void motorDecode(uint8_t i, const uint8_t* p) {
  int16_t curU = (int16_t)(p[mc.offCur] | (p[mc.offCur + 1] << 8));
  int32_t velU = (int32_t)(p[mc.offVel] | (p[mc.offVel + 1] << 8) |
                           ((uint32_t)p[mc.offVel + 2] << 16) | ((uint32_t)p[mc.offVel + 3] << 24));
  int32_t posU = (int32_t)(p[mc.offPos] | (p[mc.offPos + 1] << 8) |
                           ((uint32_t)p[mc.offPos + 2] << 16) | ((uint32_t)p[mc.offPos + 3] << 24));
  if (mc.offErr >= 0) mc.hwErr[i] = p[mc.offErr];   // hardware-error rides the fast read
  mc.iMeas[i] = (float)curU;                        // 1 mA / unit (XC330)
  mc.velDps[i] = velU * VELU2DPS;
  mc.posDeg[i] = (posU - 2048) * CNT2DEG;
  mc.q[i] = (posU - 2048) * CNT2RAD;
}

// Configure-and-enable. CONFIG is done first with torque OFF and its success is
// tracked; the motors are energized (torque ON + Bus Watchdog armed) ONLY if the
// whole config took AND we have a feedback frame to seed the setpoints from. On
// any lost config write we de-energize and report failure - we never leave a
// servo driven (possibly in a stale mode) while reporting OFF.
// Layered graceful degradation of feedback:
//   indirect block (adds hardware-error) -> direct 126..135 (no hw-error, polled)
//   Fast Sync Read 0x8A                   -> Sync Read 0x82
void motorEnable() {
  if (!mc.taken) { Serial.println(F("# motor: take the bus first (M,t,1)")); return; }
  bool ok = true, indOK = true;
  for (uint8_t i = 0; i < N_MOTOR; i++) {             // CONFIG (torque stays OFF)
    uint8_t id = DXL_IDS[i];
    ok &= motorEnsureU8(id, 64, 0, false);       // prove torque off before EEPROM
    ok &= motorEnsureU8(id, 11, 0, true);        // operating mode 0 = current control
    ok &= motorEnsureU8(id, 9, DXL_RDT_UNITS, true); // persistent; normally already correct
    ok &= motorEnsureU16(id, 38, I_LIMIT_REG, true); // hardware current ceiling
    indOK &= motorConfigIndirect(id);      // arm the one-shot feedback block (RAM)
  }
  // pick the feedback layout from what actually armed
  mc.useIndirect = indOK;
  if (indOK) { mc.readAddr = IND_DATA_BASE; mc.readLen = IND_LEN;
               mc.offPos = 0; mc.offCur = 4; mc.offVel = 6; mc.offErr = 10; }
  else       { mc.readAddr = A_PRES_CUR;    mc.readLen = 10;
               mc.offPos = 6; mc.offCur = 0; mc.offVel = 2; mc.offErr = -1; }
  // Walk the WHOLE documented degradation ladder before refusing:
  //   Fast Sync Read 0x8A -> Sync Read 0x82, and indirect block -> direct 126..135,
  // retried SEED_ROUNDS times with SEED_SETTLE_MS between. This used to be a single
  // pass of two back-to-back reads, which is why a healthy bus could report "no
  // feedback": both landed inside the servo's settle window after the config burst.
  uint8_t probe[N_MOTOR * 16], perr[N_MOTOR];
  bool seeded = false;
  uint8_t rounds = 0;
  for (; rounds < SEED_ROUNDS && !seeded; rounds++) {
    if (rounds) delay(SEED_SETTLE_MS);
    mc.useFast = dxl.fastSyncRead(mc.readAddr, mc.readLen, DXL_IDS, N_MOTOR, probe, perr);
    seeded = mc.useFast;
    if (!seeded) seeded = dxl.syncRead(mc.readAddr, mc.readLen, DXL_IDS, N_MOTOR, probe);
    if (!seeded && mc.useIndirect) {        // indirect did not answer: drop to direct
      mc.useIndirect = false;
      mc.readAddr = A_PRES_CUR; mc.readLen = 10;
      mc.offPos = 6; mc.offCur = 0; mc.offVel = 2; mc.offErr = -1;
    }
  }
  if (!ok) {                                          // config incomplete -> stay SAFE
    for (uint8_t i = 0; i < N_MOTOR; i++) dxl.writeU8(DXL_IDS[i], 64, 0);  // de-energize
    mc.torque = false; mc.fault = true; mc.mode = 0; mc.faultCause = 1;
    Serial.println(F("# motor ENABLE FAILED (a config write was lost) - torque OFF, staying safe"));
    return;
  }
  // [MERGE] no feedback frame = no safe setpoint. Refuse rather than energize
  // against the default 0 rad, which would be a saturated step toward centre.
  if (!seeded) {
    for (uint8_t i = 0; i < N_MOTOR; i++) dxl.writeU8(DXL_IDS[i], 64, 0);
    mc.torque = false; mc.fault = true; mc.mode = 0; mc.faultCause = 2;
    Serial.printf("# motor ENABLE FAILED (no feedback frame to seed the assist setpoint) - "
                  "torque OFF, staying safe | cfg=%u ind=%u addr=%u len=%u rounds=%u "
                  "timeouts=%lu crc=%lu\n",
                  ok ? 1 : 0, indOK ? 1 : 0, mc.readAddr, mc.readLen, rounds,
                  (unsigned long)dxl.rxTimeouts, (unsigned long)dxl.crcErrors);
    return;
  }
  for (uint8_t i = 0; i < N_MOTOR; i++) motorDecode(i, probe + i * mc.readLen);
  motorSeedSetpoints();                    // assist target = where the horn is NOW
  bool wdOK = true;
  for (uint8_t i = 0; i < N_MOTOR; i++) wdOK &= motorArmWatchdog(DXL_IDS[i]); // servo dead-man
  bool ton = wdOK;
  for (uint8_t i = 0; i < N_MOTOR; i++)
    ton &= motorEnsureU8(DXL_IDS[i], 64, 1, false);  // ENERGIZE, then read-back prove it
  if (!ton) {                                         // torque-on not confirmed -> stay SAFE
    for (uint8_t i = 0; i < N_MOTOR; i++) dxl.writeU8(DXL_IDS[i], 64, 0);
    mc.torque = false; mc.fault = true; mc.mode = 0; mc.faultCause = wdOK ? 3 : 6;
    Serial.println(wdOK
      ? F("# motor ENABLE FAILED (torque-on not acked) - torque OFF, staying safe")
      : F("# motor ENABLE FAILED (servo watchdog could not be armed) - torque OFF, staying safe"));
    return;
  }
  mc.torque = true; mc.fault = false; mc.faultCause = 0; mc.errRun = 0;
  if (mc.mode == 0) mc.mode = 1;           // enabling means: run the blended law
  mc.alphaF = 0.0f;                        // and it starts fully transparent
  mc.hwErr[0] = mc.hwErr[1] = 0;
  mc.wdRearm = false;
  mc.nextTick = micros();                  // tick immediately so the watchdog gets petted
  Serial.printf("# motor torque ON (current mode, RDT 0us, bus-watchdog %u ms) | feedback %s via %s (%u B/motor) | "
                "assist setpoints seeded at %.1f / %.1f deg, blend starts at 0 (transparent)\n",
                (unsigned)(BUS_WATCHDOG_UNITS * 20),
                mc.useIndirect ? "pos+cur+vel+hwErr" : "pos+cur+vel (hwErr polled)",
                mc.useFast ? "FAST sync read 0x8A" : "sync read 0x82", mc.readLen,
                mc.posDeg[0], mc.posDeg[1]);
}

// One-time EEPROM upgrade to the fast bus. Explicit command, never automatic:
// rewrites servo EEPROM (baud reg 8 = 6 -> 4 Mbps, the XC330-M181 ceiling; RDT 0)
// and re-opens the bus. Each servo answers its baud write at the OLD baud, then
// switches; we re-open at the target and PING to verify. If a servo does not
// come up (marginal signal integrity at 4 Mbps over this cable), we do not fake
// success: we rescan and report the real baud it actually answered on.
void motorUpgrade() {
  if (!mc.taken) { Serial.println(F("# motor: take the bus first (M,t,1)")); return; }
  motorTorqueOff();                              // never rewrite EEPROM while energized
  for (uint8_t i = 0; i < N_MOTOR; i++) {
    dxl.writeU8(DXL_IDS[i], 64, 0);              // torque off (EEPROM writes)
    dxl.writeU8(DXL_IDS[i], 9, DXL_RDT_UNITS);   // return delay 0 us
    dxl.writeU8(DXL_IDS[i], 8, DXL_BAUD_CODE);   // 6 = 4 Mbps (status returns at the old baud)
  }
  dxl.end();
  dxl.begin(DXL_TARGET_BAUD);
  delay(2);
  bool ok = dxl.ping(DXL_IDS[0]) && dxl.ping(DXL_IDS[1]);
  if (ok) {
    mc.tickUs = tickUsForBaud(DXL_TARGET_BAUD);  // 2 kHz: the 4 Mbps budget supports it
    mc.nextTick = micros();
    Serial.printf("# motor upgrade to %lu baud: OK (tick 500 us / 2 kHz)\n",
                  (unsigned long)DXL_TARGET_BAUD);
  } else {
    Serial.println(F("# motor upgrade: no ping at 4 Mbps - rescanning (staying honest about the real baud)"));
    motorTake();                                 // rediscover + set tickUs from the actual baud
  }
}

// The inner current-control tick (up to 2 kHz at 4 Mbaud): ONE Fast Sync Read
// (position + current + velocity + hardware-error in one turnaround) + ONE Sync
// Write (goal current). Lower loop latency = lower phase lag = the friction/
// impedance terms stay stable at higher gain = lower felt back-drive force.
// Blended control: i = (1-a)*i_transparent + a*i_assist, a = crown (or host
// override). a=0 renders zero force plus friction cancellation (best
// transparency); a=1 is a saturated PD toward the assist setpoint. One law,
// no mode-switching transients: the crown IS the controller interpolation.
void motorTick() {
  uint32_t t0 = micros();
  uint8_t rx[N_MOTOR * 16], rerr[N_MOTOR];
  // A >100 ms loop stall latches the XC330 Bus Watchdog.  Clear that latch
  // BEFORE the first post-stall feedback transaction.  Previously the re-arm
  // lived below the read, so a servo which rejected that read could never reach
  // the code intended to recover it and eventually tripped torque after 25
  // misses.  Writes are acknowledged; a failed re-arm remains safely off.
  if (mc.wdRearm && mc.torque) {
    bool armed = true;
    for (uint8_t i = 0; i < N_MOTOR; i++) armed &= motorArmWatchdog(DXL_IDS[i]);
    if (!armed) {
      mc.nMiss++;
      if (++mc.errRun >= MOTOR_ERR_TRIP) {
        motorTorqueOff(); mc.fault = true; mc.faultCause = 6;
      }
      return;
    }
    mc.wdRearm = false;
  }

  bool ok = false;
  if (mc.useFast) {
    ok = dxl.fastSyncRead(mc.readAddr, mc.readLen, DXL_IDS, N_MOTOR, rx, rerr);
    // Fast Sync Read is an optimisation, never a safety dependency.  A cable or
    // servo firmware which is marginal for the combined 0x8A response may be
    // perfectly solid with the ordinary 0x82 response.  Prove one good regular
    // frame and latch the conservative path for the rest of this enable.
    if (!ok && dxl.syncRead(mc.readAddr, mc.readLen, DXL_IDS, N_MOTOR, rx)) {
      ok = true; mc.useFast = false; mc.recoverFast++;
    }
  } else {
    ok = dxl.syncRead(mc.readAddr, mc.readLen, DXL_IDS, N_MOTOR, rx);
  }
  // The indirect map is also an optimisation.  If it becomes unreadable, prove
  // the contiguous native feedback registers before declaring the bus dead.
  if (!ok && mc.useIndirect &&
      dxl.syncRead(A_PRES_CUR, 10, DXL_IDS, N_MOTOR, rx)) {
    mc.useIndirect = false; mc.useFast = false;
    mc.readAddr = A_PRES_CUR; mc.readLen = 10;
    mc.offPos = 6; mc.offCur = 0; mc.offVel = 2; mc.offErr = -1;
    mc.recoverDirect++; ok = true;
  }
  if (!ok) {
    mc.nMiss++;
    if (++mc.errRun >= MOTOR_ERR_TRIP) {   // sustained bus loss: fail safe, stop driving
      motorTorqueOff();
      mc.fault = true; mc.faultCause = 4;
    }
    return;
  }
  mc.errRun = 0;
  float dt = mc.tickUs * 1e-6f;
  // [MERGE] blend command -> slew-limited applied blend. Sources: the host
  // override, else the crown; an ABSENT crown means 0, never noise.
  float alphaCmd = mc.aOverride;
  if (alphaCmd < 0.0f) alphaCmd = (crownFilt < 0.0f) ? 0.0f : crownFilt * 0.001f;
  const float dA = ALPHA_SLEW_PER_S * dt;
  if      (alphaCmd > mc.alphaF + dA) mc.alphaF += dA;
  else if (alphaCmd < mc.alphaF - dA) mc.alphaF -= dA;
  else                                mc.alphaF  = alphaCmd;
  const float alpha = mc.alphaF;
  uint8_t goal[N_MOTOR * 2];
  bool hwFault = false;
  for (uint8_t i = 0; i < N_MOTOR; i++) {
    motorDecode(i, rx + i * mc.readLen);
    if (mc.hwErr[i] & HW_FAULT_MASK) hwFault = true;
    float qdRaw = mc.havePrev ? (mc.q[i] - mc.qPrev[i]) / dt : 0.0f;
    mc.qPrev[i] = mc.q[i];
    mc.qdF[i] += QD_LP_ALPHA * (qdRaw - mc.qdF[i]);   // 1-pole derivative filter (fc ~ rate-dep)
    float iCmd = 0.0f;
    if (mc.mode == 1) {
      // transparency: cancel identified friction (viscous + smoothed Coulomb)
      float iT = -(mc.frV * mc.qdF[i] + mc.frC * tanhf(mc.qdF[i] / mc.frW));
      // assist: saturated PD toward the host setpoint
      float iA = mc.kp * (mc.qSet[i] - mc.q[i]) - mc.kd * mc.qdF[i];
      iCmd = (1.0f - alpha) * iT + alpha * iA;
    } else if (mc.mode == 2) {
      iCmd = mc.iSet[i];
    } else if (mc.mode == 3 && mc.jogIndex == (int8_t)i) {
      const float e = mc.qSet[i] - mc.q[i];
      if (fabsf(e) > JOG_DEADBAND_RAD) {
        const int8_t s = e > 0.0f ? 1 : -1;
        if (mc.jogErrSign != 0 && s != mc.jogErrSign) mc.jogBoostMa = 0.0f;
        mc.jogErrSign = s;
        if (fabsf(mc.qdF[i]) < JOG_STILL_RAD_S)
          mc.jogBoostMa = min(JOG_BOOST_MAX_MA,
                              mc.jogBoostMa + JOG_BOOST_UP_MA_S * dt);
        else
          mc.jogBoostMa = max(0.0f, mc.jogBoostMa - JOG_BOOST_DOWN_MA_S * dt);
        iCmd = JOG_KP_MA_RAD * e - JOG_KD_MA_RAD_S * mc.qdF[i]
             + s * (JOG_STICTION_MA + mc.jogBoostMa);
        iCmd = constrain(iCmd, -JOG_CAP_MA, JOG_CAP_MA);
      } else {
        mc.jogBoostMa = 0.0f;
        mc.jogErrSign = 0;
      }
    } else if (mc.mode == 4 && mc.seaArmed && mc.seaHaveJoint &&
               millis() - mc.seaJointMs <= 150 && mc.seaDir[i] != 0) {
      // Conservative virtual impedance.  The 30 mA cap is below the global
      // 44 mA ceiling; a stale joint sample produces zero current, never a
      // blind catch-up.  Spring tension is an estimate until a force calibration
      // is supplied, so it is not used as a false measured feedback signal.
      const float qRel = mc.seaJoint[i] - mc.seaJointZero[i];
      const float eDeg = mc.seaTarget[i] - qRel;
      const float iSea = mc.seaDir[i] * (0.70f * eDeg - 0.050f * mc.seaJointVel[i]);
      iCmd = constrain(iSea, -30.0f, 30.0f);
    }
    const float capMa = motorCapMa();                 // I_CAP_MA unless a mode-2 kick is live
    iCmd = constrain(iCmd, -capMa, capMa);            // software clamp below the reg-38 ceiling
    int16_t g = (int16_t)lrintf(iCmd);
    goal[i * 2] = (uint8_t)(g & 0xFF);
    goal[i * 2 + 1] = (uint8_t)((g >> 8) & 0xFF);
  }
  mc.havePrev = true;
  if (hwFault) {                            // a servo raised a hardware-error bit: stop, fail safe
    motorTorqueOff();
    mc.fault = true; mc.faultCause = 5;
    return;
  }
  if (mc.torque) dxl.syncWrite(102, 2, DXL_IDS, N_MOTOR, goal);  // also pets the servo Bus Watchdog
  uint32_t el = micros() - t0;
  mc.nTicks++;
  mc.sumUs += el;
  if (el > mc.worstUs) mc.worstUs = el;
}

void motorService() {
  if (!mc.taken) return;
  uint32_t now = micros();
  if ((int32_t)(now - mc.nextTick) < 0) return;
  int32_t late = (int32_t)(now - mc.nextTick);           // how late this tick arrived
  if ((uint32_t)late > mc.tickUs / 2) mc.nOverrun++;
  if (late > (int32_t)BUS_WATCHDOG_US && mc.torque)      // a stall this long may have latched the
    mc.wdRearm = true;                                   // servo Bus Watchdog: re-arm on the next tick
  mc.nextTick += mc.tickUs;
  if ((int32_t)(now - mc.nextTick) >= 0) mc.nextTick = now + mc.tickUs; // resync after stall
  // host-silence watchdog: degrade toward compliance, never toward a lock
  if (mc.torque && millis() - mc.lastCmdMs > MOTOR_WD_MS) {
    if (mc.mode == 4) {
      // [v14] Mode 4 is the only mode that DRIVES A WORN FINGER from a target
      // the host computes. There is no safe reduced version of it: demoting to
      // the blended law hands authority to the crown, and a crown parked
      // mid-travel (0.5 is its resting position on this bench) is a sustained
      // ~50 % assist hold on a joint nobody is commanding any more. The wearer
      // would feel the device keep pushing after the software that was steering
      // it died. De-energize instead, and latch it so re-engaging is deliberate.
      motorTorqueOff();
      mc.fault = true; mc.faultCause = 7;
    } else if (mc.mode == 2 || mc.mode == 3) {
      mc.mode = 1;                       // stale direct current is unsafe: blend law
      motorSeedSetpoints();              // [MERGE] and never against a stale setpoint
      mc.jogIndex = -1;
      mc.jogBoostMa = 0.0f;
      mc.jogErrSign = 0;
      mc.seaArmed = false;
    }
    mc.aOverride = -1.0f;                // the physical crown regains authority
  }
  // direct-fallback only: the hardware-error byte is not in the fast block, so
  // poll it off the hot path (~20 Hz) and fail safe on any fault bit.
  if (mc.torque && mc.offErr < 0 && millis() - mc.lastHwPollMs > 50) {
    mc.lastHwPollMs = millis();
    for (uint8_t i = 0; i < N_MOTOR; i++) {
      uint8_t e;
      if (dxl.read(DXL_IDS[i], A_HW_ERR, 1, &e)) {
        mc.hwErr[i] = e;
        if (e & HW_FAULT_MASK) { motorTorqueOff(); mc.fault = true; mc.faultCause = 5; }
      }
    }
  }
  motorTick();
}

void motorStats() {
  uint32_t mean = mc.nTicks ? (uint32_t)(mc.sumUs / mc.nTicks) : 0;
  Serial.printf("# motor stats: %lu ticks @ %lu us target, mean %lu us, worst %lu us, "
                "%lu overruns, %lu missed reads\n",
                (unsigned long)mc.nTicks, (unsigned long)mc.tickUs, (unsigned long)mean,
                (unsigned long)mc.worstUs, (unsigned long)mc.nOverrun, (unsigned long)mc.nMiss);
  Serial.printf("# dxl bus: %lu tx, %lu timeouts, %lu crc, %lu hw-err\n",
                (unsigned long)dxl.txCount, (unsigned long)dxl.rxTimeouts,
                (unsigned long)dxl.crcErrors, (unsigned long)dxl.errStatus);
  Serial.printf("# dxl link: %lu baud, %s%s, last turnaround %lu us, hwErr [0x%02X 0x%02X]\n",
                (unsigned long)dxl.baud(), mc.useFast ? "Fast Sync Read 0x8A" : "Sync Read 0x82",
                mc.useIndirect ? " + indirect(pos,cur,vel,hwErr)" : " + direct 126..135",
                (unsigned long)dxl.lastTurnaroundUs, mc.hwErr[0], mc.hwErr[1]);
  Serial.printf("# blend: cmd %s, applied %.3f, crown %s\n",
                mc.aOverride < 0 ? "crown" : "host-override", mc.alphaF,
                crownPresent ? "present" : "ABSENT (blend forced to 0)");
  Serial.printf("# motor recovery: cause=%u errRun=%u fast->regular=%lu indirect->direct=%lu\n",
                mc.faultCause, mc.errRun, (unsigned long)mc.recoverFast,
                (unsigned long)mc.recoverDirect);
  mc.nTicks = mc.nMiss = mc.nOverrun = mc.worstUs = 0;
  mc.sumUs = 0;
}

int motorIdIndex(int id) {
  for (uint8_t i = 0; i < N_MOTOR; i++) if (DXL_IDS[i] == id) return i;
  return -1;
}

// In-firmware benchmark: run n read+write ticks with BOTH methods (0x82 then
// 0x8A) at the CURRENT baud and feedback block, and print a measured row each:
// per-tick mean/min/max/jitter (us), measured bus turnaround (us), achieved Hz,
// and the delta of the bus error counters. Goal current is forced to 0 (safe:
// run with torque off for a pure bus measurement). To fill the full OLD-vs-NEW
// table, run 'M,b' before 'M,u' (1 Mbaud) and again after (4 Mbaud).
void motorBench(uint16_t n) {
  if (!mc.taken) { Serial.println(F("# motor: take the bus first (M,t,1)")); return; }
  if (n == 0) n = 2000;
  if (n > 20000) n = 20000;
  Serial.printf("# BENCH %u ticks/method @ %lu baud, %u B/motor, %s (goal=0, torque %s)\n",
                n, (unsigned long)dxl.baud(), mc.readLen,
                mc.useIndirect ? "indirect" : "direct", mc.torque ? "ON" : "off");
  Serial.println(F("# method meanUs minUs maxUs jitUs  turnUs(mean/min/max)  achHz    dTx dTo dCrc dHw"));
  uint8_t rx[N_MOTOR * 16], rerr[N_MOTOR], goal[N_MOTOR * 2];
  for (uint8_t j = 0; j < N_MOTOR * 2; j++) goal[j] = 0;
  for (uint8_t meth = 0; meth < 2; meth++) {
    uint32_t tx0 = dxl.txCount, to0 = dxl.rxTimeouts, cr0 = dxl.crcErrors, he0 = dxl.errStatus;
    uint32_t okN = 0, sumUs = 0, minUs = 0xFFFFFFFF, maxUs = 0;
    uint32_t sumTn = 0, minTn = 0xFFFFFFFF, maxTn = 0;
    uint32_t tStart = micros();
    for (uint16_t k = 0; k < n; k++) {
      uint32_t a = micros();
      bool ok = (meth == 0)
        ? dxl.syncRead(mc.readAddr, mc.readLen, DXL_IDS, N_MOTOR, rx)
        : dxl.fastSyncRead(mc.readAddr, mc.readLen, DXL_IDS, N_MOTOR, rx, rerr);
      if (ok) dxl.syncWrite(102, 2, DXL_IDS, N_MOTOR, goal);
      uint32_t el = micros() - a;
      if (ok) {
        okN++; sumUs += el; if (el < minUs) minUs = el; if (el > maxUs) maxUs = el;
        uint32_t tn = dxl.lastTurnaroundUs;
        sumTn += tn; if (tn < minTn) minTn = tn; if (tn > maxTn) maxTn = tn;
      }
    }
    uint32_t elapsed = micros() - tStart;
    uint32_t mean = okN ? sumUs / okN : 0, meanTn = okN ? sumTn / okN : 0;
    float achHz = elapsed ? (float)n * 1e6f / (float)elapsed : 0.0f;
    if (!okN) { minUs = 0; minTn = 0; }
    Serial.printf("# %-6s %6lu %5lu %5lu %5lu  %5lu/%5lu/%5lu  %7.0f  %4lu %3lu %4lu %3lu\n",
                  meth ? "0x8A" : "0x82",
                  (unsigned long)mean, (unsigned long)minUs, (unsigned long)maxUs,
                  (unsigned long)(maxUs - minUs), (unsigned long)meanTn,
                  (unsigned long)minTn, (unsigned long)maxTn, achHz,
                  (unsigned long)(dxl.txCount - tx0), (unsigned long)(dxl.rxTimeouts - to0),
                  (unsigned long)(dxl.crcErrors - cr0), (unsigned long)(dxl.errStatus - he0));
  }
  mc.nextTick = micros();   // resync the scheduler after the busy benchmark
}

// Dispatch one complete "M,..." line (the loop() reader hands it over whole,
// so payload bytes can never alias the single-letter menu commands).
void handleMotorLine(const char* line) {
  char sub = 0;
  float a = 0, b = 0;
  int n = sscanf(line, "M,%c,%f,%f", &sub, &a, &b);
  if (n < 1) return;
  // [v14] 'j' is TELEMETRY, not a command: the bridge streams calibrated joint
  // angles at 50 Hz whenever the wired encoders are alive, regardless of what
  // any UI is doing. Letting it pet the host-silence watchdog meant that
  // watchdog could never fire while the bridge process lived, so the firmware
  // had no independent protection against a UI that stopped issuing targets -
  // the 250 ms camera-freshness check in the bridge was the only layer left.
  // Commands pet the watchdog; data does not. In mode 4 the pet now comes from
  // the 10 Hz M,r target stream, which is exactly the liveness that matters.
  if (sub != 'j') mc.lastCmdMs = millis();
  switch (sub) {
    case 't': (a >= 0.5f) ? motorTake() : motorRelease(); break;
    case 'e': (a >= 0.5f) ? motorEnable() : motorTorqueOff(); break;
    // [MERGE] entering the blended law re-seeds the setpoint, so a mode change
    // can never hand the PD a target the horn has since moved away from.
    case 'm': if (a >= 0 && a <= 4) {
                uint8_t want = (uint8_t)a;
                if (want == 0) motorTorqueOff();
                else {
                  if ((want == 1 && mc.mode != 1) || want == 3) motorSeedSetpoints();
                  if (want == 3) {
                    mc.jogIndex = -1; // zero until a following M,p selects one
                    mc.jogBoostMa = 0.0f; mc.jogErrSign = 0;
                  }
                  if (want == 4) {
                    // Selecting SEA is harmless.  It stays at zero current until
                    // an explicit zero + direction identification + arm command.
                    mc.seaArmed = false;
                  }
                  mc.mode = want;
                }
              } break;
    case 'a': mc.aOverride = (a < 0) ? -1.0f : constrain(a, 0.0f, 1000.0f) * 0.001f; break;
    case 'c': { int i = motorIdIndex((int)a); if (i >= 0 && n >= 3) {
                  const float capMa = motorCapMa();
                  mc.iSet[i] = constrain(b, -capMa, capMa);
                } } break;
    // [v15] K,<mA>,<ms> - arm a bounded breakaway window. Both arguments are
    // clamped here, so a host asking for 500 mA for 10 s gets 95 mA for 250 ms.
    // Torque must already be on and the mode must be 2; anything else refuses,
    // which keeps this out of the blended and SEA laws entirely.
    case 'K': if (n >= 3 && mc.mode == 2 && mc.torque) {
                mc.kickMa = constrain(a, 0.0f, I_KICK_MAX_MA);
                mc.kickUntilMs = millis() + (uint32_t)constrain(b, 0.0f, (float)KICK_MAX_MS);
              } break;
    case 'p': { int i = motorIdIndex((int)a); if (i >= 0 && n >= 3) {
                  mc.qSet[i] = b * PI / 180.0f;
                  if (mc.mode == 3) {
                    if (mc.jogIndex != i) { mc.jogBoostMa = 0.0f; mc.jogErrSign = 0; }
                    mc.jogIndex = i;
                  }
                } } break;
    // Calibrated joint observations, MCP then PIP.  These are anatomical angles
    // from the bridge's existing ch8/ch9 calibration, never raw AS5600 degrees.
    // Store their derivative only when a fresh sample arrives; the 2 kHz motor
    // tick must not differentiate a repeated 50 Hz host sample.
    case 'j': if (n >= 3 && isfinite(a) && isfinite(b)) {
                uint32_t now = millis();
                float dt = mc.seaHaveJoint ? (now - mc.seaJointMs) * 0.001f : 0.0f;
                float v[2] = {a, b};
                for (uint8_t i = 0; i < N_MOTOR; i++) {
                  if (dt > 0.002f && dt < 0.250f)
                    mc.seaJointVel[i] = 0.75f * mc.seaJointVel[i] +
                                        0.25f * ((v[i] - mc.seaJointPrev[i]) / dt);
                  else mc.seaJointVel[i] = 0.0f;
                  mc.seaJointPrev[i] = mc.seaJoint[i] = v[i];
                }
                mc.seaJointMs = now; mc.seaHaveJoint = true;
              } break;
    // Capture neutral only with torque OFF.  This makes the physical reference
    // deliberate and prevents a re-zero from changing force while worn.
    case 'z': if (a >= 0.5f && !mc.torque && mc.seaHaveJoint &&
                  millis() - mc.seaJointMs <= 150) {
                for (uint8_t i = 0; i < N_MOTOR; i++) {
                  mc.seaJointZero[i] = mc.seaJoint[i]; mc.seaTarget[i] = 0.0f;
                  mc.seaJointVel[i] = 0.0f;
                }
                mc.seaZeroed = true;
              } break;
    // Directions are learned/confirmed per DOF during the low-current ID step.
    // A value other than exactly -1 or +1 makes an arm impossible.
    case 'd': if (!mc.torque && n >= 3 &&
                  (a == -1.0f || a == 1.0f) && (b == -1.0f || b == 1.0f)) {
                mc.seaDir[0] = (int8_t)a; mc.seaDir[1] = (int8_t)b;
              } break;
    // Relative MCP/PIP targets in degrees.  Values are bounded to the measured
    // mechanical ROM, and ignored until zero/reference exists.
    case 'r': if (n >= 3 && mc.seaZeroed) {
                mc.seaTarget[0] = constrain(a, -10.0f, 90.0f);
                mc.seaTarget[1] = constrain(b, -10.0f, 110.0f);
              } break;
    // Arm only in SEA mode, with a recent calibrated measurement and identified
    // sign for BOTH independent joints.  Otherwise write no current.
    case 'x': if (a < 0.5f) mc.seaArmed = false;
              else if (mc.mode == 4 && mc.seaZeroed && mc.seaHaveJoint &&
                       millis() - mc.seaJointMs <= 150 &&
                       mc.seaDir[0] && mc.seaDir[1]) mc.seaArmed = true;
              break;
    case 'k': if (n >= 3 && a >= 0 && b >= 0) { mc.kp = min(a, 2000.0f); mc.kd = min(b, 100.0f); } break;
    case 'f': if (n >= 3 && a >= 0 && b >= 0) { mc.frV = min(a, 50.0f); mc.frC = min(b, 60.0f); } break;
    case 's': motorStats(); break;
    case 'u': motorUpgrade(); break;
    case 'b': motorBench(n >= 2 ? (uint16_t)a : 2000); break;
  }
}

// Dispatch one complete "D,<screen>,<elapsedSec>,<mot>" line from the host.
void handleDeviceLine(const char* line) {
  int s = 0; long el = 0; int mot = 0;
  if (sscanf(line, "D,%d,%ld,%d", &s, &el, &mot) < 1) return;
  hostScreen = s; hostElapsed = el; hostMot = mot; hostRecvT = millis();
}

// Dispatch one complete "W,<face>,<colorway>" line from the host. An unknown id
// changes NOTHING and is acked with ok = 0, so the console never shows a
// selection the device did not actually take.
void handleWatchLine(const char* line) {
  int f = -1, cwi = -1;
  bool ok = (sscanf(line, "W,%d,%d", &f, &cwi) == 2) && watch::selectFace(f, cwi);
  // Do not invalidate the panel shadow until the new face has actually painted
  // the framebuffer. Otherwise uiR.task() could start shipping the OLD buffer
  // during the presentation cadence delay.
  if (ok) { watchSave(); scLastSig = 0xFFFFFFFF; screenForcePaint = true; }
  Serial.printf("E,watch,%d,%d,%d\n",
                watch::curFace, watch::curColorway[watch::curFace], ok ? 1 : 0);
}

void handleHostLine(char tag, const char* line) {
  if      (tag == 'M') handleMotorLine(line);
  else if (tag == 'D') handleDeviceLine(line);
  else if (tag == 'W') handleWatchLine(line);
}

// ---- scan / report ---------------------------------------------------------
// The production wearable uses a strapped 0x4B forearm board, while one bench
// prototype was recorded at 0x4A. Wire2 carries that sensor alone, so probing
// both legal BNO085 addresses is unambiguous and prevents a firmware build for
// one hardware revision from silently zeroing the other revision's pose.
bool resolveForearmAddress() {
  const uint8_t candidates[2] = { IMU_ADDR[1],
                                  (uint8_t)(IMU_ADDR[1] == 0x4A ? 0x4B : 0x4A) };
  for (uint8_t k = 0; k < 2; k++) {
    Wire2.beginTransmission(candidates[k]);
    if (Wire2.endTransmission() == 0) {
      IMU_ADDR[1] = candidates[k];
      bno[1].addr = candidates[k];
      return true;
    }
  }
  return false;
}

// detectAll(): quiet re-detection so sensors are HOT-PLUGGABLE (no reboot).
// - re-probes every mux channel -> chLive[]
// - re-inits any IMU that is not already live (a live IMU is left running so it
//   never loses its fusion lock). Called by the verbose scan ('s'), by the quiet
//   rescan ('R', which the host bridge sends on a sensor drop), and once at boot.
void detectAll() {
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
    uint8_t m, c; chToMux(ch, m, c);
    muxSelect(m, c);
    chLive[ch] = encoderPresent();
    muxDisable(m);
    motorService();
  }
  for (uint8_t i = 0; i < N_IMU; i++) {   // hot-plug: (re)start an IMU that appeared
    if (i == 1) resolveForearmAddress();
    if (imuLive[i] && bno[i].present()) continue;
    // [BENCH 2026-08-06] A BNO085 that latches SDA low cannot be probed away:
    // present() just fails forever and the 'R' rescan never recovers it, so the
    // bus stayed dead until a power cycle. Free it here, before deciding the
    // sensor is absent. Observed on the bench: the hand's bus hung and only a
    // board reset brought it back.
    if (!bno[i].present()) {
      imuBusRecoverRuntime();
      if (i == 1) resolveForearmAddress();
    }
    imuLive[i] = bno[i].present() ? bno[i].begin() : false;
    if (imuLive[i]) imuFreshMs[i] = millis();   // grace: first report may take a moment
    motorService();
  }
}

void scanAll() {
  detectAll();
  Serial.println(F("\n--- WIRING SCAN ---------------------------------------"));
  for (uint8_t i = 0; i < 2; i++) {
    MUX_BUS.beginTransmission(MUX_ADDR[i]);
    bool ok = (MUX_BUS.endTransmission() == 0);
    Serial.printf("  MUX %c @ 0x%02X : %s\n", 'A' + i, MUX_ADDR[i], ok ? "OK" : "MISSING");
  }
  uint8_t nLive = 0, nUsable = 0;
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
    uint8_t m, c; chToMux(ch, m, c);
    if (!chLive[ch]) {
      Serial.printf("  ENC ch%02u (mux 0x%02X:%u) : -- none\n", ch, m, c);
      continue;
    }
    nLive++;
    // [BENCH 2026-08-06] a channel that ACKs is not yet a channel that measures.
    muxDisable(MUX_ADDR[1 - m]);
    muxSelect(m, c);
    MagStat s = readMagnetStatus();
    muxDisable(m);
    motorService();
    if (s.ok && (s.status & AS_MD) && !(s.status & (AS_ML | AS_MH))) nUsable++;
    Serial.printf("  ENC ch%02u (mux 0x%02X:%u) : OK 0x36  %s (agc %u, mag %u)\n",
                  ch, m, c, magnetVerdict(s), s.agc, s.mag);
  }
  for (uint8_t i = 0; i < N_IMU; i++) {
    Serial.printf("  IMU %u (%s) @ 0x%02X on Wire%c : %s", i + 1, IMU_NAME[i],
                  IMU_ADDR[i], IMU_WIRE[i] == &Wire1 ? '1' : '2',
                  imuLive[i] ? "OK" : "MISSING");
    // A sensor that came up with only some of its reports is DEGRADED, not
    // healthy: say so here, or a silent channel gets blamed on the host parser.
    if (imuLive[i] && bno[i].featuresAsked) {
      Serial.printf("  (%u/%u reports", bno[i].featuresOk, bno[i].featuresAsked);
      if (bno[i].lastFeatureFail)
        Serial.printf(", report 0x%02X REFUSED", bno[i].lastFeatureFail);
      Serial.print(')');
    }
    Serial.println();
  }
  Serial.printf("  SD card : %s\n", sdOK ? "OK" : "MISSING");
  Serial.printf("  CROWN   : %s (raw %d, active band %d..%d)\n",
                crownPresent ? "present" : "ABSENT - blend forced to 0",
                analogRead(POT_PIN), POT_ACTIVE_LOW, POT_ACTIVE_HIGH);
  Serial.printf("  DISPLAY : face %s / %s\n", watch::active()->id(),
                watch::active()->colorway(watch::curColorway[watch::curFace]).id);
  Serial.printf("  MOTORS  : %s\n", mc.taken
                ? (mc.torque ? "bus taken, torque ON" : "bus taken, torque off (compliant)")
                : "bus not taken (M,t,1 to connect)");
  // [BENCH 2026-08-06] two encoder numbers, never one. "wired" is how many chips
  // answer; "measuring" is how many have a usable magnet. Only the second one can
  // produce an angle, and conflating them is how a bench reads healthier than it is.
  Serial.printf("  SUMMARY : %u/%u encoders wired, %u measuring, %u/%u IMUs live\n",
                nLive, N_CHANNELS, nUsable,
                (imuLive[0] + imuLive[1] + imuLive[2]), N_IMU);
  Serial.println(F("-------------------------------------------------------"));
}

// ---- imu -------------------------------------------------------------------
// A misbehaving IMU can hold the bus low and make begin() block forever,
// freezing the whole sketch at boot. Guard every IMU init: release a stuck bus,
// and only call the blocking begin after the address cleanly ACKs a bounded
// probe. A bad/absent IMU then just reads "missing" instead of killing the board.
bool i2cPresent(TwoWire &bus, uint8_t addr) {
  bus.beginTransmission(addr);
  return bus.endTransmission() == 0;   // Teensy Wire has an internal timeout
}
void busRecover(uint8_t sclPin, uint8_t sdaPin) {  // free an I2C bus if a slave holds SDA low
  pinMode(sclPin, OUTPUT);
  pinMode(sdaPin, INPUT_PULLUP);
  for (uint8_t k = 0; k < 9 && digitalRead(sdaPin) == LOW; k++) {
    digitalWrite(sclPin, LOW);  delayMicroseconds(5);
    digitalWrite(sclPin, HIGH); delayMicroseconds(5);
  }
}
void imuBusRecover() { busRecover(16, 17); busRecover(24, 25); }  // Wire1 (17/16) + Wire2 (25/24)
// [BENCH 2026-08-06] Runtime version. busRecover() takes the pins back as raw
// GPIO to bit-bang SCL, which DETACHES them from the Wire peripheral - fine in
// setup(), where Wire1/Wire2.begin() run afterwards, but fatal if called mid-run
// without re-attaching: both IMU buses would go dead permanently. Re-begin them.
// Bit-banging only happens while SDA is actually held low, so this is a no-op on
// a healthy bus and safe to call whenever a sensor is missing.
void imuBusRecoverRuntime() {
  imuBusRecover();
  Wire1.begin();  Wire1.setClock(400000);
  Wire2.begin();  Wire2.setClock(400000);
}
// All three BNO085s run SIMULTANEOUSLY at full rate: TinyBNO085 keeps all
// protocol state per object (no globals), and poll() is bounded and
// non-blocking. No round-robin, no shared-context hang.
void imuBegin() {
  for (uint8_t i = 0; i < N_IMU; i++) {
    if (i == 1) resolveForearmAddress();
    imuLive[i] = bno[i].begin();
    if (imuLive[i]) imuFreshMs[i] = millis();
  }
}
void imuService() {
  uint32_t now = millis();
  // Self-stall forgiveness: if WE did not run for a while (calibrate/fullScan
  // block deliberately), the silence is ours, not the sensors'. Reset their
  // freshness clocks instead of condemning healthy IMUs.
  if (now - imuSvcMs > IMU_STALE_MS / 2) {
    for (uint8_t i = 0; i < N_IMU; i++) imuFreshMs[i] = now;
  }
  imuSvcMs = now;
  for (uint8_t i = 0; i < N_IMU; i++) {
    if (!imuLive[i]) continue;
    for (uint8_t k = 0; k < 4 && bno[i].poll(); k++) {}  // drain up to 4 packets
    if (bno[i].fresh) {
      bno[i].fresh = false;          // read-and-clear: "new since last service"
      imuQ[i][0] = bno[i].qw; imuQ[i][1] = bno[i].qx;
      imuQ[i][2] = bno[i].qy; imuQ[i][3] = bno[i].qz;
      imuFreshMs[i] = now;
    }
    // The vectors have their OWN freshness flag: they arrive in the same batch
    // but are separate reports, so a quaternion-only batch must not stamp them
    // as new, and a vector-only batch must not count as orientation liveness
    // (the staleness watchdog below deliberately still watches the quaternion).
    if (bno[i].freshVec) {
      bno[i].freshVec = false;
      imuLin[i][0] = bno[i].lx;    imuLin[i][1] = bno[i].ly;    imuLin[i][2] = bno[i].lz;
      imuAcc[i][0] = bno[i].ax;    imuAcc[i][1] = bno[i].ay;    imuAcc[i][2] = bno[i].az;
      imuGyr[i][0] = bno[i].gyroX; imuGyr[i][1] = bno[i].gyroY; imuGyr[i][2] = bno[i].gyroZ;
      imuMag[i][0] = bno[i].mx;    imuMag[i][1] = bno[i].my;    imuMag[i][2] = bno[i].mz;
      imuGrv[i][0] = bno[i].grx;   imuGrv[i][1] = bno[i].gry;   imuGrv[i][2] = bno[i].grz;
      imuAccu[i][0] = bno[i].accAccuracy;
      imuAccu[i][1] = bno[i].gyroAccuracy;
      imuAccu[i][2] = bno[i].magAccuracy;
    }
    if (bno[i].haveGame) {
      imuGame[i][0] = bno[i].gw; imuGame[i][1] = bno[i].gx;
      imuGame[i][2] = bno[i].gy; imuGame[i][3] = bno[i].gz;
    }
    imuRotAcc[i] = bno[i].rotAccuracyRad;
    // Staleness is judged on the ORIENTATION clock only (imuFreshMs), exactly as
    // before the full set was added: a sensor still sending accelerometer rows
    // but no quaternion is a broken sensor, not a live one.
    if (now - imuFreshMs[i] > IMU_STALE_MS) {
      // Silent freeze: the chip still ACKs address probes but stopped
      // reporting (brownout / internal reset). Report it honestly - the
      // stream's live flag drops, the host bridge notices the drop and sends
      // 'R', and detectAll() re-begins the sensor. Closes the loop where a
      // frozen IMU streamed its last quaternion forever as "live".
      imuLive[i] = false;
    }
  }
}

// ---- calibration -----------------------------------------------------------
// [MERGE] the 12 s sweep now drives the CALIB face's progress ring and keeps
// both the servo tick and the panel alive; it used to be a blind blocking wait.
void calibrate() {
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) { chMin[ch] = 9999; chMax[ch] = -9999; }
  Serial.println(F("\n>>> CALIBRATION: slowly flex EVERY finger through its full"));
  Serial.println(F(">>> range (open <-> closed) for 12 seconds..."));
  calibRunning = true; calibProg = 0.0f;
  uint32_t t0 = millis();
  while (millis() - t0 < 12000) {
    float d[N_CHANNELS];
    readAllChannels(d);
    for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
      if (!chLive[ch] || d[ch] < 0) continue;
      if (d[ch] < chMin[ch]) chMin[ch] = d[ch];
      if (d[ch] > chMax[ch]) chMax[ch] = d[ch];
    }
    calibProg = (millis() - t0) / 12000.0f;
    imuService();
    motorService();   // keep the motor fail-safe live during this 12 s capture
    screenService();  // and keep the panel showing real progress
    uiR.task();
    motorService();
    delay(2);
  }
  calibRunning = false; calibProg = 0.0f;
  Serial.println(F("\n--- RANGE OF MOTION (per channel) ---------------------"));
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
    if (!chLive[ch]) continue;
    Serial.printf("  ch%02u : min %6.1f  max %6.1f  ROM %6.1f deg\n",
                  ch, chMin[ch], chMax[ch], chMax[ch] - chMin[ch]);
  }
  Serial.println(F("(Flex one finger at a time and watch which channel moves to"));
  Serial.println(F(" learn the channel->finger/joint map; note it down.)"));
  Serial.println(F("-------------------------------------------------------"));
}

// ---- SD recording ----------------------------------------------------------
// [MERGE] the old recWrite() made eight unchecked writes, counted rows
// unconditionally and never flushed, so a full card or a brownout three minutes
// into a capture produced a truncated file AND a "saved to SD" banner. Every row
// is now checked, and the file is flushed every REC_FLUSH_ROWS so at most ~1.3 s
// of data can be lost if the card is pulled.
const uint16_t REC_FLUSH_ROWS = 64;

void recToggle() {
  if (!recording) {
    if (!sdOK) { Serial.println(F("No SD card - cannot record.")); return; }
    // collision-free name: FILE_WRITE appends, so a reused name would bury a
    // second header mid-file. Scan past anything already on the card, and
    // distinguish exhaustion from success rather than falling through into
    // whatever name the loop stopped on.
    char name[24];
    bool free_name = false;
    while (recSeq < 60000) {
      snprintf(name, sizeof(name), "REC%05u.CSV", recSeq++);
      if (!SD.exists(name)) { free_name = true; break; }
    }
    if (!free_name) { Serial.println(F("# no free REC name - clear old REC*.CSV off the card")); return; }
    recFile = SD.open(name, FILE_WRITE);
    if (!recFile) { Serial.println(F("Could not open file.")); return; }
    // header: time + 14 encoder angles + 3 quaternions + emg + crown + motors
    //         + (v7) the full BNO085 report set per IMU
    recFile.print("t_ms");
    for (uint8_t ch = 0; ch < N_CHANNELS; ch++) recFile.printf(",enc%02u", ch);
    recFile.print(",h_qw,h_qx,h_qy,h_qz,f_qw,f_qx,f_qy,f_qz,emg_env,emg_rms,crown"
                  ",t_qw,t_qx,t_qy,t_qz,thumb_live"
                  ",mflags,m0_pos,m0_vel,m0_ma,m1_pos,m1_vel,m1_ma,crown_live");
    // generated rather than spelled out: a hand-written 69-column header is a
    // guaranteed future mismatch with the row writer below
    for (uint8_t i = 0; i < N_IMU; i++) {
      const char *n = IMU_NAME[i];
      recFile.printf(",%s_lax,%s_lay,%s_laz", n, n, n);
      recFile.printf(",%s_ax,%s_ay,%s_az", n, n, n);
      recFile.printf(",%s_gx,%s_gy,%s_gz", n, n, n);
      recFile.printf(",%s_mx,%s_my,%s_mz", n, n, n);
      recFile.printf(",%s_grx,%s_gry,%s_grz", n, n, n);
      recFile.printf(",%s_gqw,%s_gqx,%s_gqy,%s_gqz", n, n, n, n);
      recFile.printf(",%s_cal_a,%s_cal_g,%s_cal_m,%s_rotacc", n, n, n, n);
    }
    recFile.print('\n');
    recording = true; recStart = millis(); recRows = 0;
    Serial.printf(">>> RECORDING to %s (press 'r' again to stop)\n", name);
  } else {
    recFile.flush();
    recFile.close(); recording = false;
    Serial.printf(">>> STOPPED. %lu rows over %.1f s saved to SD.\n",
                  (unsigned long)recRows, (millis() - recStart) / 1000.0f);
  }
}
void recWrite(uint32_t t) {
  recFile.printf("%lu", (unsigned long)t);
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
    recFile.printf(",%.2f", frameDeg[ch]);   // the frame's ONE acquisition
  }
  for (uint8_t i = 0; i < 2; i++)
    recFile.printf(",%.4f,%.4f,%.4f,%.4f", imuQ[i][0], imuQ[i][1], imuQ[i][2], imuQ[i][3]);
  recFile.printf(",%.1f,%.1f", emgEnv, emgRms);
  recFile.printf(",%d", (int)(crownFilt < 0.0f ? 0 : crownFilt));
  recFile.printf(",%.4f,%.4f,%.4f,%.4f,%d",
                 imuQ[2][0], imuQ[2][1], imuQ[2][2], imuQ[2][3], imuLive[2] ? 1 : 0);
  recFile.printf(",%u,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%d",
                 motorFlags(), mc.posDeg[0], mc.velDps[0], mc.iMeas[0],
                 mc.posDeg[1], mc.velDps[1], mc.iMeas[1], crownPresent ? 1 : -1);
  // v7: the full IMU set, same 23-field-per-sensor layout and order as the
  // S-line. The card is the archival copy of a take - if the live stream carries
  // acceleration and the SD row does not, an offline re-analysis can never
  // recover the translation, which is the whole reason these reports exist.
  for (uint8_t i = 0; i < N_IMU; i++) {
    recFile.printf(",%.3f,%.3f,%.3f", imuLin[i][0], imuLin[i][1], imuLin[i][2]);
    recFile.printf(",%.3f,%.3f,%.3f", imuAcc[i][0], imuAcc[i][1], imuAcc[i][2]);
    recFile.printf(",%.4f,%.4f,%.4f", imuGyr[i][0], imuGyr[i][1], imuGyr[i][2]);
    recFile.printf(",%.2f,%.2f,%.2f", imuMag[i][0], imuMag[i][1], imuMag[i][2]);
    recFile.printf(",%.3f,%.3f,%.3f", imuGrv[i][0], imuGrv[i][1], imuGrv[i][2]);
    recFile.printf(",%.4f,%.4f,%.4f,%.4f",
                   imuGame[i][0], imuGame[i][1], imuGame[i][2], imuGame[i][3]);
    recFile.printf(",%u,%u,%u,%.4f",
                   imuAccu[i][0], imuAccu[i][1], imuAccu[i][2], imuRotAcc[i]);
  }
  recFile.print('\n');
  // One check per row covers all of them: getWriteError latches. A card that
  // stopped accepting data must stop the take loudly, not keep counting rows.
  if (recFile.getWriteError()) {
    recFile.clearWriteError();
    recFile.close();
    recording = false;
    Serial.printf("# SD WRITE FAILED after %lu rows - recording stopped\n", (unsigned long)recRows);
    return;
  }
  recRows++;
  if (recRows % REC_FLUSH_ROWS == 0) {
    recFile.flush();     // ~1.3 s of exposure at 50 Hz; a pulled card loses only that
    motorService();      // flush() can stall for milliseconds: tick right after it
  }
}

// ---- live stream (for the web-console bridge) ------------------------------
// One compact CSV line per sample. Prefix 'S,' so the bridge can pick these out
// from human-readable menu output. Uses the last scan's chLive[] gating.
void emitStream(uint32_t t) {
  Serial.print("S,");
  Serial.print(t);
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
    Serial.print(',');
    Serial.print(frameDeg[ch], 2);           // identical values to the SD row
  }
  for (uint8_t i = 0; i < 2; i++)
    for (uint8_t k = 0; k < 4; k++) { Serial.print(','); Serial.print(imuQ[i][k], 4); }
  Serial.print(','); Serial.print(imuLive[0] ? 1 : 0);
  Serial.print(','); Serial.print(imuLive[1] ? 1 : 0);
  Serial.print(','); Serial.print(emgEnv, 1);   // MyoWare envelope, mean ADC (0..1023)
  Serial.print(','); Serial.print(emgRms, 1);   // envelope RMS over the frame
  Serial.print(','); Serial.print(emgHave ? 1 : 0);
  // crown 0..1000 (v3). An absent crown still streams 0 here, which every old
  // host reads as "fully transparent" - the safe reading - and the crown_live
  // flag below tells a v6-aware host that there is no crown at all.
  Serial.print(','); Serial.print((int)(crownFilt < 0.0f ? 0 : crownFilt));
  for (uint8_t k = 0; k < 4; k++) { Serial.print(','); Serial.print(imuQ[2][k], 4); }  // thumb (v4)
  Serial.print(','); Serial.print(imuLive[2] ? 1 : 0);
  // v6: the servo telemetry v5 documented but never sent, then crown presence
  Serial.print(','); Serial.print(motorFlags());
  for (uint8_t i = 0; i < N_MOTOR; i++) {
    Serial.print(','); Serial.print(mc.posDeg[i], 1);
    Serial.print(','); Serial.print(mc.velDps[i], 1);
    Serial.print(','); Serial.print(mc.iMeas[i], 1);
  }
  Serial.print(','); Serial.print(crownPresent ? 1 : -1);
  // ---- v7 (2026-08-06): the FULL IMU set, appended -------------------------
  // Appended at the END on purpose: the S-line has always been extended this
  // way, and every existing host slices by leading index, so a v6 bridge reads
  // a v7 line unchanged and simply never looks past the crown flag.
  // Per IMU, in order hand, forearm, thumb - 23 fields each, 69 total:
  //   lin x,y,z      linear acceleration, m/s^2, GRAVITY REMOVED  <- integrable
  //   acc x,y,z      accelerometer, m/s^2, gravity included
  //   gyr x,y,z      rad/s
  //   mag x,y,z      uT
  //   grv x,y,z      gravity vector, m/s^2
  //   game w,x,y,z   game rotation vector (magnetometer-immune)
  //   ca,cg,cm       calibration accuracy 0..3 for accel, gyro, mag
  //   rotacc         rotation-vector heading accuracy, rad
  // 3 decimals on the vectors: the BNO085's own Q8 accelerometer resolution is
  // 1/256 = 0.0039 m/s^2, so more digits would be inventing precision.
  for (uint8_t i = 0; i < N_IMU; i++) {
    for (uint8_t k = 0; k < 3; k++) { Serial.print(','); Serial.print(imuLin[i][k], 3); }
    for (uint8_t k = 0; k < 3; k++) { Serial.print(','); Serial.print(imuAcc[i][k], 3); }
    for (uint8_t k = 0; k < 3; k++) { Serial.print(','); Serial.print(imuGyr[i][k], 4); }
    for (uint8_t k = 0; k < 3; k++) { Serial.print(','); Serial.print(imuMag[i][k], 2); }
    for (uint8_t k = 0; k < 3; k++) { Serial.print(','); Serial.print(imuGrv[i][k], 3); }
    for (uint8_t k = 0; k < 4; k++) { Serial.print(','); Serial.print(imuGame[i][k], 4); }
    Serial.print(','); Serial.print(imuAccu[i][0]);
    Serial.print(','); Serial.print(imuAccu[i][1]);
    Serial.print(','); Serial.print(imuAccu[i][2]);
    Serial.print(','); Serial.print(imuRotAcc[i], 4);
  }
  // v9: append-only motor fault diagnostics.  Existing bridges ignore this
  // tail; new ones can tell a bus miss from a real servo hardware alarm and
  // report which conservative read fallback was selected.
  Serial.print(','); Serial.print(mc.faultCause);
  Serial.print(','); Serial.print(mc.errRun);
  Serial.print(','); Serial.print(mc.hwErr[0]);
  Serial.print(','); Serial.print(mc.hwErr[1]);
  Serial.print(','); Serial.print(mc.nMiss);
  Serial.print(','); Serial.print(mc.recoverFast);
  Serial.print(','); Serial.print(mc.recoverDirect);
  Serial.print(','); Serial.print((mc.useFast ? 1 : 0) | (mc.useIndirect ? 2 : 0));
  // v14: SEA / camera-follow readiness as the DEVICE sees it, appended.
  //   bit0 neutral captured, bit1 ARMED, bit2 both directions identified,
  //   bit3 the host joint stream is fresh (<=150 ms).
  // The host previously had to assume its arm sequence succeeded; a refused arm
  // was indistinguishable from an accepted one. A v13 bridge ignores this tail.
  Serial.print(','); Serial.print(seaStateBits());
  Serial.print('\n');
}

// ---- full I2C scanner (diagnostic: what actually ACKs, and where) ----------
void scanChannelAddrs(bool skipMux) {
  uint8_t n = 0;
  for (uint8_t a = 0x08; a <= 0x77; a++) {
    if (skipMux && (a == 0x70 || a == 0x71)) continue;
    MUX_BUS.beginTransmission(a);
    if (MUX_BUS.endTransmission() == 0) { Serial.printf(" 0x%02X", a); n++; }
    motorService();
  }
  if (n == 0) Serial.print(F(" (nothing)"));
  Serial.println();
}
void fullScan() {
  Serial.println(F("\n--- FULL I2C SCAN -------------------------------------"));
  for (uint8_t i = 0; i < 2; i++) muxDisable(MUX_ADDR[i]);
  Serial.print(F("  MAIN bus (Wire 18/19)   :"));
  scanChannelAddrs(false);                       // expect 0x70 0x71
  Serial.print(F("  Wire1 IMU bus (17/16)   :"));
  { uint8_t n = 0;
    for (uint8_t a = 0x08; a <= 0x77; a++) {
      Wire1.beginTransmission(a);
      if (Wire1.endTransmission() == 0) { Serial.printf(" 0x%02X", a); n++; }
      motorService();
    }
    if (n == 0) Serial.print(F(" (nothing)")); Serial.println(); }
  Serial.print(F("  Wire2 IMU bus (25/24)   :"));
  { uint8_t n = 0;
    for (uint8_t a = 0x08; a <= 0x77; a++) {
      Wire2.beginTransmission(a);
      if (Wire2.endTransmission() == 0) { Serial.printf(" 0x%02X", a); n++; }
      motorService();
    }
    if (n == 0) Serial.print(F(" (nothing)")); Serial.println(); }
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {  // each mux channel: expect 0x36
    uint8_t m, c; chToMux(ch, m, c);
    muxSelect(m, c);
    Serial.printf("  ch%02u (mux 0x%02X:%u)       :", ch, m, c);
    scanChannelAddrs(true);
    muxDisable(m);
  }
  Serial.println(F("-------------------------------------------------------"));
}

// ---- the screen service -----------------------------------------------------
// Builds a DeviceState from the signals this sketch already has, hands it to
// the face engine, and repaints ONLY when the engine's value-dirty signature
// changes. A static face still costs zero paint, zero tile scan, zero SPI.
void screenService() {
  uint32_t now = millis();
  // State/safety is inspected at 50 Hz, but ordinary visible frames are built
  // at 7.7 Hz (9.6 Hz for the crown). Sensor sampling and motor service do not
  // pass through this gate.
  if ((uint32_t)(now - scLastService) < WATCH_PRESENT_SERVICE_MS) return;
  scLastService = now;

  int nimu = 0;
  for (uint8_t i = 0; i < N_IMU; i++) if (imuLive[i]) nimu++;
  int nenc = 0;
  for (int i = 0; i < N_CHANNELS; i++) if (chLive[i]) nenc++;
  bool sensorsOk = (nimu > 0 || nenc > 0);
  bool hostFresh = (hostScreen >= 0) && (now - hostRecvT < 1500);
  bool carouselOn = now < carouselUntil;
  bool localFresh = (localScreen >= 0) && (now < localUntil);
  if (streaming) everLinked = true;

  int screen;
  if (!sensorsOk)       screen = UI_SAFE;          // total sensor loss
  else if (calibRunning) screen = UI_CALIB;        // the 12 s sweep owns the screen
  else if (carouselOn)  screen = UI_READY;         // carousel paints over home
  else if (localFresh)  screen = localScreen;      // crown-selected, until host agrees
  else if (hostFresh)   screen = hostScreen;       // website/AR-driven mode
  else if (!streaming)  screen = everLinked ? -2 : UI_CONNECTING;
  else                  screen = UI_READY;         // connected + idle

  FaceState st = mapScreen(screen);
  // a dead subsystem while otherwise idle is a FAULT, not merely a dim lamp.
  uint8_t sev = 0;
  if (st == FS_IDLE && (nimu == 0 || nenc == 0)) { st = FS_FAULT; sev = (nenc == 0) ? 1 : 0; }
  const bool stateChanged = st != curState;
  if (stateChanged) { curState = st; stateEnterMs = now; }

  const float forearmRoll = imuLive[UI_ORIENTATION_IMU]
      ? atan2f(2.0f*(imuQ[UI_ORIENTATION_IMU][0]*imuQ[UI_ORIENTATION_IMU][1]
                    + imuQ[UI_ORIENTATION_IMU][2]*imuQ[UI_ORIENTATION_IMU][3]),
               1.0f - 2.0f*(imuQ[UI_ORIENTATION_IMU][1]*imuQ[UI_ORIENTATION_IMU][1]
                            + imuQ[UI_ORIENTATION_IMU][2]*imuQ[UI_ORIENTATION_IMU][2]))
      : 0.0f;
  screenOrientation.update(forearmRoll, imuLive[UI_ORIENTATION_IMU]);
  // Never rotate while a dirty tile frame is shipping. The subsequent forced
  // full repaint makes the new GC9A01 address orientation coherent in one pass.
  if (screenOrientationApplied != screenOrientation.turn && uiR.idle()) {
    screenOrientationApplied = screenOrientation.turn;
    tft.setRotation((TFT_ROTATION + UI_DEFAULT_TURNS + screenOrientationApplied) & 3);
    scLastSig = 0xFFFFFFFF;
    screenForcePaint = true;
  }

  // A framebuffer is immutable while its dirty tiles are being shipped. This
  // is the coherence rule that removes mixed-frame flicker: an animation may
  // skip a visual sample, but it may never rewrite a half-delivered frame.
  const bool forcePaint = screenForcePaint || stateChanged;
  // The small BOOT arc is cheap enough to move in 1-degree increments. Every
  // other screen keeps the calmer normal/carousel cadence.
  const uint32_t presentationPeriod = (st == FS_BOOT) ? WATCH_PRESENT_CONNECT_MS
      : (carouselOn ? WATCH_PRESENT_INTERACT_MS : WATCH_PRESENT_FRAME_MS);
  WatchPresentationCadence::Decision decision =
      screenCadence.decidePeriod(now, presentationPeriod, forcePaint, uiR.idle());
  if (decision == WatchPresentationCadence::WAIT_TIME) return;
  if (decision == WatchPresentationCadence::WAIT_PANEL) {
    screenDeferredBusy++;
    return;
  }
  const float dt = scLastPush ? (now - scLastPush) * 0.001f
                              : WATCH_PRESENT_FRAME_MS * 0.001f;
  scLastPush = now;
  screenCadence.committed(now);
  screenSamples++;

  // on-device effort: the real envelope, self-normalized (honest running range)
  float eff = 0.0f;
  if (emgHave) {
    if (emgEnv < effLo) effLo = emgEnv;
    if (emgEnv > effHi) effHi = emgEnv;
    effHi -= (effHi - effLo) * 0.0004f;            // slow re-adapt
    if (effHi - effLo > 8.0f) eff = (emgEnv - effLo) / (effHi - effLo);
    if (eff < 0) eff = 0; if (eff > 1) eff = 1;
  }

  dstate.t       = now * 0.001f;
  dstate.stateT  = (now - stateEnterMs) * 0.001f;
  dstate.state   = curState;
  dstate.emg     = eff;
  // [MERGE] torque is REAL now. The Teensy owns the motor bus, so the faces show
  // the measured current normalized against the same software cap the control
  // law clamps to - not a host-fed placeholder, and 0 whenever nothing is driven.
  {
    float tq = 0.0f;
    if (mc.taken && mc.torque) {
      for (uint8_t i = 0; i < N_MOTOR; i++) {
        float m = fabsf(mc.iMeas[i]) / I_CAP_MA;
        if (m > tq) tq = m;
      }
      if (tq > 1.0f) tq = 1.0f;
    }
    dstate.torque = tq;
  }
  dstate.roll    = forearmRoll;
  // joints 0..11 = the first twelve encoder channels, normalized by the range
  // seen so far. A channel that has not been read this session, or has not yet
  // shown a usable range, reports -1 and the faces draw it as absent instead of
  // inventing a value.
  for (int i = 0; i < 12; i++) {
    float d = chSampled ? frameDeg[i] : -1.0f;
    float span = romHi[i] - romLo[i];
    if (d < 0 || span < 5.0f) { dstate.joints[i] = -1.0f; continue; }
    float v = (d - romLo[i]) / span;
    dstate.joints[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  dstate.imuOk   = nimu > 0;
  dstate.encOk   = nenc > 0;
  dstate.emgOk   = emgHave;
  // the device knows its own motor state now; hostMot stays parsed for protocol
  // compatibility but is no longer what the lamp reports.
  dstate.motOk   = mc.taken && mc.torque && !mc.fault;
  dstate.link    = streaming;
  dstate.capSec  = recording ? (long)((now - recStart) / 1000)
                             : (hostFresh ? hostElapsed : 0);
  dstate.calibProgress = calibRunning ? calibProg : 0.0f;
  dstate.battery = -1.0f;                          // no fuel gauge on this board
  dstate.charging = false;
  dstate.faultSev = sev;

  carousel.active = carouselOn;
  carousel.f      = uiIn.f;
  carousel.focus  = uiIn.focus();

  // Presentation-only conditioning: the control/telemetry values above remain
  // untouched elsewhere. The face receives calm 2%/2-degree display steps.
  screenFilter.apply(dstate, dt);
  watch::engineUpdate(dstate, dt);                 // the shared finger-amplitude law

  uint32_t sig = watch::signature(dstate, carousel);
  if (!forcePaint && sig == scLastSig) return;     // nothing visible changed
  scLastSig = sig;

  FB = cv.getBuffer();
  const uint32_t p0 = micros();
  watch::engineRender(FB, dstate, carousel);
  paintLastUs = micros() - p0;
  if (paintLastUs > paintMaxUs) paintMaxUs = paintLastUs;
  paintSumUs += paintLastUs;
  paintCount++;
  if (forcePaint) {
    uiR.forceFullRepaint();                        // discontinuity: rebuild every panel tile
    screenForcePaint = false;
  } else {
    uiR.notifyPainted();                           // arm the dirty-run scan
  }
  motorService();                                  // the paint is the longest CPU
                                                   // block in the loop: tick after it
}

// crown/button events -> local nav + host mirror ("E," lines -> device_command)
void uiHandleEvent(Ev ev) {
  uint32_t now = millis();
  switch (ev) {
    case Ev::CW:
    case Ev::CCW:
      if (curState == FS_IDLE || now < carouselUntil) {
        carouselUntil = now + 6000;                // open / keep the carousel
        Serial.println(ev == Ev::CW ? "E,nav,cw" : "E,nav,ccw");
      }
      break;
    case Ev::PRESS:
      if (now < carouselUntil) {                   // select the focused mode
        carouselUntil = 0;
        int sel = uiIn.focus();
        localScreen = (sel == 0) ? UI_TRANSPARENT : (sel == 1) ? UI_CAPTURE
                    : (sel == 2) ? UI_OPERATOR    : UI_CALIB;
        localUntil = now + 4000;                   // host D takes over after echo
        Serial.print("E,screen,"); Serial.println(MODE_IDS[sel]);
        uiIn.tick(4200, 20);                       // the confirm chirp
      } else if (curState == FS_IDLE) {
        carouselUntil = now + 6000;                // press on home opens the picker
      } else {
        Serial.println("E,press");
      }
      break;
    case Ev::LONG:                                 // back home from anywhere
      carouselUntil = 0; localScreen = -1;
      Serial.println("E,home");
      break;
    default: break;
  }
}

// ---- crown arbitration ------------------------------------------------------
// ONE pot, TWO consumers, and they must never both be live:
//   * UiInput.poll() reads it every loop pass as the carousel's rotary nav;
//   * this reads it at 50 Hz as the transparency crown, which multiplies
//     straight into commanded motor current.
// Turning the crown to pick a menu item would otherwise slew the assist blend
// from transparent to full assist while the wearer is only navigating. Rule:
// while the carousel is OPEN the blend is HELD at its last value; when the
// carousel closes, the pot re-acquires the blend through the EMA, and the
// slew limiter in motorTick() bounds how fast that can move the actual current.
void crownSample() {
  const int raw = analogRead(POT_PIN);
  if (raw >= POT_PRESENT_LO && raw <= POT_PRESENT_HI) {
    if (crownInBand < CROWN_PRESENT_FRAMES) crownInBand++;
  } else {
    crownInBand = 0;
  }
  crownPresent = (crownInBand >= CROWN_PRESENT_FRAMES);
  if (!crownPresent) { crownFilt = -1.0f; return; }   // absent -> blend 0, never noise
  if (millis() < carouselUntil) return;               // navigating: hold the blend
  float t01 = (float)(raw - POT_ACTIVE_LOW) / (float)(POT_ACTIVE_HIGH - POT_ACTIVE_LOW);
  if (t01 < 0.0f) t01 = 0.0f;
  if (t01 > 1.0f) t01 = 1.0f;
  const float v = t01 * 1000.0f;
  crownFilt = (crownFilt < 0.0f) ? v : crownFilt + 0.25f * (v - crownFilt);
}

// ---- main ------------------------------------------------------------------
void printHelp() {
  Serial.println(F("\nCommands: s=scan  A=full I2C scan  c=calibrate  r=record  b/e=rec start/stop"));
  Serial.println(F("          j=stream  k=stop  v=version  R=rescan  T=paint cost  ?=help"));
  Serial.println(F("          D,<screen>,<sec>,<mot>  W,<face>,<colorway>  M,<sub>,...  (whole lines)"));
}

void setup() {
  Serial.begin(115200);
  // The 74HC241 is parked in RECEIVE before anything else: a floating direction
  // pin could enable the Teensy's transmit buffer onto the shared Dynamixel data
  // line while the U2D2 is master, which is a bus collision.
  dxlParkReceive();
  while (!Serial && millis() < 3000) delay(10);
  analogReadResolution(10);            // the crown band + EMG scaling assume 10-bit
  MUX_BUS.begin();  MUX_BUS.setClock(400000);
  imuBusRecover();                     // release both IMU buses if a slave holds SDA low
  Wire1.begin();  Wire1.setClock(400000);   // hand 0x4A + thumb tip 0x4B (pins 17/16)
  Wire2.begin();  Wire2.setClock(400000);   // forearm 0x4B, own bus (pins 25/24)
  for (uint8_t i = 0; i < 2; i++) muxDisable(MUX_ADDR[i]);
  pinMode(EMG_PIN, INPUT);             // MyoWare envelope on A0 (analog in)
  for (uint8_t ch = 0; ch < N_CHANNELS; ch++) {
    frameDeg[ch] = -1.0f; romLo[ch] = 1e9f; romHi[ch] = -1e9f;
  }
  sdOK = SD.begin(BUILTIN_SDCARD);
  Serial.println(F("\ntakto_one - TAKTO ONE device firmware, Teensy 4.1"));
  imuBegin();
  scanAll();
  // display last: the panel init is the only thing that can be skipped without
  // losing sensing, and bringing the buses up first keeps the boot report honest
  SPI.begin();  tft.begin();  tft.setSPISpeed(40000000);
  tft.setRotation((TFT_ROTATION + UI_DEFAULT_TURNS) & 3);
  tft.fillScreen(0x0000);
  uiIn.begin(POT_PIN, BTN_PIN, PZ_PIN);           // crown pot / button / piezo
  watchLoad();                                    // the face chosen last session
  FB = cv.getBuffer();
  memset(FB, 0, 240 * 240 * 2);
  uiR.begin(&tft, FB, uiShadow, uiStaging);       // dirty-tile DMA engine
  scBootT0 = millis();
  stateEnterMs = millis();
  statsT0 = millis();
  lastSample = millis();
  Serial.printf("E,watch,%d,%d,1\n", watch::curFace, watch::curColorway[watch::curFace]);
  printHelp();
}

void loop() {
  motorService();   // servo control tick (no-op until the bus is taken with M,t,1)
  // Drain everything pending (a backlog builds during the deliberate blocking
  // commands). Line-oriented input (D/W/M) is buffered as a unit so payload
  // bytes can never alias the single-letter menu commands.
  while (Serial.available()) {
    char c = Serial.read();
    if (discardLine) { if (c == '\n') discardLine = false; continue; }
    if (lnTag) {                            // accumulate a whole line, dispatch on newline
      if (c == '\n') { lnBuf[lnLen] = 0; handleHostLine(lnTag, lnBuf); lnTag = 0; lnLen = 0; }
      else if (lnLen >= sizeof(lnBuf) - 1) {  // over-long: dispatch what we have, swallow the tail
        lnBuf[lnLen] = 0; handleHostLine(lnTag, lnBuf); lnTag = 0; lnLen = 0; discardLine = true;
      } else lnBuf[lnLen++] = c;
      continue;
    }
    if (c == 'D' || c == 'W' || c == 'M') { lnTag = c; lnLen = 0; lnBuf[lnLen++] = c; }
    else if (c == 's') scanAll();
    else if (c == 'A') fullScan();
    else if (c == 'c') calibrate();
    else if (c == 'r') recToggle();                       // human toggle
    else if (c == 'b') { if (!recording) recToggle(); }   // host: explicit start (idempotent)
    else if (c == 'e') { if (recording)  recToggle(); }   // host: explicit stop  (idempotent)
    // The banner token stays "bringup_12ch": it IS the host handshake string the
    // bridge greps for (teensy_bridge.py "# ver"), so renaming it would silently
    // demote every console to legacy-firmware behaviour.
    else if (c == 'v') Serial.printf("# ver bringup_12ch %u\n", FW_VERSION);
    else if (c == 'j') { streaming = true;  Serial.println(F("# stream ON")); }
    else if (c == 'k') { streaming = false; Serial.println(F("# stream OFF")); }
    else if (c == 'R') detectAll();   // quiet hot-plug rescan (host bridge sends this)
    else if (c == '?') printHelp();
    else if (c == 'T') {                    // paint-cost report (frame budget)
      uint32_t win = millis() - statsT0;
      if (win < 1) win = 1;
      Serial.printf("# paint face=%s/%s last=%luus max=%luus mean=%luus "
                    "paints=%lu (%.1f/s) samples=%lu (%.1f/s) loop=%.0f/s window=%lums "
                    "tiles=%lu panel_runs=%lu panel_last=%luus panel_max=%luus slow=%lu "
                    "cadence=%lums interact=%lums deferred=%lu pending=%d rot=%d sync=1\n",
                    watch::active()->id(),
                    watch::active()->colorway(watch::curColorway[watch::curFace]).id,
                    (unsigned long)paintLastUs, (unsigned long)paintMaxUs,
                    (unsigned long)(paintCount ? paintSumUs / paintCount : 0),
                    (unsigned long)paintCount, paintCount * 1000.0f / win,
                    (unsigned long)screenSamples, screenSamples * 1000.0f / win,
                    loopPasses * 1000.0f / win, (unsigned long)win,
                    (unsigned long)uiR.pushed, (unsigned long)uiR.runs,
                    (unsigned long)uiR.lastWriteUs, (unsigned long)uiR.maxWriteUs,
                    (unsigned long)uiR.slowWrites,
                    (unsigned long)WATCH_PRESENT_FRAME_MS,
                    (unsigned long)WATCH_PRESENT_INTERACT_MS,
                    (unsigned long)screenDeferredBusy, uiR.pending ? 1 : 0,
                    TFT_ROTATION);
      paintMaxUs = 0; paintCount = 0; paintSumUs = 0; loopPasses = 0;
      screenSamples = 0; screenDeferredBusy = 0;
      statsT0 = millis();
    }
  }
  motorService();   // keep the control tick alive after draining a serial backlog
  loopPasses++;
  imuService();
  Ev ev = uiIn.poll();                    // crown + button (detents tick the piezo)
  if (ev != Ev::NONE) uiHandleEvent(ev);
  screenService();                        // presentation <=7.7 Hz (crown <=9.6 Hz)
  uiR.task();                             // ships <=1 coherent synchronous run per pass
  motorService();
  // oversample the MyoWare envelope (pin 14) at ~1 kHz between the 50 Hz frames
  uint32_t nowU = micros();
  if (nowU - emgLastU >= 1000) {
    emgLastU = nowU;
    uint16_t v = analogRead(EMG_PIN);
    emgSum += v; emgSumSq += (uint32_t)v * v; emgCount++;
  }
  const uint32_t PERIOD_MS = (uint32_t)(1000.0f / SAMPLE_HZ);
  uint32_t now = millis();
  if (now - lastSample >= PERIOD_MS) {
    // Advance by the period so the average rate is exactly SAMPLE_HZ (a plain
    // `lastSample = now` slips by the loop latency every frame). After a real
    // stall (SD flush, calibrate) resync instead of bursting catch-up frames:
    // bunched rows would be worse data than honestly missing rows.
    lastSample += PERIOD_MS;
    if (now - lastSample >= PERIOD_MS) lastSample = now;
    // reduce the EMG oversample to envelope (mean) + RMS, then reset the accumulator
    emgHave = (emgCount > 0);
    if (emgHave) {
      emgEnv = (float)emgSum / (float)emgCount;
      emgRms = sqrtf((float)emgSumSq / (float)emgCount);
    } else { emgEnv = 0.0f; emgRms = 0.0f; }
    emgSum = 0; emgSumSq = 0; emgCount = 0;
    crownSample();                  // presence-gated, carousel-arbitrated blend
    // ONE sensor acquisition per frame, shared by the SD row, the S-line AND the
    // faces. [MERGE] the sweep now runs whenever anything consumes it - and the
    // on-device screen always does, which is why the device shows real finger
    // motion standing alone instead of only while a host is streaming.
    readAllChannels(frameDeg);
    noteChannelRange();
    motorService();                 // the 50 Hz frame is the longest blocker
    if (recording) recWrite(now);
    if (streaming) emitStream(now);
    motorService();
  }
}
