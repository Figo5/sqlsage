---
name: SQLSage
description: Correctness-first PostgreSQL query explainer and optimizer — docs read as a live query-console session
colors:
  void: "#0d0c0a"
  void-raised: "#141310"
  paper: "#ede6d6"
  muted: "#9a927c"
  green: "#3fb950"
  green-dim: "#1f5c2c"
  amber: "#d08a3e"
  border: "#282419"
typography:
  display:
    fontFamily: "IBM Plex Mono, ui-monospace, ui-sans-serif, system-ui, monospace"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.01em"
  headline:
    fontFamily: "IBM Plex Mono, ui-monospace, ui-sans-serif, system-ui, monospace"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
  title:
    fontFamily: "IBM Plex Mono, ui-monospace, ui-sans-serif, system-ui, monospace"
    fontSize: "14.5px"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "'Source Serif 4', Georgia, 'Times New Roman', serif"
    fontSize: "16.5px"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, ui-sans-serif, system-ui, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    letterSpacing: "0.08em"
    textTransform: "lowercase"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.85
rounded:
  xs: "4px"
  sm: "6px"
  md: "7px"
  pill: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.25rem"
  2xl: "1.5rem"
  3xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.green-dim}"
    textColor: "{colors.paper}"
    rounded: "{rounded.xs}"
    padding: "10px 18px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.xs}"
    padding: "10px 18px"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.xs}"
    padding: "4px 10px"
  terminal-window:
    backgroundColor: "{colors.void-raised}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "20px 22px"
  feature-card:
    backgroundColor: "{colors.void}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "26px 24px"
  breadcrumb:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
  tree-sidebar:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
---

# Design System: SQLSage (Query Console)

## Overview

**Creative North Star: "The Query Console"**

SQLSage's documentation is a terminal you can read. Every page sits inside a warm
near-black console — serif prose for the reading voice, IBM Plex Mono for all the
chrome — with a single green accent that means "correctness, active, go." The reader
is never handed a brochure; they are handed a session. The topbar carries the two-tone
`sql·sage` wordmark, the sidebar is a directory tree (`docs/`, `├──` and `└──` glyphs),
and every page opens with a psql-style breadcrumb: `sqlsage=# \d docs.getting-started`.

The density is quiet and ordered: one idea per card, tight mono headings, generous
serif lines capped at ~62ch. Surfaces are flat, separated by tone and hairline rules
rather than shadows or glow. Nothing flashes; the only motion is the terminal cursor's
blink and the home demo's slow line-by-line reveal. Green is reserved for the accent —
prompts, keywords, active nav, primary action — and amber appears only where the tool
is flagging a wrong-result risk or safety warning.

**Key Characteristics:**
- A console session as a reading experience, not a marketing page
- Warm near-black void (`#0d0c0a`) with paper ink (`#ede6d6`)
- Serif prose (Source Serif 4) inside mono chrome (IBM Plex Mono)
- One green accent for correctness and action; amber for warnings only
- Flat surfaces and hairline rules — no glow, no gradient, no light theme

## Colors

A warm, dark, quiet palette. The page is near-black with a faint warm cast; ink is a
warm off-white; green is the single accent; amber is the only alert color.

