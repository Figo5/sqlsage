import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import AuroraHero from './components/AuroraHero.vue';
import FeatureGrid from './components/FeatureGrid.vue';
import TerminalDemo from './components/TerminalDemo.vue';
import PipelineDiagram from './components/PipelineDiagram.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('AuroraHero', AuroraHero);
    app.component('FeatureGrid', FeatureGrid);
    app.component('TerminalDemo', TerminalDemo);
    app.component('PipelineDiagram', PipelineDiagram);
  },
} satisfies Theme;
