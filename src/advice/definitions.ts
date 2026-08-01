/** Small shared helpers for stable advice identities and safe SQL identifiers. */

import { findTable } from '../catalog.ts';
import type { Catalog } from '../types.ts';

export interface AdviceIndexDefinition {
  purpose: string;
  table: string;
  keys: string[];
  include?: string[];
  method?: string;
  where?: string;
}

/**
 * Stable, definition-derived id shared by M5 and M6.
 *
 * `purpose` describes the access-path shape, while `parts` are table/key names.
 * No query id or SQL fingerprint participates in the identity.
 */
export function indexAdviceId(purpose: string, ...parts: Array<string | undefined>): string {
  const raw = ['idx', ...parts.filter((part): part is string => !!part), purpose]
    .map(slug)
    .filter(Boolean)
    .join('-');
  if (raw.length <= 96) return raw;
  return `${raw.slice(0, 79).replace(/-+$/, '')}-${shortHash(raw)}`;
}

/** Stable identity for one complete proposed physical definition. */
export function indexDefinitionAdviceId(definition: AdviceIndexDefinition): string {
  return indexAdviceId(
    definition.purpose,
    definition.table,
    definition.method ?? 'btree',
    ...definition.keys,
    ...(definition.include ?? []).map((column) => `include-${column}`),
    definition.where ? `where-${definition.where}` : undefined,
  );
}

/** Physical PostgreSQL index name, capped at PostgreSQL's 63-byte identifier limit. */
export function physicalIndexName(adviceId: string): string {
  const raw = `idx_sqlsage_${adviceId.replace(/^idx-/, '')}`.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  if (Buffer.byteLength(raw, 'utf8') <= 63) return raw;
  return `${raw.slice(0, 54).replace(/_+$/, '')}_${shortHash(raw)}`;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function qualifiedTable(catalog: Catalog, source: string): string {
  const table = findTable(catalog, source);
  if (!table) return quoteIdentifier(source.split('.').at(-1) ?? source);
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
}

/** Remove one known relation alias from a bound expression before using it in DDL. */
export function removeQualifier(expression: string, alias: string | undefined): string {
  if (!alias) return expression.trim();
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return expression.replace(new RegExp(`\\b${escaped}\\.`, 'gi'), '').trim();
}

export function keySql(key: string): string {
  // M5 keys are either bare identifiers with an optional direction/operator
  // class, or a deliberately constructed parenthesized expression.
  if (/^\(.+\)$/.test(key.trim())) return key.trim();
  const match = /^(.+?)(\s+(?:ASC|DESC))?(\s+[a-z_][a-z0-9_]*(?:_ops)?)?$/i.exec(key.trim());
  if (!match) return key.trim();
  const base = match[1]!;
  const suffix = `${match[2] ?? ''}${match[3] ?? ''}`;
  if (/^".*"$/.test(base) || /[()'\-+/*]/.test(base)) return `${base}${suffix}`;
  return `${quoteIdentifier(base)}${suffix}`;
}

function slug(value: string): string {
  return value
    .replace(/::/g, '-')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function shortHash(value: string): string {
  // FNV-1a: deterministic identity disambiguation, not a security primitive.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
