// depthGpu.js - GPU depth-texture readback for the Quest browser (2026-07-20).
//
// PINNED BY THE DEVICE'S OWN DIAG LOG (~/.sensoryhand_diag.log, owner attempt
// 2026-07-20 16:12): the Quest browser GRANTS depth-sensing but serves it
// gpu-optimized ONLY (session.depthUsage="gpu-optimized", depthDataFormat
// "unsigned-short") no matter that main.js prefers cpu-optimized - so the CPU
// frame.getDepthInformation() threw InvalidStateError on EVERY frame and the
// room cloud sat at 0 points forever. On this browser the only road to the
// depth data is the WebGL path: XRWebGLBinding.getDepthInformation(view)
// hands back an opaque depth TEXTURE. We sample that texture into a tiny
// offscreen RGBA target (one texel per sparse-grid cell, the exact grid the
// CPU path used) and read it back with one readPixels per scanning frame
// (COLS x ROWS x 4 = ~900 bytes; runs only while a scan is active).
//
// On-device unknowns are handled by DIAGNOSIS, not assumption: every failure
// path returns a DISTINCT reason string that envScan surfaces on the HUD /
// world panel and ships to ~/.sensoryhand_diag.log. If the readback
// misbehaves on the next owner attempt, the log says exactly where.
//
// Encoding: the fragment shader converts the sampled raw value to METERS
// (raw * 65535 * rawValueToMeters for the normalized unsigned-short depth
// texture; raw * rawValueToMeters for float32), then packs millimeters into
// two bytes (lo, hi) + a validity byte. Zero raw = no depth at that texel.

export class GpuDepthReader {
  /** cols/rows must match envScan's sparse sample grid. */
  constructor(renderer, cols, rows) {
    this._renderer = renderer;
    this._cols = cols; this._rows = rows;
    this._session = null;
    this._binding = null;
    this._res = null;              // lazily-built GL resources per (gl, type)
    this._pixels = new Uint8Array(cols * rows * 4);
    this._out = new Float32Array(cols * rows);   // meters, 0 = invalid
    this.lastReason = "gpu reader idle";
  }

  _ensureBinding(session) {
    if (this._binding && this._session === session) return null;
    const gl = this._renderer.getContext();
    if (typeof WebGL2RenderingContext === "undefined" ||
        !(gl instanceof WebGL2RenderingContext)) {
      return "gpu depth needs WebGL2 (context is WebGL1)";
    }
    if (typeof XRWebGLBinding === "undefined") {
      return "no XRWebGLBinding in this browser";
    }
    try {
      this._binding = new XRWebGLBinding(session, gl);
      this._session = session;
      this._res = null;            // context/session changed: rebuild resources
    } catch (e) {
      return "XRWebGLBinding failed: " + (e && e.name || e);
    }
    return null;
  }

