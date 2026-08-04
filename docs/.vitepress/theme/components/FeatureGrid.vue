<script setup lang="ts">
const features = [
  {
    icon: '🎯',
    tint: '#3fb950',
    title: 'Correctness before speed',
    text: 'Wrong-result and business-intent risks are flagged first — a query that silently returns zero rows matters more than one that runs slowly.',
  },
  {
    icon: '💬',
    tint: '#38bdf8',
    title: 'Plain-English explanations',
    text: 'Result grain, execution shape, and risk — described in words, with the exact SQL and column behind each finding.',
  },
  {
    icon: '🏷️',
    tint: '#a78bfa',
    title: 'Honest evidence labels',
    text: 'Every claim is predicted, plan-observed, measured, or unverified. Nothing over-promises, and result-changing rewrites say so.',
  },
  {
    icon: '📴',
    tint: '#fbbf24',
    title: 'Works completely offline',
    text: 'Analyze with just schema or catalog metadata. A database connection is optional — and connected mode never executes your query by default.',
  },
  {
    icon: '⚙️',
    tint: '#f472b6',
    title: 'Actionable output',
    text: 'Conservative index recommendations and rewrites as explicit change sets — never executed silently, always reviewable.',
  },
  {
    icon: '🔁',
    tint: '#34d399',
    title: 'Machine-readable JSON',
    text: 'JSON output is a reusable evidence bundle you can replay and compare across captures.',
  },
];
</script>

<template>
  <section class="feature-section">
    <div class="feature-head">
      <h2 class="feature-title">What it does</h2>
      <p class="feature-sub">
        A deterministic pipeline over PostgreSQL SQL and metadata — fully offline.
      </p>
    </div>
    <div class="feature-grid">
      <article
        v-for="f in features"
        :key="f.title"
        class="feature-card"
        :style="{ '--tint': f.tint }"
      >
        <div class="feature-icon" :style="{ background: `${f.tint}22`, color: f.tint }">
          {{ f.icon }}
        </div>
        <h3 class="feature-name">{{ f.title }}</h3>
        <p class="feature-text">{{ f.text }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.feature-section {
  padding: 3.5rem 1.5rem 2rem;
}
.feature-head {
  text-align: center;
  margin-bottom: 2rem;
}
.feature-title {
  margin: 0;
  font-size: clamp(1.7rem, 4vw, 2.3rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.feature-sub {
  margin: 0.5rem auto 0;
  max-width: 30rem;
  color: var(--vp-c-text-2);
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  max-width: 1080px;
  margin: 0 auto;
}
.feature-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  padding: 1.4rem 1.3rem;
  background: linear-gradient(180deg, var(--vp-c-bg-soft), transparent);
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.25s ease;
}
.feature-card:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--tint) 45%, transparent);
  box-shadow: 0 12px 34px -12px color-mix(in srgb, var(--tint) 40%, transparent);
}
.feature-icon {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-size: 1.25rem;
  margin-bottom: 0.9rem;
}
.feature-name {
  margin: 0 0 0.4rem;
  font-size: 1.05rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.feature-text {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

@media (max-width: 900px) {
  .feature-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .feature-grid { grid-template-columns: 1fr; }
}
</style>
