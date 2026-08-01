/**
 * Source-text recovery.
 *
 * Every `Predicate.sql` and projection `sql` in the IR must be the fragment
 * exactly as the author wrote it, so downstream modules can quote it as
 * evidence in a report. `pgsql-ast-parser` gives us byte offsets when parsed
 * with `locationTracking: true`, so we slice the original string rather than
 * re-serialising the AST (which would normalise whitespace, casing and
 * quoting, and would silently rewrite `TIMESTAMPTZ 'x'` into `('x')::timestamptz`).
 *
 * `toSql` is only the fallback for nodes the parser did not locate.
 */
import { toSql } from 'pgsql-ast-parser';

interface Located {
  type?: string;
  _location?: { start: number; end: number };
}

const SUBQUERY_TYPES = new Set(['select', 'union', 'union all', 'with', 'with recursive', 'values']);

/** A source document plus the offsets the parser recorded against it. */
export class Source {
  readonly sql: string;

  constructor(sql: string) {
    this.sql = sql;
  }

  /**
   * The exact substring the node was parsed from, with surrounding whitespace
   * and any trailing/leading comment noise trimmed. Falls back to
   * re-serialising, then to the empty string.
   */
  of(node: unknown): string {
    const bounds = this.bounds(node);
    if (bounds) {
      return tidy(this.sql.slice(bounds.start, bounds.end));
    }
    return this.serialize(node);
  }

  /** Like `of`, but returns undefined instead of guessing. */
  exact(node: unknown): string | undefined {
    const bounds = this.bounds(node);
    if (bounds) {
      return tidy(this.sql.slice(bounds.start, bounds.end));
    }
    return undefined;
  }

  /** Text spanning two nodes, e.g. `a.x = b.y` from its two operands. */
  between(from: unknown, to: unknown): string | undefined {
    const a = (from as Located | null | undefined)?._location;
    const b = (to as Located | null | undefined)?._location;
    if (!a || !b) return undefined;
    const start = Math.min(a.start, b.start);
    const end = Math.max(a.end, b.end);
    if (end <= start || end > this.sql.length) return undefined;
    return tidy(this.sql.slice(start, end));
  }

  private serialize(node: unknown): string {
    if (node === null || node === undefined) return '';
    try {
      return tidy(toSql.expr(node as never));
    } catch {
      try {
        return tidy(toSql.statement(node as never));
      } catch {
        return '';
      }
    }
  }

  /**
   * Parser locations omit syntactic parentheses around subqueries and the
   * closing parenthesis of IN/subquery operands. Recover those delimiters from
   * the source without swallowing a parent call's parentheses around a normal
   * scalar expression.
   */
  private bounds(node: unknown): { start: number; end: number } | undefined {
    const located = node as Located | null | undefined;
    const loc = located?._location;
    if (!loc || loc.end <= loc.start || loc.end > this.sql.length) return undefined;

    let start = loc.start;
    let end = loc.end;
    if (located?.type && SUBQUERY_TYPES.has(located.type)) {
      // A subquery expression's AST starts at SELECT/WITH and ends before its
      // wrapper. Include only balanced pairs immediately surrounding it.
      for (;;) {
        const left = previousNonWhitespace(this.sql, start);
        const right = nextNonWhitespace(this.sql, end);
        if (left < 0 || right >= this.sql.length || this.sql[left] !== '(' || this.sql[right] !== ')') break;
        start = left;
        end = right + 1;
      }
    }

    return recoverCrossingParentheses(this.sql, start, end);
  }
}

function previousNonWhitespace(sql: string, before: number): number {
  let i = before - 1;
  while (i >= 0 && /\s/.test(sql[i]!)) i--;
  return i;
}

function nextNonWhitespace(sql: string, from: number): number {
  let i = from;
  while (i < sql.length && /\s/.test(sql[i]!)) i++;
  return i;
}

/**
 * Parser locations occasionally contain one half of a syntactic parenthesis
 * pair. Boolean tests are the important example: for `(a = b) IS FALSE`, the
 * range starts at `a` but includes the `)` before `IS FALSE`. Expand only pairs
 * that cross a reported boundary. A parent call's wrapper has both delimiters
 * outside an ordinary scalar child range, so it is deliberately not swallowed.
 */
function recoverCrossingParentheses(
  sql: string,
  originalStart: number,
  originalEnd: number,
): { start: number; end: number } {
  const pairs = parenthesisPairs(sql);
  let start = originalStart;
  let end = originalEnd;
  let changed = true;
  while (changed) {
    changed = false;
    for (const { open, close } of pairs) {
      if (open < start && close >= start && close < end) {
        start = open;
        changed = true;
      }
      if (open >= start && open < end && close >= end) {
        end = close + 1;
        changed = true;
      }
    }
  }
  return { start, end };
}

/** Matched SQL parenthesis positions, ignoring literals and comments. */
function parenthesisPairs(sql: string): Array<{ open: number; close: number }> {
  const stack: number[] = [];
  const pairs: Array<{ open: number; close: number }> = [];
  let quote: "'" | '"' | undefined;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag: string | undefined;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (ch === '/' && next === '*') {
        blockCommentDepth++;
        i++;
      } else if (ch === '*' && next === '/') {
        blockCommentDepth--;
        i++;
      }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = undefined;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) {
        if (next === quote) i++;
        else quote = undefined;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      lineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      blockCommentDepth = 1;
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length - 1;
      }
    } else if (ch === '(') {
      stack.push(i);
    } else if (ch === ')') {
      const open = stack.pop();
      if (open !== undefined) pairs.push({ open, close: i });
    }
  }
  return pairs;
}

/** Collapse the incidental whitespace a multi-line fragment picks up. */
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
