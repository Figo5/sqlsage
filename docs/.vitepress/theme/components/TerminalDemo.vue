<script setup lang="ts">
// The signature panel: a `sqlsage demo` run, exactly the home mockup's
// sequence — install + run, parse, catalog bind, grain/shape, the wrong-result
// risk with its evidence label, the rewrite with its evidence label, and the
// report write-out. Pure-CSS staggered reveal; prefers-reduced-motion renders
// the whole session complete.
interface Line {
  html: string;
  cls: string;
}

const lines: Line[] = [
  {
    html: '<span class="q-prompt">$</span> npm install --global sqlsage &amp;&amp; sqlsage demo',
    cls: 'l1',
  },
  { html: '▸ parsing query .......... done', cls: 'l2 q-muted q-indent' },
  { html: '▸ binding to catalog ...... done', cls: 'l3 q-muted q-indent' },
  {
    html: '<span class="q-label">grain</span>&nbsp;&nbsp;&nbsp;&nbsp;1 row per (customer_id, order_id)',
    cls: 'l4 gap-8',
  },
  {
    html: '<span class="q-label">shape</span>&nbsp;&nbsp;&nbsp;&nbsp;Seq Scan → Hash Join → Sort',
    cls: 'l5',
  },
  {
    html: '<span class="q-warn">⚑ wrong-result risk</span> <span class="q-ev">evidence: plan-observed</span>',
    cls: 'l6 gap',
  },
  { html: 'NOT IN excludes all rows when customer_id', cls: 'l7 q-muted q-indent' },
  { html: 'contains any NULL — silently returns 0 rows', cls: 'l8 q-muted q-indent' },
  {
    html: '→ rewrite to <span class="q-prompt">NOT EXISTS</span> <span class="q-ev">evidence: predicted</span>',
    cls: 'l9 q-indent gap-4',
  },
  {
    html: '<span class="q-label">report</span>&nbsp;&nbsp;written → sqlsage-report.json',
    cls: 'l10 gap',
  },
  { html: '<span class="q-prompt">$</span> <span class="q-cursor"></span>', cls: 'l11 gap' },
];
</script>

<template>
  <div class="q-term q-term-demo">
    <div class="q-term-head">
      <div class="q-term-head-left">
        <span class="q-dot"></span><span class="q-dot"></span><span class="q-dot"></span>
        <span class="q-term-title">sqlsage demo</span>
      </div>
      <span class="q-term-tag">offline · no db</span>
    </div>
    <div class="q-term-body">
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="q-line"
        :class="line.cls"
        v-html="line.html"
      />
    </div>
  </div>
</template>

<style scoped>
.q-term-demo .q-line {
  opacity: 0;
  animation: q-reveal 0.4s ease forwards;
}
.l1 { animation-delay: 0.1s; }
.l2 { animation-delay: 0.5s; }
.l3 { animation-delay: 0.85s; }
.l4 { animation-delay: 1.15s; }
.l5 { animation-delay: 1.35s; }
.l6 { animation-delay: 1.75s; }
.l7 { animation-delay: 2.0s; }
.l8 { animation-delay: 2.2s; }
.l9 { animation-delay: 2.6s; }
.l10 { animation-delay: 2.85s; }
.l11 { animation-delay: 3.1s; }

.gap { margin-top: 10px; }
.gap-8 { margin-top: 8px; }
.gap-4 { margin-top: 4px; }

@keyframes q-reveal {
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .q-term-demo .q-line {
    opacity: 1;
    animation: none;
  }
}
</style>
