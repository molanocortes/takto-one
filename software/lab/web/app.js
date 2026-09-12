// app.js - the page. It renders state; it never keeps its own.
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let S = null;                 // the latest state from the server
let proto = 'bare';
let calibName = null;         // marker being sampled
let takes = [];
let selTake = null;

// ---- views ---------------------------------------------------------------
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('on', x === b));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view !== 'live') loadTakes();
}));

// ---- state socket --------------------------------------------------------
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onmessage = (e) => { S = JSON.parse(e.data); render(); };
  ws.onclose = () => setTimeout(connect, 800);
}
connect();

const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '–' : Number(v).toFixed(d);
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

function render() {
  if (!S) return;
  const c = S.camera, t = S.tracker, d = S.device, f = d.follow, r = S.run;
  const chipCam = $('#chipCam');
  setText(chipCam, c.opened ? `CAMERA ${c.width}×${c.height} · ${fmt(c.fps, 1)} FPS` : 'CAMERA ' + (c.error || 'closed'));
  chipCam.className = 'chip ' + (c.opened ? 'ok' : 'bad');
  setText($('#chipTrk'), `TRACKER ${t.mode} · ${t.found ? 'FOUND' : 'no finger'} · ${fmt(t.hz, 0)} HZ` + (t.infer_ms ? ` · ${fmt(t.infer_ms, 0)} MS` : ''));
  $('#chipTrk').className = 'chip ' + (t.found ? 'ok' : '');
  setText($('#chipDev'), `DEVICE ${d.connected ? d.detail : (d.url ? d.detail : 'none')}`);
  $('#chipDev').className = 'chip ' + (d.connected ? 'ok' : (d.url ? 'bad' : ''));
  setText($('#chipFollow'), `FOLLOW ${f.armed ? 'ARMED' : f.reason || 'disarmed'}` + (f.enabled ? ` · ${f.mode} · lag ${fmt(f.lag_s, 2)} S` : ''));
  $('#chipFollow').className = 'chip ' + (f.armed ? 'ok' : '');
  $('#liveDot').classList.toggle('on', c.opened);

  setText($('#camMcp'), fmt(t.mcp)); setText($('#camPip'), fmt(t.pip)); setText($('#camDip'), fmt(t.dip));
  setText($('#devMcp'), fmt(d.mcp)); setText($('#devPip'), fmt(d.pip));
  setText($('#lag'), f.enabled ? fmt(f.lag_s, 2) : '–'); setText($('#queue'), f.enabled ? String(f.queued) : '–');

  // the run panel
  const running = r.running;
  setText($('#phaseTitle'), running ? r.title : (r.message ? 'Idle' : 'Idle'));
  setText($('#phaseInstr'), running ? r.instruction : (r.message || $('#phaseInstr').textContent));
  $('#runFill').style.width = (r.total ? 100 * r.elapsed / r.total : 0) + '%';
  $('#btnStart').disabled = running; $('#btnAbort').disabled = !running;
  const cnt = $('#count');
  if (running && r.countdown > 0) { setText(cnt, String(Math.ceil(r.countdown))); cnt.classList.add('on'); }
  else if (running && r.countdown === 0 && r.elapsed - lastGoElapsed < 0.6 && r.block) { setText(cnt, 'GO'); cnt.classList.add('on'); }
  else cnt.classList.remove('on');
  if (running && r.countdown > 0) lastGoElapsed = r.elapsed;
  const ban = $('#banner');
  if (r.recording) { setText(ban, `REC · ${r.take_id} · ${r.title}${S.recorder ? ' · ' + S.recorder.frames + ' frames' : ''}`); ban.className = 'banner on rec'; }
  else if (r.message) { setText(ban, r.message); ban.className = 'banner on'; }
  else ban.className = 'banner';
  setText($('#runMsg'), running ? `${fmt(r.remaining, 0)} s left in phase · ${fmt(r.total - r.elapsed, 0)} s total` : '');

  // tracker + follow controls
  $$('#trkMode .segb').forEach((b) => b.classList.toggle('on', b.dataset.mode === t.mode));
  $$('#followMode .segb').forEach((b) => b.classList.toggle('on', b.dataset.fm === f.mode));
  const fs = $('#followState');
  setText(fs, `${f.zeroed ? 'neutral ✓' : 'neutral –'} · ${f.directions ? 'directions ✓' : 'directions –'} · ${f.armed ? 'ARMED' : 'off'}`);
  $$('[data-f]').forEach((b) => b.classList.toggle('armed', b.dataset.f === 'arm' && f.armed));
  setText($('#followInfo'), f.enabled ? `sent ${f.sent} · reached ${f.reached} · timed out ${f.timed_out} · lag ${fmt(f.lag_s, 2)} s (max ${fmt(f.max_lag_s, 2)})` : (f.target ? `target ${fmt(f.target.mcp_deg, 0)}/${fmt(f.target.pip_deg, 0)} · actual ${fmt(f.actual && f.actual.mcp_deg, 0)}/${fmt(f.actual && f.actual.pip_deg, 0)}` : ''));
  renderSwatches(t.markers);
  drawOverlay(t);
  if (!protoRendered) renderProtocols();
}
let lastGoElapsed = -10;
let protoRendered = false;

