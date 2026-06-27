<script lang="ts">
  import { mind } from '$lib/mindStore';
  import { drawRing } from '$lib/util';
  import { onMount } from 'svelte';

  let ringToks: HTMLCanvasElement;
  let ringCtx: HTMLCanvasElement;

  $: toks = $mind.stats.tokPerSec.toFixed(1);
  $: ctxpct = $mind.context.budget > 0 ? (($mind.context.used / $mind.context.budget) * 100).toFixed(1) : '0.0';
  $: ctxabs = $mind.context.budget > 0 ? `${$mind.context.used.toLocaleString()}/${Math.round($mind.context.budget / 1000)}k` : '0/0k';
  $: fillPct = $mind.context.budget > 0 ? Math.min(100, ($mind.context.used / $mind.context.budget) * 100) : 0;

  $: redraw($mind.stats.tokPerSec, $mind.context.used / ($mind.context.budget || 1));

  function redraw(tps: number, pct: number) {
    drawRing(ringToks, tps / 90, '#ffb454');
    drawRing(ringCtx, pct, '#5cc8ff');
  }

  onMount(() => requestAnimationFrame(() => redraw(0, 0)));
</script>

<section class="card card--telemetry">
  <div class="gauges-row">
    <div class="gauge">
      <canvas class="ring" bind:this={ringToks} width="72" height="72"></canvas>
      <div class="gauge__val"><b>{toks}</b><span>tok/s</span></div>
    </div>
    <div class="gauge">
      <canvas class="ring" bind:this={ringCtx} width="72" height="72"></canvas>
      <div class="gauge__val"><b>{ctxpct}%</b><span>{ctxabs}</span></div>
    </div>
    <div class="ctxbar"><div class="ctxbar__fill" style="width:{fillPct}%"></div><span class="ctxbar__lbl">CONTEXT FILL</span></div>
    <div class="stat-tile"><span class="stat-tile__k">TTFT</span><b>{$mind.stats.ttft}</b><span>ms</span></div>
    <div class="stat-tile"><span class="stat-tile__k">ITER</span><b>{$mind.stats.iter}</b><span>/20</span></div>
    <div class="stat-tile"><span class="stat-tile__k">LAST</span><b>{$mind.stats.lastElapsed}</b><span>ms</span></div>
    <div class="stat-tile"><span class="stat-tile__k">TURNS</span><b>{$mind.stats.totalTurns}</b></div>
  </div>
</section>