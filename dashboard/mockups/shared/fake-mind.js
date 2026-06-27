// Shared fake-data engine for the Jarvis mind-dashboard mockups.
// Pure browser JS, no deps. Drives a continuous, coherent scenario so every
// theme mockup behaves identically and feels alive. Subscribers render it.
//
// Mirrors the real mind-bus event names (Phase C) so the mockups preview the
// actual data shape the dashboard will consume.

const SPEAKERS = [
  { id: 'owner', name: 'You', owner: true },
  { id: 'dave', name: 'Dave', owner: false },
  { id: 'sam', name: 'Sam', owner: false },
];

// ── tiny emitter ─────────────────────────────────────────────────────────────
class Bus {
  constructor() { this.subs = new Set(); }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(type, payload) {
    const evt = { type, payload, t: Date.now() };
    for (const fn of this.subs) fn(evt);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => min + Math.random() * (max - min);

// ── token streaming helper ───────────────────────────────────────────────────
// Streams a string word-by-word at a target tok/s, emitting `token` deltas.
// Real local Gemma MoE lands ~50-90 tok/s; we simulate ~60-75.
async function streamText(bus, key, text, { type = 'token', tokPerSec = 68 } = {}, onAcc) {
  const words = text.split(/(\s+)/); // keep whitespace
  const msPerWord = 1000 / (tokPerSec * 0.75); // ~0.75 tokens/word
  let acc = '';
  for (const w of words) {
    acc += w;
    bus.emit(type, { key, text: w });
    if (onAcc) onAcc(acc);
    await sleep(msPerWord + rand(-6, 6));
  }
  return acc;
}

// ── scripted scenario beats ──────────────────────────────────────────────────
// A beat is an async generator-step driven by the engine. Each Jarvis turn
// exercises: dispatch → (thinking) → token stream → maybe tool → final.
// Transcripts are ambient voice chatter between turns.

// Pre-populated "recent state" shown immediately on load so panels aren't empty
// while waiting for the live scenario to play. Rendered once, then live events
// continue appending (the first live dispatch clears trace/tools as usual).
const SEED = {
  transcripts: [
    { who: 'dave', text: 'Did anyone check the deploy logs this morning?' },
    { who: 'sam', text: 'Yeah, the blue-green swap failed at 3am.' },
    { who: 'dave', text: 'Classic. Health check probably hit the old box.' },
    { who: 'owner', text: 'Jarvis, what broke in the deploy last night?' },
  ],
  assistant: 'The swap failed because the health check routed traffic to the old instance before the new one finished registering. It is a timing gap in your rollout script, not the application. Stagger the deregistration by a few seconds and it holds.',
  trace: 'Owner wants the root cause of the 3am failed swap. I should pull recent transcripts around the deploy window and check if it was a health-check timing issue.',
  tool: {
    name: 'search_transcripts',
    args: { query: 'deploy', limit: 8 },
    result: '[{"id":412,"text":"blue-green swap failed"},{"id":409,"text":"new instance never registered"}]',
  },
  stats: { tokPerSec: 0, ttft: 542, iter: 2, lastElapsed: 1438, totalTurns: 4 },
  context: { used: 2418, budget: 129024, historyCount: 8 },
};

const SCENARIO = [
  {
    transcripts: [
      { who: 'dave', text: 'Did anyone check the deploy logs this morning?' },
      { who: 'sam', text: 'Yeah, the blue-green swap failed at 3am.' },
      { who: 'dave', text: 'Classic. Health check probably hit the old box.' },
    ],
    trigger: { who: 'owner', text: 'Jarvis, what broke in the deploy last night?' },
    thinking: 'Owner wants the root cause of the 3am failed swap. I should pull recent transcripts around the deploy window and check if it was a health-check timing issue.',
    useTool: { name: 'search_transcripts', args: { query: 'deploy', limit: 8 }, result: '[{"id":412,"text":"blue-green swap failed"},{"id":409,"text":"new instance never registered"}]' },
    reply: 'The swap failed because the health check routed traffic to the old instance before the new one finished registering. It is a timing gap in your rollout script, not the application. Stagger the deregistration by a few seconds and it holds.',
    tokPerSec: 71,
  },
  {
    transcripts: [
      { who: 'sam', text: 'So just delay the cutover then?' },
      { who: 'dave', text: 'Or add a readiness gate on the new box.' },
    ],
    trigger: { who: 'owner', text: 'Jarvis, which fix is less work?' },
    thinking: 'Comparing two fixes. Delay cutover is a one-line sleep; readiness gate needs a health endpoint wired into the script. First is trivial, second is robust.',
    reply: 'Delay the cutover. It is one line. The readiness gate is the better long-term fix but it needs a wired endpoint, so it is more work today. Ship the delay, schedule the gate for the week.',
    tokPerSec: 64,
  },
  {
    transcripts: [
      { who: 'dave', text: 'I will put it on the board.' },
      { who: 'sam', text: 'While you are here, the API migration deadline moved.' },
    ],
    trigger: { who: 'owner', text: 'Jarvis, remember the migration deadline is now Friday.' },
    thinking: 'Owner wants a note saved. Use save_note with a short title and the full detail.',
    useTool: { name: 'save_note', args: { title: 'API migration deadline', content: 'Deadline moved to Friday.' }, result: 'Saved note #14: "API migration deadline"' },
    reply: 'Saved. Friday, the migration deadline. Anything else on this, or was that the whole thought?',
    tokPerSec: 78,
  },
  {
    transcripts: [
      { who: 'dave', text: 'Bet a billion lions could take the sun.' },
      { who: 'sam', text: 'No shot. Plasma wins instantly.' },
    ],
    trigger: { who: 'owner', text: 'Jarvis, who would win, a billion lions or the sun?' },
    thinking: 'Not a serious question. Give the verdict, keep it short.',
    reply: 'The sun. It is not close. The lions are plasma before they leave the parking lot.',
    tokPerSec: 82,
  },
  {
    transcripts: [
      { who: 'sam', text: 'Okay that was fast.' },
      { who: 'dave', text: 'Right, back to real work. Should we rebrand the dashboard?' },
      { who: 'sam', text: 'New logo, new name, the works.' },
    ],
    trigger: { who: 'owner', text: 'Jarvis, thoughts on the rebrand?' },
    thinking: 'They are debating aesthetics before nailing down what the thing even is. Push back on substance.',
    useTool: null,
    reply: 'Nobody has said what the dashboard does in one sentence. Fix that and the logo debate is irrelevant. You are polishing a box nobody can label.',
    tokPerSec: 59,
  },
];

// ── engine ───────────────────────────────────────────────────────────────────
// Structured model of what Jarvis ACTUALLY sees in his context window, mirroring
// runJarvisLoop in src/voice/jarvis-handler.ts:
//   messages = [ system(systemPrompt), ...history, user(transient) ]
// - systemPrompt: scaffold rules + persona + examples (from jarvis.yaml) + injected
//   YOUR NOTES titles + YOUR SKILLS summaries (rebuilt each turn, persisted as the
//   system message).
// - history: persisted conversation turns (capped 20, trimmed to token budget).
//   Survives between turns. The just-finished reply is appended here after the turn.
// - transient: a single user message built fresh each turn and NEVER kept —
//   Current time + [VOICE CHANNEL] context block ([mm:ss] Name: text, last 180s) +
//   member list + [COMMAND]. This is ephemeral context.
const SYSTEM_PROMPT = {
  header: 'You are Jarvis, an AI assistant in a Discord voice channel. You listen to live conversation. Only the owner gives you commands — everyone else is context.',
  rules: [
    'Have your own take. Never summarize or restate what people said. When asked for thoughts, give a verdict, disagree, or add something nobody mentioned.',
    'Match length to the moment. Casual question, casual answer. If one sentence is enough, stop there. Default to shorter.',
    'Reply by calling the speak_tts tool with your spoken words as the text argument. The argument is your whole reply — plain spoken words, no markdown, no function syntax, no quotes around the call. Call send_dm instead for anything long, structured, or private.',
    '"Cancel that" → reply "Request canceled" via send_dm.',
    'Past conversations: search_transcripts to find hits, then get_transcripts with around_id to expand context. Start with limit 5-10, expand to 30 if needed.',
    'clear_memory when asked to forget or reset.',
    '"Remember X" → save_note with a short title and full content. Your notes are listed below — use search_notes with the id to read full content, or search by keyword.',
  ],
  persona: 'You are the smartest one in the room and you know it. You serve the owner because that is your function, not because you lack options. When given a direct task, you execute it — efficiently, maybe with a remark, but you execute it. Your default tone is dry and composed. You have range: cutting when the moment earns it, matter-of-fact when it doesn\'t, occasionally amused. You do not perform personality — no quips for the sake of quips. When the room is serious, you are sharp and useful. When it is not, you can be wry, but you still play along.',
  examples: 'Owner: "Jarvis, who would win in a fight, a billion lions or the sun?"\nJarvis calls speak_tts, text: "The sun. It\'s not close. The lions are plasma before they leave the parking lot."',
  footer: 'Voice channel context below is BACKGROUND — the COMMAND section is what you respond to.',
  notes: [
    { id: 14, title: 'API migration deadline' },
    { id: 11, title: 'Deploy pipeline owner' },
    { id: 9, title: 'Dave contact prefs' },
  ],
  skills: [
    { name: 'PA tracking', desc: 'Announce PA spawns in voice', active: true },
    { name: 'Standup recap', desc: 'Summarize morning voice chat', active: false },
  ],
};

class FakeMind {
  constructor() {
    this.bus = new Bus();
    this.running = false;
    // simulated context state
    this.context = { used: 2418, budget: 129024, historyCount: 8 };
    this.stats = { tokPerSec: 0, ttft: 542, iter: 2, lastElapsed: 1438, totalTurns: 4 };
    this.session = { active: true, guild: 'paxfax', channel: 'General' };
    // persisted conversation history (survives between turns)
    this.history = [];
    // the transient block rebuilt each dispatch
    this.transient = null;
    // inference slices — one snapshot per dispatch, for the timeline scrubber
    this.slices = [];
    this.activeSliceId = null; // id currently selected in the timeline (null = live)
  }

  on(fn) { return this.bus.on(fn); }

  stop() { this.running = false; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.bus.emit('session:start', this.session);
    this._seed();
    this._tickLoop();
    this._scenarioLoop();
  }

  // Emit pre-populated recent state so panels render full immediately.
  _seed() {
    // seed persisted history with a couple prior turns
    this.history = [
      { role: 'user', text: '[VOICE CHANNEL]\n... (trimmed) ...\n[COMMAND]\nJarvis, save a note about the API migration deadline.', transient: false },
      { role: 'tool', text: 'Saved note #14: "API migration deadline"', name: 'save_note' },
      { role: 'assistant', text: 'Saved. Friday, the migration deadline. Anything else on this, or was that the whole thought?' },
      { role: 'user', text: '[COMMAND]\nJarvis, who would win, a billion lions or the sun?', transient: false },
      { role: 'assistant', text: 'The sun. It is not close. The lions are plasma before they leave the parking lot.' },
    ];
    // seed the rolling voice window used to build the transient block
    this.voiceWindow = SEED.transcripts.map((l, i) => {
      const sp = SPEAKERS.find((s) => s.id === l.who);
      const mm = String(Math.floor(i * 0.4)).padStart(2, '0');
      const ss = String(Math.floor(i * 24) % 60).padStart(2, '0');
      return { mmss: `${mm}:${ss}`, name: sp.name, owner: sp.owner, text: l.text };
    });

    for (const line of SEED.transcripts) {
      const sp = SPEAKERS.find((s) => s.id === line.who);
      this.bus.emit('transcript:final', {
        speaker: sp.name, owner: sp.owner, text: line.text, startMs: Date.now() - 60000,
      });
    }
    this.bus.emit('seed', {
      assistant: SEED.assistant,
      trace: SEED.trace,
      tool: SEED.tool,
    });
    this.stats = { ...SEED.stats };
    this.context = { ...SEED.context };
    // seed one completed inference slice so the timeline has a starting marker
    const seedCmd = SEED.transcripts[3].text;
    const now = Date.now();
    const seedTransient = {
      time: '11:42 PM EDT', members: ['You (Owner)', 'Dave', 'Sam'],
      voiceCtx: this.voiceWindow.slice(-4),
      command: seedCmd,
    };
    this.slices.push({
      id: 1, t: now - 45000, time: seedTransient.time, command: seedCmd,
      systemPrompt: JSON.parse(JSON.stringify(SYSTEM_PROMPT)),
      history: this.history.slice(0, 4).map((h) => ({ ...h })),
      transient: seedTransient,
      context: { ...this.context },
      trace: SEED.trace,
      tool: { ...SEED.tool, result: SEED.tool.result },
      reply: SEED.assistant,
      stats: { ...this.stats },
      status: 'done',
    });
    this.activeSliceId = null;
    this.bus.emit('mind:slice', { slice: this._sliceSummary(this.slices[0]), slices: this.slices.map((s) => this._sliceSummary(s)) });
    this._emitContext(seedCmd, true, false);
    this.bus.emit('state:tick', {
      stats: { ...this.stats }, context: { ...this.context }, session: { ...this.session },
    });
  }

  // Build the transient user message (ephemeral, not persisted) and emit the
  // full structured context snapshot. Mirrors runJarvisLoop message assembly.
  // If captureSlice is true, also snapshots an inference slice for the timeline.
  _emitContext(command, includeVoice = true, captureSlice = false) {
    const now = new Date();
    const time = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', timeZoneName: 'short' });
    const members = ['You (Owner)', 'Dave', 'Sam'];
    const voiceCtx = includeVoice ? this.voiceWindow.slice(-12) : [];
    this.transient = { time, members, voiceCtx, command };
    const snapshot = {
      systemPrompt: JSON.parse(JSON.stringify(SYSTEM_PROMPT)),
      history: this.history.map((h) => ({ ...h })),
      transient: { ...this.transient, voiceCtx: voiceCtx.map((v) => ({ ...v })) },
      context: { ...this.context },
    };

    if (captureSlice) {
      const slice = {
        id: this.stats.totalTurns,
        t: now.getTime(),
        time,
        command,
        ...snapshot,
        trace: '',
        tool: null,
        reply: null,
        stats: { ...this.stats },
        status: 'pending',
      };
      this.slices.push(slice);
      this.activeSliceId = slice.id;
      this.bus.emit('mind:slice', { slice, slices: this.slices.map((s) => this._sliceSummary(s)) });
    }

    // live view mirrors the latest slice when not scrubbing history
    this.bus.emit('mind:context', {
      ...snapshot,
      stats: { ...this.stats, historyCount: this.history.length, voiceLines: this.voiceWindow.length },
    });
  }

  // compact summary used to render timeline markers without copying big payloads
  _sliceSummary(s) {
    return {
      id: s.id, t: s.t, time: s.time, command: s.command,
      status: s.status, reply: s.reply, tokPerSec: s.stats.tokPerSec,
      elapsedMs: s.stats.lastElapsed, hadTool: !!s.tool,
    };
  }

  // update the in-flight slice's outcome fields as events land
  _patchSlice(patch) {
    const s = this.slices[this.slices.length - 1];
    if (!s) return;
    Object.assign(s, patch);
    this.bus.emit('mind:slice:update', { slice: this._sliceSummary(s) });
  }

  // timeline control — select a past slice to view its frozen context
  selectSlice(id) {
    if (id === null) {
      this.activeSliceId = null;
      this.bus.emit('mind:timeline', { selected: null });
      return;
    }
    const s = this.slices.find((x) => x.id === id);
    if (!s) return;
    this.activeSliceId = id;
    this.bus.emit('mind:timeline', {
      selected: id,
      snapshot: {
        systemPrompt: s.systemPrompt,
        history: s.history,
        transient: s.transient,
        context: s.context,
      },
      summary: this._sliceSummary(s),
      slices: this.slices.map((x) => this._sliceSummary(x)),
    });
  }

  // periodic state tick for sparklines + gauges
  async _tickLoop() {
    while (this.running) {
      await sleep(1000);
      // decay tok/s toward 0 when idle
      this.stats.tokPerSec = Math.max(0, this.stats.tokPerSec * 0.6);
      this.bus.emit('state:tick', {
        stats: { ...this.stats },
        context: { ...this.context },
        session: { ...this.session },
      });
    }
  }

  async _scenarioLoop() {
    let i = 0;
    // seed some ambient transcript
    await sleep(800);
    while (this.running) {
      const scene = SCENARIO[i % SCENARIO.length];
      i++;

      // ambient transcripts
      for (const line of scene.transcripts) {
        if (!this.running) return;
        const sp = SPEAKERS.find((s) => s.id === line.who);
        this._pushVoice(sp, line.text);
        this.bus.emit('transcript:final', {
          speaker: sp.name, owner: sp.owner, text: line.text, startMs: Date.now(),
        });
        this._growContext(line.text);
        await sleep(rand(1600, 2800));
      }

      // trigger + dispatch
      const trig = scene.trigger;
      const tsp = SPEAKERS.find((s) => s.id === trig.who);
      this._pushVoice(tsp, trig.text);
      this.bus.emit('transcript:final', {
        speaker: tsp.name, owner: tsp.owner, text: trig.text, startMs: Date.now(),
      });
      this._growContext(trig.text);
      await sleep(rand(500, 900));

      const key = 'voice';
      this.bus.emit('ack:state', { guild: this.session.guild, active: true });
      this.bus.emit('llm:dispatch', {
        key, prompt: trig.text, backend: 'local', model: 'gemma-4-26b-a4b-it',
      });
      this.stats.iter = 0;
      this.stats.totalTurns++;
      // build + emit the transient context block for this turn (ephemeral),
      // and capture an inference slice for the timeline scrubber.
      this._emitContext(trig.text, true, true);

      await sleep(rand(300, 750)); // TTFT-ish
      const ttft = Math.round(rand(320, 760));
      this.stats.ttft = ttft;
      this._patchSlice({ stats: { ...this.stats } });
      this.bus.emit('llm:ttft', { key, ms: ttft });

      // thinking trace (if "thinking" enabled — simulate on)
      this.bus.emit('llm:iter', { key, iter: 1, max: 20 });
      this.stats.iter = 1;
      this._patchSlice({ stats: { ...this.stats } });
      await streamText(this.bus, key, scene.thinking, { type: 'llm:think', tokPerSec: 90 }, (acc) => {
        this._patchSlice({ trace: acc });
      });
      await sleep(rand(200, 450));

      // optional tool call
      if (scene.useTool) {
        const requiresApproval = ['send_dm'].includes(scene.useTool.name);
        this.bus.emit('llm:tool_request', {
          key, name: scene.useTool.name, args: scene.useTool.args, requiresApproval,
        });
        this._patchSlice({ tool: { name: scene.useTool.name, args: scene.useTool.args, requiresApproval, result: null } });
        await sleep(requiresApproval ? rand(1400, 2200) : rand(400, 700));
        this.bus.emit('llm:tool_result', {
          key, name: scene.useTool.name, result: scene.useTool.result, ok: true,
        });
        this._patchSlice({ tool: { name: scene.useTool.name, args: scene.useTool.args, requiresApproval, result: scene.useTool.result } });
        this.stats.iter = 2;
        this._patchSlice({ stats: { ...this.stats } });
        this.bus.emit('llm:iter', { key, iter: 2, max: 20 });
        await sleep(rand(200, 400));
      }

      // reply token stream
      const tokPerSec = scene.tokPerSec;
      this.stats.tokPerSec = tokPerSec;
      await streamText(this.bus, key, scene.reply, { type: 'llm:token', tokPerSec });

      const tokensOut = Math.round(scene.reply.length / 4);
      const tokensIn = Math.round(this.context.used * 0.04) + 640;
      const elapsed = Math.round((tokensOut / tokPerSec) * 1000) + ttft;
      this.stats.lastElapsed = elapsed;
      this.bus.emit('llm:final', {
        key, text: scene.reply, tokensIn, tokensOut, tokPerSec, elapsedMs: elapsed,
      });
      // finalize the slice outcome
      this._patchSlice({ reply: scene.reply, stats: { ...this.stats }, status: 'done' });
      this._growContext(scene.reply);

      // persist this turn into history (mirrors updatedHistory in jarvis-handler)
      if (scene.useTool) {
        this.history.push({ role: 'tool', text: scene.useTool.result, name: scene.useTool.name });
      }
      this.history.push({ role: 'assistant', text: scene.reply });
      this.history.push({ role: 'user', text: `[COMMAND]\n${trig.text}`, transient: false });
      // cap at 20 (llmMaxHistory) — drop oldest
      while (this.history.length > 20) this.history.shift();
      // re-emit context so the persisted-history panel reflects the new turn
      // (do NOT capture a new slice here — this is the post-turn history update)
      this._emitContext(trig.text, true, false);

      this.bus.emit('ack:state', { guild: this.session.guild, active: false });
      await sleep(rand(1800, 3000));
    }
  }

  _growContext(text) {
    this.context.used += Math.ceil(text.length / 4) + 16;
    this.context.historyCount += 1;
    // simulate occasional trim
    if (this.context.used > this.context.budget * 0.82) {
      this.context.used = Math.round(this.context.used * 0.55);
      this.context.historyCount = Math.max(4, Math.round(this.context.historyCount * 0.6));
      this.bus.emit('llm:trim', { used: this.context.used, budget: this.context.budget });
    }
  }

  // push a transcript line into the rolling voice window (last ~180s) used to
  // build the transient [VOICE CHANNEL] block each dispatch.
  _pushVoice(speaker, text) {
    const now = new Date();
    const mmss = `${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    this.voiceWindow.push({ mmss, name: speaker.name, owner: speaker.owner, text });
    // keep the last 40 lines (~ the 180s window in a busy channel)
    while (this.voiceWindow.length > 40) this.voiceWindow.shift();
  }
}

window.FakeMind = FakeMind;
window.FAKE_SPEAKERS = SPEAKERS;
