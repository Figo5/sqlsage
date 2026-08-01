import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadSchemaCatalog, parseSchemaCatalog, SchemaInputError } from './schema.ts';

const corpusSchema = fileURLToPath(new URL('../corpus/schema.sql', import.meta.url));

test('loads the corpus schema with live-introspection-compatible keys and indexes', async () => {
  const catalog = await loadSchemaCatalog(corpusSchema);
  assert.equal(catalog.dialect, 'postgres');
  assert.equal(catalog.serverVersion, undefined);
  assert.deepEqual(catalog.tables.map((table) => table.name), [
    'categories', 'customers', 'events', 'order_items', 'orders', 'products',
  ]);
  assert.ok(catalog.tables.every((table) => table.schema === 'shop'));
  assert.equal(catalog.tables.reduce((sum, table) => sum + table.indexes.length, 0), 8);

  const orders = catalog.tables.find((table) => table.name === 'orders')!;
  assert.deepEqual(orders.primaryKey, ['order_id']);
  assert.deepEqual(orders.indexes.map((index) => index.name), ['orders_pkey', 'idx_orders_customer_id']);
  assert.deepEqual(orders.foreignKeys, [{
    columns: ['customer_id'], referencesTable: 'customers', referencesColumns: ['customer_id'],
  }]);
  assert.equal(orders.columns.find((column) => column.name === 'shipped_at')?.nullable, true);
  assert.equal(orders.columns.find((column) => column.name === 'created_at')?.dataType, 'timestamp with time zone');

  const categories = catalog.tables.find((table) => table.name === 'categories')!;
  assert.deepEqual(categories.foreignKeys, [{
    columns: ['parent_id'], referencesTable: 'categories', referencesColumns: ['category_id'],
  }]);
});

test('parses a minimal table and makes primary keys non-null with a unique btree index', () => {
  const catalog = parseSchemaCatalog(`
    CREATE TABLE widgets (
      id bigint,
      label varchar(40) NULL,
      CONSTRAINT widgets_pk PRIMARY KEY (id)
    );
  `);
  assert.deepEqual(catalog.tables[0], {
    schema: 'public',
    name: 'widgets',
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false },
      { name: 'label', dataType: 'character varying(40)', nullable: true },
    ],
    indexes: [{
      name: 'widgets_pk', table: 'widgets', columns: ['id'], unique: true,
      method: 'btree', expressions: [],
    }],
    primaryKey: ['id'],
  });
});

test('supports inline and table foreign keys, including an omitted referenced PK list', () => {
  const catalog = parseSchemaCatalog(`
    CREATE SCHEMA app;
    SET search_path = app, public;
    CREATE TABLE parents (a int, b int, PRIMARY KEY (a, b));
    CREATE TABLE children (
      id int PRIMARY KEY,
      parent_a int REFERENCES parents(a) ON DELETE CASCADE NOT NULL,
      parent_b int,
      FOREIGN KEY (parent_a, parent_b) REFERENCES parents
    );
  `);
  const children = catalog.tables.find((table) => table.name === 'children')!;
  assert.equal(children.columns.find((column) => column.name === 'parent_a')?.nullable, false);
  assert.deepEqual(children.foreignKeys, [
    { columns: ['parent_a'], referencesTable: 'parents', referencesColumns: ['a'] },
    { columns: ['parent_a', 'parent_b'], referencesTable: 'parents', referencesColumns: ['a', 'b'] },
  ]);
});

test('accepts DEFAULT NULL without mistaking it for a nullability constraint', () => {
  const catalog = parseSchemaCatalog('CREATE TABLE notes (id int PRIMARY KEY, body text DEFAULT NULL NOT NULL);');
  assert.equal(catalog.tables[0]?.columns[1]?.nullable, false);
});

test('parses unique, method, expression, INCLUDE, and partial-index metadata', () => {
  const catalog = parseSchemaCatalog(`
    CREATE TABLE public.accounts (
      id bigint PRIMARY KEY,
      email text NOT NULL,
      display_name text,
      active boolean NOT NULL DEFAULT true
    );
    CREATE UNIQUE INDEX accounts_email_active
      ON public.accounts USING btree (lower(email), id DESC)
      INCLUDE (display_name) WHERE active = true;
  `);
  const index = catalog.tables[0]!.indexes[1]!;
  assert.deepEqual(index, {
    name: 'accounts_email_active',
    table: 'accounts',
    columns: ['lower(email)', 'id DESC'],
    includeColumns: ['display_name'],
    unique: true,
    method: 'btree',
    where: 'active = true',
    expressions: ['lower(email)'],
  });
});

test('safely ignores comments and DROP SCHEMA', () => {
  const catalog = parseSchemaCatalog(`
    -- reset only; no catalog object survives a schema dump
    DROP SCHEMA IF EXISTS app CASCADE;
    /* nested comments are accepted: /* inner */ done */
    CREATE SCHEMA app;
    SET search_path TO app, public;
    CREATE TABLE things (id int PRIMARY KEY, note text DEFAULT ';--not a comment');
  `);
  assert.equal(catalog.tables[0]?.schema, 'app');
  assert.equal(catalog.tables[0]?.columns[1]?.nullable, true);
});

test('rejects unsupported DDL rather than returning a partial catalog', () => {
  assert.throws(
    () => parseSchemaCatalog('CREATE TABLE t (id int); ALTER TABLE t ADD PRIMARY KEY (id);'),
    (error: unknown) => error instanceof SchemaInputError
      && /statement 2: unsupported statement ALTER TABLE t/.test(error.message),
  );
  assert.throws(
    () => parseSchemaCatalog('CREATE TABLE t (id int CHECK (id > 0));'),
    (error: unknown) => error instanceof SchemaInputError && /unsupported construct CHECK/i.test(error.message),
  );
});

test('rejects invalid references and unsupported index methods concisely', () => {
  assert.throws(
    () => parseSchemaCatalog('CREATE TABLE child (id int, parent_id int REFERENCES missing(id));'),
    (error: unknown) => error instanceof SchemaInputError && /references unknown or ambiguous table missing/.test(error.message),
  );
  assert.throws(
    () => parseSchemaCatalog('CREATE TABLE t (id int); CREATE INDEX ix ON t USING bloom (id);'),
    (error: unknown) => error instanceof SchemaInputError && /unsupported access method bloom/.test(error.message),
  );
});

test('wraps file read failures as SchemaInputError', async () => {
  await assert.rejects(
    loadSchemaCatalog('/definitely/not/a/sqlsage/schema.sql'),
    (error: unknown) => error instanceof SchemaInputError && /could not read schema/.test(error.message),
  );
});