  _buildResources(gl, textureType) {
    const isArray = textureType === "texture-array";
    const vs = `#version 300 es
      void main() {
        // fullscreen triangle from gl_VertexID, no buffers
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`;
    const fs = `#version 300 es
      precision highp float;
      ${isArray ? "precision highp sampler2DArray;\nuniform sampler2DArray uDepth;" : "uniform sampler2D uDepth;"}
      uniform mat4 uUvTf;          // normDepthBufferFromNormView (view uv -> depth uv)
      uniform vec2 uGrid;          // cols, rows
      uniform vec2 uJitter;        // golden-ratio grid slide (matches CPU path)
      uniform float uRawScale;     // 65535 for unsigned-short, 1 for float32
      uniform float uRawToMeters;
      ${isArray ? "uniform float uLayer;" : ""}
      out vec4 o;
      void main() {
        // view-space uv of this grid cell (same formula as the CPU loop)
        vec2 cell = floor(gl_FragCoord.xy);
        vec2 uvView = (cell + 0.5) / uGrid + uJitter;
        if (uvView.x >= 1.0 || uvView.y >= 1.0) { o = vec4(0.0); return; }
        vec2 uvDepth = (uUvTf * vec4(uvView, 0.0, 1.0)).xy;
        if (uvDepth.x < 0.0 || uvDepth.x > 1.0 || uvDepth.y < 0.0 || uvDepth.y > 1.0) { o = vec4(0.0); return; }
        float raw = ${isArray ? "texture(uDepth, vec3(uvDepth, uLayer)).r" : "texture(uDepth, uvDepth).r"};
        float meters = raw * uRawScale * uRawToMeters;
        float mm = clamp(meters * 1000.0, 0.0, 65535.0);
        float hi = floor(mm / 256.0);
        float lo = mm - hi * 256.0;
        o = vec4(lo / 255.0, hi / 255.0, raw > 0.0 ? 1.0 : 0.0, 1.0);
      }`;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error("shader: " + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("link: " + gl.getProgramInfoLog(prog));
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._cols, this._rows, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error("fbo status " + st);
    this._res = {
      type: textureType, prog, fbo,
      uUvTf: gl.getUniformLocation(prog, "uUvTf"),
      uGrid: gl.getUniformLocation(prog, "uGrid"),
      uJitter: gl.getUniformLocation(prog, "uJitter"),
      uRawScale: gl.getUniformLocation(prog, "uRawScale"),
      uRawToMeters: gl.getUniformLocation(prog, "uRawToMeters"),
      uLayer: isArray ? gl.getUniformLocation(prog, "uLayer") : null,
      uDepth: gl.getUniformLocation(prog, "uDepth"),
    };
  }

  /** One readback. Returns { ok:true, depths:Float32Array(cols*rows) } with
   *  meters per grid cell (0 = no depth), or { ok:false, reason }. */
  read(session, view, ju, jv) {
    const bindErr = this._ensureBinding(session);
    if (bindErr) { this.lastReason = bindErr; return { ok: false, reason: bindErr }; }
    let info = null;
    try { info = this._binding.getDepthInformation(view); }
    catch (e) {
      const r = "gpu getDepthInformation threw: " + (e && e.name || e);
      this.lastReason = r; return { ok: false, reason: r };
    }
    if (!info || !info.texture) {
      const r = "gpu depth texture null this frame";
      this.lastReason = r; return { ok: false, reason: r };
    }
    const gl = this._renderer.getContext();
    const type = info.textureType === "texture-array" ? "texture-array" : "texture";
    try {
      if (!this._res || this._res.type !== type) this._buildResources(gl, type);
    } catch (e) {
      const r = "gpu depth pipeline build failed: " + (e && e.message || e);
      this.lastReason = r; this._res = null;
      return { ok: false, reason: r };
    }
    const R = this._res;
    const fmt = session.depthDataFormat || "";
    const rawScale = fmt === "float32" ? 1.0 : 65535.0;   // unsigned-short default
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
      gl.viewport(0, 0, this._cols, this._rows);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(R.prog);
      gl.activeTexture(gl.TEXTURE0);
      const target = type === "texture-array" ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
      gl.bindTexture(target, info.texture);
      // depth textures sample correctly only with NEAREST + compare off
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_COMPARE_MODE, gl.NONE);
      gl.uniform1i(R.uDepth, 0);
      const m = info.normDepthBufferFromNormView && info.normDepthBufferFromNormView.matrix;
      // identity if the UA does not supply the uv transform
      gl.uniformMatrix4fv(R.uUvTf, false, m || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
      gl.uniform2f(R.uGrid, this._cols, this._rows);
      gl.uniform2f(R.uJitter, ju || 0, jv || 0);
      gl.uniform1f(R.uRawScale, rawScale);
      gl.uniform1f(R.uRawToMeters, info.rawValueToMeters || 0.001);
      if (R.uLayer) gl.uniform1f(R.uLayer, info.imageIndex || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, this._cols, this._rows, gl.RGBA, gl.UNSIGNED_BYTE, this._pixels);
    } catch (e) {
      const r = "gpu depth pass threw: " + (e && e.name || e);
      this.lastReason = r;
      try { this._renderer.resetState(); } catch (_) {}
      return { ok: false, reason: r };
    }
    // hand the GL state back to three (we clobbered fbo/program/texture state)
    try { this._renderer.resetState(); } catch (_) {}
    const px = this._pixels, out = this._out;
    let valid = 0;
    for (let i = 0; i < out.length; i++) {
      const b = i * 4;
      if (px[b + 2] === 0) { out[i] = 0; continue; }
      out[i] = (px[b] + px[b + 1] * 256) / 1000;   // mm -> meters
      valid++;
    }
    if (valid === 0) {
      const r = "gpu depth read ok but every sample raw=0 (texture unreadable?)";
      this.lastReason = r; return { ok: false, reason: r };
    }
    this.lastReason = "gpu depth ok";
    return { ok: true, depths: out };
  }
}
