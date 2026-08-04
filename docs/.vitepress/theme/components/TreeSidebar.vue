<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, withBase } from 'vitepress';
import { useSidebar } from 'vitepress/theme';

const { sidebarGroups } = useSidebar();
const route = useRoute();

const groups = computed(() => sidebarGroups.value);

function currentPage(): string {
  // e.g. 'getting-started.md', 'tutorials/01-wrong-results-not-in.md', 'index.md'
  return route.data.relativePath;
}

function isActive(link: string): boolean {
  const current = currentPage();
  const target = link === '/' ? 'index.md' : `${link.replace(/^\//, '')}.md`;
  return current === target;
}

function dirName(text: string): string {
  return `${text.toLowerCase()}/`;
}
</script>

<template>
  <nav class="qtree" aria-label="Docs tree">
    <div class="qtree-path">docs/</div>

    <!-- The first group renders flat (like the mockup's introduction /
         getting-started / connecting links); the rest render as directories
         with ├── / └── children. -->
    <template v-for="(group, gi) in groups" :key="gi">
      <template v-if="group.items?.length">
        <template v-if="gi === 0">
          <div v-for="item in group.items" :key="item.link ?? item.text" class="qtree-row">
            <a
              v-if="item.link"
              :href="withBase(item.link)"
              :class="{ active: isActive(item.link) }"
              >{{ item.text }}</a
            >
          </div>
        </template>
        <template v-else>
          <div class="qtree-dir">{{ dirName(group.text ?? '') }}</div>
          <div v-for="(item, ii) in group.items" :key="item.link ?? item.text" class="qtree-row">
            <span class="qtree-glyph">{{
              ii === group.items.length - 1 ? '└── ' : '├── '
            }}</span>
            <a
              v-if="item.link"
              :href="withBase(item.link)"
              :class="{ active: isActive(item.link) }"
              >{{ item.text }}</a
            >
          </div>
        </template>
      </template>
    </template>
  </nav>
</template>

<style scoped>
.qtree {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 13px;
  line-height: 2.1;
}
.qtree-path {
  color: var(--q-muted);
  font-size: 12px;
  margin-bottom: 10px;
}
.qtree-dir {
  color: var(--q-muted);
  white-space: pre;
}
/* Each row is a flex line: the glyph keeps `white-space: pre` (and never
 * shrinks) so `├── ` / `└── ` alignment is preserved, while the label is a
 * wrapping flex item. Long tutorial titles then wrap inside the sidebar
 * instead of clipping, with continuation lines aligned under the label text
 * (not under the glyph). */
.qtree-row {
  display: flex;
  align-items: baseline;
  color: var(--q-muted);
}
.qtree-glyph {
  flex: 0 0 auto;
  white-space: pre;
  color: var(--q-border);
}
.qtree a {
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--q-muted);
  text-decoration: none;
  text-transform: lowercase;
}
.qtree a:hover {
  color: var(--q-paper);
}
.qtree a.active {
  color: var(--q-green);
}
</style>
