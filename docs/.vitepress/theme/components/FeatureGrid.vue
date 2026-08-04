<script setup lang="ts">
const features = [
  {
    tag: 'correctness',
    title: 'Correctness before speed',
    desc: "A query that silently returns the wrong rows matters more than one that's merely slow — wrong-result risks are flagged first.",
  },
  {
    tag: 'explain',
    title: 'Plain-English explanations',
    desc: 'Result grain, execution shape, and risk — described in words, with the exact SQL and column behind each finding.',
  },
  {
    tag: 'evidence',
    title: 'Honest evidence labels',
    desc: 'Every claim is predicted, plan-observed, measured, or unverified. Nothing over-promises.',
  },
  {
    tag: 'offline',
    title: 'Works completely offline',
    desc: 'Analyze with just schema or catalog metadata. A database connection is optional, and never required.',
  },
  {
    tag: 'actionable',
    title: 'Explicit change sets',
    desc: 'Conservative index recommendations and rewrites — never executed silently, always reviewable.',
  },
  {
    tag: 'json',
    title: 'Machine-readable output',
    desc: 'An evidence bundle you can replay and compare across captures, in text, markdown, or JSON.',
  },
];
</script>

<template>
  <div class="q-features">
    <h2 class="q-features-heading">-- what it does</h2>
    <div class="q-feature-grid">
      <div v-for="f in features" :key="f.tag" class="q-feature">
        <div class="q-tag">{{ f.tag }}</div>
        <div class="q-ftitle">{{ f.title }}</div>
        <p class="q-fdesc">{{ f.desc }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.q-features {
  max-width: 980px;
  margin: 0 auto;
  padding: 0 28px 90px;
}
.q-features-heading {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 500;
  font-size: 14px;
  color: var(--q-muted);
  text-align: center;
  margin-bottom: 36px;
  letter-spacing: 0.02em;
}
.q-feature-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--q-border);
  border: 1px solid var(--q-border);
  border-radius: 7px;
  overflow: hidden;
}
.q-feature {
  background: var(--q-void);
  padding: 26px 24px;
}
.q-tag {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 11px;
  color: var(--q-green);
  margin-bottom: 12px;
  letter-spacing: 0.04em;
}
.q-ftitle {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 14.5px;
  color: var(--q-paper);
  margin-bottom: 8px;
}
.q-fdesc {
  font-size: 14px;
  color: var(--q-muted);
  line-height: 1.6;
  margin: 0;
}

@media (max-width: 700px) {
  .q-feature-grid {
    grid-template-columns: 1fr;
  }
}
</style>
