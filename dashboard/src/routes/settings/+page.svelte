<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type SettingsState } from '$lib/api';

  let state: SettingsState | null = null;
  let loading = true;
  let error = '';
  let toast = '';
  let busy = false;

  let confirmReset = false;
  let newLlmModel = '';
  let newBackend = 'local';
  let newAckSound = '';

  function showToast(msg: string) {
    toast = msg;
    setTimeout(() => (toast = ''), 2500);
  }

  async function refresh() {
    try {
      state = await api.state();
      if (state) {
        newBackend = state.llm.backend;
        newLlmModel = state.llm.model;
        newAckSound = state.ack.ackSound;
      }
      error = '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  async function run(fn: () => Promise<any>, okMsg: string) {
    busy = true;
    try {
      await fn();
      await refresh();
      showToast(okMsg);
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }

  function setPersonality(id: string) { run(() => api.setPersonality(id), 'Personality updated'); }
  function reloadPersonalities() { run(() => api.reloadPersonalities(), 'Personalities reloaded'); }
  function resetMemory() {
    run(() => api.resetMemory().then(() => { confirmReset = false; }), 'Memory wiped');
  }
  function setLlm() { run(() => api.setLlm(newBackend, newLlmModel || undefined), 'LLM backend updated'); }
  function toggleThinking(v: boolean) { run(() => api.setThinking(v), `Thinking ${v ? 'on' : 'off'}`); }
  function setAckSound() { if (newAckSound) run(() => api.setAckSound(newAckSound), 'Ack sound set'); }
  function toggleAck(v: boolean) { run(() => api.setAckEnabled(v), `Ack ${v ? 'on' : 'off'}`); }
  function startVoice() {
    if (!state?.voice.ownerVoice) return;
    run(() => api.startVoice(state!.voice.ownerVoice!.guildId, state!.voice.ownerVoice!.channelId), 'Listening started');
  }
  function stopVoice() {
    if (!state?.voice.session) return;
    run(() => api.stopVoice(state!.voice.session!.guildId), 'Listening stopped');
  }
</script>

<section class="card" style="flex:1;min-height:0;overflow-y:auto">
  <div class="pane__head"><span>SETTINGS</span><span class="pane__sub">manage jarvis</span></div>

  {#if loading}
    <div style="padding:24px;color:var(--muted)">Loading…</div>
  {:else if error}
    <div style="padding:24px;color:var(--red)">Failed to load: {error}</div>
  {:else if state}
    <div class="settings-grid">

      <!-- Memory -->
      <div class="set-card">
        <div class="set-card__title">Memory</div>
        <p class="set-card__desc">Wipe the shared conversation history (DM + voice + mentions). Transcripts are not affected.</p>
        {#if confirmReset}
          <div class="confirm">
            <span>Are you sure?</span>
            <button class="btn btn--danger" on:click={resetMemory} disabled={busy}>Yes, wipe</button>
            <button class="btn" on:click={() => (confirmReset = false)} disabled={busy}>Cancel</button>
          </div>
        {:else}
          <button class="btn btn--danger" on:click={() => (confirmReset = true)} disabled={busy}>Reset conversation memory</button>
        {/if}
      </div>

      <!-- Personality -->
      <div class="set-card">
        <div class="set-card__head">
          <div class="set-card__title">Personality</div>
          <button class="btn btn--ghost" on:click={reloadPersonalities} disabled={busy}>Reload from disk</button>
        </div>
        <div class="pgrid">
          {#each state.personality.list as p (p.id)}
            <button
              class="pcard {p.active ? 'pcard--active' : ''}"
              on:click={() => !p.active && setPersonality(p.id)}
              disabled={busy || p.active}
            >
              <div class="pcard__name">{p.name}</div>
              <div class="pcard__meta">{p.voice} · {p.speed}x</div>
              {#if p.active}<span class="pcard__tag">active</span>{/if}
            </button>
          {/each}
        </div>
        {#if state.personality.active}
          <details class="persona-detail">
            <summary>Persona</summary>
            <pre class="persona-pre">{state.personality.active.persona}</pre>
          </details>
        {/if}
      </div>

      <!-- LLM -->
      <div class="set-card">
        <div class="set-card__title">LLM Backend</div>
        <div class="field-row">
          <label class="seg">
            <input type="radio" name="backend" bind:group={newBackend} value="local" /> local (llama.cpp)
          </label>
          <label class="seg">
            <input type="radio" name="backend" bind:group={newBackend} value="openrouter" /> openrouter
          </label>
        </div>
        <div class="field-row">
          <input class="inp" bind:value={newLlmModel} placeholder="model id" list="model-list" />
          <datalist id="model-list">
            {#if newBackend === 'local' && state.llm.models}
              {#each state.llm.models as m}<option value={m.id}>{m.status}</option>{/each}
            {/if}
          </datalist>
          <button class="btn" on:click={setLlm} disabled={busy}>Apply</button>
        </div>
        <label class="toggle">
          <input type="checkbox" checked={state.llm.thinking} on:change={(e) => toggleThinking(e.currentTarget.checked)} disabled={busy} />
          <span>Thinking mode (reasoning trace)</span>
        </label>
      </div>

      <!-- Voice session -->
      <div class="set-card">
        <div class="set-card__title">Voice Session</div>
        {#if state.voice.session}
          <div class="voice-status">
            <span class="dot dot--green"></span>
            Listening in <b>{state.voice.session.channelId}</b>
          </div>
          <button class="btn btn--danger" on:click={stopVoice} disabled={busy}>Stop listening</button>
        {:else if state.voice.ownerVoice}
          <div class="voice-status">
            <span class="dot dot--amber"></span>
            You're in <b>#{state.voice.ownerVoice.channelName}</b> ({state.voice.ownerVoice.guildName})
          </div>
          <button class="btn" on:click={startVoice} disabled={busy}>Start listening</button>
        {:else}
          <div class="voice-status"><span class="dot dot--red"></span> You're not in a voice channel.</div>
          <p class="set-card__desc">Join a Discord voice channel, then refresh.</p>
        {/if}
        <div class="health">
          <div class="health__row">
            <span>ASR</span>
            <span class={state.voice.asr.ok ? 'ok' : 'bad'}>{state.voice.asr.ok ? '✓' : '✕'} {state.voice.asr.detail}</span>
          </div>
          <div class="health__row">
            <span>TTS</span>
            <span class={state.voice.tts.ok ? 'ok' : 'bad'}>{state.voice.tts.ok ? '✓' : '✕'} {state.voice.tts.detail}</span>
          </div>
        </div>
      </div>

      <!-- Ack -->
      <div class="set-card">
        <div class="set-card__title">Acknowledgement</div>
        <label class="toggle">
          <input type="checkbox" checked={state.ack.ackEnabled} on:change={(e) => toggleAck(e.currentTarget.checked)} disabled={busy} />
          <span>Ack enabled (sound + green indicator)</span>
        </label>
        <div class="field-row">
          <select class="inp" bind:value={newAckSound}>
            {#each state.ack.sounds as s}<option value={s}>{s}</option>{/each}
          </select>
          <button class="btn" on:click={setAckSound} disabled={busy}>Set</button>
        </div>
        <div class="ack-source">Source: {state.ack.source} · {state.ack.ackSound} {state.ack.soundPath ? '✓' : '⚠ missing'}</div>
      </div>

    </div>
  {/if}
</section>

{#if toast}<div class="toast">{toast}</div>{/if}

<style>
  .settings-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:12px; padding:14px; }
  .set-card { border:1px solid var(--line); border-radius:10px; padding:14px; background:rgba(0,0,0,.2); display:flex; flex-direction:column; gap:10px; }
  .set-card__head { display:flex; justify-content:space-between; align-items:center; }
  .set-card__title { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--cyan); font-weight:700; }
  .set-card__desc { font-size:11.5px; color:var(--muted); line-height:1.4; }
  .btn { font:inherit; font-size:11px; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:rgba(92,200,255,.08); color:var(--text); cursor:pointer; transition:all .15s; }
  .btn:hover:not(:disabled) { background:rgba(92,200,255,.16); }
  .btn:disabled { opacity:.5; cursor:default; }
  .btn--danger { background:rgba(255,107,122,.1); border-color:rgba(255,107,122,.3); color:var(--red); }
  .btn--danger:hover:not(:disabled) { background:rgba(255,107,122,.18); }
  .btn--ghost { background:transparent; }
  .confirm { display:flex; gap:8px; align-items:center; font-size:11.5px; }
  .pgrid { display:grid; grid-template-columns: repeat(auto-fill, minmax(140px,1fr)); gap:8px; }
  .pcard { text-align:left; padding:10px; border:1px solid var(--line-2); border-radius:8px; background:rgba(0,0,0,.2); cursor:pointer; position:relative; color:var(--text); font:inherit; transition:all .15s; }
  .pcard:hover:not(:disabled) { border-color:var(--cyan-dim); }
  .pcard--active { border-color:var(--green); background:rgba(78,224,138,.06); }
  .pcard--active:disabled { cursor:default; }
  .pcard__name { font-size:13px; font-weight:700; color:var(--text); }
  .pcard__meta { font-size:10px; color:var(--muted); margin-top:2px; }
  .pcard__tag { position:absolute; top:6px; right:6px; font-size:8px; color:var(--green); letter-spacing:.08em; text-transform:uppercase; }
  .persona-detail summary { font-size:10.5px; color:var(--cyan-dim); cursor:pointer; }
  .persona-pre { font-family:var(--mono); font-size:10.5px; color:#9fb8d6; white-space:pre-wrap; word-break:break-word; background:rgba(0,0,0,.3); padding:8px; border-radius:6px; margin-top:6px; max-height:200px; overflow:auto; }
  .field-row { display:flex; gap:8px; align-items:center; }
  .seg { font-size:11px; color:var(--text); display:flex; gap:5px; align-items:center; cursor:pointer; }
  .inp { flex:1; font:inherit; font-size:11px; padding:6px 8px; border-radius:6px; border:1px solid var(--line-2); background:rgba(0,0,0,.3); color:var(--text); }
  .toggle { display:flex; gap:8px; align-items:center; font-size:11.5px; color:var(--text); cursor:pointer; }
  .voice-status { display:flex; align-items:center; gap:8px; font-size:11.5px; }
  .dot { width:9px; height:9px; border-radius:50%; }
  .dot--green { background:var(--green); box-shadow:0 0 8px var(--green); }
  .dot--amber { background:var(--amber); box-shadow:0 0 8px var(--amber); }
  .dot--red { background:var(--red); }
  .health { margin-top:6px; border-top:1px solid var(--line-2); padding-top:8px; display:flex; flex-direction:column; gap:4px; }
  .health__row { display:flex; justify-content:space-between; font-size:10.5px; font-family:var(--mono); }
  .health__row .ok { color:var(--green); }
  .health__row .bad { color:var(--red); }
  .ack-source { font-size:10px; color:var(--muted); font-family:var(--mono); }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--glass); border:1px solid var(--cyan-dim); color:var(--text); padding:8px 16px; border-radius:8px; font-size:12px; z-index:100; backdrop-filter:blur(12px); }
</style>