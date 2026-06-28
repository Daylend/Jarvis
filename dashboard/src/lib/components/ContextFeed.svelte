<script lang="ts">
  import { browser } from '$app/environment';
  import { mind } from '$lib/mindStore';
  import type { VoiceLine } from '$lib/types';
  import SystemPrompt from './SystemPrompt.svelte';
  import PersistedHistory from './PersistedHistory.svelte';
  import Transient from './Transient.svelte';
  import Generating from './Generating.svelte';

  $: sp = $mind.systemPrompt;
  $: history = $mind.history;
  $: transient = $mind.transient;
  $: scrubbing = $mind.viewMode === 'slice';

  let feedEl: HTMLElement;
  let stick = true;

  function onScroll() {
    if (!feedEl) return;
    stick = feedEl.scrollTop + feedEl.clientHeight + 40 >= feedEl.scrollHeight;
  }

  // stick the feed to the bottom while a turn streams in (llm:dispatch + think/reply/tool)
  // and while voice lines land in the transient block (transcript:final → voiceBuf)
  $: reactGen($mind.gen.think, $mind.gen.reply, $mind.gen.tools, $mind.session.active, $mind.voiceBuf, $mind.transient);
  function reactGen(_a: string, _b: string, _c: unknown[], _active: boolean, _buf: VoiceLine[], _trans: unknown) {
    if (!browser || !feedEl || !stick) return;
    requestAnimationFrame(() => {
      if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
    });
  }
</script>

<section class="card card--feed">
  <div class="pane__head">
    CONTEXT WINDOW
    <span class="pane__sub">{scrubbing ? 'frozen on inference slice' : 'what jarvis sees · live'}</span>
  </div>
  <div class="feed" bind:this={feedEl} on:scroll={onScroll}>
    <SystemPrompt {sp} />
    <PersistedHistory {history} />
    <Transient {transient} />
    <Generating />
  </div>
</section>
