---
layout: home
title: SQLSage
titleTemplate: Correctness-first PostgreSQL query explainer

hero:
  name: SQLSage
  text: Explain and optimize PostgreSQL queries
  tagline: A correctness-first CLI. It tells you when a query returns the wrong answer before it tells you it is slow, and it labels every claim as predicted, plan-observed, measured, or unverified.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Tutorials
      link: /tutorials/01-wrong-results-not-in
    - theme: alt
      text: View on GitHub
      link: https://github.com/Figo5/sqlsage

features:
  - title: Correctness before speed
    details: Wrong-result and business-intent risks are flagged first. A query that silently returns zero rows is more important than one that runs slowly.
  - title: Plain-English explanations
    details: Describes the result grain, the execution shape, and the risks in words — with the exact SQL and column that drive each finding.
  - title: Honest evidence labels
    details: Every claim is labeled predicted, plan-observed, measured, or unverified. Nothing over-promises, and rewrites that change results say so.
  - title: Works offline
    details: Analyze a query with just schema or catalog metadata. A database connection is optional, and connected mode never executes your query by default.
  - title: Actionable output
    details: Conservative index recommendations and rewrites as explicit change sets — never executed silently, always reviewable.
  - title: Machine-readable
    details: JSON output is a reusable evidence bundle you can replay and compare across captures.
---

<script setup>
import { VPButton } from 'vitepress/theme';
</script>

<div class="quickstart">
  <h2>Try it in 30 seconds</h2>
  <p class="lead">
    One command, no files, no database. SQLSage analyzes a bundled query that
    silently returns the wrong answer — and explains why.
  </p>
  <div class="quickstart-cards">
    <div class="card">
      <div class="card-head">Install</div>
      <pre class="card-body"><code>npm install --global sqlsage
sqlsage --version</code></pre>
    </div>
    <div class="card">
      <div class="card-head">Run the demo</div>
      <pre class="card-body"><code>sqlsage demo</code></pre>
      <div class="card-note">No database, no catalog, no files involved.</div>
    </div>
    <div class="card">
      <div class="card-head">Analyze your own query</div>
      <pre class="card-body"><code>sqlsage analyze --query query.sql --schema schema.sql</code></pre>
      <div class="card-note">Offline. See <a href="/getting-started">Getting Started</a>.</div>
    </div>
  </div>
</div>

<style scoped>
.quickstart {
  margin-top: 3rem;
  padding: 0 1.5rem;
}
.quickstart h2 {
  font-size: 1.7rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}
.lead {
  max-width: 42rem;
  opacity: 0.75;
  margin-bottom: 1.5rem;
}
.quickstart-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1rem;
}
.card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  overflow: hidden;
}
.card-head {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.7;
  padding: 0.6rem 1rem 0.25rem;
}
.card-body {
  margin: 0;
  padding: 0.4rem 1rem 0.75rem;
  font-size: 0.85rem;
  overflow-x: auto;
}
.card-note {
  font-size: 0.8rem;
  opacity: 0.65;
  padding: 0 1rem 0.75rem;
}
@media (max-width: 720px) {
  .quickstart { padding: 0; }
}
</style>
