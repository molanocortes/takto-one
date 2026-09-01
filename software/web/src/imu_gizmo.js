// imu_gizmo.js - the IMU bench's instruments. Hand-rolled 2D canvas, no WebGL.
//
// Why 2D canvas and not three.js: this page wants FOUR live views at once (three
// attitude gizmos plus a trace). Four WebGL contexts is four GPU contexts on a
// page that already shares the browser's hard context limit with the twin, and
// the shapes here are a board, a triad and a polyline - nothing that needs a
// renderer. Painter's-algorithm 2D is cheaper, crisper on HiDPI, and lets the
// drawing match the console's ink exactly.
//
// Everything is drawn in the DISPLAY frame the bridge publishes, i.e. after the
// remap/offset/tare pipeline, because that is the frame the operator is trying
// to get right. The faint ghost triad is the world frame (identity), so "the
// sensor is aligned" reads as "the coloured triad sits on the grey one".

const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const _sizes = new WeakMap();
const _ro = new ResizeObserver((entries) => {
  const d = DPR();
  for (const e of entries) {
    const r = e.contentRect;
    _sizes.set(e.target, { w: Math.max(2, Math.round(r.width * d)),
                           h: Math.max(2, Math.round(r.height * d)), dpr: d });
  }
});
function surface(canvas) {
  let s = _sizes.get(canvas);
  const d = DPR();
  if (!s || s.dpr !== d) {
    _ro.observe(canvas);
    const r = canvas.getBoundingClientRect();
    s = { w: Math.max(2, Math.round((r.width || 200) * d)),
          h: Math.max(2, Math.round((r.height || 140) * d)), dpr: d };
    _sizes.set(canvas, s);
  }
  if (canvas.width !== s.w || canvas.height !== s.h) { canvas.width = s.w; canvas.height = s.h; }
  return { ctx: canvas.getContext("2d"), w: s.w, h: s.h, dpr: s.dpr };
}

// ---- maths ---------------------------------------------------------------
export function qRot(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty),
          v[1] + w * ty + (z * tx - x * tz),
          v[2] + w * tz + (x * ty - y * tx)];
}
export const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
export function qMul(a, b) {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  return [aw * bw - ax * bx - ay * by - az * bz,
          aw * bx + ax * bw + ay * bz - az * by,
          aw * by - ax * bz + ay * bw + az * bx,
          aw * bz + ax * by - ay * bx + az * bw];
}
/** Angle of a quaternion, degrees, taking the short way round. */
export function qAngleDeg(q) {
  const w = Math.min(1, Math.abs(q[0]));
  return 2 * Math.acos(w) * 180 / Math.PI;
}

// Fixed three-quarter camera. Looking slightly down the +Z axis with +Y up, so
// the world triad lands in a familiar orientation and nothing ever spins the
// camera - the SENSOR moves, the viewpoint does not. A moving camera would make
// it impossible to tell which of the two is rotating.
const CAM_YAW = -0.62, CAM_PITCH = 0.40;
const CY = Math.cos(CAM_YAW), SY = Math.sin(CAM_YAW);
const CP = Math.cos(CAM_PITCH), SP = Math.sin(CAM_PITCH);
function project(p, cx, cy, s) {
  // yaw about Y, then pitch about X, then a weak perspective divide
  const x1 = p[0] * CY + p[2] * SY;
  const z1 = -p[0] * SY + p[2] * CY;
  const y2 = p[1] * CP - z1 * SP;
  const z2 = p[1] * SP + z1 * CP;
  const k = s / (3.2 + z2 * 0.55);         // weak perspective: depth without drama
  return [cx + x1 * k, cy - y2 * k, z2];
}

const INK = {
  bg: "transparent",
  grid: "rgba(60,52,42,0.13)",
  ghost: "rgba(60,52,42,0.26)",
  label: "rgba(60,52,42,0.55)",
  board: "rgba(60,52,42,0.10)",
  boardEdge: "rgba(60,52,42,0.42)",
  x: "#C9401B",      // the console's rust: the axis you are usually chasing
  y: "#2E7D53",
  z: "#2B6CB0",
  warn: "#B0821F",
};

function line(ctx, a, b, color, wpx) {
  ctx.strokeStyle = color; ctx.lineWidth = wpx;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}

/**
 * One sensor's attitude: a board with a labelled triad, over a ghost of the
 * world frame. `opts.compare` draws a second, dimmer triad (the other sensor)
 * so a rigid-body move can be checked by eye.
 */
export class AttitudeGizmo {
  constructor(canvas) { this.canvas = canvas; this.q = [1, 0, 0, 0]; }

