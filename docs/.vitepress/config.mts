import { defineConfig } from 'vitepress';

const releaseUrl = 'https://github.com/Figo5/sqlsage/releases';
const repoUrl = 'https://github.com/Figo5/sqlsage';
const npmUrl = 'https://www.npmjs.com/package/sqlsage';

// Query-console Shiki theme: SQL keywords read as terminal output — keywords
// in the accent green, strings warm, comments muted, identifiers paper. Unset
// scopes fall through to the default foreground, so the code stays readable.
const queryConsoleTheme = {
  name: 'query-console',
  type: 'dark',
  colors: {
    'editor.background': '#141310',
    'editor.foreground': '#EDE6D6',
  },
  tokenColors: [
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.other',
        'keyword.operator.logical',
        'keyword.operator.comparison',
        'storage',
        'storage.type',
        'storage.modifier',
        'support.type',
        'support.function',
      ],
      settings: { foreground: '#3FB950' },
    },
    { scope: ['string', 'string.quoted', 'string.quoted.single', 'string.quoted.double', 'constant.character.escape'], settings: { foreground: '#D08A3E' } },
    { scope: ['comment', 'comment.block'], settings: { foreground: '#9A927C' } },
    {
      scope: ['entity.name.function', 'function', 'variable.function'],
      settings: { foreground: '#EDE6D6' },
    },
    {
      scope: ['constant.numeric', 'constant', 'number'],
      settings: { foreground: '#EDE6D6' },
    },
    {
      scope: ['variable', 'variable.other', 'variable.parameter', 'identifier'],
      settings: { foreground: '#EDE6D6' },
    },
    {
      scope: ['punctuation', 'operator', 'delimiter', 'meta'],
      settings: { foreground: '#9A927C' },
    },
  ],
} as const;

export default defineConfig({
  lang: 'en-US',
  title: 'SQLSage',
  description: 'Correctness-first PostgreSQL query explainer and optimizer',
  base: '/sqlsage/',
  cleanUrls: true,
  lastUpdated: true,
  // The query-console world is dark-only: warm near-black void, no light theme.
  appearance: 'force-dark',

  // Contributor-facing docs that stay in the repo (and in this tree) but are
  // deliberately excluded from the public site: neither linked nor searchable.
  srcExclude: ['PRODUCT-ROADMAP.md', 'AUDIT-2026-08-03.md', 'RELEASING.md'],

  // Note: the pre-existing docs keep their filenames (and thus their default,
  // uppercase routes) — /ARCHITECTURE, /SUPPORTED, /LIMITATIONS, /USAGE,
  // /AUDIT-2026-08-03, /PRODUCT-ROADMAP — so their internal relative .md links
  // keep resolving without editing those files. A lowercase-route rename can be
  // done later as its own commit.

  head: [
    ['meta', { name: 'theme-color', content: '#0D0C0A' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap',
      },
    ],
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

  markdown: {
    theme: queryConsoleTheme,
  },

  themeConfig: {
    // The custom Layout's two-tone `sql·sage` wordmark (injected via the
    // nav-bar-title-after slot) is the only title. Suppress the default title
    // node entirely rather than hiding it with CSS, and drop the logo — its
    // base-prefixed path made VPImage request /sqlsage/sqlsage/favicon.svg
    // (a 404). The favicon in `head` is the correct browser-tab icon.
    siteTitle: false,

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
        ],
      },
      // The external "Project" group is deliberately absent: GitHub and the npm
      // package already live in the topbar and footer, and the sidebar is a
      // directory tree of doc pages only (per the query-console world).
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
