<script setup lang="ts">
const steps = [
  { icon: '⚡', title: 'SQL + Catalog', sub: 'query & metadata' },
  { icon: '🔗', title: 'Bound IR', sub: 'parsed & bound' },
  { icon: '💬', title: 'Explain', sub: 'result grain' },
  { icon: '🚩', title: 'Findings', sub: 'wrong-result first' },
  { icon: '🧱', title: 'Indexes & Rewrites', sub: 'explicit change sets' },
  { icon: '📄', title: 'Report', sub: 'text / markdown / JSON' },
];
</script>

<template>
  <section class="pipeline">
    <div class="pipeline-head">
      <h2 class="pipeline-title">How it works</h2>
      <p class="pipeline-sub">
        One deterministic pipeline — from SQL and metadata to an honest, labeled report.
      </p>
    </div>

    <ol class="pipeline-track">
      <li
        v-for="(s, i) in steps"
        :key="s.title"
        class="pipeline-step"
        :style="{ '--i': i }"
      >
        <div class="node">
          <span class="node-icon">{{ s.icon }}</span>
          <span class="node-title">{{ s.title }}</span>
          <span class="node-sub">{{ s.sub }}</span>
        </div>
        <span v-if="i < steps.length - 1" class="connector" aria-hidden="true">→</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.pipeline {
  padding: 3rem 1.5rem 1rem;
}
.pipeline-head {
  text-align: center;
  margin-bottom: 2rem;
}
.pipeline-title {
  margin: 0;
  font-size: clamp(1.7rem, 4vw, 2.3rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.pipeline-sub {
  margin: 0.5rem auto 0;
  max-width: 30rem;
  color: var(--vp-c-text-2);
}

.pipeline-track {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 0.4rem;
  max-width: 1040px;
  margin: 0 auto;
}
.pipeline-step {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.node {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 0.85rem 0.6rem;
  text-align: center;
  background: linear-gradient(180deg, var(--vp-c-bg-soft), transparent);
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.25s ease;
  animation: rise 0.5s ease both;
  animation-delay: calc(var(--i) * 0.07s);
}
.node:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-3);
  box-shadow: 0 10px 28px -12px rgba(63, 185, 80, 0.4);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.node-icon {
  display: block;
  font-size: 1.3rem;
  margin-bottom: 0.35rem;
}
.node-title {
  display: block;
  font-size: 0.86rem;
  font-weight: 650;
  color: var(--vp-c-text-1);
  letter-spacing: -0.01em;
}
.node-sub {
  display: block;
  margin-top: 0.15rem;
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
}
.connector {
  color: var(--sql-cyan);
  font-size: 1.1rem;
  animation: flow 1.6s ease-in-out infinite;
}
@keyframes flow {
  0%, 100% { opacity: 0.35; transform: translateX(0); }
  50% { opacity: 1; transform: translateX(3px); }
}

@media (max-width: 860px) {
  .pipeline-track {
    flex-direction: column;
    max-width: 380px;
  }
  .pipeline-step { flex-direction: row; }
  .connector { transform: rotate(90deg); }
}
</style>
