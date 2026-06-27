// Glass mockup — single mega feed that IS the context array, ordered:
//   [0] system prompt  →  [1..n] persisted history  →  [n+1] transient (this turn)
// with a live GENERATING tail (thinking → tools → streaming reply) that gets
// absorbed into history on completion. Mirrors runJarvisLoop message assembly.
// Telemetry gauges + inference-timeline scrubber sit above the feed.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));

// avatar map — mockup placeholders (real impl: client.users.fetch(id).displayAvatarURL())
const AVATARS = {
  'You (Owner)': 'https://i.pravatar.cc/72?img=12',
  You: 'https://i.pravatar.cc/72?img=12',
  Dave: 'https://i.pravatar.cc/72?img=33',
  Sam: 'https://i.pravatar.cc/72?img=51',
  Jarvis: 'https://i.pravatar.cc/72?img=68',
};
const avatarFor = (name) => AVATARS[name] || AVATARS.Jarvis;

const app = document.querySelector('.app');
const elFeed = $('feed');
const elToks = $('toks'), elCtxpct = $('ctxpct'), elCtxabs = $('ctxabs');
const elTtft = $('ttft'), elIter = $('iter'), elLast = $('last'), elTurns = $('turns');
const elStatus = $('status'), elClock = $('clock');
const elTimeline = $('timeline'), elTlCount = $('tlCount'), elTlLive = $('tlLive');
const elTlDetail = $('tlDetail'), elTlCmd = $('tlCmd'), elTlToks = $('tlToks'), elTlElapsed = $('tlElapsed'), elTlStatus = $('tlStatus');
const elGenThink = $('genThink'), elGenTools = $('genTools'), elGenReply = $('genReply');

let activeReplyText = null, activeReplyCursor = null, activeTool = null;
// view state: 'live' mirrors the live context; 'slice' freezes on a past inference.
let viewMode = 'live';
let selectedSliceId = null;
let sliceSummaries = [];
// live rolling voice window for the transient [VOICE CHANNEL] block
let voiceBuf = [];
let transFields = null;

function setThinking(on) { app.classList.toggle('is-thinking', on); }

// ── gauges ──────────────────────────────────────────────────────────────────
function drawRing(id, pct, color, size = 72) {
  const cv = $(id); const dpr = window.devicePixelRatio || 1; const s = size;
  cv.width = s * dpr; cv.height = s * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, s, s);
  const lw = 5, r = (s - lw) / 2, cx = s / 2, cy = s / 2;
  ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(120,160,220,.12)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + Math.PI*2*Math.min(1,pct)); ctx.stroke();
}

// ── collapsible sections ────────────────────────────────────────────────────
function wireToggle(secId, headId, bodyId, openByDefault) {
  const sec = $(secId);
  if (openByDefault) sec.classList.add('open');
  $(headId).addEventListener('click', () => {
    const open = sec.classList.toggle('open');
    if (bodyId) $(bodyId).hidden = !open;
  });
}
wireToggle('sysSec', 'sysToggle', 'sysBody', false);
wireToggle('histSec', 'histToggle', 'histBody', true);
wireToggle('transSec', 'transToggle', 'transBody', true);

// ── structured context window rendering ─────────────────────────────────────
function renderSystemPrompt(sp) {
  $('sysHeader').textContent = sp.header;
  $('sysRules').innerHTML = sp.rules.map((r) => `<li>${esc(r)}</li>`).join('');
  $('sysPersona').textContent = sp.persona;
  $('sysExamples').textContent = sp.examples;
  $('sysFooter').textContent = sp.footer;
  $('sysNotes').innerHTML = sp.notes.map((n) => `<li>#${n.id} ${esc(n.title)}</li>`).join('') || '<li class="muted">(none)</li>';
  $('sysSkills').innerHTML = sp.skills.map((s) => `<li class="${s.active ? 'active' : ''}">- ${esc(s.name)} — ${esc(s.desc)}${s.active ? ' [active]' : ''}</li>`).join('') || '<li class="muted">(none)</li>';
}

function renderHistory(history) {
  $('histBadge').textContent = `kept · ${history.length} msgs`;
  $('histIdx').textContent = history.length ? `[1..${history.length}]` : '[1..0]';
  const out = history.map((m) => {
    const r = m.role === 'tool' ? 'tool' : m.role;
    let preview = m.text;
    let dim = false;
    if (m.role === 'user' && preview.includes('[COMMAND]')) preview = preview.replace(/.*\[COMMAND\]\n?/, '› ');
    if (m.role === 'user' && preview.includes('[VOICE CHANNEL]')) { preview = '[voice ctx] …'; dim = true; }
    if (preview.length > 220) preview = preview.slice(0, 220) + '…';
    return `<div class="hist__msg r-${r}"><span class="hist__role">${esc(m.name || r)}</span><span class="hist__txt ${dim ? 'dim' : ''}">${esc(preview)}</span></div>`;
  }).join('');
  $('hist').innerHTML = out || '<div class="hist__empty muted">(empty — first turn)</div>';
}

