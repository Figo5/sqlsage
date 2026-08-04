<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';

interface Line {
  text: string;
  cls: string;
}

const lines: Line[] = [
  { text: 'sqlsage demo', cls: 'prompt' },
  { text: '', cls: 'plain' },
  { text: 'SQLSage demo — analyzing the bundled example q05-not-in-nullable:', cls: 'dim' },
  { text: '  Customers with no events, via NOT IN on a nullable column', cls: 'dim' },
  { text: '  No database, no catalog, and no files of your own are involved.', cls: 'dim' },
  { text: '', cls: 'plain' },
  { text: "SELECT c.customer_id, c.email", cls: 'sql' },
  { text: "FROM shop.customers c", cls: 'sql' },
  { text: "WHERE c.customer_id NOT IN (", cls: 'sql' },
  { text: "    SELECT e.customer_id FROM shop.events e", cls: 'sql' },
  { text: "    WHERE e.event_type = 'checkout'", cls: 'sql' },
  { text: ");", cls: 'sql' },
  { text: '', cls: 'plain' },
  { text: 'WRONG RESULTS', cls: 'alert' },
  { text: 'This query returns wrong answers today. Fix that before you spend', cls: 'alert' },
  { text: 'a minute on its speed.', cls: 'alert' },
  { text: '', cls: 'plain' },
  { text: '• Nullable NOT IN subquery can invalidate anti-membership.', cls: 'bullet' },
  { text: '  Catalog stats: 14.5% NULL (~725,170 of 5,000,022 rows)', cls: 'dim' },
  { text: '  for events.customer_id. One NULL is enough.', cls: 'dim' },
  { text: '• Result grain: one row per qualifying customer row.', cls: 'bullet' },
  { text: '', cls: 'plain' },
  { text: 'Recommended fix — use NULL-safe NOT EXISTS anti-membership', cls: 'fix' },
  { text: '  (changes results — review the corrected population).', cls: 'dim' },
  { text: '  Plus partial index on events(customer_id)', cls: 'fix' },
  { text: "  WHERE event_type = 'checkout' AND customer_id IS NOT NULL;", cls: 'fix' },
];

const reducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const done = ref(false);
const visible = ref(0);
const typed = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
let linePause = 0;

function start() {
  done.value = false;
  visible.value = 0;
  typed.value = 0;
  timer = setInterval(tick, 16);
}

function tick() {
  if (visible.value >= lines.length) {
    clearInterval(timer);
    done.value = true;
    return;
  }
  const line = lines[visible.value]!;
  if (typed.value >= line.text.length) {
    visible.value++;
    typed.value = 0;
    linePause = visible.value === 1 ? 6 : 2; // breathe after the command
    return;
  }
  if (linePause > 0) {
    linePause--;
    return;
  }
  typed.value += visible.value === 0 ? 2 : 1;
}

onMounted(() => {
  if (reducedMotion) {
    visible.value = lines.length;
    typed.value = 0;
    done.value = true;
  } else {
    start();
  }
});

onBeforeUnmount(() => clearInterval(timer));

function textOf(i: number): string {
  const line = lines[i]!;
  if (i < visible.value) return line.text;
  if (i === visible.value) return line.text.slice(0, typed.value);
  return '';
}
</script>

<template>
  <div class="terminal-wrap">
    <div class="terminal">
      <div class="term-head">
        <span class="dot r" /><span class="dot y" /><span class="dot g" />
        <span class="term-title">sqlsage demo</span>
        <span class="term-tag">offline · no db</span>
      </div>
      <div class="term-body" aria-label="SQLSage demo terminal output">
        <div
          v-for="(line, i) in lines"
          :key="i"
          class="term-line"
          :class="line.cls"
        >
          <template v-if="i === 0"><span class="prompt-glyph">$ </span>{{ textOf(i) }}</template>
          <template v-else>{{ textOf(i) }}</template>
          <span
            v-if="i === visible.value && !done"
            class="cursor"
          />
        </div>
        <span v-if="done" class="cursor dim" />
      </div>
    </div>
    <button v-if="done" class="replay" type="button" @click="start">
      ↺ replay
    </button>
  </div>
</template>

<style scoped>
.terminal-wrap {
  max-width: 820px;
  margin: 0 auto;
  padding: 0 1.5rem;
}
.terminal {
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background: rgba(7, 9, 10, 0.92);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(63, 185, 80, 0.08);
  font-family: var(--vp-font-family-mono);
  font-size: 0.83rem;
  line-height: 1.6;
  text-align: left;
}
.term-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}
.dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
}
.dot.r { background: #ff5f57; }
.dot.y { background: #febc2e; }
.dot.g { background: #28c840; }
.term-title {
  margin-left: 0.5rem;
  font-size: 0.76rem;
  color: var(--vp-c-text-2);
}
.term-tag {
  margin-left: auto;
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}
.term-body {
  padding: 1rem 1.2rem;
  min-height: 340px;
  white-space: pre-wrap;
  word-break: break-word;
}
.term-line {
  min-height: 1.6em;
  color: var(--vp-c-text-2);
}
.term-line.prompt { color: #e6edf3; }
.prompt-glyph { color: var(--sql-cyan); font-weight: 700; }
.term-line.sql { color: #9ecbff; }
.term-line.dim { color: var(--vp-c-text-3); }
.term-line.alert { color: var(--sql-red); font-weight: 700; }
.term-line.bullet { color: #7ee787; }
.term-line.fix { color: #56d364; }
.cursor {
  display: inline-block;
  width: 0.6em;
  height: 1.05em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--sql-cyan);
  animation: blink 1s steps(1) infinite;
}
.cursor.dim { opacity: 0.5; animation: blink 1.4s steps(1) infinite; }
@keyframes blink {
  50% { opacity: 0; }
}
.replay {
  display: block;
  margin: 0.8rem auto 0;
  border: 1px solid var(--vp-c-divider);
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 0.8rem;
  padding: 0.35rem 0.9rem;
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.replay:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-3);
}

@media (max-width: 640px) {
  .term-body { font-size: 0.74rem; padding: 0.8rem 0.9rem; min-height: 0; }
}
</style>
