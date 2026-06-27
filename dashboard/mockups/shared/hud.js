const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));

const elStream = $('stream'), elTrace = $('trace'), elTools = $('tools');
const elToks = $('toks'), elCtxpct = $('ctxpct'), elCtxabs = $('ctxabs');
const elTtft = $('ttft'), elLast = $('last'), elTurns = $('turns'), elIter = $('iter');
const elStatus = $('status'), elStatusCard = $('statusCard'), elBackend = $('backend');

let activeAssistant = null;
let activeThink = null;
let activeTool = null;

const sparkTtft = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  542,498,610,0,0,0,0,0,0,0,560];

function setState(state, text) {
  elStatusCard.dataset.state = state;
  elStatus.innerHTML = `<span class="led"></span> ${text}`;
}

function avatar(role, who) {
  const label = role === 'assistant' ? 'J' : role === 'tool' ? 'T' : role === 'system' ? '!' : (who || '?').slice(0,1).toUpperCase();
  return `<span class="msg__avatar">${esc(label)}</span>`;
}

function ensureAssistant() {
  if (activeAssistant) return activeAssistant.querySelector('.msg__text');
  const div = document.createElement('div');
  div.className = 'msg role-assistant';
  div.innerHTML = `${avatar('assistant')}<div class="msg__body"><div class="msg__who">JARVIS</div><div class="msg__text"></div></div>`;
  elStream.appendChild(div);
  const body = div.querySelector('.msg__text');
  const cur = document.createElement('span'); cur.className = 'cursor'; body.appendChild(cur);
  activeAssistant = div;
  elStream.scrollTop = elStream.scrollHeight;
  return body;
}
function closeAssistant() {
  if (activeAssistant) { const c = activeAssistant.querySelector('.cursor'); if (c) c.remove(); activeAssistant = null; }
}
function ensureThink() {
  if (activeThink) return activeThink;
  const c = elTrace.querySelector('.cursor'); if (c) c.remove();
  const span = document.createElement('span'); elTrace.appendChild(span);
  activeThink = span;
  const cur = document.createElement('span'); cur.className = 'cursor'; elTrace.appendChild(cur);
  return span;
}
function closeThink() {
  if (activeThink) { const c = elTrace.querySelector('.cursor'); if (c) c.remove(); activeThink = null; }
}

function drawRing(canvasId, pct, color) {
  const cv = document.getElementById(canvasId).querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const size = 120;
  cv.width = size * dpr; cv.height = size * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);
  const lw = 8, r = (size - lw) / 2, cx = size / 2, cy = size / 2;
  ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(86,180,233,.12)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, pct));
  ctx.stroke();
}

function drawSpark(id, data, color) {
  const cv = $(id); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 200;
  cv.width = w * dpr; cv.height = 34 * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, 34);
  const max = Math.max(900, ...data);
  ctx.strokeStyle = color; ctx.lineWidth = 1.4;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = 30 - (v / max) * 26 - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.lineTo(w, 30); ctx.lineTo(0, 30); ctx.closePath();
  ctx.fillStyle = color.replace(')', ',.12)').replace('rgb', 'rgba');
  ctx.fill();
}

