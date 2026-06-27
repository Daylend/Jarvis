<script lang="ts">
  import { esc } from '$lib/util';
  import type { SystemPromptParts } from '$lib/types';

  export let sp: SystemPromptParts | null;
  let open = false;
</script>

<div class="ctx-sec" class:open={open}>
  <button class="ctx-sec__head" on:click={() => (open = !open)}>
    <span class="ctx-sec__idx">[0]</span>
    <span class="ctx-sec__title">SYSTEM PROMPT</span>
    <span class="ctx-sec__badge kept">rebuilt each turn</span>
    <span class="ctx-sec__chev">▸</span>
  </button>
  {#if open && sp}
    <div class="ctx-sec__body">
      <div class="syspart">
        <div class="syspart__label">scaffold header</div>
        <div class="syspart__txt">{sp.header}</div>
      </div>
      <div class="syspart">
        <div class="syspart__label">rules</div>
        <ol class="rules">
          {#each sp.rules as r}<li>{@html esc(r)}</li>{/each}
        </ol>
      </div>
      <div class="syspart">
        <div class="syspart__label">persona <span class="tag tag--yaml">jarvis.yaml</span></div>
        <div class="syspart__txt">{sp.persona}</div>
      </div>
      <div class="syspart">
        <div class="syspart__label">examples <span class="tag tag--yaml">jarvis.yaml</span></div>
        <pre class="syspart__pre">{sp.examples}</pre>
      </div>
      <div class="syspart">
        <div class="syspart__label">injected · your notes <span class="tag tag--inj">noteStore</span></div>
        <ul class="injlist">
          {#if sp.notes.length === 0}<li class="muted">(none)</li>{/if}
          {#each sp.notes as n}<li>#{n.id} {@html esc(n.title)}</li>{/each}
        </ul>
      </div>
      <div class="syspart">
        <div class="syspart__label">injected · your skills <span class="tag tag--inj">skillStore</span></div>
        <ul class="injlist">
          {#if sp.skills.length === 0}<li class="muted">(none)</li>{/if}
          {#each sp.skills as sk}
            <li class={sk.active ? 'active' : ''}>- {@html esc(sk.name)} — {@html esc(sk.desc)}{sk.active ? ' [active]' : ''}</li>
          {/each}
        </ul>
      </div>
      <div class="syspart">
        <div class="syspart__label">scaffold footer</div>
        <div class="syspart__txt">{sp.footer}</div>
      </div>
    </div>
  {/if}
</div>