// app.js - the console renders state; it keeps none of its own.
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const C = ['#0072BD', '#D95319', '#EDB120', '#7E2F8E', '#77AC30', '#4DBEEE', '#A2142F'];   // MATLAB
let S = null, proto = 'bare', calibName = null, takes = [], selTake = null, lastGoElapsed = -10;
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '–' : Number(v).toFixed(d);
const num = (v, d = 0, unit = '') => (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(d) + unit : '–';
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
$('#date').textContent = new Date().toISOString().slice(0, 10);

// ---- sections ------------------------------------------------------------
$$('.sec').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  $$('.sec').forEach((x) => x.classList.toggle('on', x === a));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + a.dataset.view));
  if (a.dataset.view !== 'live') loadTakes();
}));

// ---- state socket ----------------------------------------------------------
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onmessage = (e) => { S = JSON.parse(e.data); render(); };
  ws.onclose = () => setTimeout(connect, 800);
}
connect();
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

// ---- Figure 2: strip chart ring buffer -------------------------------------
const strip = { t: [], a: [], b: [], c: [], d: [], e: [] };
function pushStrip() {
  const t = S.t_ns / 1e9, tr = S.tracker, d = S.device, f = d.follow;
  strip.t.push(t); strip.a.push(tr.found ? tr.mcp : null); strip.b.push(tr.found ? tr.pip : null);
  strip.c.push(d.connected ? d.mcp : null); strip.d.push(d.connected ? d.pip : null);
  strip.e.push(f.target ? f.target.mcp_deg : null);
  while (strip.t.length && t - strip.t[0] > 12) for (const k in strip) strip[k].shift();
}
// MATLAB-style axes: box, ticks inward, grid, labels in the figure font
function axes(ctx, W, H, m, x0, x1, y0, y1, xl, yl, xt, yt) {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const X = (x) => m.l + (x - x0) / (x1 - x0) * (W - m.l - m.r), Y = (y) => H - m.b - (y - y0) / (y1 - y0) * (H - m.t - m.b);
  ctx.strokeStyle = '#DADADA'; ctx.lineWidth = 1;
  for (const x of xt) { ctx.beginPath(); ctx.moveTo(X(x), m.t); ctx.lineTo(X(x), H - m.b); ctx.stroke(); }
  for (const y of yt) { ctx.beginPath(); ctx.moveTo(m.l, Y(y)); ctx.lineTo(W - m.r, Y(y)); ctx.stroke(); }
  ctx.strokeStyle = '#000'; ctx.strokeRect(m.l + 0.5, m.t + 0.5, W - m.l - m.r, H - m.t - m.b);
  ctx.fillStyle = '#000'; ctx.font = '13px "LM Roman", serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const x of xt) { ctx.beginPath(); ctx.moveTo(X(x), H - m.b); ctx.lineTo(X(x), H - m.b - 6); ctx.stroke(); ctx.fillText(String(x), X(x), H - m.b + 5); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const y of yt) { ctx.beginPath(); ctx.moveTo(m.l, Y(y)); ctx.lineTo(m.l + 6, Y(y)); ctx.stroke(); ctx.fillText(String(y), m.l - 6, Y(y)); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = 'italic 14px "LM Roman", serif';
  ctx.fillText(xl, m.l + (W - m.l - m.r) / 2, H - 4);
  ctx.save(); ctx.translate(14, m.t + (H - m.t - m.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'top'; ctx.fillText(yl, 0, 0); ctx.restore();
  return { X, Y };
}
function polyline(ctx, xs, ys, X, Y, color, width = 1.6, dash = []) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath(); let pen = false;
  for (let i = 0; i < xs.length; i++) { const v = ys[i]; if (v === null || v === undefined || !Number.isFinite(v)) { pen = false; continue; } const x = X(xs[i]), y = Y(v); if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true; }
  ctx.stroke(); ctx.setLineDash([]);
}
function legend(ctx, X, Y, items, x, y) {
  ctx.font = '12.5px "LM Roman", serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const w = 150, h = 16 * items.length + 8;
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  items.forEach((it, i) => { const yy = y + 12 + i * 16; ctx.strokeStyle = it.c; ctx.lineWidth = 1.8; ctx.setLineDash(it.dash || []); ctx.beginPath(); ctx.moveTo(x + 8, yy); ctx.lineTo(x + 30, yy); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#000'; ctx.fillText(it.n, x + 36, yy); });
}
function drawStrip() {
  const cv = $('#strip'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  const tNow = S.t_ns / 1e9, t0 = tNow - 12;
  const vals = [...strip.a, ...strip.b, ...strip.c, ...strip.d].filter((v) => v !== null && Number.isFinite(v));
  const hi = Math.max(60, Math.ceil((Math.max(0, ...vals) + 5) / 30) * 30), lo = Math.min(0, Math.floor((Math.min(0, ...vals) - 5) / 30) * 30);
  const yt = []; for (let y = lo; y <= hi; y += 30) yt.push(y);
  const xt = []; for (let s = -12; s <= 0; s += 2) xt.push(s);
  const m = { l: 56, r: 16, t: 14, b: 40 };
  const { X, Y } = axes(ctx, W, H, m, -12, 0, lo, hi, 't − t_now (s)', 'θ (deg)', xt, yt);
  const xs = strip.t.map((t) => t - tNow);
  polyline(ctx, xs, strip.a, X, Y, C[0]); polyline(ctx, xs, strip.b, X, Y, C[1]);
  polyline(ctx, xs, strip.c, X, Y, C[2]); polyline(ctx, xs, strip.d, X, Y, C[3]);
  polyline(ctx, xs, strip.e, X, Y, C[2], 1.2, [4, 3]);
  legend(ctx, X, Y, [{ n: 'camera MCP', c: C[0] }, { n: 'camera PIP', c: C[1] }, { n: 'device MCP', c: C[2] }, { n: 'device PIP', c: C[3] }, { n: 'follow target', c: C[2], dash: [4, 3] }], W - m.r - 158, m.t + 8);
}

// ---- Figure 1: overlay with axes, skeleton and angle annotations -------------
const ov = $('#overlay');
function imageBox() {
  const W = ov.clientWidth, H = ov.clientHeight;
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  const pl = 46, pt = 10, pr = 12, pb = 30;                    // the axes padding in style.css
  const aw = W - pl - pr, ah = H - pt - pb;
  const iw = (S && S.camera.width) || 16, ih = (S && S.camera.height) || 9;
  const s = Math.min(aw / iw, ah / ih), bw = iw * s, bh = ih * s;
  return { W, H, pl, pt, pr, pb, iw, ih, s, bx: pl + (aw - bw) / 2, by: pt + (ah - bh) / 2, bw, bh };
}
function drawOverlay(t) {
  const b = imageBox(); const ctx = ov.getContext('2d'); ctx.clearRect(0, 0, b.W, b.H);
  const P = (x, y) => [b.bx + x * b.bw, b.by + y * b.bh];
  // pixel axes around the picture
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.fillStyle = '#000'; ctx.font = '11.5px "LM Roman", serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const stepX = b.iw >= 1600 ? 400 : 200, stepY = b.ih >= 900 ? 200 : 100;
  for (let x = 0; x <= b.iw; x += stepX) { const [px] = P(x / b.iw, 0); ctx.beginPath(); ctx.moveTo(px, b.by + b.bh); ctx.lineTo(px, b.by + b.bh + 5); ctx.stroke(); ctx.fillText(String(x), px, b.by + b.bh + 7); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let y = 0; y <= b.ih; y += stepY) { const [, py] = P(0, y / b.ih); ctx.beginPath(); ctx.moveTo(b.bx, py); ctx.lineTo(b.bx - 5, py); ctx.stroke(); ctx.fillText(String(y), b.bx - 7, py); }
  ctx.font = 'italic 12.5px "LM Roman", serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('x (px)', b.bx + b.bw / 2, b.H - 3);
  ctx.save(); ctx.translate(12, b.by + b.bh / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'top'; ctx.fillText('y (px)', 0, 0); ctx.restore();
  ctx.strokeRect(b.bx + 0.5, b.by + 0.5, b.bw, b.bh);
  if (!t) return;
  const label = (x, y, text) => { ctx.font = '12px "LM Mono", monospace'; const w = ctx.measureText(text).width + 8; ctx.fillStyle = '#fff'; ctx.fillRect(x, y - 8, w, 16); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y - 7.5, w, 16); ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 4, y); };
  const angleArc = (a, m, c, deg) => {   // arc at m between the two segments
    const [ax, ay] = a, [mx, my] = m, [cx, cy] = c;
    const r = 18, a1 = Math.atan2(ay - my, ax - mx), a2 = Math.atan2(cy - my, cx - mx);
    ctx.strokeStyle = C[1]; ctx.lineWidth = 1.2; ctx.beginPath();
    let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    ctx.arc(mx, my, r, a1, a1 + d, d < 0); ctx.stroke();
    label(mx + 14, my - 18, `θ = ${deg.toFixed(1)}°`);
  };
  if (t.mode === 'hand' && t.lm && t.lm.length === 21) {
    const bones = [[0,1],[1,2],[2,3],[3,4],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
    for (const [a, c] of bones) { const [x0, y0] = P(...t.lm[a]); const [x1, y1] = P(...t.lm[c]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
    const chain = [0, 5, 6, 7, 8].map((k) => P(...t.lm[k]));
    ctx.strokeStyle = C[0]; ctx.lineWidth = 2.2; ctx.beginPath(); chain.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    for (const [x, y] of chain) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); ctx.strokeStyle = C[0]; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (t.found) { angleArc(chain[0], chain[1], chain[2], t.mcp); angleArc(chain[1], chain[2], chain[3], t.pip); angleArc(chain[2], chain[3], chain[4], t.dip); }
  } else if (t.mode === 'markers') {
    const pts = t.points || {}; const order = ['wrist', 'mcp', 'pip', 'dip'].filter((k) => pts[k]);
    const chain = order.map((k) => P(...pts[k]));
    ctx.strokeStyle = C[0]; ctx.lineWidth = 2.2; ctx.beginPath(); chain.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    order.forEach((k, i) => { const [x, y] = chain[i]; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.strokeStyle = C[0]; ctx.lineWidth = 1.5; ctx.stroke(); label(x + 8, y + 14, k.toUpperCase()); });
    if (t.found && order.length === 4) { angleArc(chain[0], chain[1], chain[2], t.mcp); angleArc(chain[1], chain[2], chain[3], t.pip); }
  }
}

// ---- render ------------------------------------------------------------------
function render() {
  const c = S.camera, t = S.tracker, d = S.device, f = d.follow, r = S.run;
  setText($('#clock'), `t = ${(S.t_ns / 1e9).toFixed(3)} s`);
  // Table 1
  setText($('#aCam'), c.opened ? c.source : 'not open'); setText($('#aCamNote'), c.opened ? (c.note || '') : '');
  setText($('#aRes'), c.opened ? `${c.width} × ${c.height}` : '–');
  setText($('#aFps'), c.opened ? fmt(c.fps, 1) : '–'); setText($('#aFpsRep'), fmt(c.fps_reported, 0));
  setText($('#aPer'), c.opened ? `${fmt(c.period_p50_ms, 1)} / ${fmt(c.period_p95_ms, 1)}` : '–');
  setText($('#aTrk'), `${t.mode} · ${fmt(t.hz, 0)} Hz`); setText($('#aTrkNote'), t.found ? `finger found · ${fmt(t.infer_ms, 0)} ms/frame` : (t.error || 'no finger in view'));
  setText($('#aDev'), d.connected ? d.detail : (d.url ? d.detail : 'none')); setText($('#aDevNote'), d.url || '');
  setText($('#aFollow'), f.armed ? 'armed' : 'disarmed'); setText($('#aFollowNote'), f.reason || '');
  setText($('#aRec'), r.recording ? `${S.recorder ? S.recorder.frames : 0} frames` : 'off'); setText($('#aRecNote'), r.recording ? `${r.take_id} · dropped ${S.recorder ? S.recorder.dropped : 0}` : '');
  const warn = $('#camWarn'); setText(warn, c.error || ''); warn.classList.toggle('on', !!c.error && !c.opened);
  const nocam = $('#nocam'); setText(nocam, c.opened ? '' : ('No picture. ' + (c.error || '') + ' Then press Re-open.')); nocam.classList.toggle('on', !c.opened);
  setText($('#cap1'), c.opened ? `Live camera frame, ${c.width} × ${c.height}, ${fmt(c.fps, 1)} fps measured (period p50 ${fmt(c.period_p50_ms, 1)} ms, p95 ${fmt(c.period_p95_ms, 1)} ms). Tracker: ${t.mode}, ${fmt(t.hz, 0)} Hz.` : 'Camera not open.');
  // run
  const running = r.running;
  setText($('#phaseTitle'), running ? r.title : 'idle'); setText($('#phaseLeft'), running ? `${fmt(r.remaining, 0)} s left · ${fmt(r.total - r.elapsed, 0)} s total` : '');
  if (running) setText($('#phaseInstr'), r.instruction); else if (r.message) setText($('#phaseInstr'), r.message);
  $('#runFill').style.width = (r.total ? 100 * r.elapsed / r.total : 0) + '%';
  $('#btnStart').disabled = running; $('#btnAbort').disabled = !running;
  const cnt = $('#count');
  if (running && r.countdown > 0) { setText(cnt, String(Math.ceil(r.countdown))); cnt.classList.add('on'); lastGoElapsed = r.elapsed; }
  else if (running && r.block && r.elapsed - lastGoElapsed < 0.7) { setText(cnt, 'GO'); cnt.classList.add('on'); }
  else cnt.classList.remove('on');
  const ban = $('#banner');
  if (r.recording) { setText(ban, `● REC  ${r.take_id}  ${r.title}  ${S.recorder ? S.recorder.frames + ' frames' : ''}`); ban.classList.add('on'); } else ban.classList.remove('on');
  $$('#timeline .ph').forEach((el, i) => el.classList.toggle('now', running && i === r.phase_idx));
  // tracker + markers
  $('#trkHand').checked = t.mode === 'hand'; $('#trkMarkers').checked = t.mode === 'markers';
  renderMarkers(t.markers);
  // follow
  setText($('#fZero'), f.zeroed ? 'yes' : 'no'); setText($('#fDir'), f.directions ? 'yes' : 'no'); setText($('#fArm'), f.armed ? 'yes' : 'no'); setText($('#fReason'), f.reason || '');
  setText($('#fTA'), f.target ? `${fmt(f.target.mcp_deg, 0)}/${fmt(f.target.pip_deg, 0)} → ${fmt(f.actual && f.actual.mcp_deg, 0)}/${fmt(f.actual && f.actual.pip_deg, 0)}` : '–');
  setText($('#fQ'), f.enabled ? `${f.queued} · ${f.sent} · ${f.reached} · ${f.timed_out}` : '–');
  setText($('#fLag'), f.enabled ? `${fmt(f.lag_s, 2)} / ${fmt(f.max_lag_s, 2)}` : '–');
  $$('[data-f]').forEach((b) => b.classList.toggle('armed', b.dataset.f === 'arm' && f.armed));
  $('#fmQueue').checked = f.mode === 'queue'; $('#fmLatest').checked = f.mode === 'latest';
  // console
  const con = $('#console'); const text = S.console.map(([tt, x]) => `${new Date(tt * 1000).toTimeString().slice(0, 8)}  ${x}`).join('\n');
  if (con.textContent !== text) { con.textContent = text; con.scrollTop = con.scrollHeight; }
  pushStrip(); drawStrip(); drawOverlay(t);
  if (!protoRendered) renderProtocols();
}
let protoRendered = false;

// ---- protocols ------------------------------------------------------------------
function renderProtocols() {
  if (!S) return; protoRendered = true;
  $('#protoRows').innerHTML = Object.entries(S.protocols).map(([k, p]) => `<tr class="pick ${k === proto ? 'sel' : ''}" data-p="${k}"><td><input type="radio" name="proto" ${k === proto ? 'checked' : ''}></td><td><b>${p.name}</b><br><span class="note">${p.summary}</span></td><td class="num">${p.phases.length}</td><td class="num">${p.duration_s.toFixed(0)} s</td><td>${p.follow ? 'follows the camera' : p.targets ? 'drives to targets' : p.comparison ? 'encoders (vs ' + p.comparison + ')' : 'none'}</td></tr>`).join('');
  $$('#protoRows tr').forEach((tr) => tr.addEventListener('click', () => { proto = tr.dataset.p; renderProtocols(); }));
  const p = S.protocols[proto];
  $('#setupList').innerHTML = p.setup.map((s) => `<li>${s}</li>`).join('');
  const tl = $('#timeline'); tl.innerHTML = p.phases.map((ph) => `<div class="ph ${ph.countdown ? 'cd' : ''} ${ph.block ? 'blk' : ''}" style="width:${100 * ph.seconds / p.duration_s}%" title="${ph.title} · ${ph.seconds} s">${ph.key}</div>`).join('');
}
$('#btnStart').addEventListener('click', async () => { try { await post('/api/protocol/start', { key: proto }); } catch (e) { $('#runMsg').textContent = e.message; } });
$('#btnAbort').addEventListener('click', () => post('/api/protocol/abort'));
$('#trkHand').addEventListener('change', () => post('/api/tracker', { mode: 'hand' }));
$('#trkMarkers').addEventListener('change', () => post('/api/tracker', { mode: 'markers' }));
$('#fmQueue').addEventListener('change', () => post('/api/follow', { action: 'mode', mode: 'queue' }));
$('#fmLatest').addEventListener('change', () => post('/api/follow', { action: 'mode', mode: 'latest' }));
$$('[data-f]').forEach((b) => b.addEventListener('click', async () => { try { await post('/api/follow', { action: b.dataset.f, mcp: 1, pip: 1 }); } catch (e) { $('#fReason').textContent = e.message; } }));
$('#markerClear').addEventListener('click', () => post('/api/markers/clear'));

// ---- camera controls ----------------------------------------------------------------
$('#camProbe').addEventListener('click', async () => {
  $('#camMsg').textContent = 'probing…';
  const j = await (await fetch('/api/cameras')).json();
  $('#camSel').innerHTML = j.cameras.map((c) => `<option value="${c.index}">${c.index}: ${c.name} ${c.width}×${c.height}</option>`).join('') || '<option value="">none found</option>';
  $('#camMsg').textContent = j.cameras.length ? `${j.cameras.length} camera(s) deliver frames` : 'no camera delivers frames to this process';
});
$('#camReopen').addEventListener('click', async () => {
  const idx = $('#camSel').value; $('#camMsg').textContent = 'opening…';
  const j = await post('/api/camera', idx === '' ? {} : { index: Number(idx) });
  $('#camMsg').textContent = j.ok ? `open, ${j.width}×${j.height}` : j.error;
  $('#cam').src = '/video.mjpg?' + Date.now();
});
function renderMarkers(ms) {
  const box = $('#markerRows'); const key = JSON.stringify(ms) + calibName;
  if (box.dataset.key === key) return; box.dataset.key = key;
  const by = Object.fromEntries((ms || []).map((m) => [m.name, m]));
  box.innerHTML = ['wrist', 'mcp', 'pip', 'dip'].map((n) => { const m = by[n]; return `<tr><td>${n.toUpperCase()}${m ? ` <span style="display:inline-block;width:10px;height:10px;border:1px solid #000;vertical-align:middle;background:hsl(${m.h * 2} ${Math.round(m.s / 2.55)}% ${Math.round(m.v / 2.55 * 0.6)}%)"></span>` : ''}</td><td class="num">${m ? m.h : '–'}</td><td class="num">${m ? m.s : '–'}</td><td class="num">${m ? m.v : '–'}</td><td class="num">${m ? m.h_tol : '–'}</td><td><button class="btn" data-m="${n}">${calibName === n ? 'click the dot…' : 'sample'}</button></td></tr>`; }).join('');
  $$('#markerRows [data-m]').forEach((b) => b.addEventListener('click', () => { calibName = b.dataset.m; $('#viewport').classList.add('calib'); setText($('#calibHint'), `click the ${calibName.toUpperCase()} dot in Figure 1`); $('#calibHint').classList.add('on'); box.dataset.key = ''; }));
}
$('#viewport').addEventListener('click', async (e) => {
  if (!calibName) return;
  const b = imageBox(); const rect = ov.getBoundingClientRect();
  const x = (e.clientX - rect.left - b.bx) / b.bw, y = (e.clientY - rect.top - b.by) / b.bh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  try { await post('/api/markers/sample', { name: calibName, x, y }); } catch (err) { setText($('#calibHint'), err.message); }
  calibName = null; $('#viewport').classList.remove('calib'); $('#calibHint').classList.remove('on');
});

// ---- takes ---------------------------------------------------------------------------
async function loadTakes() {
  takes = await (await fetch('/api/takes')).json();
  $('#takeRows').innerHTML = takes.map((t) => {
    const a = t.analysis || {}; const fast = a.blocks && (a.blocks.fast || a.blocks.follow || a.blocks.comfortable);
    const head = a.comparison && typeof a.comparison.fast_slower_pct === 'number' ? `${num(a.comparison.fast_slower_pct)} % slower` : (fast && fast.camera && fast.camera.mcp ? `${num(fast.camera.mcp.peak_speed_deg_s)} °/s` : '');
    return `<tr class="pick ${t.id === selTake ? 'sel' : ''}" data-id="${t.id}"><td class="mono">${t.id}</td><td>${t.protocol_name || t.protocol}</td><td class="num">${t.video ? t.video.frames : '–'}</td><td class="num">${t.video ? num(t.video.fps_effective, 1) : '–'}</td><td class="num">${t.device_rows || 0}</td><td class="num">${typeof a.found_pct === 'number' ? num(a.found_pct) + ' %' : '–'}</td><td>${t.status}</td><td class="num">${head}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="note">no takes yet; run a protocol in section 1</td></tr>';
  $$('#takeRows tr.pick').forEach((el) => el.addEventListener('click', () => selectTake(el.dataset.id)));
  fillComposeSelects();
}
$('#takesRefresh').addEventListener('click', loadTakes);
async function selectTake(id) {
  selTake = id; $$('#takeRows tr').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  const m = await (await fetch('/api/takes/' + id)).json();
  const { video, phases, markers, ...rest } = m;
  $('#takeMeta').textContent = JSON.stringify(rest, (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v, 2);
  const series = await (await fetch(`/api/takes/${id}/series`)).json();
  drawChart(series, m); renderResults(m);
}
$('#btnAnalyze').addEventListener('click', async () => { if (!selTake) return; await post(`/api/takes/${selTake}/analyze`); $('#takeMsg').textContent = 'analysing…'; const key = `analyze:${selTake}`; const tm = setInterval(() => { const j = S && S.jobs && S.jobs[key]; if (j && j.done) { clearInterval(tm); $('#takeMsg').textContent = j.error ? 'failed: ' + j.error : 'analysed'; selectTake(selTake); loadTakes(); } else if (j) $('#takeMsg').textContent = `analysing ${(j.progress * 100).toFixed(0)} %`; }, 400); });
$('#btnTwin').addEventListener('click', () => { if (selTake) window.open(`/twin?take=${selTake}`, '_blank'); });
function drawChart(series, m) {
  const cv = $('#chart'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  const all = [...series.camera.map((r) => r[0]), ...series.device.map((r) => r[0])];
  if (!all.length) { axes(ctx, W, H, { l: 56, r: 16, t: 14, b: 40 }, 0, 30, 0, 90, 't (s)', 'θ (deg)', [0, 10, 20, 30], [0, 30, 60, 90]); return; }
  const t0 = Math.floor(Math.min(...all)), t1 = Math.ceil(Math.max(...all));
  const offC = series.offsets || {}, offD = series.device_offsets || {};
  const cam = series.camera.map((r) => [r[0], r[1] === null ? null : r[1] - (offC.mcp || 0), r[2] === null ? null : r[2] - (offC.pip || 0)]);
  const dev = series.device.map((r) => [r[0], r[1] === null ? null : r[1] - (offD.mcp || 0), r[2] === null ? null : r[2] - (offD.pip || 0), r[5]]);
  const vals = [...cam.flatMap((r) => [r[1], r[2]]), ...dev.flatMap((r) => [r[1], r[2], r[3]])].filter((v) => v !== null && Number.isFinite(v));
  const hi = Math.max(60, Math.ceil((Math.max(0, ...vals) + 5) / 30) * 30), lo = Math.min(0, Math.floor((Math.min(0, ...vals) - 5) / 30) * 30);
  const yt = []; for (let y = lo; y <= hi; y += 30) yt.push(y);
  const step = t1 - t0 > 40 ? 10 : 5; const xt = []; for (let s = Math.ceil(t0 / step) * step; s <= t1; s += step) xt.push(s);
  const mg = { l: 56, r: 16, t: 14, b: 40 };
  const { X, Y } = axes(ctx, W, H, mg, t0, t1, lo, hi, 't − t_GO (s)', 'θ (deg)', xt, yt);
  // analysed blocks shaded, with their names
  const blocks = (m.analysis && m.analysis.blocks) || {};
  ctx.font = '12px "LM Roman", serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  for (const [k, b] of Object.entries(blocks)) { ctx.fillStyle = 'rgba(0,0,0,.05)'; ctx.fillRect(X(b.t0_s), mg.t + 1, X(b.t1_s) - X(b.t0_s), H - mg.t - mg.b - 1); ctx.fillStyle = '#000'; ctx.fillText(k, X(b.t0_s) + 4, mg.t + 4); }
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(0), mg.t); ctx.lineTo(X(0), H - mg.b); ctx.stroke(); ctx.setLineDash([]); ctx.fillText('GO', X(0) + 4, H - mg.b - 16);
  polyline(ctx, cam.map((r) => r[0]), cam.map((r) => r[1]), X, Y, C[0]); polyline(ctx, cam.map((r) => r[0]), cam.map((r) => r[2]), X, Y, C[1]);
  polyline(ctx, dev.map((r) => r[0]), dev.map((r) => r[1]), X, Y, C[2], 1.3); polyline(ctx, dev.map((r) => r[0]), dev.map((r) => r[2]), X, Y, C[3], 1.3);
  polyline(ctx, dev.map((r) => r[0]), dev.map((r) => r[3]), X, Y, C[2], 1, [4, 3]);
  legend(ctx, X, Y, [{ n: 'camera MCP', c: C[0] }, { n: 'camera PIP', c: C[1] }, { n: 'device MCP', c: C[2] }, { n: 'device PIP', c: C[3] }, { n: 'follow target', c: C[2], dash: [4, 3] }], W - mg.r - 158, mg.t + 8);
  setText($('#cap4'), `${m.id || selTake}, ${m.protocol_name}.`);
}
function renderResults(m) {
  const a = m.analysis; const rows = [];
  if (!a) { $('#resultRows').innerHTML = '<tr><td colspan="9" class="note">not analysed yet</td></tr>'; $('#comparison').textContent = ''; return; }
  for (const [k, b] of Object.entries(a.blocks || {})) {
    for (const src of ['camera', 'device']) {
      const s = b[src]; if (!s) continue;
      for (const j of ['mcp', 'pip']) {
        const x = s[j] || {}; const ag = (b.agreement || {})[j];
        rows.push(`<tr><td>${k}</td><td>${src} ${j.toUpperCase()}</td><td class="num">${num(x.rom_deg, 1, '°')}</td><td class="num">${num(x.peak_speed_deg_s, 0, ' °/s')}</td><td class="num">${x.cycles ?? '–'}</td><td class="num">${num(x.cycle_hz, 2, ' Hz')}</td><td class="num">${src === 'device' && ag ? num(ag.rmse_deg, 1, '°') : ''}</td><td class="num">${src === 'device' && ag ? num(ag.lag_ms, 0, ' ms') : ''}</td><td class="num">${src === 'device' && ag ? num(ag.accuracy_pct, 0, ' %') : ''}</td></tr>`);
      }
    }
    if (b.follow) rows.push(`<tr><td>${k}</td><td>follow target→actual</td><td colspan="4"></td><td class="num">${num(b.follow.rmse_mcp_deg, 1, '°')} / ${num(b.follow.rmse_pip_deg, 1, '°')}</td><td class="num">${num(b.follow.lag_ms, 0, ' ms')}</td><td></td></tr>`);
    if (b.settle) rows.push(`<tr><td>${k}</td><td>settle MCP / PIP (target ${b.target ? b.target.mcp_deg + '/' + b.target.pip_deg : ''})</td><td colspan="7" class="num">${b.settle.mcp === null ? 'not reached' : num(b.settle.mcp, 2, ' s')} / ${b.settle.pip === null ? 'not reached' : num(b.settle.pip, 2, ' s')}</td></tr>`);
  }
  if (a.follow_queue) rows.push(`<tr><td>queue</td><td>follower</td><td colspan="7" class="num">${a.follow_queue.poses} poses · reached ${num(a.follow_queue.reached_pct)} % · lag mean ${num(a.follow_queue.lag_mean_s, 2)} s · max ${num(a.follow_queue.lag_max_s, 2)} s · final ${num(a.follow_queue.lag_final_s, 2)} s</td></tr>`);
  $('#resultRows').innerHTML = rows.join('') || '<tr><td colspan="9" class="note">no blocks</td></tr>';
  const c = a.comparison;
  $('#comparison').textContent = c ? `Against ${c.reference}: fast block ${num(c.fast_slower_pct)} % slower (peak angular speed), ROM retained ${num(c.fast_rom_retained_pct)} %; comfortable block ${num(c.comfortable_slower_pct)} % slower, ROM retained ${num(c.comfortable_rom_retained_pct)} %. Zeroing: ${JSON.stringify(a.zero_method || {})}.` : `Finger found in ${num(a.found_pct)} % of ${a.frames} frames. Onset ${num(a.onset_s, 2)} s after GO. Zeroing: ${JSON.stringify(a.zero_method || {})}.`;
}

// ---- compose ------------------------------------------------------------------------
const crops = { top: null, bot: null };
function fillComposeSelects() {
  for (const id of ['topTake', 'botTake']) { const sel = $('#' + id); const cur = sel.value; sel.innerHTML = takes.filter((t) => t.has_video).map((t) => `<option value="${t.id}">${t.id} · ${t.protocol_name}</option>`).join(''); if (cur) sel.value = cur; }
  suggest();
}
function bindCrop(prefix) {
  const vid = $(`#${prefix}Vid`), cv = $(`#${prefix}Crop`), sel = $(`#${prefix}Take`); let start = null;
  const load = () => { const t = takes.find((x) => x.id === sel.value); if (!t) return; vid.preload = 'auto'; vid.src = `/takes/${t.id}/video.mp4`; crops[prefix] = null; draw(); };
  // show a frame from inside the movement, not the black first frame
  vid.addEventListener('loadedmetadata', () => { vid.currentTime = Math.min(3, (vid.duration || 6) / 2); });
  vid.addEventListener('seeked', () => draw());
  sel.addEventListener('change', () => { load(); suggest(); }); setTimeout(load, 400);
  const box = () => { const W = cv.clientWidth, H = cv.clientHeight; if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; } const iw = vid.videoWidth || 16, ih = vid.videoHeight || 9; const s = Math.min(W / iw, H / ih); return { W, H, s, bx: (W - iw * s) / 2, by: (H - ih * s) / 2, bw: iw * s, bh: ih * s }; };
  const draw = () => { const b = box(); const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, b.W, b.H); const c = crops[prefix]; if (!c) return; ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(b.bx, b.by, b.bw, b.bh); ctx.clearRect(b.bx + c[0] * b.s, b.by + c[1] * b.s, c[2] * b.s, c[3] * b.s); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(b.bx + c[0] * b.s, b.by + c[1] * b.s, c[2] * b.s, c[3] * b.s); };
  const pt = (e) => { const b = box(); const r = cv.getBoundingClientRect(); return [(e.clientX - r.left - b.bx) / b.s, (e.clientY - r.top - b.by) / b.s]; };
  cv.addEventListener('mousedown', (e) => { start = pt(e); });
  cv.addEventListener('mousemove', (e) => { if (!start) return; const p = pt(e); crops[prefix] = [Math.round(Math.min(start[0], p[0])), Math.round(Math.min(start[1], p[1])), Math.round(Math.abs(p[0] - start[0])), Math.round(Math.abs(p[1] - start[1]))]; draw(); });
  window.addEventListener('mouseup', () => { if (start && crops[prefix] && (crops[prefix][2] < 20 || crops[prefix][3] < 20)) crops[prefix] = null; start = null; draw(); });
  vid.addEventListener('loadeddata', draw);
}
bindCrop('top'); bindCrop('bot');
function suggest() {
  const a = takes.find((t) => t.id === $('#topTake').value), b = takes.find((t) => t.id === $('#botTake').value); const lines = [];
  if (b && b.analysis && b.analysis.comparison) { const c = b.analysis.comparison; if (typeof c.fast_slower_pct === 'number') lines.push(`headline: ${num(c.fast_slower_pct)} % slower   (peak angular speed, fast block, ${b.id} vs ${c.reference})`); if (typeof c.fast_rom_retained_pct === 'number') lines.push(`range of motion retained: ${num(c.fast_rom_retained_pct)} %`); }
  for (const t of [a, b]) { if (!t || !t.analysis) continue; for (const [k, bl] of Object.entries(t.analysis.blocks || {})) { if (bl.agreement && bl.agreement.mcp) lines.push(`${t.id} ${k}: twin agreement MCP ${num(bl.agreement.mcp.accuracy_pct)} %  (RMSE ${num(bl.agreement.mcp.rmse_deg, 1)} deg, lag ${num(bl.agreement.mcp.lag_ms)} ms)`); if (bl.follow) lines.push(`${t.id} ${k}: follow RMSE MCP ${num(bl.follow.rmse_mcp_deg, 1)} deg, lag ${num(bl.follow.lag_ms / 1000, 2)} s`); } const fq = t.analysis.follow_queue; if (fq) lines.push(`${t.id}: follower reached ${num(fq.reached_pct)} % of ${fq.poses} poses, lag mean ${num(fq.lag_mean_s, 2)} s, max ${num(fq.lag_max_s, 2)} s`); }
  $('#suggest').textContent = lines.join('\n') || 'suggestions from the analysis appear here';
}
$('#btnRender').addEventListener('click', async () => {
  const body = { top: { take: $('#topTake').value, source: $('#topSrc').value, label: $('#topLabel').value || 'Camera', crop: crops.top },
    bottom: { take: $('#botTake').value, source: $('#botSrc').value, label: $('#botLabel').value || 'Comparison', crop: crops.bot },
    headline: $('#headline').value, sub: $('#sub').value, footer: $('#footer').value, slow: Number($('#slow').value) || 1, duration_s: $('#dur').value ? Number($('#dur').value) : null };
  $('#composeMsg').textContent = 'rendering…';
  try {
    const j = await post('/api/compose', body);
    const tm = setInterval(() => { const job = S && S.jobs && S.jobs[j.job]; if (!job) return; if (job.done) { clearInterval(tm); $('#composeMsg').textContent = job.error ? 'failed: ' + job.error : 'done'; if (!job.error) $('#result').innerHTML = `<div><video src="${job.path}" controls loop></video><a href="${job.path}" download>${job.path.split('/').pop()}</a></div>`; } else $('#composeMsg').textContent = `rendering ${(job.progress * 100).toFixed(0)} %`; }, 400);
  } catch (e) { $('#composeMsg').textContent = e.message; }
});
loadTakes();