const mind = new FakeMind();
mind.on(({ type, payload }) => {
  switch (type) {
    case 'seed': {
      const a = document.createElement('div');
      a.className = 'msg role-assistant';
      a.innerHTML = `${avatar('assistant')}<div class="msg__body"><div class="msg__who">JARVIS</div><div class="msg__text">${esc(payload.assistant)}</div></div>`;
      elStream.appendChild(a);
      const t = document.createElement('span');
      t.textContent = payload.trace;
      elTrace.appendChild(t);
      const card = document.createElement('div');
      card.className = 'tool';
      card.innerHTML = `<div class="tool__head"><span class="tool__name">${esc(payload.tool.name)}</span><span class="tool__badge ok">done</span></div><div class="tool__args">${esc(JSON.stringify(payload.tool.args, null, 0))}</div><div class="tool__res">${esc(payload.tool.result)}</div>`;
      elTools.innerHTML = '';
      elTools.appendChild(card);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'transcript:final': {
      closeAssistant(); closeThink();
      const who = payload.owner ? payload.speaker + ' (owner)' : payload.speaker;
      const div = document.createElement('div');
      div.className = `msg role-user ${payload.owner ? 'owner' : ''}`;
      div.innerHTML = `${avatar('user', payload.speaker)}<div class="msg__body"><div class="msg__who">${esc(who)}</div><div class="msg__text">${esc(payload.text)}</div></div>`;
      elStream.appendChild(div);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'ack:state': {
      if (payload.active) setState('thinking', 'PROCESSING');
      else setState('idle', 'IDLE');
      break;
    }
    case 'llm:dispatch': {
      closeAssistant(); closeThink(); elTrace.innerHTML = '';
      elTools.innerHTML = '<span class="muted">no active calls</span>';
      elBackend.textContent = `${payload.backend} · ${payload.model}`;
      setState('thinking', 'PROCESSING');
      break;
    }
    case 'llm:iter': { elIter.innerHTML = `${payload.iter}<span>/${payload.max}</span>`; break; }
    case 'llm:ttft': {
      elTtft.innerHTML = `${payload.ms}<span>ms</span>`;
      sparkTtft.push(payload.ms); sparkTtft.shift();
      drawSpark('sparkTtft', sparkTtft, 'rgb(240,160,64)');
      break;
    }
    case 'llm:think': {
      const n = ensureThink(); n.textContent += payload.text;
      elTrace.scrollTop = elTrace.scrollHeight;
      break;
    }
    case 'llm:tool_request': {
      closeThink();
      const card = document.createElement('div');
      card.className = 'tool';
      const badge = payload.requiresApproval ? '<span class="tool__badge pending">approval</span>' : '<span class="tool__badge pending">running</span>';
      card.innerHTML = `<div class="tool__head"><span class="tool__name">${esc(payload.name)}</span>${badge}</div><div class="tool__args">${esc(JSON.stringify(payload.args, null, 0))}</div>`;
      if (elTools.querySelector('.muted')) elTools.innerHTML = '';
      elTools.appendChild(card);
      activeTool = card;
      break;
    }
    case 'llm:tool_result': {
      if (activeTool) {
        const b = activeTool.querySelector('.tool__badge');
        if (b) { b.className = 'tool__badge ok'; b.textContent = 'done'; }
        const res = document.createElement('div'); res.className = 'tool__res'; res.textContent = payload.result;
        activeTool.appendChild(res);
      }
      break;
    }
    case 'llm:token': {
      const n = ensureAssistant();
      const cur = n.querySelector('.cursor');
      const t = document.createTextNode(payload.text);
      if (cur) n.insertBefore(t, cur); else n.appendChild(t);
      elStream.scrollTop = elStream.scrollHeight;
      break;
    }
    case 'llm:final': {
      closeAssistant();
      elLast.innerHTML = `${payload.elapsedMs}<span>ms</span>`;
      break;
    }
    case 'llm:trim': {
      const note = document.createElement('div');
      note.className = 'msg role-system';
      note.innerHTML = `${avatar('system')}<div class="msg__body"><div class="msg__who">system</div><div class="msg__text">context trimmed → ${payload.used} tok</div></div>`;
      elStream.appendChild(note);
      break;
    }
    case 'state:tick': {
      const { stats, context } = payload;
      elToks.textContent = stats.tokPerSec.toFixed(1);
      elTtft.innerHTML = `${stats.ttft}<span>ms</span>`;
      elLast.innerHTML = `${stats.lastElapsed}<span>ms</span>`;
      elIter.innerHTML = `${stats.iter}<span>/20</span>`;
      const pct = context.used / context.budget;
      elCtxpct.textContent = `${(pct * 100).toFixed(1)}%`;
      elCtxabs.textContent = `${context.used.toLocaleString()} / ${Math.round(context.budget/1000)}k`;
      elTurns.textContent = `${stats.totalTurns} turns`;
      drawRing('ringToks', stats.tokPerSec / 90, '#f0a040');
      drawRing('ringCtx', pct, '#56b4e9');
      drawSpark('sparkTtft', sparkTtft, 'rgb(240,160,64)');
      break;
    }
  }
});

function clock() { $('clock').textContent = new Date().toTimeString().slice(0, 8); }
setInterval(clock, 1000); clock();
mind.start();
