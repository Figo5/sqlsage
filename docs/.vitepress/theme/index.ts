import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import HomeLanding from './components/HomeLanding.vue';
import TerminalSession from './components/TerminalSession.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    // Registered so `layout: HomeLanding` in a page's frontmatter renders the
    // custom landing page (VPContent resolves any layout name as a component).
    app.component('HomeLanding', HomeLanding);
    // Reusable terminal-session frame for authoring real console output in
    // markdown (prompt lines, highlighted SQL, result tables, blinking cursor).
    app.component('TerminalSession', TerminalSession);
  },
} satisfies Theme;
