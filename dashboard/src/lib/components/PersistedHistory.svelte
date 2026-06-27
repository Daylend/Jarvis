<script lang="ts">
  import { esc } from '$lib/util';
  import type { HistoryMessage } from '$lib/types';

  export let history: HistoryMessage[];
  let open = true;
</script>

<div class="ctx-sec" class:open={open}>
  <button class="ctx-sec__head" on:click={() => (open = !open)}>
    <span class="ctx-sec__idx">{history.length ? `[1..${history.length}]` : '[1..0]'}</span>
    <span class="ctx-sec__title">PERSISTED HISTORY</span>
    <span class="ctx-sec__badge kept">kept · {history.length} msgs</span>
    <span class="ctx-sec__chev">▸</span>
  </button>
  {#if open}
    <div class="ctx-sec__body">
      <div class="hist">
        {#if history.length === 0}
          <div class="hist__empty muted">(empty — first turn)</div>
        {:else}
          {#each history as m}
            {@const r = m.role === 'tool' ? 'tool' : m.role}
            {@const isOwner = m.role === 'user'}
            {@const preview = m.text}
            {@const dim = m.role === 'user' && preview.includes('[VOICE CHANNEL]')}
            <div class="hist__msg r-{r} {isOwner ? 'owner' : ''}">
              <span class="hist__role">{m.name || r}</span>
              <span class="hist__txt {dim ? 'dim' : ''}">{preview.length > 220 ? preview.slice(0, 220) + '…' : preview}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>