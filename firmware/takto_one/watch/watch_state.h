// watch_state.h — the face engine's shared vocabulary (dual-target: Teensy + host).
//
// A watch face is a pure CONSUMER of DeviceState: it reads the struct, paints a
// 240x240 RGB565 framebuffer, and never touches sensors, buses, or timing. The
// sketch (or the host harness) fills DeviceState and decides when to repaint via
// the face's signature() — the value-dirty scheme the thesis firmware already
// uses (identical signature = zero paint, zero scan, zero SPI).
//
// State model: the union of what the device can display. Faces must render ALL
// of them; the firmware maps its runtime onto this set (see watch_engine.h).
#pragma once
#include <stdint.h>

enum FaceState : uint8_t {
  FS_BOOT = 0,     // power-on / waiting for the first host link
  FS_IDLE,         // connected + idle (home)
  FS_LINKED,       // console/operator session owns the device
  FS_STANDALONE,   // running without a host link (link lost after boot)
  FS_TELEOP,       // transparent / teleoperation (effort visible)
  FS_RECORDING,    // capture take running (capSec = elapsed)
  FS_CALIB,        // range calibration in progress (calibProgress 0..1)
  FS_SAVED,        // take saved confirmation
  FS_STOP,         // e-stop / safe state — loud and absolute
  FS_FAULT,        // degraded: a subsystem dropped (faultSev 0=minor 1=major)
  FS_BATTERY,      // battery focus: low / charging (battery, charging)
  FS_STATE_COUNT
};

struct DeviceState {
  // clocks
  float t;              // seconds, monotonic (animation clock)
  float stateT;         // seconds since the current state was entered
  FaceState state;
  // kinematics (normalized by the calibrated range; <0 = channel not live)
  float joints[12];     // flexion 0..1 per channel
  float amps[4];        // per-finger velocity envelope 0..1 (Ferro AMP law,
                        // computed by watchEngineUpdate: a=min(1,4|dv/dt|),
                        // instant attack, exp(-dt/0.45 s) decay)
  float emg;            // activation envelope 0..1 (self-normalized)
  float torque;         // motor effort 0..1 — HOST-FED; 0 on today's bench
                        // (the host owns the motor bus; the device never
                        // measures torque itself)
  float roll;           // hand roll, rad (from the hand IMU quaternion)
  // health lamps (the thesis-face pentagon)
  bool imuOk, encOk, emgOk, motOk, link;
  // per-state payloads
  long  capSec;         // FS_RECORDING elapsed seconds
  float calibProgress;  // FS_CALIB 0..1
  float battery;        // 0..1, or <0 = unknown (no fuel gauge on the device)
  bool  charging;
  uint8_t faultSev;     // FS_FAULT: 0 minor, 1 major
};

// crown carousel overlay (HMI chrome, engine-owned, face-independent)
struct CarouselState {
  bool  active;
  float f;              // continuous focus (UiInput.f)
  int   focus;          // snapped slot
};

struct Colorway {
  const char* id;       // wire id (DATA_CONTRACT)
  const char* name;     // display name
  uint8_t r, g, b;      // representative accent for UI swatches
  bool canonical;       // false = an explored candidate / non-canonical extra
  const char* note;     // panel caveats etc., surfaced by the selectors
};

class WatchFace {
public:
  virtual const char* id() const = 0;        // production wire identifier
  virtual const char* name() const = 0;
  virtual int nColorways() const = 0;
  virtual const Colorway& colorway(int i) const = 0;
  virtual void init(int colorwayIdx) = 0;    // select palette; reset face state
  // paint the full face into fb (240x240 RGB565). Must not block on anything.
  virtual void render(uint16_t* fb, const DeviceState& s) = 0;
  // value-dirty repaint signature: quantized "what the eye can see".
  virtual uint32_t signature(const DeviceState& s) const = 0;
  virtual ~WatchFace() {}
};
