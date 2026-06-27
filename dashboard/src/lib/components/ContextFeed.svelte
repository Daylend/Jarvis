<script lang="ts">
  import { mind } from '$lib/mindStore';
  import SystemPrompt from './SystemPrompt.svelte';
  import PersistedHistory from './PersistedHistory.svelte';
  import Transient from './Transient.svelte';
  import Generating from './Generating.svelte';

  $: sp = $mind.systemPrompt;
  $: history = $mind.history;
  $: transient = $mind.transient;
  $: scrubbing = $mind.viewMode === 'slice';
</script>

<section class="card card--feed">
  <div class="pane__head">
    CONTEXT WINDOW
    <span class="pane__sub">{scrubbing ? 'frozen on inference slice' : 'what jarvis sees · live'}</span>
  </div>
  <div class="feed">
    <SystemPrompt {sp} />
    <PersistedHistory {history} />
    <Transient {transient} />
    <Generating />
  </div>
</section>