function renderTransient() {
  if (!transFields && voiceBuf.length === 0) {
    $('trans').innerHTML = '<span class="muted">— idle, no active turn —</span>';
    return;
  }
  const voice = voiceBuf.map((v) => `<div class="trans__vline ${v.owner ? 'owner' : ''}"><span class="ts">${esc(v.mmss)}</span><span class="who ${v.owner ? 'owner' : ''}">${esc(v.name)}:</span><span class="txt">${esc(v.text)}</span></div>`).join('');
  const fields = transFields
    ? `<div class="trans__line"><b>Current time:</b> ${esc(transFields.time)}</div>
       <div class="trans__label">[VOICE CHANNEL] · members: ${esc((transFields.members || []).join(', '))}</div>`
    : `<div class="trans__label">[VOICE CHANNEL]</div>`;
  const cmd = transFields && transFields.command
    ? `<div class="trans__cmd"><b>[COMMAND]</b> ${esc(transFields.command)}</div>` : '';
  $('trans').innerHTML = `${fields}<div class="trans__voice">${voice || '<span class="muted">(silent)</span>'}</div>${cmd}`;
}

function setTransient(t) {
  transFields = t;
  if (t) { voiceBuf = (t.voiceCtx || []).map((v) => ({ ...v })); }
  renderTransient();
}

// ── generating block (in-flight reply that will persist on completion) ──────
function resetGen() {
  activeReplyText = null; activeReplyCursor = null; activeTool = null;
  elGenThink.innerHTML = '<span class="muted">— idle · no active generation —</span>';
  elGenTools.innerHTML = '';
  elGenReply.innerHTML = '';
}

function ensureThink() {
  if (elGenThink.querySelector('.muted')) elGenThink.innerHTML = '';
  return elGenThink;
}
function ensureReply() {
  if (activeReplyText) return activeReplyText;
  const div = document.createElement('div'); div.className = 'gen__replymsg';
  div.innerHTML = `<img class="gen__avatar" src="${avatarFor('Jarvis')}" alt="" onerror="this.style.visibility='hidden'"><div class="gen__replybody"><div class="gen__who"><span class="gen__name">Jarvis</span><span class="gen__badge">streaming</span></div><div class="gen__text"></div></div>`;
  elGenReply.appendChild(div);
  activeReplyText = div.querySelector('.gen__text');
  const cur = document.createElement('span'); cur.className = 'cursor'; activeReplyText.appendChild(cur);
  activeReplyCursor = cur;
  return activeReplyText;
}
function closeReply() { if (activeReplyCursor) { activeReplyCursor.remove(); activeReplyCursor = null; } }

// scroll the feed so the generating tail stays in view while streaming
function stickToBottom() {
  elFeed.scrollTop = elFeed.scrollHeight;
}

// ── timeline rendering ───────────────────────────────────────────────────────
function renderTimeline() {
  if (sliceSummaries.length === 0) {
    elTimeline.innerHTML = '<div class="tl-empty muted">no inferences yet</div>';
    elTlCount.textContent = '0 slices';
    return;
  }
  elTlCount.textContent = `${sliceSummaries.length} slice${sliceSummaries.length === 1 ? '' : 's'}`;
  let html = '<div class="tl-axis"></div>';
  for (const s of sliceSummaries) {
    const cls = `tl-marker ${s.status} ${s.hadTool ? 'tool' : ''} ${selectedSliceId === s.id ? 'selected' : ''}`;
    const label = `#${s.id} ${s.tokPerSec ? s.tokPerSec.toFixed(0) + 't/s' : '…'}`;
    html += `<div class="${cls}" data-id="${s.id}" title="${esc(s.command)}">
      <div class="tl-marker__dot"></div><div class="tl-marker__label">${label}</div></div>`;
  }
  elTimeline.innerHTML = html;
  elTimeline.querySelectorAll('.tl-marker').forEach((m) => {
    m.addEventListener('click', () => {
      const id = parseInt(m.dataset.id, 10);
      mind.selectSlice(id);
    });
  });
  // auto-scroll so the latest marker is visible
  requestAnimationFrame(() => { elTimeline.scrollLeft = elTimeline.scrollWidth; });
}

function showSliceDetail(s) {
  elTlDetail.hidden = false;
  elTlCmd.textContent = s.command;
  elTlToks.textContent = s.tokPerSec ? `${s.tokPerSec.toFixed(0)} tok/s` : '—';
  elTlElapsed.textContent = s.elapsedMs ? `${s.elapsedMs} ms` : '—';
  elTlStatus.textContent = s.status === 'done' ? 'completed' : s.status === 'pending' ? 'in flight' : s.status;
}

function setViewMode(mode) {
  viewMode = mode;
  app.classList.toggle('is-scrubbing', mode === 'slice');
  if (mode === 'live') {
    selectedSliceId = null;
    elTlDetail.hidden = true;
    elTlLive.innerHTML = '● LIVE';
    $('ctxmeta').textContent = 'what jarvis sees · live';
  } else {
    elTlLive.innerHTML = '▸ GO LIVE';
    $('ctxmeta').textContent = 'frozen on inference slice';
  }
}

