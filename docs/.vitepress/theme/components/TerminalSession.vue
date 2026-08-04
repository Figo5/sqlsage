<script setup lang="ts">
// Reusable terminal-session frame for authoring real console output in
// markdown. The frame (head + tag) is rendered here; the body is the slot, so
// authors can drop prompt lines, highlighted SQL (class `q-kw`), result
// tables (class `q-result` + `q-row-count`) and the `q-cursor` marker inside.
// All `q-*` terminal styles live in custom.css so slotted content is styled too.
withDefaults(
  defineProps<{
    title?: string;
    tag?: string;
  }>(),
  {
    title: 'session',
    tag: 'offline',
  },
);
</script>

<template>
  <div class="q-term">
    <div class="q-term-head">
      <span class="q-term-title">{{ title }}</span>
      <span class="q-term-tag">{{ tag }}</span>
    </div>
    <div class="q-term-body">
      <slot />
    </div>
  </div>
</template>
