<script setup lang="ts">
import { computed } from 'vue';
import { useData, useRoute } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import AuroraHero from './components/AuroraHero.vue';
import FeatureGrid from './components/FeatureGrid.vue';

const { Layout } = DefaultTheme;
const { frontmatter } = useData();
const route = useRoute();

const isHome = computed(
  () => frontmatter.value.layout === 'home' && route.path === '/',
);
</script>

<template>
  <Layout>
    <template #home-hero>
      <AuroraHero v-if="isHome" />
    </template>
    <template #home-features>
      <FeatureGrid v-if="isHome" />
    </template>
  </Layout>
</template>
