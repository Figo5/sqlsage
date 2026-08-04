<script setup lang="ts">
import { withBase } from 'vitepress';
import TerminalDemo from './TerminalDemo.vue';
import FeatureGrid from './FeatureGrid.vue';
</script>

<template>
  <div class="q-home">
    <div class="q-hero">
      <div class="q-eyebrow">
        <span class="dot">●</span> correctness-first · offline-first · postgresql
      </div>
      <h1 class="q-title">
        Explain your PostgreSQL query, and
        <span class="green">know it&rsquo;s right</span> before you make it fast.
      </h1>

      <div class="q-badges">
        <span class="q-badge">npm <span class="green">0.2.1</span></span>
        <span class="q-badge">ci <span class="green">passing</span></span>
        <span class="q-badge">mit license</span>
        <span class="q-badge">postgresql</span>
      </div>

      <div class="q-cta">
        <!-- Internal routes must carry the /sqlsage/ base (withBase); the
             GitHub CTA is an absolute external URL and stays as-is. -->
        <a class="q-btn primary" :href="withBase('/getting-started')">Get started</a>
        <a class="q-btn ghost" :href="withBase('/tutorials/01-wrong-results-not-in')"
          >Walk through a bug</a
        >
        <a class="q-btn ghost" href="https://github.com/Figo5/sqlsage">GitHub ↗</a>
      </div>
    </div>

    <div class="q-term-wrap">
      <TerminalDemo />
    </div>

    <FeatureGrid />
  </div>
</template>

<style scoped>
.q-home {
  width: 100%;
}

.q-hero {
  max-width: 900px;
  margin: 0 auto;
  padding: 64px 28px 20px;
  text-align: center;
}
.q-eyebrow {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 12.5px;
  color: var(--q-muted);
  letter-spacing: 0.08em;
  text-transform: lowercase;
  margin-bottom: 22px;
}
.q-eyebrow .dot {
  color: var(--q-green);
}
.q-title {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 500;
  font-size: 36px;
  line-height: 1.35;
  color: var(--q-paper);
  max-width: 680px;
  margin: 0 auto 26px;
  letter-spacing: -0.01em;
}
.q-title .green {
  color: var(--q-green);
}

.q-badges {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 32px;
  flex-wrap: wrap;
}
.q-badge {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 11.5px;
  color: var(--q-muted);
  border: 1px solid var(--q-border);
  border-radius: 4px;
  padding: 4px 10px;
}
.q-badge .green {
  color: var(--q-green);
}

.q-cta {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-bottom: 56px;
  flex-wrap: wrap;
}
.q-btn {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 13.5px;
  padding: 10px 18px;
  border-radius: 5px;
  border: 1px solid var(--q-border);
  color: var(--q-muted);
  text-decoration: none;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.q-btn.primary {
  background: var(--q-green-dim);
  border-color: var(--q-green);
  color: var(--q-paper);
}
.q-btn.ghost:hover {
  border-color: var(--q-green);
  color: var(--q-paper);
}

.q-term-wrap {
  max-width: 640px;
  margin: 0 auto 80px;
  padding: 0 28px;
}

@media (max-width: 700px) {
  .q-title {
    font-size: 27px;
  }
}
</style>
