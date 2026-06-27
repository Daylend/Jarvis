const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));

const elStream = $('stream'), elThink = $('think'), elTools = $('tools');
const elToks = $('toks'), elTtft = $('ttft'), elIter = $('iter'), elLast = $('last'), elTurns = $('turns');
const elVu = $('vu'), elCtx = $('ctxlabel'), elStatus = $('status'), elClock = $('clock');

let activeAssistant = null;
let activeThink = null;
let activeTool = null;

// rolling buffers for oscilloscope waveforms
const W = 240;
// seed buffers with two decayed past-turn bursts so the scope traces look alive immediately
const seedBurst = (peak, w) => {
  const a = new Array(w).fill(0);
  for (let i = 0; i < 22; i++) a[w - 130 + i] = peak * Math.exp(-i / 9);
  for (let i = 0; i < 22; i++) a[w - 60 + i] = peak * 0.9 * Math.exp(-i / 9);
  return a;
};
const tokBuf = seedBurst(72, W);
const ttftBuf = seedBurst(560, W);
// eeg noisy trace accumulators
let eegPhase = 0;
let thinkActive = false;

function setStatus(text, color) {
  elStatus.textContent = text;
  elStatus.style.color = color || '';
}

function ensureAssistant() {
  if (activeAssistant) return activeAssistant;
  const div = document.createElement('div');
  div.className = 'msg role-assistant';
  div.innerHTML = '<span class="msg__tag">assistant</span><span class="msg__body"></span>';
  elStream.appendChild(div);
  activeAssistant = div.querySelector('.msg__body');
  const c = document.createElement('span'); c.className = 'cursor'; activeAssistant.appendChild(c);
  elStream.scrollTop = elStream.scrollHeight;
  return activeAssistant;
}
function closeAssistant() { if (activeAssistant) { const c = activeAssistant.querySelector('.cursor'); if (c) c.remove(); activeAssistant = null; } }
function ensureThink() {
  if (activeThink) return activeThink;
  const c = elThink.querySelector('.cursor'); if (c) c.remove();
  const span = document.createElement('span'); elThink.appendChild(span);
  activeThink = span;
  const cur = document.createElement('span'); cur.className = 'cursor'; elThink.appendChild(cur);
  return span;
}
function closeThink() { if (activeThink) { const c = elThink.querySelector('.cursor'); if (c) c.remove(); activeThink = null; } }

// ── waveforms ─────────────────────────────────────────────────────────────────
function drawWave() {
  const cv = $('wave');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600;
  const h = 150;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = 'rgba(57,255,138,.07)'; ctx.lineWidth = 1;
  for (let y = 0; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }

  const drawLine = (buf, color, max, glow) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.4;
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 6; }
    ctx.beginPath();
    buf.forEach((v, i) => {
      const x = (i / (buf.length - 1)) * w;
      const y = h - (Math.min(v, max) / max) * (h - 6) - 3;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke(); ctx.shadowBlur = 0;
  };
  drawLine(tokBuf, '#39ff8a', 90, true);
  drawLine(ttftBuf, '#ffcc33', 900, false);
}

