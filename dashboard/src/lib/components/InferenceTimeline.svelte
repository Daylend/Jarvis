<script lang="ts">
  import { mind } from '$lib/mindStore';
  import { sendSelectSlice } from '$lib/ws';
  import { esc } from '$lib/util';

  $: slices = $mind.sliceSummaries;
  $: selected = $mind.selectedSliceId;
  $: detail = $mind.detailSlice;
  $: scrubbing = $mind.viewMode === 'slice';

  function goLive() {
    sendSelectSlice(null);
  }

  function selectSlice(id: number) {
    sendSelectSlice(id);
  }

  $: autoScroll(slices.length);
  function autoScroll(_n: number) {
    requestAnimationFrame(() => {
      const el = document.getElementById('timeline');
      if (el) el.scrollLeft = el.scrollWidth;
    });
  }
</script>

<section class="card card--timeline">
  <div class="pane__head">
    <span>INFERENCE TIMELINE</span>
    <span class="pane__sub">{slices.length} slice{slices.length === 1 ? '' : 's'}</span>
    <button class="tl-live" class:scrubbing on:click={goLive}>
      {#if scrubbing}▸ GO LIVE{:else}● LIVE{/if}
    </button>
  </div>
  <div class="timeline" id="timeline">
    {#if slices.length === 0}
      <div class="tl-empty muted">no inferences yet</div>
    {:else}
      <div class="tl-axis"></div>
      {#each slices as s (s.id)}
        <div
          role="button"
          tabindex="0"
          class="tl-marker {s.status} {s.hadTool ? 'tool' : ''} {selected === s.id ? 'selected' : ''}"
          title={s.command}
          on:click={() => selectSlice(s.id)}
          on:keydown={(e) => e.key === 'Enter' && selectSlice(s.id)}
        >
          <div class="tl-marker__dot"></div>
          <div class="tl-marker__label">#{s.id} {s.tokPerSec ? s.tokPerSec.toFixed(0) + 't/s' : '…'}</div>
        </div>
      {/each}
    {/if}
  </div>
  {#if detail}
    <div class="tl-detail">
      <div class="tl-detail__cmd">{detail.command}</div>
      <div class="tl-detail__meta">
        <span>{detail.tokPerSec ? detail.tokPerSec.toFixed(0) + ' tok/s' : '—'}</span>
        <span>{detail.elapsedMs ? detail.elapsedMs + ' ms' : '—'}</span>
        <span>{detail.status === 'done' ? 'completed' : 'in flight'}</span>
      </div>
    </div>
  {/if}
</section>