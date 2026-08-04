<script setup lang="ts">
import AuroraHero from './AuroraHero.vue';
import FeatureGrid from './FeatureGrid.vue';
import TerminalDemo from './TerminalDemo.vue';
import PipelineDiagram from './PipelineDiagram.vue';
</script>

<template>
  <div class="home-landing">
    <AuroraHero />
    <TerminalDemo />
    <FeatureGrid />
    <PipelineDiagram />

    <div class="home-cta">
      <h2>Trust your queries again</h2>
      <p>
        Install it, point it at your slowest query, and let it tell you whether the
        query is wrong before you make it fast.
      </p>
      <div class="home-cta-actions">
        <a class="home-btn primary" href="/getting-started">Install &amp; run</a>
        <a class="home-btn ghost" href="/cli-reference">CLI reference</a>
        <a class="home-btn ghost" href="/examples">Bundled examples</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-landing {
  width: 100%;
  background: var(--vp-c-bg);
}
.home-cta {
  text-align: center;
  padding: 2.5rem 1.5rem 4.5rem;
}
.home-cta h2 {
  margin: 0;
  font-size: clamp(1.7rem, 4vw, 2.3rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.home-cta p {
  margin: 0.75rem auto 0;
  max-width: 30rem;
  color: var(--vp-c-text-2);
}
.home-cta-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.7rem;
  margin-top: 1.6rem;
}
.home-btn {
  display: inline-flex;
  align-items: center;
  padding: 0.7rem 1.4rem;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 600;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.2s ease;
}
.home-btn.primary {
  background: linear-gradient(135deg, #2ea043, #3fb950);
  color: #06120a;
  box-shadow: 0 6px 24px rgba(63, 185, 80, 0.35);
}
.home-btn.primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 32px rgba(63, 185, 80, 0.45);
}
.home-btn.ghost {
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-1);
  background: rgba(14, 18, 20, 0.55);
}
.home-btn.ghost:hover {
  border-color: var(--vp-c-brand-3);
  transform: translateY(-2px);
}
</style>
