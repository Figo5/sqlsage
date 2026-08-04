<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vitepress';

const route = useRoute();

// The current page read as a psql object: getting-started → docs.getting-started,
// tutorials/01-wrong-results-not-in → docs.tutorials.01-wrong-results-not-in.
const object = computed(() => {
  const rel = route.data.relativePath.replace(/\.md$/, '');
  if (!rel || rel === 'index') return 'docs';
  return `docs.${rel.replace(/\//g, '.')}`;
});
</script>

<template>
  <div class="q-crumb">
    <span class="q-prompt">sqlsage=#</span>
    <span class="q-cmd">\d {{ object }}</span>
    <span class="q-status">offline-first · v0.2.1</span>
  </div>
</template>

<style scoped>
.q-crumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 12.5px;
  color: var(--q-muted);
  margin-bottom: 28px;
}
.q-prompt {
  color: var(--q-green);
}
.q-cmd {
  color: var(--q-muted);
}
.q-status {
  margin-left: auto;
  color: var(--q-muted);
}
</style>
