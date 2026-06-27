<script lang="ts">
  import { esc } from '$lib/util';
  import { mind } from '$lib/mindStore';
  import type { TransientFields, VoiceLine } from '$lib/types';

  export let transient: TransientFields | null;
  let open = true;

  $: voiceBuf = $mind.voiceBuf;
</script>

<div class="ctx-sec ctx-sec--fill" class:open={open}>
  <button class="ctx-sec__head" on:click={() => (open = !open)}>
    <span class="ctx-sec__idx">[n+1]</span>
    <span class="ctx-sec__title">TRANSIENT · THIS TURN</span>
    <!-- transient block (voice ctx) is rebuilt each turn; the user turn itself is persisted -->
    <span class="ctx-sec__badge kept">rebuilt each turn</span>
    <span class="ctx-sec__chev">▸</span>
  </button>
  {#if open}
    <div class="ctx-sec__body">
      <div class="trans">
        {#if !transient && voiceBuf.length === 0}
          <span class="muted">— idle, no active turn —</span>
        {:else}
          {#if transient}
            <div class="trans__line"><b>Current time:</b> {transient.time}</div>
            <div class="trans__label">[VOICE CHANNEL]{#if transient.members.length} · members: {transient.members.join(', ')}{/if}</div>
          {:else}
            <div class="trans__label">[VOICE CHANNEL]</div>
          {/if}
          <div class="trans__voice">
            {#if voiceBuf.length === 0}
              <span class="muted">(silent)</span>
            {:else}
              {#each voiceBuf as v (v.mmss + v.text)}
                <div class="trans__vline {v.owner ? 'owner' : ''}">
                  <span class="ts">{v.mmss}</span>
                  <span class="who {v.owner ? 'owner' : ''}">{v.name}:</span>
                  <span class="txt">{v.text}</span>
                </div>
              {/each}
            {/if}
          </div>
          {#if transient && transient.command}
            <div class="trans__cmd"><b>[COMMAND]</b> {transient.command}</div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>