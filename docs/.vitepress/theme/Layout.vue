<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import TreeSidebar from './components/TreeSidebar.vue';
import Breadcrumb from './components/Breadcrumb.vue';
</script>

<template>
  <DefaultTheme.Layout>
    <!-- Two-tone brand (sql·sage) replaces the default nav title; the default
         title node is suppressed via `siteTitle: false` and the logo removed,
         so this wordmark is the only content of the home link. It is not
         aria-hidden: with the title and logo gone, its text ("sqlsage") is the
         link's accessible name. -->
    <template #nav-bar-title-after>
      <span class="q-brand">sql<span class="q-brand-sage">sage</span></span>
    </template>
    <!-- The query-console tree sidebar replaces the default VPSidebar nav in
         both the desktop aside and the mobile drawer. VitePress's Layout has
         no `sidebar-nav` slot — only `sidebar-nav-before`/`sidebar-nav-after`
         around the hardcoded VPSidebarGroup — so the tree is injected through
         `sidebar-nav-before` and the default groups are hidden in custom.css. -->
    <template #sidebar-nav-before><TreeSidebar /></template>
    <!-- The psql-style breadcrumb leads every doc page. The home layout is
         custom, so this slot never renders there. -->
    <template #doc-before><Breadcrumb /></template>
  </DefaultTheme.Layout>
</template>
