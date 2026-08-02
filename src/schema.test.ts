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
  // This case used to assert that ALTER TABLE was rejected outright. ALTER TABLE is
  // now supported, so the assertion was replaced with DDL that is still unsupported
  // rather than deleted -- the point of the test is that unknown DDL fails loudly.
  assert.throws(
    () => parseSchemaCatalog('CREATE TABLE t (id int); CREATE VIEW v AS SELECT id FROM t;'),
    (error: unknown) => error instanceof SchemaInputError
      && /statement 2: unsupported statement CREATE VIEW v/.test(error.message),
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

test('UNIQUE constraints become unique indexes without forcing NOT NULL', () => {
  const catalog = parseSchemaCatalog(`
    CREATE SCHEMA s;
    CREATE TABLE s.t (
      id bigint PRIMARY KEY,
      email text UNIQUE,
      badge text NOT NULL CONSTRAINT badge_uq UNIQUE,
      a text, b text,
      UNIQUE (a, b)
    );
  `);
  const t = catalog.tables[0]!;

  // PostgreSQL's own naming, so a recommendation never proposes an index that
  // already exists under the name the server would have chosen.
  assert.deepEqual(t.indexes.map((i) => i.name), ['t_pkey', 't_email_key', 'badge_uq', 't_a_b_key']);
  assert.ok(t.indexes.every((i) => i.unique));
  assert.deepEqual(t.indexes.find((i) => i.name === 't_a_b_key')!.columns, ['a', 'b']);

  // The load-bearing part. UNIQUE does not imply NOT NULL -- PostgreSQL treats
  // NULLs as distinct, so a unique column may hold many of them. Copying the
  // primary-key behaviour here would silently claim a column is non-nullable and
  // corrupt the null-rejection analysis.
  const nullable = Object.fromEntries(t.columns.map((c) => [c.name, c.nullable]));
  assert.equal(nullable.email, true);
  assert.equal(nullable.a, true);
  assert.equal(nullable.badge, false); // only because NOT NULL was declared too
  assert.equal(t.primaryKey!.length, 1);
});

test('malformed UNIQUE constraints are rejected rather than half-understood', () => {
  const cases: [string, RegExp][] = [
    ['CREATE SCHEMA s; CREATE TABLE s.t (id bigint PRIMARY KEY, UNIQUE (nope));', /unknown column nope/],
    ['CREATE SCHEMA s; CREATE TABLE s.t (id bigint PRIMARY KEY, UNIQUE);', /must contain a column list/],
    // NULLS NOT DISTINCT changes the semantics we would be asserting, so it is
    // refused rather than parsed into a plain unique index.
    ['CREATE SCHEMA s; CREATE TABLE s.t (id bigint PRIMARY KEY, e text, UNIQUE (e) NULLS NOT DISTINCT);', /unsupported trailing options/],
  ];
  for (const [ddl, expected] of cases) {
    assert.throws(() => parseSchemaCatalog(ddl), (error: SchemaInputError) => {
      assert.match(error.message, expected);
      return true;
    }, ddl);
  }
});

test('ALTER TABLE adds constraints and columns to an already-declared table', () => {
  const catalog = parseSchemaCatalog(`
    CREATE SCHEMA s;
    CREATE TABLE s.a (id bigint PRIMARY KEY, code text);
    CREATE TABLE s.b (id bigint PRIMARY KEY, code text, aid bigint, note text);
    ALTER TABLE s.b ADD CONSTRAINT b_code_uq UNIQUE (code);
    ALTER TABLE s.b ADD CONSTRAINT b_a_fk FOREIGN KEY (aid) REFERENCES s.a (id);
    ALTER TABLE ONLY s.b ADD COLUMN extra text NOT NULL, ALTER COLUMN note SET NOT NULL;
  `);
  const b = catalog.tables.find((table) => table.name === 'b')!;

  // Constraint actions reuse parseTableConstraint, so ADD CONSTRAINT ... UNIQUE and an
  // inline UNIQUE cannot drift apart or disagree about the generated index name.
  assert.deepEqual(b.indexes.map((index) => index.name), ['b_pkey', 'b_code_uq']);
  assert.equal(b.indexes.find((index) => index.name === 'b_code_uq')!.unique, true);
  assert.deepEqual(b.foreignKeys, [
    { columns: ['aid'], referencesTable: 'a', referencesColumns: ['id'] },
  ]);

  const nullable = Object.fromEntries(b.columns.map((column) => [column.name, column.nullable]));
  assert.equal(nullable.extra, false);
  assert.equal(nullable.note, false);   // SET NOT NULL applied
  assert.equal(nullable.code, true);    // UNIQUE alone must not imply NOT NULL
});

test('ALTER TABLE refuses actions it does not model instead of ignoring them', () => {
  const base = 'CREATE SCHEMA s; CREATE TABLE s.t (id bigint PRIMARY KEY, k bigint, v text);';
  const cases: [string, RegExp][] = [
    // Order matters, exactly as it does for PostgreSQL.
    [`${base} ALTER TABLE s.zzz ADD UNIQUE (k);`, /unknown table s\.zzz/],
    [`${base} ALTER TABLE s.t ADD CONSTRAINT c CHECK (k > 0);`, /unsupported table constraint CHECK/],
    [`${base} ALTER TABLE s.t DROP COLUMN v;`, /unsupported action DROP/],
    // Silently accepting these would imply we modelled them.
    [`${base} ALTER TABLE s.t ALTER COLUMN v SET DEFAULT 'x';`, /unsupported ALTER COLUMN action on v/],
    [`${base} ALTER TABLE s.t ADD PRIMARY KEY (k);`, /declares more than one primary key/],
    [`${base} ALTER TABLE s.t ADD COLUMN v text;`, /declares column v more than once/],
    [`${base} ALTER TABLE s.t ADD CONSTRAINT t_pkey UNIQUE (k);`, /index t_pkey is declared more than once/],
    // A primary key column cannot become nullable.
    [`${base} ALTER TABLE s.t ALTER COLUMN id DROP NOT NULL;`, /cannot drop NOT NULL from primary key column id/],
    [`${base} ALTER TABLE s.t;`, /has no action/],
  ];
  for (const [ddl, expected] of cases) {
    assert.throws(() => parseSchemaCatalog(ddl), (error: SchemaInputError) => {
      assert.match(error.message, expected);
      return true;
    }, ddl);
  }
});