// ---- overlay: the skeleton or the markers, in the picture's own frame ----
const ov = $('#overlay'), img = $('#cam');
function drawOverlay(t) {
  const W = ov.clientWidth, H = ov.clientHeight;
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  // object-fit: contain -> the picture's box inside the canvas
  const iw = S.camera.width || 16, ih = S.camera.height || 9;
  const s = Math.min(W / iw, H / ih), bw = iw * s, bh = ih * s, bx = (W - bw) / 2, by = (H - bh) / 2;
  const P = (x, y) => [bx + x * bw, by + y * bh];
  if (t.mode === 'hand' && t.lm && t.lm.length === 21) {
    const bones = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(23,23,26,.45)';
    for (const [a, b] of bones) { const [x0, y0] = P(...t.lm[a]); const [x1, y1] = P(...t.lm[b]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
    ctx.lineWidth = 3; ctx.strokeStyle = '#2F6BFF';
    for (const [a, b] of [[0,5],[5,6],[6,7],[7,8]]) { const [x0, y0] = P(...t.lm[a]); const [x1, y1] = P(...t.lm[b]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
    for (const k of [5, 6, 7]) { const [x, y] = P(...t.lm[k]); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.strokeStyle = '#2F6BFF'; ctx.lineWidth = 2; ctx.stroke(); }
  } else if (t.mode === 'markers') {
    const pts = t.points || {};
    const order = ['wrist', 'mcp', 'pip', 'dip'].filter((k) => pts[k]);
    ctx.lineWidth = 3; ctx.strokeStyle = '#2F6BFF'; ctx.beginPath();
    order.forEach((k, i) => { const [x, y] = P(...pts[k]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
    for (const k of order) { const [x, y] = P(...pts[k]); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.strokeStyle = '#2F6BFF'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = '10px JBM'; ctx.fillStyle = '#17171A'; ctx.fillText(k.toUpperCase(), x + 9, y - 8); }
  }
}
function renderSwatches(ms) {
  const box = $('#swatches');
  const key = JSON.stringify(ms);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = (ms || []).map((m) => `<span class="sw"><i style="background:hsl(${m.h * 2} ${Math.round(m.s / 2.55)}% ${Math.round(m.v / 2.55 * 0.6)}%)"></i>${m.name}</span>`).join('') || '<span class="sw">no markers calibrated</span>';
}

// ---- protocols -------------------------------------------------------------
function renderProtocols() {
  if (!S) return;
  protoRendered = true;
  const box = $('#protoCards');
  box.innerHTML = Object.entries(S.protocols).map(([k, p]) => `<div class="card ${k === proto ? 'on' : ''}" data-p="${k}"><div class="n">${p.name}</div><div class="s">${p.summary}</div><div class="d">${p.duration_s.toFixed(0)} S · ${p.phases.length} PHASES${p.follow ? ' · FOLLOW' : ''}${p.targets ? ' · TARGETS' : ''}</div></div>`).join('');
  $$('#protoCards .card').forEach((c) => c.addEventListener('click', () => { proto = c.dataset.p; renderProtocols(); }));
  $('#setupList').innerHTML = S.protocols[proto].setup.map((s) => `<li>${s}</li>`).join('');
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}
$('#btnStart').addEventListener('click', async () => { try { await post('/api/protocol/start', { key: proto }); } catch (e) { $('#runMsg').textContent = e.message; } });
$('#btnAbort').addEventListener('click', () => post('/api/protocol/abort'));
$$('#trkMode .segb').forEach((b) => b.addEventListener('click', () => post('/api/tracker', { mode: b.dataset.mode })));
$$('#followMode .segb').forEach((b) => b.addEventListener('click', () => post('/api/follow', { action: 'mode', mode: b.dataset.fm })));
$$('[data-f]').forEach((b) => b.addEventListener('click', async () => { try { await post('/api/follow', { action: b.dataset.f, mcp: 1, pip: 1 }); } catch (e) { $('#followInfo').textContent = e.message; } }));
$('#markerClear').addEventListener('click', () => post('/api/markers/clear'));
$$('#markerBtns [data-m]').forEach((b) => b.addEventListener('click', () => {
  calibName = b.dataset.m; $('#viewport').classList.add('calib'); $('#calibHint').textContent = `click the ${calibName} dot in the picture`; $('#calibHint').classList.add('on');
}));
$('#viewport').addEventListener('click', async (e) => {
  if (!calibName) return;
  const W = ov.clientWidth, H = ov.clientHeight, iw = S.camera.width, ih = S.camera.height;
  const s = Math.min(W / iw, H / ih), bw = iw * s, bh = ih * s, bx = (W - bw) / 2, by = (H - bh) / 2;
  const rect = ov.getBoundingClientRect();
  const x = (e.clientX - rect.left - bx) / bw, y = (e.clientY - rect.top - by) / bh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  try { await post('/api/markers/sample', { name: calibName, x, y }); } catch (err) { $('#calibHint').textContent = err.message; }
  calibName = null; $('#viewport').classList.remove('calib'); $('#calibHint').classList.remove('on');
});

// ---- takes ---------------------------------------------------------------
async function loadTakes() {
  takes = await (await fetch('/api/takes')).json();
  const box = $('#takeList');
  box.innerHTML = takes.map((t) => {
    const a = t.analysis || {};
    const fast = a.blocks && (a.blocks.fast || a.blocks.follow || a.blocks.comfortable);
    const headline = a.comparison && typeof a.comparison.fast_slower_pct === 'number' ? `${num(a.comparison.fast_slower_pct)} % slower`
      : (fast && fast.camera && fast.camera.mcp && typeof fast.camera.mcp.peak_speed_deg_s === 'number' ? `${num(fast.camera.mcp.peak_speed_deg_s)} °/s peak` : '');
    return `<div class="take ${t.id === selTake ? 'on' : ''}" data-id="${t.id}"><div class="id">${t.id}</div><div class="n">${t.protocol_name || t.protocol}</div><div class="s">${t.status}${t.video ? ` · ${t.video.frames} frames · ${(t.video.fps_effective || 0).toFixed(1)} fps` : ''}${t.device_rows ? ` · ${t.device_rows} device rows` : ''}${a.found_pct !== undefined ? ` · finger found ${a.found_pct.toFixed(0)} %` : ''}</div>${headline ? `<div class="num">${headline}</div>` : ''}</div>`;
  }).join('') || '<div class="hint">No takes yet. Run a protocol on the Live tab.</div>';
  $$('.take').forEach((el) => el.addEventListener('click', () => selectTake(el.dataset.id)));
  fillComposeSelects();
}
$('#takesRefresh').addEventListener('click', loadTakes);
async function selectTake(id) {
  selTake = id;
  $$('.take').forEach((el) => el.classList.toggle('on', el.dataset.id === id));
  const m = await (await fetch('/api/takes/' + id)).json();
  $('#takeTitle').textContent = `${id} · ${m.protocol_name}`;
  const { video, phases, markers, ...rest } = m;
  $('#takeMeta').textContent = JSON.stringify(rest, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v, 2);
  const series = await (await fetch(`/api/takes/${id}/series`)).json();
  drawChart(series, m);
}
$('#btnAnalyze').addEventListener('click', async () => { if (!selTake) return; await post(`/api/takes/${selTake}/analyze`); $('#takeMsg').textContent = 'analyzing…'; pollJob(`analyze:${selTake}`, () => { $('#takeMsg').textContent = 'analyzed'; selectTake(selTake); loadTakes(); }); });
$('#btnTwin').addEventListener('click', () => { if (selTake) window.open(`/twin?take=${selTake}`, '_blank'); });
function pollJob(key, done) {
  const t = setInterval(() => { const j = S && S.jobs && S.jobs[key]; if (j && j.done) { clearInterval(t); done(j); } else if (j) $('#takeMsg').textContent = `${key} ${(j.progress * 100).toFixed(0)} %`; }, 400);
}
function drawChart(series, m) {
  const cv = $('#chart'), ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const all = [...series.camera.map((r) => r[0]), ...series.device.map((r) => r[0])];
  if (!all.length) { ctx.fillStyle = '#A2A2A8'; ctx.font = '12px JBM'; ctx.fillText('NO TRACES YET', 20, 30); return; }
  const t0 = Math.min(...all), t1 = Math.max(...all);
  const vals = [...series.camera.flatMap((r) => [r[1], r[2]]), ...series.device.flatMap((r) => [r[1], r[2], r[5], r[6]])].filter((v) => v !== null && Number.isFinite(v));
  const lo = Math.min(-5, ...vals), hi = Math.max(30, ...vals);
  const X = (t) => 50 + (t - t0) / (t1 - t0 || 1) * (W - 70), Y = (v) => H - 30 - (v - lo) / (hi - lo || 1) * (H - 50);
  ctx.strokeStyle = '#DDDBD6'; ctx.lineWidth = 1; ctx.font = '10px JBM'; ctx.fillStyle = '#A2A2A8';
  for (const v of [0, 30, 60, 90]) { if (v < lo || v > hi) continue; ctx.beginPath(); ctx.moveTo(50, Y(v)); ctx.lineTo(W - 20, Y(v)); ctx.stroke(); ctx.fillText(v + '°', 14, Y(v) + 3); }
  ctx.beginPath(); ctx.moveTo(X(0), 20); ctx.lineTo(X(0), H - 30); ctx.strokeStyle = '#E38A1C'; ctx.stroke(); ctx.fillText('GO', X(0) + 4, 16);
  const line = (rows, ix, color, width = 1.6) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); let pen = false; for (const r of rows) { const v = r[ix]; if (v === null || !Number.isFinite(v)) { pen = false; continue; } const x = X(r[0]), y = Y(v); if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true; } ctx.stroke(); };
  const offC = series.offsets || {}, offD = series.device_offsets || {};
  line(series.camera.map((r) => [r[0], r[1] === null ? null : r[1] - (offC.mcp || 0), r[2] === null ? null : r[2] - (offC.pip || 0)]), 1, '#2F6BFF');
  line(series.camera.map((r) => [r[0], null, r[2] === null ? null : r[2] - (offC.pip || 0)]), 2, '#1FA463');
  line(series.device.map((r) => [r[0], r[1] === null ? null : r[1] - (offD.mcp || 0)]), 1, '#17171A', 1.2);
  line(series.device.map((r) => [r[0], null, r[2] === null ? null : r[2] - (offD.pip || 0)]), 2, '#A2A2A8', 1.2);
  line(series.device, 5, '#E38A1C', 1);
  ctx.fillStyle = '#A2A2A8'; for (let s = Math.ceil(t0); s <= t1; s += 5) ctx.fillText(s + ' s', X(s) - 8, H - 12);
}

// ---- compose -------------------------------------------------------------
const crops = { top: null, bot: null };
function fillComposeSelects() {
  for (const id of ['topTake', 'botTake']) {
    const sel = $('#' + id); const cur = sel.value;
    sel.innerHTML = takes.filter((t) => t.has_video).map((t) => `<option value="${t.id}">${t.id} · ${t.protocol_name}</option>`).join('');
    if (cur) sel.value = cur;
  }
  suggest();
}
function bindCrop(prefix) {
  const vid = $(`#${prefix}Vid`), cv = $(`#${prefix}Crop`); let start = null;
  const sel = $(`#${prefix}Take`);
  const load = () => { const t = takes.find((x) => x.id === sel.value); if (!t) return; vid.src = `/takes/${t.id}/video.mp4#t=3`; crops[prefix] = null; draw(); };
  sel.addEventListener('change', () => { load(); suggest(); }); setTimeout(load, 300);
  const box = () => { const W = cv.clientWidth, H = cv.clientHeight; if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; } const iw = vid.videoWidth || 16, ih = vid.videoHeight || 9; const s = Math.min(W / iw, H / ih); return { W, H, iw, ih, s, bw: iw * s, bh: ih * s, bx: (W - iw * s) / 2, by: (H - ih * s) / 2 }; };
  const draw = () => { const b = box(); const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, b.W, b.H); const c = crops[prefix]; if (!c) return; ctx.fillStyle = 'rgba(23,23,26,.35)'; ctx.fillRect(b.bx, b.by, b.bw, b.bh); ctx.clearRect(b.bx + c[0] * b.s, b.by + c[1] * b.s, c[2] * b.s, c[3] * b.s); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(b.bx + c[0] * b.s, b.by + c[1] * b.s, c[2] * b.s, c[3] * b.s); };
  const pt = (e) => { const b = box(); const r = cv.getBoundingClientRect(); return [(e.clientX - r.left - b.bx) / b.s, (e.clientY - r.top - b.by) / b.s]; };
  cv.addEventListener('mousedown', (e) => { start = pt(e); });
  cv.addEventListener('mousemove', (e) => { if (!start) return; const p = pt(e); const x = Math.min(start[0], p[0]), y = Math.min(start[1], p[1]); const w = Math.abs(p[0] - start[0]), h = Math.abs(p[1] - start[1]); crops[prefix] = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)]; draw(); });
  window.addEventListener('mouseup', () => { if (start && crops[prefix] && (crops[prefix][2] < 20 || crops[prefix][3] < 20)) crops[prefix] = null; start = null; draw(); });
  vid.addEventListener('loadeddata', draw);
}
bindCrop('top'); bindCrop('bot');
// a number the method could not produce arrives as null and prints as a dash
const num = (v, d = 0, unit = '') => (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(d) + unit : '–';
function suggest() {
  const a = takes.find((t) => t.id === $('#topTake').value), b = takes.find((t) => t.id === $('#botTake').value);
  const lines = [];
  if (b && b.analysis && b.analysis.comparison) {
    const c = b.analysis.comparison;
    if (typeof c.fast_slower_pct === 'number') lines.push(`headline suggestion: ${num(c.fast_slower_pct)} % slower · peak angular speed, fast block, ${b.id} vs ${c.reference}`);
    if (typeof c.fast_rom_retained_pct === 'number') lines.push(`range of motion retained: ${num(c.fast_rom_retained_pct)} %`);
  }
  for (const t of [a, b]) {
    if (!t || !t.analysis) continue;
    for (const [k, bl] of Object.entries(t.analysis.blocks || {})) {
      if (bl.agreement && bl.agreement.mcp) lines.push(`${t.id} ${k}: twin agreement MCP ${num(bl.agreement.mcp.accuracy_pct)} % (RMSE ${num(bl.agreement.mcp.rmse_deg, 1)}°, lag ${num(bl.agreement.mcp.lag_ms)} ms)`);
      if (bl.follow) lines.push(`${t.id} ${k}: follow RMSE MCP ${num(bl.follow.rmse_mcp_deg, 1)}° · lag ${num(bl.follow.lag_ms / 1000, 2)} s`);
      if (bl.settle) lines.push(`${t.id} ${k}: settle MCP ${bl.settle.mcp === null ? 'not reached' : num(bl.settle.mcp, 2, ' s')}, PIP ${bl.settle.pip === null ? 'not reached' : num(bl.settle.pip, 2, ' s')}`);
    }
    const fq = t.analysis.follow_queue;
    if (fq) lines.push(`${t.id}: follower reached ${num(fq.reached_pct)} % of ${fq.poses} poses, lag mean ${num(fq.lag_mean_s, 2)} s, max ${num(fq.lag_max_s, 2)} s`);
  }
  $('#suggest').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
}
$('#btnRender').addEventListener('click', async () => {
  const body = {
    top: { take: $('#topTake').value, source: $('#topSrc').value, label: $('#topLabel').value || 'Camera', crop: crops.top },
    bottom: { take: $('#botTake').value, source: $('#botSrc').value, label: $('#botLabel').value || 'Comparison', crop: crops.bot },
    headline: $('#headline').value, sub: $('#sub').value, footer: $('#footer').value, slow: Number($('#slow').value) || 1,
    duration_s: $('#dur').value ? Number($('#dur').value) : null,
  };
  $('#composeMsg').textContent = 'rendering…';
  try {
    const j = await post('/api/compose', body);
    const t = setInterval(() => { const job = S && S.jobs && S.jobs[j.job]; if (!job) return; if (job.done) { clearInterval(t); $('#composeMsg').textContent = job.error ? 'failed: ' + job.error : 'done'; if (!job.error) $('#result').innerHTML = `<video src="${job.path}" controls loop></video><a href="${job.path}" download>Download ${job.path.split('/').pop()}</a>`; } else $('#composeMsg').textContent = `rendering ${(job.progress * 100).toFixed(0)} %`; }, 400);
  } catch (e) { $('#composeMsg').textContent = e.message; }
});
loadTakes();
