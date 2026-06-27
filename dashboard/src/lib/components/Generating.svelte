<script lang="ts">
  import { mind } from '$lib/mindStore';
  import { esc } from '$lib/util';

  $: gen = $mind.gen;
  $: active = $mind.session.active;
</script>

<div class="ctx-sec open">
  <div class="ctx-sec__head ctx-sec__head--static">
    <span class="ctx-sec__idx">→</span>
    <span class="ctx-sec__title">GENERATING</span>
    <span class="ctx-sec__badge {active ? 'kept' : ''}">{active ? 'in-flight · will persist on completion' : 'idle'}</span>
  </div>
  <div class="ctx-sec__body ctx-sec__body--open">
    <div class="gen">
      <div class="gen__think">
        {#if gen.think}{@html esc(gen.think)}{:else}<span class="muted">— idle · no active generation —</span>{/if}
      </div>
      <div class="gen__tools">
        {#each gen.tools as t (t.name + t.args)}
          <div class="tool">
            <div class="tool__head">
              <span class="tool__name">{t.name}</span>
              <span class="tool__badge {t.ok === null ? 'pending' : 'ok'}">
                {t.requiresApproval && t.ok === null ? 'approval' : t.ok === null ? 'running' : t.ok ? 'done' : 'error'}
              </span>
            </div>
            <div class="tool__args">{JSON.stringify(t.args)}</div>
            {#if t.result !== null}<div class="tool__res">{t.result}</div>{/if}
          </div>
        {/each}
      </div>
      {#if gen.reply}
        <div class="gen__replymsg">
          <div class="gen__replybody">
            <div class="gen__who">
              <span class="gen__name">Jarvis</span>
              <span class="gen__badge">streaming</span>
            </div>
            <div class="gen__text">{gen.reply}{#if active}<span class="cursor"></span>{/if}</div>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>