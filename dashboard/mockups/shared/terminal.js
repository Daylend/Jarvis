const $ = (id) => document.getElementById(id);
const elStream = $('stream');
const elTrace = $('trace');
const elToks = $('toks');
const elTtft = $('ttft');
const elIter = $('iter');
const elLast = $('last');
const elTurns = $('turns');
const elGauge = $('gauge');
const elCtx = $('ctxlabel');
const elTools = $('tools');
const elStatus = $('status');
const elClock = $('clock');
const elSess = $('sess');

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));

// in-flight assistant message being streamed
let activeAssistant = null;
// in-flight tool card for the current iteration
let activeTool = null;
let activeThink = null;

function status(text, color = '') {
  elStatus.textContent = text;
  elStatus.style.color = color || '';
}

function ensureAssistant() {
  if (activeAssistant) return activeAssistant;
  const div = document.createElement('div');
  div.className = 'msg role-assistant';
  div.innerHTML = '<span class="msg__role">assistant</span><span class="msg__body"></span>';
  elStream.appendChild(div);
  activeAssistant = div.querySelector('.msg__body');
  // cursor
  const cur = document.createElement('span');
  cur.className = 'cursor';
  activeAssistant.appendChild(cur);
  elStream.scrollTop = elStream.scrollHeight;
  return activeAssistant;
}

function closeAssistant() {
  if (activeAssistant) {
    const cur = activeAssistant.querySelector('.cursor');
    if (cur) cur.remove();
    activeAssistant = null;
  }
}

function ensureThink() {
  if (activeThink) return activeThink;
  const cur = elTrace.querySelector('.cursor');
  if (cur) cur.remove();
  const span = document.createElement('span');
  elTrace.appendChild(span);
  activeThink = span;
  const c = document.createElement('span');
  c.className = 'cursor';
  elTrace.appendChild(c);
  return activeThink;
}
function closeThink() {
  if (activeThink) {
    const cur = elTrace.querySelector('.cursor');
    if (cur) cur.remove();
    activeThink = null;
  }
}

// pre-fill sparkline with a decayed recent-turn shape so it's not flat at rest
const sparkData = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  62,71,68,70,66,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,58,64,71,69,72,0,0,0,0,0];
const MAX_ITER = 20;
function drawSpark() {
  const cv = $('spark');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 260;
  cv.width = w * dpr; cv.height = 42 * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, 42);
  ctx.strokeStyle = '#ffb000';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const max = Math.max(90, ...sparkData);
  sparkData.forEach((v, i) => {
    const x = (i / (sparkData.length - 1)) * w;
    const y = 40 - (v / max) * 36 - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // baseline
  ctx.strokeStyle = 'rgba(255,176,0,.2)';
  ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(w, 40); ctx.stroke();
}

const mind = new FakeMind();
mind.on((evt) => {
  const { type, payload } = evt;
  switch (type) {
    case 'seed': {
      // completed assistant reply (no cursor)
      const a = document.createElement('div');
      a.className = 'msg role-assistant';
      a.innerHTML = `<span class="msg__role">assistant</span><span class="msg__body">${esc(payload.assistant)}</span>`;
      elStream.appendChild(a);
      // thinking trace (dimmed, no cursor)
      const t = document.createElement('span');
      t.textContent = payload.trace;
      elTrace.appendChild(t);
      // completed tool card
      const card = document.createElement('div');
      card.className = 'tool';
      card.innerHTML = `<div class="tool__name">${esc(payload.tool.name)}</div><div class="tool__args">${esc(JSON.stringify(payload.tool.args))}</div><span class="tool__ok">✓ ok</span><div class="tool__res">${esc(payload.tool.result)}</div>`;
      elTools.innerHTML = '';
      elTools.appendChild(card);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'transcript:final': {
      closeAssistant(); closeThink();
      const cls = payload.owner ? 'role-user' : 'role-user';
      const div = document.createElement('div');
      div.className = `msg ${cls}`;
      div.innerHTML = `<span class="msg__role">${esc(payload.owner ? 'owner' : payload.speaker.toLowerCase())}</span><span class="msg__body">${esc(payload.text)}</span>`;
      elStream.appendChild(div);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'ack:state': {
      if (payload.active) status('● THINKING', 'var(--ok)');
      else status('● IDLE');
      break;
    }
    case 'llm:dispatch': {
      closeAssistant(); closeThink();
      elTrace.innerHTML = '';
      elTools.innerHTML = '<span class="muted">— none —</span>';
      status('● THINKING', 'var(--ok)');
      break;
    }
    case 'llm:iter': {
      elIter.textContent = `${payload.iter}/${payload.max}`;
      break;
    }
    case 'llm:ttft': {
      elTtft.textContent = `${payload.ms} ms`;
      break;
    }
    case 'llm:think': {
      const node = ensureThink();
      node.textContent += payload.text;
      elTrace.scrollTop = elTrace.scrollHeight;
      break;
    }
    case 'llm:tool_request': {
      closeThink();
      const card = document.createElement('div');
      card.className = 'tool';
      const pending = payload.requiresApproval ? '<span class="tool__pending">⏵ awaiting approval</span>' : '<span class="tool__pending">⏵ running…</span>';
      card.innerHTML = `<div class="tool__name">${esc(payload.name)}</div><div class="tool__args">${esc(JSON.stringify(payload.args))}</div>${pending}`;
      if (elTools.querySelector('.muted')) elTools.innerHTML = '';
      elTools.appendChild(card);
      activeTool = card;
      break;
    }
    case 'llm:tool_result': {
      if (activeTool) {
        const pen = activeTool.querySelector('.tool__pending');
        if (pen) pen.outerHTML = `<span class="tool__ok">✓ ok</span>`;
        const res = document.createElement('div');
        res.className = 'tool__res';
        res.textContent = payload.result;
        activeTool.appendChild(res);
      }
      break;
    }
    case 'llm:token': {
      const node = ensureAssistant();
      const cur = node.querySelector('.cursor');
      const t = document.createTextNode(payload.text);
      if (cur) node.insertBefore(t, cur); else node.appendChild(t);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'llm:final': {
      closeAssistant();
      elToks.textContent = payload.tokPerSec.toFixed(1);
      elLast.textContent = `${payload.elapsedMs} ms`;
      status('● IDLE');
      break;
    }
    case 'llm:trim': {
      const note = document.createElement('div');
      note.className = 'msg role-system';
      note.innerHTML = `<span class="msg__role">system</span><span class="msg__body">[ctx trimmed → ${payload.used} tok]</span>`;
      elStream.appendChild(note);
      break;
    }
    case 'state:tick': {
      const { stats, context } = payload;
      elToks.textContent = stats.tokPerSec.toFixed(1);
      elTurns.textContent = stats.totalTurns;
      elTtft.textContent = `${stats.ttft} ms`;
      elIter.textContent = `${stats.iter}/${MAX_ITER}`;
      elLast.textContent = `${stats.lastElapsed} ms`;
      const pct = (context.used / context.budget) * 100;
      elGauge.style.width = `${Math.min(100, pct)}%`;
      elCtx.textContent = `${context.used.toLocaleString()} / ${context.budget.toLocaleString()} tok (${pct.toFixed(2)}%)`;
      sparkData.push(stats.tokPerSec); sparkData.shift();
      drawSpark();
      break;
    }
  }
});

// clock
function tickClock() {
  const d = new Date();
  elClock.textContent = d.toTimeString().slice(0, 8);
}
setInterval(tickClock, 1000); tickClock();

mind.start();