elTlLive.addEventListener('click', () => { mind.selectSlice(null); });

// ── live voice lines land directly in the transient [VOICE CHANNEL] block ──
function pushVoice({ name, owner, text }) {
  const now = new Date();
  const mmss = `${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  voiceBuf.push({ mmss, name, owner, text });
  while (voiceBuf.length > 24) voiceBuf.shift();
  renderTransient();
}

const mind = new FakeMind();

mind.on(({ type, payload }) => {
  switch (type) {
    case 'mind:context': {
      if (viewMode === 'slice') break; // frozen on a past slice
      renderSystemPrompt(payload.systemPrompt);
      renderHistory(payload.history);
      setTransient(payload.transient);
      if (payload.transient) {
        const ts = $('transSec');
        ts.classList.remove('flash'); void ts.offsetWidth; ts.classList.add('flash');
      }
      break;
    }
    case 'mind:slice': {
      sliceSummaries = payload.slices;
      renderTimeline();
      break;
    }
    case 'mind:slice:update': {
      const s = payload.slice;
      const idx = sliceSummaries.findIndex((x) => x.id === s.id);
      if (idx >= 0) sliceSummaries[idx] = s;
      renderTimeline();
      if (viewMode === 'slice' && selectedSliceId === s.id) showSliceDetail(s);
      break;
    }
    case 'mind:timeline': {
      if (payload.selected === null) {
        setViewMode('live');
        renderTimeline();
      } else {
        selectedSliceId = payload.selected;
        setViewMode('slice');
        renderSystemPrompt(payload.snapshot.systemPrompt);
        renderHistory(payload.snapshot.history);
        setTransient(payload.snapshot.transient);
        showSliceDetail(payload.summary);
        renderTimeline();
      }
      break;
    }
    case 'seed': {
      // history + transient arrive via mind:context (emitted next); nothing to seed here
      break;
    }
    case 'transcript:final': {
      if (viewMode === 'slice') break; // keep the frozen transient intact
      pushVoice({ name: payload.speaker, owner: payload.owner, text: payload.text });
      break;
    }
    case 'ack:state': { setThinking(payload.active); break; }
    case 'llm:dispatch': {
      resetGen();
      setThinking(true);
      stickToBottom();
      break;
    }
    case 'llm:iter': { elIter.textContent = payload.iter; break; }
    case 'llm:ttft': { elTtft.textContent = payload.ms; break; }
    case 'llm:think': {
      if (elGenThink.querySelector('.muted')) elGenThink.innerHTML = '';
      ensureThink().append(document.createTextNode(payload.text));
      elGenThink.scrollTop = elGenThink.scrollHeight;
      stickToBottom();
      break;
    }
    case 'llm:tool_request': {
      const card = document.createElement('div'); card.className = 'tool';
      const badge = payload.requiresApproval ? '<span class="tool__badge pending">approval</span>' : '<span class="tool__badge pending">running</span>';
      card.innerHTML = `<div class="tool__head"><span class="tool__name">${esc(payload.name)}</span>${badge}</div><div class="tool__args">${esc(JSON.stringify(payload.args))}</div>`;
      elGenTools.appendChild(card);
      activeTool = card;
      stickToBottom();
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
      if (elGenThink.querySelector('.muted')) elGenThink.innerHTML = '';
      const n = ensureReply();
      const t = document.createTextNode(payload.text);
      if (activeReplyCursor) n.insertBefore(t, activeReplyCursor); else n.appendChild(t);
      stickToBottom();
      break;
    }
    case 'llm:final': {
      // the reply is absorbed into persisted history via the next mind:context;
      // clear the generating tail so it isn't shown twice.
      closeReply();
      setTimeout(() => { resetGen(); }, 700);
      elLast.textContent = payload.elapsedMs;
      setThinking(false);
      break;
    }
    case 'llm:trim': {
      // note the trim inside history is reflected by the next mind:context render
      break;
    }
    case 'state:tick': {
      const { stats, context } = payload;
      elToks.textContent = stats.tokPerSec.toFixed(1);
      elTurns.textContent = stats.totalTurns;
      elIter.textContent = stats.iter;
      const pct = context.used / context.budget;
      elCtxpct.textContent = `${(pct * 100).toFixed(1)}%`;
      elCtxabs.textContent = `${context.used.toLocaleString()}/${Math.round(context.budget/1000)}k`;
      $('ctxFill').style.width = `${Math.min(100, pct * 100).toFixed(1)}%`;
      drawRing('ringToks', stats.tokPerSec / 90, '#ffb454');
      drawRing('ringCtx', pct, '#5cc8ff');
      break;
    }
  }
});

function clock() { elClock.textContent = new Date().toTimeString().slice(0, 8); }
setInterval(clock, 1000); clock();
mind.start();
