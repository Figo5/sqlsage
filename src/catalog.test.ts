import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CatalogInputError, validateCatalog } from './catalog.ts';

test('the bundled catalog passes the same runtime boundary used for CLI input', async () => {
  const input = JSON.parse(await readFile(new URL('../corpus/catalog.json', import.meta.url), 'utf8'));
  const catalog = validateCatalog(input);
  assert.equal(catalog.dialect, 'postgres');
  assert.equal(catalog.tables.length, 6);
});

test('catalog validation rejects malformed roots and nested safety-bearing fields', () => {
  const valid = {
    dialect: 'postgres',
    tables: [{
      schema: 'app', name: 'things', rowCount: 10,
      columns: [{ name: 'id', dataType: 'bigint', nullable: false }],
      indexes: [{ name: 'things_pkey', table: 'things', columns: ['id'], unique: true, method: 'btree' }],
      primaryKey: ['id'],
    }],
  };
  assert.doesNotThrow(() => validateCatalog(valid));

  const mutations: Array<[string, (copy: any) => void]> = [
    ['dialect', (copy) => { copy.dialect = 'mysql'; }],
    ['tables', (copy) => { copy.tables = {}; }],
    ['column nullability', (copy) => { copy.tables[0].columns[0].nullable = 'no'; }],
    ['index method', (copy) => { copy.tables[0].indexes[0].method = 'magic'; }],
    ['primary key shape', (copy) => { copy.tables[0].primaryKey = '{id}'; }],
    ['negative rows', (copy) => { copy.tables[0].rowCount = -1; }],
  ];
  for (const [label, mutate] of mutations) {
    const copy = structuredClone(valid);
    mutate(copy);
    assert.throws(() => validateCatalog(copy), CatalogInputError, label);
  }
});
