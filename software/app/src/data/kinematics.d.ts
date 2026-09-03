// Types for the shared mechanical model. kinematics.js is carried byte-for-byte
// from software/console; it is the project's single source of truth for the
// mechanism and must not be edited here.
export declare const KIN_VERSION: number;
export declare const MCP_MAX_DEG: number;
export declare const PIP_MAX_DEG: number;
export declare const AB_MIN: number;
export declare const AB_MAX: number;
export type FingerPose = {
  ab: number; mcp: number; pip: number;
  slideKnuckleMm: number; slideMcpMm: number; slideMcpMidMm: number; slidePipMm: number;
  spoolMcpDeg: number; spoolPipDeg: number;
};
export declare function fingerPose(
  finger: string, abDeg: number, mcpDeg: number, pipDeg: number): FingerPose;
export declare const SPOOL_STATIONS: Record<string, { finger: string; joint: 'mcp' | 'pip' } | null>;
export declare function spoolAngleDeg(
  station: string, poses: Record<string, FingerPose>, motorsDeg?: any): number;
