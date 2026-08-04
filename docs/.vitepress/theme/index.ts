import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import HomeLanding from './components/HomeLanding.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Registered so `layout: HomeLanding` in a page's frontmatter renders the
    // custom landing page (VPContent resolves any layout name as a component).
    app.component('HomeLanding', HomeLanding);
  },
} satisfies Theme;
