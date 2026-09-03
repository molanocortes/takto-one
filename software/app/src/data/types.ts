// types.ts - the shapes every surface in this app agrees on.
//
// ONE NAMING TRAP, inherited from the device's wire contract and repeated
// here so nobody has to rediscover it: a joint channel called `{f}_mcp` is
// the MCP *abduction* encoder, `{f}_pip` is MCP *flexion*, and `{f}_dip` is
// PIP *flexion*. There is no DIP joint in the mechanism. The Pose type below
// uses the mechanical names, and the channel map is the only place the wire
// names appear.
import type { Finger } from '../ui/tokens';

export type Quat = [number, number, number, number];   // w, x, y, z

export type Pose = {
  /** MCP abduction, signed degrees (wire channel `{f}_mcp`) */
  ab: number;
  /** MCP flexion, degrees (wire channel `{f}_pip`) */
  mcp: number;
  /** PIP flexion, degrees (wire channel `{f}_dip`) */
  pip: number;
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
  hand: Quat;
  forearm: Quat;
  /** wrist position in millimetres, replay takes only */
  pos?: [number, number, number];
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

export type SourceKind = 'sim' | 'take' | 'bridge';

export type Link = {
  kind: SourceKind;
  /** true only when a real bridge socket is open */
  live: boolean;
  label: string;
  detail: string;
};

export const ZERO_QUAT: Quat = [1, 0, 0, 0];

export function emptyFrame(): Frame {
  const p = (): Pose => ({ ab: 0, mcp: 6, pip: 8 });
  const o = () => ({ ab: true, mcp: true, pip: true });
  return {
    t: 0,
    joints: { index: p(), middle: p(), ring: p(), pinky: p() },
    ok: { index: o(), middle: o(), ring: o(), pinky: o() },
    emg: 0,
    blend: 0,
    hand: [...ZERO_QUAT] as Quat,
    forearm: [...ZERO_QUAT] as Quat,
  };
}
