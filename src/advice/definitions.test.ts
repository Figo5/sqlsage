import assert from 'node:assert/strict';
import test from 'node:test';

import {
  indexAdviceId,
  keySql,
  physicalIndexName,
  quoteIdentifier,
  removeQualifier,
} from './definitions.ts';

// ---------------------------------------------------------------------------
// removeQualifier — strips one relation alias from a bound expression.
//
// This function has a documented regression history (see the comment above it):
// a naive global replace once rewrote the inside of string literals, so
//   o.coupon_code = 'o.SPECIAL'
// became
//   coupon_code = 'SPECIAL'
// and that corrupted text was emitted as a partial index's WHERE clause. These
// tests pin the quote-aware behaviour so the regression cannot return.
// ---------------------------------------------------------------------------

test('removeQualifier strips a bare alias prefix at an identifier boundary', () => {
  assert.equal(removeQualifier('o.coupon_code', 'o'), 'coupon_code');
  assert.equal(removeQualifier('o.coupon_code = o.status', 'o'), 'coupon_code = status');
});

test('removeQualifier never strips inside a single-quoted string literal', () => {
  // The documented regression guard: 'o.SPECIAL' is data, not a qualifier.
  assert.equal(
    removeQualifier(`o.coupon_code = 'o.SPECIAL'`, 'o'),
    `coupon_code = 'o.SPECIAL'`,
  );
  // A literal containing the alias followed by a column-shaped suffix must also
  // survive intact.
  assert.equal(
    removeQualifier(`o.note = 'o.customer_id is fun'`, 'o'),
    `note = 'o.customer_id is fun'`,
  );
});

test('removeQualifier only matches at an identifier boundary, so xo.col is not o.col', () => {
  assert.equal(removeQualifier('xo.coupon_code', 'o'), 'xo.coupon_code');
  assert.equal(removeQualifier('prod.code', 'rod'), 'prod.code');
});

test('removeQualifier is case-insensitive on the alias', () => {
  assert.equal(removeQualifier('O.col', 'o'), 'col');
  assert.equal(removeQualifier('o.col', 'O'), 'col');
});

test('removeQualifier leaves a quoted identifier prefix alone', () => {
  // The alias `o` does not match `"o".` because the regex anchors to a bare
  // alias, so a deliberately-quoted identifier is preserved verbatim.
  assert.equal(removeQualifier('"o".code', 'o'), '"o".code');
});

test('removeQualifier returns the trimmed input when no alias is given', () => {
  assert.equal(removeQualifier('  coupon_code  ', undefined), 'coupon_code');
  assert.equal(removeQualifier('o.col', undefined), 'o.col');
});

test('removeQualifier keeps the remainder when a quote is unterminated', () => {
  // The function must not crash or drop text on malformed input.
  const result = removeQualifier("o.col = 'unterminated", 'o');
  assert.equal(result, "col = 'unterminated");
});

test('removeQualifier honours doubled single quotes inside literals', () => {
  // 'a''b' is a single literal containing an apostrophe; the alias o inside it
  // (had it appeared) would not be stripped.
  assert.equal(removeQualifier(`o.col = 'a''b'`, 'o'), `col = 'a''b'`);
});

// ---------------------------------------------------------------------------
// Identifier quoting and physical index naming.
// ---------------------------------------------------------------------------

test('quoteIdentifier doubles embedded double quotes', () => {
  assert.equal(quoteIdentifier('foo'), '"foo"');
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
});

test('keySql quotes bare identifiers but leaves parenthesized expressions and suffixes alone', () => {
  assert.equal(keySql('col'), '"col"');
  assert.equal(keySql('(a+b)'), '(a+b)');
  assert.equal(keySql('col DESC'), '"col" DESC');
  assert.equal(keySql('col text_pattern_ops'), '"col" text_pattern_ops');
});

test('physicalIndexName stays within PostgreSQL 63 bytes and suffixes a hash when truncated', () => {
  assert.equal(physicalIndexName('idx-foo-bar'), 'idx_sqlsage_foo_bar');
  const overlong = physicalIndexName('idx-' + 'x'.repeat(80));
  assert.ok(Buffer.byteLength(overlong, 'utf8') <= 63, `<=63 bytes, got ${overlong.length}`);
  assert.match(overlong, /_[0-9a-f]{8}$/);
});

test('indexAdviceId stays within 96 characters and suffixes a hash when truncated', () => {
  const short = indexAdviceId('purpose', 'table');
  assert.ok(short.length <= 96);
  assert.match(short, /^idx-/);
  // A deliberately overlong purpose+key set must be truncated and disambiguated
  // by an 8-hex-character FNV-1a suffix rather than exceeding the limit.
  const overlong = indexAdviceId('x'.repeat(200), 'table', 'btree', 'k'.repeat(200));
  assert.ok(overlong.length <= 96, `<=96 chars, got ${overlong.length}`);
  assert.match(overlong, /-[0-9a-f]{8}$/);
});