### Primary
- **Green** (#3fb950): The one accent. Prompts, SQL keywords, active nav and tree
  links, primary-button border, inline code, link text, feature tags. Means "correct."
- **Green Dim** (#1f5c2c): Primary-button fill, selection, heading dashes. The dark
  green that carries paper text on a primary action.

### Alert
- **Amber** (#d08a3e): Warnings and wrong-result alerts only — custom-block borders,
  the terminal's `⚑` risk line. Never a decorative accent.

### Neutral
- **Void** (#0d0c0a): The page background. Warm near-black, the console's dark.
- **Void Raised** (#141310): Surfaces one tone up — terminal, cards, code blocks,
  dropdowns, search modal, custom blocks.
- **Paper** (#ede6d6): Primary ink. Prose, headings (below h1), terminal output.
- **Muted** (#9a927c): Secondary ink — nav links, tags, labels, metadata, breadcrumb.
- **Border** (#282419): Hairline rules — dividers, frames, button borders.

### Named Rules
**The Single-Accent Rule.** Green is the only accent color, and amber is the only
alert color; the two never trade jobs and nothing decorative borrows either. A page
that needs a second accent is a page the design system is already failing.

## Typography

**Body Font:** Source Serif 4 (with Georgia / Times fallbacks)
**Chrome Font:** IBM Plex Mono (with ui-monospace fallbacks)

**Character:** The reading voice is a warm serif; everything machine-shaped — headings,
topbar, sidebar, breadcrumb, badges, code, tables, terminal, footers — is IBM Plex
Mono. Headings are mono at 500 weight and read as SQL comments: `-- Title`. This is the
product voice: a query console where prose is what the tool explains and mono is what
the tool prints.

### Hierarchy
- **Display** (Mono 500, 26px, 1.35): Page titles — the h1, in Green with a Green Dim
  `-- ` dash. The one green headline in the system.
- **Headline** (Mono 500, 17px, 1.4): Section headings — h2, in Paper with a dim dash.
- **Title** (Mono 500, 14.5px, 1.4): Card and feature titles, in Paper.
- **Body** (Source Serif 4, 16.5px, 1.75): Prose and lead paragraphs, in Paper,
  capped at ~62ch. Secondary copy in Muted.
- **Label** (Mono 400, 12.5px, +0.08em, lowercase): Eyebrows, feature tags, metadata.
- **Mono** (13px, 1.85): Terminal output, code, tables, badges, tree, breadcrumb. The
  product voice for everything machine-shaped.

### Named Rules
**The Console Voice Rule.** Anything machine-shaped — commands, badges, headings, tree,
breadcrumb, terminal output, code, tables — is set in the mono stack; prose is the only
serif. Headings are mono because they are comments a session would print.

## Layout

A single dark column. The home page centers a hero (eyebrow, display headline, badges,
primary + ghost CTAs, terminal demo, feature grid) inside the VitePress shell. Doc
pages use the console chrome: a topbar with the two-tone wordmark and mono nav links; a
left tree sidebar (`docs/` path, `├──`/`└──` glyphs, lowercase links, active in Green);
a breadcrumb under the nav (`sqlsage=# \d docs.<page>`, with a right-aligned
`offline-first · v0.2.1` status); and the doc body with the `-- Title` heading, serif
prose, terminal-framed code, and result-table-styled markdown tables.

Widths: the layout caps at 1440px, the sidebar at 272px, prose at ~62ch, the home
terminal demo at 640px. The world is **dark-only** (`appearance: 'force-dark'`); there
is no light theme, and the token bindings are mirrored under `.dark` so the site never
falls back to a light theme's variables. The feature grid runs 3 columns and collapses
to 1 at ≤700px. Motion respects `prefers-reduced-motion`.

## Elevation & Depth

**Tone, not light.** Depth is carried entirely by surface tone (Void → Void Raised) and
by hairline rules (Border). There are no shadows, no glow-on-hover, no gradient fills.
The only "lift" is a border or text-color change on hover — a ghost button's border
goes Green, a tree link goes Paper, the terminal's copy button goes Green. Selection is
Green Dim on Paper. The terminal is the one object that feels raised, and it is raised
by tone alone (Void Raised fill), not by a drop shadow.

### Named Rules
**The Flat-Surface Rule.** No surface carries a static or hover shadow; no element uses
gradient or glow. Elevation is a lighter surface tone, and state is a border or ink
change — nothing floats.

## Shapes

Small, quiet radii: 4px on badges, chips, buttons, and the search/kbd keys; 6px on
terminal sessions, code blocks, custom blocks, the pager links, and the feature grid;
7px on the home terminal frame. Borders are 1px hairline rules in Border. The feature
grid is a 1px hairline lattice (gap: 1px, background: Border) with Void cells. The
terminal is a framed mono surface: a head bar (title + tag chip) over the body.

## Components

### Topbar
The VitePress nav restyled as console chrome. The two-tone wordmark `sql` (Paper)
`sage` (Green) replaces the logo + title. Nav links are mono, Muted → Paper on hover,
active in Green. The search button is a bordered mono chip with its ⌘K keys; its border
goes Green on hover. A hairline Border rule sits under the bar.

### Tree Sidebar
Replaces the default VitePress sidebar groups (injected through the Layout's
`sidebar-nav-before` slot; the default groups are hidden). A mono directory tree: a
Muted `docs/` path line, the first group rendered flat (Home, Getting Started, …), and
every later group as a lowercase `dirname/` with `├──`/`└──` glyphs in Border. Links are
Muted → Paper on hover, active in Green.

### Breadcrumb
Under the topbar on every doc page: `sqlsage=#` (Green prompt) `\d docs.<page>` (Muted)
with a right-aligned Muted status, `offline-first · v0.2.1`. Reads as the session's
current object.

### Headings
Mono, 500 weight, prefixed with a `-- ` dash in Green Dim. The h1 is Green; deeper
levels are Paper. The dash makes every section title read as an SQL comment.

### Prose
Source Serif 4, Paper, 16.5px at 1.75, capped at ~62ch. Links are Green with a Border
underline that shifts to Green on hover; `strong` stays Paper at 500.

### Inline Code
A bordered mono chip: Void Raised fill, 1px Border rule, 4px radius, Green text.

### Code Blocks
Terminal-session chrome: Void Raised fill, 1px Border rule, 6px radius, a 34px header
bar with the lowercase language label (Mono, Muted) and a bordered copy button that
goes Green on hover. Syntax colors come from the bundled `query-console` Shiki theme —
keywords Green, strings Amber, comments Muted, punctuation Muted, identifiers Paper —
all unset scopes falling through to Paper.

### Tables
Result-table chrome: mono, Paper data, Muted headers at 400, hairline Border rules
between rows. Reads like a terminal's query result.

### Custom Blocks
Terminal alerts: framed mono surfaces with a `⚑ ` marker and a type-tinted border —
Tip and Info in Green, Warning and Danger in Amber. The title is a lowercase mono label
in the border's color; the body is Muted.

### Terminal Session
The signature frame (TerminalDemo on the home page, TerminalSession for reusable
markdown authoring). Void Raised fill, 1px Border rule, 6px radius. The head bar holds
three Border dots, a Muted mono title, and a bordered tag chip (`offline · no db`). The
body is mono at 13px: Green prompts and keywords, Paper output, Muted labels, Amber
`⚑` risk lines, Green Dim evidence labels, and a Green block cursor that blinks at
1s step-start. On the home page the lines reveal one at a time (0.4s ease, staggered);
`prefers-reduced-motion` renders the full session instantly.

### Feature Cards
A 3-column hairline lattice. Each cell (Void) holds a mono Green tag, a mono Paper
title, and serif Muted description. Hover keeps the cell flat — no lift, no glow.

### Buttons
Mono, 13.5px, 4px radius. **Primary:** Green Dim fill, Green border, Paper text — the
one action. **Ghost:** transparent, Border rule, Muted text; on hover the border goes
Green and the text Paper. No gradient, no glow.

### Footer
A hairline-top mono footer: `MIT licensed · Analyzes PostgreSQL SELECT statements…`
and `© 2026 Gio Fiore`, both Muted, links Green.

## Do's and Don'ts

### Do:
- **Do** keep every surface flat and separate it with tone and hairline rules — never
  shadow, glow, or gradient.
- **Do** set all machine-shaped type — headings, topbar, sidebar, breadcrumb, badges,
  code, tables, terminal, footer — in IBM Plex Mono, and all prose in Source Serif 4.
- **Do** reserve Green for the single accent (correctness, active, primary action) and
  Amber exclusively for warnings and wrong-result alerts.
- **Do** cap prose at ~62ch and keep the reading column narrow.
- **Do** keep the world dark-only; there is no light theme.
- **Do** honor `prefers-reduced-motion` — the terminal demo must render its full output
  instantly when reduced motion is requested.

### Don't:
- **Don't** add a second accent; Green is the only accent and Amber is alert-only.
- **Don't** use gradient text, glow, or drop shadows anywhere.
- **Don't** mix Inter back in — the world is IBM Plex Mono + Source Serif 4.
- **Don't** widen prose beyond ~62ch.
- **Don't** let amber appear on anything that is not a warning or wrong-result alert.