  draw(q, opts = {}) {
    const { ctx, w, h, dpr } = surface(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2 + 4 * dpr, s = Math.min(w, h) * 0.86;
    const P = (p) => project(p, cx, cy, s);
    const lw = Math.max(1, 1.4 * dpr);

    // ground grid: a horizon to rotate against, otherwise the board floats
    ctx.save();
    for (let i = -2; i <= 2; i++) {
      const t = i * 0.32;
      line(ctx, P([t, -0.52, -0.64]), P([t, -0.52, 0.64]), INK.grid, lw * 0.7);
      line(ctx, P([-0.64, -0.52, t]), P([0.64, -0.52, t]), INK.grid, lw * 0.7);
    }
    ctx.restore();

    // ghost world triad: where the axes sit when the sensor reads identity
    for (const [v, c] of [[[1, 0, 0], INK.ghost], [[0, 1, 0], INK.ghost], [[0, 0, 1], INK.ghost]]) {
      line(ctx, P([0, 0, 0]), P(v.map((k) => k * 0.62)), c, lw * 0.9);
    }

    if (opts.compare) this._triad(ctx, P, opts.compare, lw * 1.1, 0.30, false);
    this._board(ctx, P, q, lw);
    this._triad(ctx, P, q, lw * 2.0, 1.0, true, dpr);

    // gravity: which way is down, straight from the sensor's own gravity vector.
    // Drawn separately from the triad because it is the one arrow that should
    // NOT move when the mounting config is correct and the rig is level.
    if (opts.gravity) {
      const g = opts.gravity;
      const n = Math.hypot(g[0], g[1], g[2]) || 1;
      const gv = [g[0] / n * 0.5, g[1] / n * 0.5, g[2] / n * 0.5];
      const a = P([0, 0, 0]), b = P(gv);
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      line(ctx, a, b, INK.warn, lw);
      ctx.setLineDash([]);
      ctx.fillStyle = INK.warn;
      ctx.font = `${9 * dpr}px ui-monospace, Menlo, monospace`;
      ctx.fillText("g", b[0] + 3 * dpr, b[1] + 3 * dpr);
    }
  }

  _board(ctx, P, q, lw) {
    // a flat PCB, so roll and pitch are legible even when the axes overlap
    const hx = 0.34, hz = 0.24, hy = 0.03;
    const corners = [
      [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
    ].map((v) => P(qRot(q, v)));
    ctx.fillStyle = INK.board;
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath(); ctx.fill();
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
                   [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of edges) line(ctx, corners[a], corners[b], INK.boardEdge, lw * 0.8);
  }

  _triad(ctx, P, q, lw, alpha, labels, dpr = 1) {
    const axes = [[[1, 0, 0], INK.x, "X"], [[0, 1, 0], INK.y, "Y"], [[0, 0, 1], INK.z, "Z"]];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    for (const [v, col, name] of axes) {
      const tip = qRot(q, v.map((k) => k * 0.66));
      const a = P([0, 0, 0]), b = P(tip);
      line(ctx, a, b, col, lw);
      // arrowhead, so the SIGN of an axis is visible - a flipped axis is the
      // single most common mounting error and it is invisible on a bare line
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L, hlen = 6 * dpr, hw = 3.2 * dpr;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - ux * hlen - uy * hw, b[1] - uy * hlen + ux * hw);
      ctx.lineTo(b[0] - ux * hlen + uy * hw, b[1] - uy * hlen - ux * hw);
      ctx.closePath(); ctx.fill();
      if (labels) {
        ctx.fillStyle = col;
        ctx.font = `600 ${10 * dpr}px ui-monospace, Menlo, monospace`;
        ctx.fillText(name, b[0] + 5 * dpr, b[1] - 4 * dpr);
      }
    }
    ctx.restore();
  }
}

/**
 * The displacement trace: a 3D path of where the hand went relative to the
 * forearm, on a fixed iso grid, with the live acceleration drawn as an arrow.
 * Autoscales to the path, with a floor so resting noise is not magnified into
 * a dramatic squiggle.
 */
export class TraceGizmo {
  constructor(canvas) { this.canvas = canvas; }

  /** pts: [[x,y,z] mm], accel: [x,y,z] m/s2 in the same frame, or null. */
  draw(pts, accel, opts = {}) {
    const { ctx, w, h, dpr } = surface(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, base = Math.min(w, h) * 0.78;

    let span = opts.minSpanMm || 40;
    for (const p of pts) span = Math.max(span, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    span *= 1.25;
    const S = (p) => project([p[0] / span, p[1] / span, p[2] / span], cx, cy, base);
    const lw = Math.max(1, 1.3 * dpr);

    // reference cage at the current scale, so the trace has a size to read against
    for (const [a, b] of [[[-1, -1, -1], [1, -1, -1]], [[1, -1, -1], [1, -1, 1]],
                          [[1, -1, 1], [-1, -1, 1]], [[-1, -1, 1], [-1, -1, -1]]]) {
      line(ctx, project(a, cx, cy, base), project(b, cx, cy, base), INK.grid, lw * 0.8);
    }
    // origin cross: the zero, i.e. wherever "Zero here" was last pressed
    for (const [v, c] of [[[0.13, 0, 0], INK.x], [[0, 0.13, 0], INK.y], [[0, 0, 0.13], INK.z]]) {
      line(ctx, project([0, 0, 0], cx, cy, base),
           project(v, cx, cy, base), c, lw * 1.2);
    }

    // the path, fading into the past so direction of travel is readable
    if (pts.length > 1) {
      for (let i = 1; i < pts.length; i++) {
        const a = S(pts[i - 1]), b = S(pts[i]);
        ctx.globalAlpha = 0.12 + 0.88 * (i / pts.length);
        line(ctx, a, b, INK.x, lw * 1.4);
      }
      ctx.globalAlpha = 1;
      const tip = S(pts[pts.length - 1]);
      ctx.fillStyle = INK.x;
      ctx.beginPath(); ctx.arc(tip[0], tip[1], 3.2 * dpr, 0, Math.PI * 2); ctx.fill();

      // live acceleration off the current point: shows the CAUSE of the motion,
      // scaled so 1 m/s^2 is a visible but not overwhelming arrow
      if (accel && opts.showAccel !== false) {
        const k = 0.22 / Math.max(0.35, span / 1000);
        const av = [pts[pts.length - 1][0] / span + accel[0] * k,
                    pts[pts.length - 1][1] / span + accel[1] * k,
                    pts[pts.length - 1][2] / span + accel[2] * k];
        line(ctx, tip, project(av, cx, cy, base), INK.warn, lw * 1.3);
      }
    }

    // scale caption: a trace with no units is a decoration
    ctx.fillStyle = INK.label;
    ctx.font = `${9.5 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.fillText(`cage ±${Math.round(span)} mm`, 6 * dpr, h - 6 * dpr);
  }
}
