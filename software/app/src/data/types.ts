// types.ts - the shapes every surface in this app agrees on.
//
// ONE NAMING TRAP, inherited from the device's wire contract and repeated
// here so nobody has to rediscover it: a joint channel called `{f}_mcp` is
// the MCP *abduction* encoder, `{f}_pip` is MCP *flexion*, and `{f}_dip` is
// PIP *flexion*. There is no DIP joint in the mechanism. The Pose type below
// uses the mechanical names, and the channel map is the only place the wire
// names appear.
//
// Motion follows software/MOTION_PIPELINE.md: quaternions [w, x, y, z],
// positions in metres, the Y-up body frame (+Y up, +Z forward, +X left,
// origin at the shoulder), segment axes +Z distal, +Y dorsal, +X thumb side.
import type { Finger } from '../ui/tokens';

export type Quat = [number, number, number, number];   // w, x, y, z
export type Vec3 = [number, number, number];

export type Pose = {
  /** MCP abduction, signed degrees (wire channel `{f}_mcp`) */
  ab: number;
  /** MCP flexion, degrees (wire channel `{f}_pip`) */
  mcp: number;
  /** PIP flexion, degrees (wire channel `{f}_dip`) */
  pip: number;
};

/** the resting pose a dead channel is drawn at: neutral, never a fake 0 degrees */
export const NEUTRAL_POSE: Pose = { ab: 0, mcp: 6, pip: 8 };

/**
 * The arm in the shared body frame (the snapshot's `body` block, a take's
 * b_* columns, or the synthetic feed). Everything a twin needs to put the
 * forearm and the hand in space.
 */
export type Body = {
  /** where this came from: the v16 body model, or a fallback built from the
   *  legacy tared hand/forearm quaternions under a fixed hanging upper arm */
  origin: 'body' | 'legacy';
  /** 'none' = no neutral for this boot, 'provisional' = auto neutral (ask the
   *  user to calibrate), 'calibrated' = a real neutral capture */
  cal: 'none' | 'provisional' | 'calibrated';
  /** hand + forearm IMUs live */
  live: boolean;
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  /** palm centre */
  hand: Vec3;
  forearmQuat: Quat;
  handQuat: Quat;
  /** + flexion (palm-ward), + radial, + pronation; null when not reported */
  wristDeg: { flex: number; dev: number; pro: number } | null;
  posSource: string;
  sinceNeutralS: number | null;
  inertialConf: number | null;
  still: boolean | null;
};

/** The snapshot's `device` block (firmware v16): SD recording and power. */
export type DeviceInfo = {
  fw: number | null;
  bootId: number | null;
  sdPresent: boolean;
  sdRecording: boolean;
  sdTake: number;
  sdRows: number;
  standby: boolean;
  autoRecord: boolean | null;
  neutralRunning: boolean;
};

/** The snapshot's `session` block: the one shared recording. */
export type RecInfo = {
  recording: boolean;
  id: string | null;
  task: string | null;
  profile: string | null;
  elapsedMs: number;
  samples: number;
};

export type Frame = {
  /** seconds since the source started */
  t: number;
  joints: Record<Finger, Pose>;
  /** per-joint liveness, keyed the same way as `joints` */
  ok: Record<Finger, { ab: boolean; mcp: boolean; pip: boolean }>;
  /** EMG activation envelope, 0..1, or -1 when the sensor is absent */
  emg: number;
  /** transparent (0) to assist (1) */
  blend: number;
  /** legacy tared orientations, kept for read-outs; the twin uses `body` */
  hand: Quat;
  forearm: Quat;
  /** the arm in the body frame, or null when the source carries no IMU pose */
  body: Body | null;
  /** headset-world wrist position in METRES (px/py/pz of a take), replay only */
  pos?: Vec3;
  /** device-side SD/power state; absent before firmware v16 */
  device?: DeviceInfo;
  /** the bridge's recording state; absent from replays */
  rec?: RecInfo;
  /**
   * Housekeeping the synthetic feed models and a bridge may or may not
   * report. Absent means the source does not carry it; the UI shows a dash.
   */
  telemetry?: Telemetry;
};

export type Telemetry = {
  /** motor bay temperature, degrees C */
  tempC: number;
  /** motor load, 0..1 */
  load: number;
  /** position accuracy, mm */
  accuracyMm: number;
  /** control response, ms */
  responseMs: number;
  /** battery, 0..1, and minutes remaining */
  battery: number;
  minutesLeft: number;
  /** overall system health, 0..1 */
  health: number;
};

/** A take in the bridge's library (the {kind:"takes"} message), as sent. */
export type LibTake = {
  id: string;
  profile?: string;
  task?: string;
  notes?: string;
  created_ms?: number;
  duration_s?: number;
  samples?: number;
  quality?: string;
  has_data?: boolean;
  joint_source?: string;
  env?: string;
  source?: string;
  [k: string]: unknown;
};

/** One file on the device's SD card (the {kind:"sd_takes"} message). */
export type SdTake = { name: string; bytes: number; imported_take: string | null };

export const ZERO_QUAT: Quat = [1, 0, 0, 0];

export function emptyFrame(): Frame {
  const p = (): Pose => ({ ...NEUTRAL_POSE });
  const o = () => ({ ab: true, mcp: true, pip: true });
  return {
    t: 0,
    joints: { index: p(), middle: p(), ring: p(), pinky: p() },
    ok: { index: o(), middle: o(), ring: o(), pinky: o() },
    emg: 0,
    blend: 0,
    hand: [...ZERO_QUAT] as Quat,
    forearm: [...ZERO_QUAT] as Quat,
    body: null,
  };
}