function drawEeg() {
  const cv = $('eeg'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600; const h = 56;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  // grid baseline
  ctx.strokeStyle = 'rgba(57,255,138,.08)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();

  // a noisy wandering trace; amplitude depends on activity (thinking/token streaming)
  ctx.strokeStyle = '#39ff8a'; ctx.lineWidth = 1.2;
  ctx.shadowColor = '#39ff8a'; ctx.shadowBlur = 5;
  ctx.beginPath();
  const amp = thinkActive ? 18 : 4;
  for (let x = 0; x < w; x += 2) {
    eegPhase += 0.18;
    const n = (Math.sin(eegPhase) + Math.sin(eegPhase * 0.37 + 1.1) + (Math.random() - .5) * 0.8) / 3;
    const y = h/2 + n * amp;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.shadowBlur = 0;
}

const mind = new FakeMind();
mind.on(({ type, payload }) => {
  switch (type) {
    case 'seed': {
      const a = document.createElement('div');
      a.className = 'msg role-assistant';
      a.innerHTML = `<span class="msg__tag">assistant</span><span class="msg__body">${esc(payload.assistant)}</span>`;
      elStream.appendChild(a);
      const t = document.createElement('span');
      t.textContent = payload.trace;
      elThink.appendChild(t);
      const card = document.createElement('div');
      card.className = 'tool';
      card.innerHTML = `<div><span class="tool__name">${esc(payload.tool.name)}</span> <span class="tool__badge ok">✓ ok</span></div><div class="tool__args">${esc(JSON.stringify(payload.tool.args))}</div><div class="tool__res">${esc(payload.tool.result)}</div>`;
      elTools.innerHTML = '';
      elTools.appendChild(card);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'transcript:final': {
      closeAssistant(); closeThink();
      const div = document.createElement('div');
      div.className = `msg role-user`;
      div.innerHTML = `<span class="msg__tag">${esc(payload.owner ? 'owner' : payload.speaker.toLowerCase())}</span><span class="msg__body">${esc(payload.text)}</span>`;
      elStream.appendChild(div);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'ack:state': {
      if (payload.active) setStatus('▍ PROCESSING', 'var(--green)');
      else setStatus('▍ STANDBY', '');
      break;
    }
    case 'llm:dispatch': {
      closeAssistant(); closeThink(); elThink.innerHTML = '';
      elTools.innerHTML = '<span class="muted">— idle —</span>';
      setStatus('▍ PROCESSING', 'var(--green)');
      break;
    }
    case 'llm:iter': { elIter.textContent = `${payload.iter}/${payload.max}`; break; }
    case 'llm:ttft': {
      elTtft.textContent = payload.ms;
      ttftBuf.push(payload.ms); ttftBuf.shift();
      break;
    }
    case 'llm:think': {
      thinkActive = true;
      const n = ensureThink(); n.textContent += payload.text;
      elThink.scrollTop = elThink.scrollHeight;
      break;
    }
    case 'llm:tool_request': {
      closeThink(); thinkActive = false;
      const card = document.createElement('div');
      card.className = 'tool';
      const badge = payload.requiresApproval ? '<span class="tool__badge">⏵ approval</span>' : '<span class="tool__badge">⏵ run</span>';
      card.innerHTML = `<div><span class="tool__name">${esc(payload.name)}</span> ${badge}</div><div class="tool__args">${esc(JSON.stringify(payload.args))}</div>`;
      if (elTools.querySelector('.muted')) elTools.innerHTML = '';
      elTools.appendChild(card);
      activeTool = card;
      break;
    }
    case 'llm:tool_result': {
      if (activeTool) {
        const b = activeTool.querySelector('.tool__badge');
        if (b) { b.className = 'tool__badge ok'; b.textContent = '✓ ok'; }
        const res = document.createElement('div'); res.className = 'tool__res'; res.textContent = payload.result;
        activeTool.appendChild(res);
      }
      break;
    }
    case 'llm:token': {
      thinkActive = false;
      const n = ensureAssistant();
      const cur = n.querySelector('.cursor');
      const t = document.createTextNode(payload.text);
      if (cur) n.insertBefore(t, cur); else n.appendChild(t);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'llm:final': {
      closeAssistant(); thinkActive = false;
      elLast.textContent = payload.elapsedMs;
      setStatus('▍ STANDBY', '');
      break;
    }
    case 'llm:trim': {
      const note = document.createElement('div');
      note.className = 'msg role-system';
      note.innerHTML = `<span class="msg__tag">system</span><span class="msg__body">[ctx trimmed → ${payload.used} tok]</span>`;
      elStream.appendChild(note);
      break;
    }
    case 'state:tick': {
      const { stats, context } = payload;
      elToks.textContent = stats.tokPerSec.toFixed(1);
      elTtft.textContent = stats.ttft;
      elIter.textContent = `${stats.iter}/20`;
      elLast.textContent = stats.lastElapsed;
      elTurns.textContent = stats.totalTurns;
      const pct = context.used / context.budget;
      elVu.style.width = `${Math.min(100, pct * 100)}%`;
      elCtx.textContent = `${context.used.toLocaleString()} / ${context.budget.toLocaleString()} tok`;
      tokBuf.push(stats.tokPerSec); tokBuf.shift();
      break;
    }
  }
});

function clock() { elClock.textContent = new Date().toTimeString().slice(0, 8); }
setInterval(clock, 1000); clock();

// render loop for the live oscilloscope traces
function frame() {
  drawWave();
  drawEeg();
  requestAnimationFrame(frame);
}
frame();

mind.start();
