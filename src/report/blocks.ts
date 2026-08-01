/**
 * A tiny document model shared by both output formats.
 *
 * The point of this layer is that markdown and terminal renderings can never
 * drift in *content*: `index.ts` builds one `Block[]` and the two renderers
 * below only decide how it looks. Adding a section to one format and forgetting
 * the other is structurally impossible.
 *
 * Inline markup is a deliberate two-character subset of markdown:
 *   `code`   -> cyan in the terminal, backticks in markdown
 *   **bold** -> bold in the terminal, ** in markdown
 * Anything richer belongs in a block, not in a string.
 */

export type Tone = 'critical' | 'warn' | 'info' | 'good' | 'muted' | 'plain';

export interface ListItem {
  text: string;
  tone?: Tone;
  /** Secondary lines rendered under the item, indented. */
  sub?: string[];
}

export type Block =
  | { kind: 'title'; text: string; subtitle?: string }
  | { kind: 'banner'; tone: Tone; label: string; text: string }
  | { kind: 'heading'; level: 2 | 3; text: string; badges?: string[] }
  | { kind: 'para'; text: string; tone?: Tone }
  | { kind: 'list'; ordered?: boolean; items: ListItem[] }
  | { kind: 'code'; lang: 'sql' | 'text'; code: string }
  | { kind: 'note'; tone: Tone; label: string; text: string }
  | { kind: 'rule' };

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/**
 * Escape terminal-control bytes supplied by analyzers, SQL comments, catalog
 * names, or API callers. Newlines and tabs are retained only for code blocks;
 * every other C0/C1 byte becomes a visible `\\xNN` token. This runs before M7
 * adds any trusted ANSI styling, so `color: false` is control-byte free and
 * stripping M7's ANSI from colored output still yields the plain output.
 */
export function escapeControls(value: unknown, preserveCodeLayout = false): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
    if (preserveCodeLayout && (ch === '\n' || ch === '\t')) return ch;
    if (!preserveCodeLayout && (ch === '\n' || ch === '\t')) return ' ';
    return `\\x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

/**
 * Greedy wrap with a hanging indent. Never loops forever on a long unbreakable
 * token (a URL or a SQL fragment) — such a token simply overflows its line.
 */
export function wrap(text: string, width: number, indent = 0, firstIndent = indent): string[] {
  const pad = ' '.repeat(Math.max(0, indent));
  const firstPad = ' '.repeat(Math.max(0, firstIndent));
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = '';
  let curPad = firstPad;
  for (const w of words) {
    if (cur === '') {
      cur = w;
      continue;
    }
    if (curPad.length + cur.length + 1 + w.length <= width) {
      cur += ' ' + w;
    } else {
      lines.push(curPad + cur);
      curPad = pad;
      cur = w;
    }
  }
  lines.push(curPad + cur);
  return lines;
}

function text(value: unknown): string {
  return escapeControls(value, false);
}

function code(value: unknown): string {
  return escapeControls(value, true);
}

/**
 * CommonMark fenced blocks may contain backticks, provided the surrounding
 * fence is longer than every backtick run in the payload. Computing the fence
 * after control escaping keeps executable SQL/DDL byte-for-byte copyable while
 * preventing a SQL comment or literal from escaping into report markup.
 */
function markdownFence(payload: string): string {
  let longest = 0;
  for (const run of payload.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const ESC = '\u001b[';
const A = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  cyan: `${ESC}36m`,
  reverse: `${ESC}7m`,
};

const TONE_COLOR: Record<Tone, string> = {
  critical: A.red,
  warn: A.yellow,
  info: A.blue,
  good: A.green,
  muted: A.dim,
  plain: '',
};

/**
 * Colour support detection. This is the only place the module looks at the
 * environment, it is overridable via `opts.color`, and it can change escape
 * codes only — never a single character of report content.
 */
export function detectColor(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined>; stdout?: { isTTY?: boolean } } })
    .process;
  if (!env) return false;
  const e = env.env ?? {};
  if (e.NO_COLOR !== undefined && e.NO_COLOR !== '') return false;
  if (e.FORCE_COLOR !== undefined) return e.FORCE_COLOR !== '0' && e.FORCE_COLOR !== 'false';
  if (e.TERM === 'dumb') return false;
  return env.stdout?.isTTY === true;
}

/**
 * Expands the inline `code` / **bold** subset for the terminal.
 *
 * Plain terminal output deliberately drops the markdown delimiters. This
 * makes colour a presentation-only choice: stripping ANSI from coloured
 * output yields byte-for-byte the same text as `color: false`.
 */
function inline(s: string, color: boolean): string {
  return s
    .replace(/`([^`]+)`/g, (_m, t: string) => (color ? `${A.cyan}${t}${A.reset}` : t))
    .replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => (color ? `${A.bold}${t}${A.reset}` : t));
}

