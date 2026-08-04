<script setup lang="ts">
const badges = [
  { label: 'npm 0.2.1', href: 'https://www.npmjs.com/package/sqlsage', tone: 'npm' },
  { label: 'CI passing', href: 'https://github.com/Figo5/sqlsage/actions', tone: 'ci' },
  { label: 'MIT license', href: 'https://github.com/Figo5/sqlsage/blob/main/LICENSE', tone: 'mit' },
  { label: 'PostgreSQL', href: 'https://www.postgresql.org/', tone: 'pg' },
];
</script>

<template>
  <section class="aurora-hero sql-noise">
    <div class="aurora-bg" aria-hidden="true">
      <div class="blob b1" />
      <div class="blob b2" />
      <div class="blob b3" />
      <div class="grid-line grid-h" />
      <div class="grid-line grid-v" />
    </div>

    <div class="hero-inner">
      <div class="hero-copy">
        <div class="eyebrow">
          <span class="eyebrow-dot" />Correctness-first · offline-first · PostgreSQL
        </div>

        <h1 class="title">SQLSage</h1>
        <p class="tagline">
          Explain your PostgreSQL query, and know it's
          <span class="accent">right</span> before you make it fast.
        </p>

        <div class="badges">
          <a
            v-for="b in badges"
            :key="b.label"
            class="badge"
            :class="`tone-${b.tone}`"
            :href="b.href"
            target="_blank"
            rel="noopener"
          >{{ b.label }}</a>
        </div>

        <div class="actions">
          <a class="btn primary" href="/getting-started">Get Started</a>
          <a class="btn ghost" href="/tutorials/01-wrong-results-not-in">Walk through a bug</a>
          <a class="btn ghost" href="https://github.com/Figo5/sqlsage" target="_blank" rel="noopener">
            GitHub ↗
          </a>
        </div>

        <div class="install-pill" aria-label="Install command">
          <span class="prompt">$</span>
          <code>npm install --global sqlsage</code>
          <span class="and">&amp;&amp;</span>
          <code>sqlsage demo</code>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.aurora-hero {
  position: relative;
  overflow: hidden;
  padding: 6.5rem 1.5rem 4.5rem;
  text-align: center;
}

.aurora-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.5;
  will-change: transform;
}

.b1 {
  width: 560px;
  height: 560px;
  left: -140px;
  top: -200px;
  background: radial-gradient(circle at 30% 30%, rgba(63, 185, 80, 0.55), transparent 65%);
  animation: drift1 22s ease-in-out infinite alternate;
}
.b2 {
  width: 520px;
  height: 520px;
  right: -160px;
  top: -120px;
  background: radial-gradient(circle at 60% 40%, rgba(56, 189, 248, 0.4), transparent 65%);
  animation: drift2 26s ease-in-out infinite alternate;
}
.b3 {
  width: 620px;
  height: 620px;
  left: 18%;
  bottom: -320px;
  background: radial-gradient(circle at 50% 50%, rgba(167, 139, 250, 0.28), transparent 65%);
  animation: drift3 30s ease-in-out infinite alternate;
}

@keyframes drift1 {
  0%   { transform: translate(0, 0) scale(1); }
  100% { transform: translate(70px, 40px) scale(1.12); }
}
@keyframes drift2 {
  0%   { transform: translate(0, 0) scale(1.05); }
  100% { transform: translate(-60px, 50px) scale(0.95); }
}
@keyframes drift3 {
  0%   { transform: translate(0, 0) scale(0.95); }
  100% { transform: translate(40px, -40px) scale(1.1); }
}

.grid-line {
  position: absolute;
  opacity: 0.5;
}
.grid-h {
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(63, 185, 80, 0.4), transparent);
}
.grid-v {
  top: 0;
  bottom: 0;
  right: 12%;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(56, 189, 248, 0.25), transparent);
}

.hero-inner {
  position: relative;
  z-index: 1;
  max-width: 920px;
  margin: 0 auto;
}

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
  margin-bottom: 1.2rem;
  padding: 0.35rem 0.8rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: rgba(14, 18, 20, 0.6);
  backdrop-filter: blur(6px);
}
.eyebrow-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sql-cyan);
  box-shadow: 0 0 12px var(--sql-cyan);
  animation: pulse 2.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}

.title {
  margin: 0;
  font-size: clamp(3.4rem, 9vw, 6.2rem);
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.04em;
  background: linear-gradient(120deg, #e6edf3 30%, #4fd16c 70%, #38bdf8);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 2px 30px rgba(63, 185, 80, 0.25));
}

.tagline {
  margin: 1.4rem auto 0;
  max-width: 34rem;
  font-size: 1.2rem;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
.tagline .accent {
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
  margin: 1.6rem 0 0;
}
.badge {
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  padding: 0.28rem 0.7rem;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: transform 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.badge:hover {
  transform: translateY(-1px);
  border-color: var(--vp-c-brand-3);
  color: var(--vp-c-text-1);
}
.tone-npm { border-left: 2px solid #cb3837; }
.tone-ci { border-left: 2px solid #3fb950; }
.tone-mit { border-left: 2px solid #fbbf24; }
.tone-pg { border-left: 2px solid #38bdf8; }

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.7rem;
  margin-top: 2rem;
}
.btn {
  display: inline-flex;
  align-items: center;
  padding: 0.7rem 1.4rem;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 600;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease;
}
.btn.primary {
  background: linear-gradient(135deg, #2ea043, #3fb950);
  color: #06120a;
  box-shadow: 0 6px 24px rgba(63, 185, 80, 0.35);
}
.btn.primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 32px rgba(63, 185, 80, 0.45);
}
.btn.ghost {
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-1);
  background: rgba(14, 18, 20, 0.55);
  backdrop-filter: blur(6px);
}
.btn.ghost:hover {
  border-color: var(--vp-c-brand-3);
  transform: translateY(-2px);
}

.install-pill {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 2.2rem;
  padding: 0.7rem 1.1rem;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: rgba(7, 9, 10, 0.75);
  font-family: var(--vp-font-family-mono);
  font-size: 0.86rem;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}
.prompt {
  color: var(--sql-cyan);
  font-weight: 700;
}
.install-pill code {
  color: var(--vp-c-text-1);
  background: none;
  padding: 0;
}
.install-pill .and {
  color: var(--vp-c-text-3);
}

@media (max-width: 640px) {
  .aurora-hero { padding: 4.5rem 1rem 3.5rem; }
  .tagline { font-size: 1.05rem; }
  .install-pill { font-size: 0.76rem; }
}
</style>
