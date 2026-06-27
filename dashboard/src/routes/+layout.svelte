<script lang="ts">
  import '$lib/styles/glass.css';
  import { startWs, stopWs } from '$lib/ws';
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';

  let { children } = $props();

  let clock = $state('');

  function tick() {
    clock = new Date().toTimeString().slice(0, 8);
  }

  onMount(() => {
    startWs();
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  });

  onDestroy(() => stopWs());

  const statusText = $derived($page.url.pathname === '/mind' ? 'MIND' : 'SETTINGS');
</script>

<div class="app">
  <header class="topbar">
    <a class="brand" href="/mind"><span class="brand__dot"></span> JARVIS <em>MIND</em></a>
    <nav class="topbar__nav">
      <a href="/mind" class:active={$page.url.pathname === '/mind'}>Mind</a>
      <a href="/settings" class:active={$page.url.pathname === '/settings'}>Settings</a>
    </nav>
    <div class="topbar__sub">context observatory · live</div>
    <div class="topbar__right">
      <span class="statuspill"><span class="led"></span> {statusText}</span>
      <span class="clock">{clock}</span>
    </div>
  </header>

  <main class="main">
    {@render children()}
  </main>
</div>

<style>
  .topbar__nav { display: flex; gap: 14px; margin-left: 18px; }
  .topbar__nav a {
    font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
    color: var(--muted); text-decoration: none; padding: 4px 0;
    border-bottom: 1px solid transparent; transition: color .15s, border-color .15s;
  }
  .topbar__nav a:hover { color: var(--text); }
  .topbar__nav a.active { color: var(--cyan); border-bottom-color: var(--cyan); }
</style>