import { defineConfig } from 'vitepress';

const releaseUrl = 'https://github.com/Figo5/sqlsage/releases';
const repoUrl = 'https://github.com/Figo5/sqlsage';
const npmUrl = 'https://www.npmjs.com/package/sqlsage';

export default defineConfig({
  lang: 'en-US',
  title: 'SQLSage',
  description: 'Correctness-first PostgreSQL query explainer and optimizer',
  base: '/sqlsage/',
  cleanUrls: true,
  lastUpdated: true,

  // Note: the pre-existing docs keep their filenames (and thus their default,
  // uppercase routes) — /ARCHITECTURE, /SUPPORTED, /LIMITATIONS, /USAGE,
  // /AUDIT-2026-08-03, /PRODUCT-ROADMAP — so their internal relative .md links
  // keep resolving without editing those files. A lowercase-route rename can be
  // done later as its own commit.

  head: [
    ['meta', { name: 'theme-color', content: '#3fb950' }],
    ['meta', { property: 'og:title', content: 'SQLSage' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Correctness-first PostgreSQL query explainer and optimizer',
      },
    ],
    ['link', { rel: 'icon', href: '/sqlsage/favicon.svg' }],
  ],

  themeConfig: {
    logo: '/sqlsage/favicon.svg',

    nav: [
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'CLI Reference', link: '/cli-reference' },
      {
        text: 'Tutorials',
        items: [
          { text: '1 · Catching a query that returns the wrong answer', link: '/tutorials/01-wrong-results-not-in' },
          { text: '2 · Fixing a date filter an index cannot help', link: '/tutorials/02-non-sargable-date' },
          { text: '3 · Analyzing a real plan from your own database', link: '/tutorials/03-real-explain-plan' },
        ],
      },
      { text: 'Examples', link: '/examples' },
      { text: 'npm', link: npmUrl },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Home', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'CLI Reference', link: '/cli-reference' },
          { text: 'Examples', link: '/examples' },
        ],
      },
      {
        text: 'Tutorials',
        items: [
          { text: '1 · Wrong results via NOT IN', link: '/tutorials/01-wrong-results-not-in' },
          { text: '2 · A date filter an index cannot help', link: '/tutorials/02-non-sargable-date' },
          { text: '3 · A real plan from your database', link: '/tutorials/03-real-explain-plan' },
        ],
      },
      {
        text: 'Concepts',
        items: [{ text: 'Architecture', link: '/ARCHITECTURE' }],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Supported constructs', link: '/SUPPORTED' },
          { text: 'Limitations & known gaps', link: '/LIMITATIONS' },
          { text: 'Usage & inputs', link: '/USAGE' },
          { text: '2026-08 adversarial audit', link: '/AUDIT-2026-08-03' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Roadmap', link: '/PRODUCT-ROADMAP' },
          { text: 'GitHub', link: repoUrl },
          { text: 'npm package', link: npmUrl },
          { text: 'Releases', link: releaseUrl },
        ],
      },
    ],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/Figo5/sqlsage/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    socialLinks: [{ icon: 'github', link: repoUrl }],

    footer: {
      message: 'MIT licensed · Analyzes PostgreSQL SELECT statements with an honest evidence model.',
      copyright: `Copyright © 2026 Gio Fiore`,
    },
  },
});