function paint(s: string, code: string, color: boolean): string {
  if (!color || !code) return s;
  return `${code}${s}${A.reset}`;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function renderMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'title':
        out.push(`# ${text(b.text)}`);
        if (b.subtitle) out.push(`*${text(b.subtitle)}*`);
        break;
      case 'banner': {
        const lines = [`> ## ${text(b.label)}`, `>`, `> ${text(b.text)}`];
        out.push(lines.join('\n'));
        break;
      }
      case 'heading': {
        const badges = b.badges?.length ? '  ' + b.badges.map((x) => `\`${text(x)}\``).join(' ') : '';
        out.push(`${'#'.repeat(b.level)} ${text(b.text)}${badges}`);
        break;
      }
      case 'para':
        out.push(text(b.text));
        break;
      case 'list': {
        const lines: string[] = [];
        b.items.forEach((it, i) => {
          const marker = b.ordered ? `${i + 1}.` : '-';
          lines.push(`${marker} ${text(it.text)}`);
          const nestedIndent = ' '.repeat(marker.length + 1);
          for (const s of it.sub ?? []) lines.push(`${nestedIndent}- ${text(s)}`);
        });
        out.push(lines.join('\n'));
        break;
      }
      case 'code': {
        const payload = code(b.code).replace(/\s+$/, '');
        const fence = markdownFence(payload);
        out.push(fence + b.lang + '\n' + payload + '\n' + fence);
        break;
      }
      case 'note':
        out.push(`> **${text(b.label)}:** ${text(b.text)}`);
        break;
      case 'rule':
        out.push('---');
        break;
    }
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

/**
 * ASCII-only structure (no box drawing, no emoji) so the output survives dumb
 * terminals, pipes, CI logs and copy-paste into a ticket.
 */
export function renderTerminal(blocks: Block[], color: boolean, width: number): string {
  const requestedWidth = Number.isFinite(width) ? Math.trunc(width) : 80;
  const w = Math.max(40, Math.min(requestedWidth, 120));
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'title': {
        const title = text(b.text);
        push(paint(title, A.bold, color));
        push(paint('='.repeat(Math.min(w, Math.max(title.length, 24))), A.dim, color));
        if (b.subtitle) {
          for (const l of wrap(text(b.subtitle), w)) push(paint(l, A.dim, color));
        }
        blank();
        break;
      }
      case 'banner': {
        blank();
        const label = text(b.label);
        push(color ? `${A.bold}${TONE_COLOR[b.tone]}${A.reverse}${label}${A.reset}` : label);
        for (const l of wrap(text(b.text), w)) push(inline(paint(l, b.tone === 'critical' ? A.bold : '', color), color));
        blank();
        break;
      }
      case 'heading': {
        blank();
        const indent = b.level === 3 ? '  ' : '';
        for (const line of wrap(text(b.text), w, indent.length, indent.length)) {
          push(paint(line, A.bold, color));
        }
        if (b.badges?.length) {
          const badges = b.badges.map((x) => `[${text(x)}]`).join(' ');
          for (const line of wrap(badges, w, indent.length + 2, indent.length + 2)) {
            push(paint(line, A.dim, color));
          }
        }
        break;
      }
      case 'para': {
        const code = b.tone ? TONE_COLOR[b.tone] : '';
        for (const l of wrap(text(b.text), w)) push(inline(paint(l, code, color), color));
        blank();
        break;
      }
      case 'list': {
        b.items.forEach((it, i) => {
          const marker = b.ordered ? `${String(i + 1).padStart(2)}. ` : '  - ';
          const lines = wrap(text(it.text), w, marker.length, marker.length);
          lines.forEach((l, li) => {
            const body = li === 0 ? marker + l.slice(marker.length) : l;
            push(inline(paint(body, it.tone ? TONE_COLOR[it.tone] : '', color), color));
          });
          for (const s of it.sub ?? []) {
            for (const l of wrap(text(s), w, marker.length + 4, marker.length + 2)) {
              push(inline(paint(l, A.dim, color), color));
            }
          }
        });
        blank();
        break;
      }
      case 'code': {
        for (const l of code(b.code).replace(/\s+$/, '').split('\n')) {
          push(paint('    ' + l, A.dim, color));
        }
        blank();
        break;
      }
      case 'note': {
        const lines = wrap(`${text(b.label)}: ${text(b.text)}`, w, 6, 4);
        lines.forEach((l) => push(inline(paint(l, TONE_COLOR[b.tone] || A.dim, color), color)));
        blank();
        break;
      }
      case 'rule':
        blank();
        push(paint('-'.repeat(Math.min(w, 60)), A.dim, color));
        blank();
        break;
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
