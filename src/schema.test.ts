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
  // ALTER TABLE, then CREATE VIEW, have each in turn become supported and been
  // replaced here rather than deleted -- the point of the test is that unknown DDL
  // fails loudly, so it always needs a statement that is genuinely still unknown.
  assert.throws(
    () => parseSchemaCatalog('CREATE TABLE t (id int); CREATE RULE r AS ON DELETE TO t DO INSTEAD NOTHING;'),
    (error: unknown) => error instanceof SchemaInputError
      && /statement 2: unsupported statement CREATE RULE r/.test(error.message),
  );
  // CHECK used to be rejected here. It is now accepted (and not modelled), so this
  // asserts on COLLATE instead -- still unsupported, so the test keeps its point.
  assert.throws(
    () => parseSchemaCatalog('CREATE TABLE t (id int COLLATE "C");'),
    (error: unknown) => error instanceof SchemaInputError && /unsupported construct COLLATE/i.test(error.message),
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
    // CHECK is now accepted; EXCLUDE stands in as a constraint still not modelled.
    [`${base} ALTER TABLE s.t ADD EXCLUDE USING gist (k WITH =);`, /unsupported table constraint EXCLUDE/],
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

test('a realistic pg_dump --schema-only file parses end to end', () => {
  const catalog = parseSchemaCatalog(`
    SET statement_timeout = 0;
    SET default_table_access_method = heap;
    SELECT pg_catalog.set_config('search_path', '', false);
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
    CREATE SCHEMA app;
    ALTER SCHEMA app OWNER TO postgres;
    CREATE TYPE app.status AS ENUM ('new', 'done');
    CREATE FUNCTION app.touch() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();  -- a semicolon inside the body must not split the file
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE SEQUENCE app.orders_id_seq AS bigint START WITH 1;
    ALTER SEQUENCE app.orders_id_seq OWNED BY app.orders.id;
    CREATE TABLE app.orders (
        id bigint GENERATED ALWAYS AS IDENTITY,
        ref text NOT NULL,
        state app.status DEFAULT 'new'::app.status NOT NULL,
        qty int CONSTRAINT qty_ck CHECK (qty > 0),
        label text GENERATED ALWAYS AS (ref) STORED,
        CHECK (qty < 1000)
    );
    ALTER TABLE app.orders OWNER TO postgres;
    ALTER TABLE ONLY app.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY app.orders ADD CONSTRAINT orders_ref_key UNIQUE (ref);
    CREATE INDEX orders_state_idx ON app.orders USING btree (state);
    CREATE TRIGGER orders_touch BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.touch();
    GRANT SELECT ON TABLE app.orders TO readonly;
    COMMENT ON TABLE app.orders IS 'order headers';
  `);

  assert.equal(catalog.tables.length, 1);
  const orders = catalog.tables[0]!;
  assert.equal(orders.schema, 'app');
  assert.deepEqual(orders.columns.map((c) => c.name), ['id', 'ref', 'state', 'qty', 'label']);
  assert.deepEqual(orders.primaryKey, ['id']);
  assert.deepEqual(orders.indexes.map((i) => i.name), ['orders_pkey', 'orders_ref_key', 'orders_state_idx']);

  const nullable = Object.fromEntries(orders.columns.map((c) => [c.name, c.nullable]));
  assert.equal(nullable.id, false);    // GENERATED ALWAYS AS IDENTITY implies NOT NULL
  assert.equal(nullable.label, true);  // a stored generated column is an ordinary nullable column
  assert.equal(nullable.qty, true);    // a CHECK does not constrain nullability
  // An enum column keeps its type name as an opaque string, which is all the analysis uses.
  assert.equal(orders.columns.find((c) => c.name === 'state')!.dataType, 'app.status');
});

test('ignoring dump noise is an allowlist, not a catch-all', () => {
  // Everything outside the allowlist must still fail loudly. A parser that quietly
  // skipped what it did not understand would return a catalog silently missing keys
  // or indexes, and every downstream uniqueness and fan-out claim would inherit it.
  const cases: [string, RegExp][] = [
    // Views are supported now; these keep the case pointed at genuinely unknown DDL.
    ['CREATE TABLE t (id int); CREATE POLICY p ON t USING (true);', /unsupported statement CREATE POLICY/],
    ['CREATE TABLE t (id int); LOCK TABLE t;', /unsupported statement LOCK TABLE/],
    // PARTITION BY used to be rejected here and is now supported; INHERITS stands in
    // so the case still proves unknown trailing options do not slip through.
    ['CREATE TABLE t (id int) INHERITS (other);', /unsupported trailing options/],
    ['CREATE TABLE t (id int); TRUNCATE t;', /unsupported statement TRUNCATE/],
    // Regression: EXCLUDE fell through to the column parser and produced a phantom
    // column named "exclude" with data type "using gist(id with =)".
    ['CREATE TABLE t (id int, EXCLUDE USING gist (id WITH =));', /unsupported table constraint EXCLUDE/],
    ['CREATE TABLE t (LIKE other);', /unsupported table constraint LIKE/],
    ['CREATE TABLE t (id int GENERATED ALWAYS AS (id) VIRTUAL);', /generated expression without STORED/],
    ["CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; ", /unterminated dollar-quoted string/],
  ];
  for (const [ddl, expected] of cases) {
    assert.throws(() => parseSchemaCatalog(ddl), (error: SchemaInputError) => {
      assert.match(error.message, expected);
      return true;
    }, ddl);
  }
});

test('partitioned tables parse, and partitions are relations in their own right', () => {
  const catalog = parseSchemaCatalog(`
    CREATE SCHEMA s;
    CREATE TABLE s.events (
      id bigint,
      occurred_at date NOT NULL,
      payload text,
      PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at);
    CREATE TABLE s.events_2024 PARTITION OF s.events
      FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
    CREATE TABLE s.events_rest PARTITION OF s.events DEFAULT;
    CREATE INDEX events_payload ON s.events (payload);
  `);

  assert.deepEqual(catalog.tables.map((t) => t.name), ['events', 'events_2024', 'events_rest']);
  const parent = catalog.tables[0]!;
  const child = catalog.tables[1]!;

  // A partition is queryable directly, so it carries the parent's columns and the
  // primary key PostgreSQL materialises on each partition -- under its own index name.
  assert.deepEqual(child.columns.map((c) => c.name), parent.columns.map((c) => c.name));
  assert.deepEqual(child.primaryKey, ['id', 'occurred_at']);
  assert.deepEqual(child.indexes.map((i) => i.name), ['events_2024_pkey']);
  assert.deepEqual(parent.indexes.map((i) => i.name), ['events_pkey', 'events_payload']);
});

test('the pg_dump ATTACH PARTITION form parses', () => {
  const catalog = parseSchemaCatalog(`
    CREATE SCHEMA s;
    CREATE TABLE s.events (id bigint NOT NULL, occurred_at date NOT NULL) PARTITION BY RANGE (occurred_at);
    CREATE TABLE s.events_2024 (id bigint NOT NULL, occurred_at date NOT NULL);
    ALTER TABLE ONLY s.events ATTACH PARTITION s.events_2024
      FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
  `);
  assert.deepEqual(catalog.tables.map((t) => t.name), ['events', 'events_2024']);
});

test('a unique constraint PostgreSQL would refuse on a partitioned table is refused here', () => {
  // Uniqueness is what the join fan-out proof reads. Accepting a constraint the real
  // database never enforces would make SQLSage assert a relation is unique when the
  // server could hold duplicates -- a wrong correctness verdict, not a missing one.
  const cases: [string, RegExp][] = [
    ['CREATE SCHEMA s; CREATE TABLE s.e (id bigint, at date NOT NULL, PRIMARY KEY (id)) PARTITION BY RANGE (at);',
      /must include partition key column at/],
    ['CREATE SCHEMA s; CREATE TABLE s.e (id bigint NOT NULL, at date NOT NULL, UNIQUE (id)) PARTITION BY RANGE (at);',
      /must include partition key column at/],
    // The rule applies however the constraint arrives.
    ['CREATE SCHEMA s; CREATE TABLE s.e (id bigint NOT NULL, at date NOT NULL) PARTITION BY RANGE (at); ALTER TABLE s.e ADD PRIMARY KEY (id);',
      /must include partition key column at/],
    // PostgreSQL permits no unique constraint at all when the key is an expression.
    ["CREATE SCHEMA s; CREATE TABLE s.e (id bigint NOT NULL, at timestamptz NOT NULL, UNIQUE (id)) PARTITION BY RANGE (date_trunc('day', at));",
      /not allowed on e, which is partitioned by an expression/],
    ['CREATE SCHEMA s; CREATE TABLE s.e (id bigint NOT NULL) PARTITION BY RANGE (nope);',
      /references unknown column nope/],
    ['CREATE SCHEMA s; CREATE TABLE s.e (id bigint NOT NULL) PARTITION BY WEIRD (id);',
      /must use RANGE, LIST, or HASH/],
    ['CREATE SCHEMA s; CREATE TABLE s.c PARTITION OF s.nope DEFAULT;',
      /PARTITION OF unknown table s\.nope/],
    // PARTITION BY must not have opened the trailing-options gate for anything else.
    ['CREATE SCHEMA s; CREATE TABLE s.e (id bigint NOT NULL) INHERITS (other);',
      /unsupported trailing options/],
  ];
  for (const [ddl, expected] of cases) {
    assert.throws(() => parseSchemaCatalog(ddl), (error: SchemaInputError) => {
      assert.match(error.message, expected);
      return true;
    }, ddl);
  }
});

test('views and materialized views resolve their columns from the declared tables', () => {
  const catalog = parseSchemaCatalog(`
    CREATE SCHEMA s;
    CREATE TABLE s.a (id bigint PRIMARY KEY, code text NOT NULL, note text);
    CREATE TABLE s.b (id bigint PRIMARY KEY, aid bigint NOT NULL, amt numeric);
    CREATE VIEW s.plain AS SELECT id, code FROM s.a;
    CREATE VIEW s.renamed (x, y) AS SELECT id, upper(code) AS up FROM s.a;
    CREATE VIEW s.joined AS SELECT a.id, a.code, b.amt FROM s.a a JOIN s.b b ON b.aid = a.id;
    CREATE MATERIALIZED VIEW s.matview AS SELECT * FROM s.a;
  `);
  const byName = Object.fromEntries(catalog.tables.map((t) => [t.name, t]));

  assert.equal(byName.plain!.kind, 'view');
  assert.equal(byName.matview!.kind, 'materialized-view');
  assert.equal(byName.a!.kind, undefined); // ordinary tables stay unmarked

  // A single-source view projecting a column directly inherits its nullability.
  assert.deepEqual(byName.plain!.columns, [
    { name: 'id', dataType: 'bigint', nullable: false },
    { name: 'code', dataType: 'text', nullable: false },
  ]);

  // A computed column has no inferable type, and the declared name list renames both.
  assert.deepEqual(byName.renamed!.columns.map((c) => [c.name, c.dataType]), [['x', 'bigint'], ['y', 'unknown']]);

  // Across a join, nullability is NOT inherited: an outer join, aggregate or CASE can
  // introduce NULLs the source column's declaration does not show. Over-claiming
  // NOT NULL here would corrupt the null-rejection analysis.
  assert.ok(byName.joined!.columns.every((c) => c.nullable));
  assert.deepEqual(byName.joined!.columns.map((c) => c.name), ['id', 'code', 'amt']);

  assert.deepEqual(byName.matview!.columns.map((c) => c.name), ['id', 'code', 'note']);
});

test('a view whose columns cannot be resolved faithfully is rejected, not guessed at', () => {
  const base = 'CREATE SCHEMA s; CREATE TABLE s.a (id bigint PRIMARY KEY, code text); CREATE TABLE s.b (id bigint PRIMARY KEY, aid bigint); ';
  const cases: [string, RegExp][] = [
    [`${base}CREATE VIEW s.v AS SELECT id FROM s.nope;`, /unknown relation s\.nope/],
    [`${base}CREATE VIEW s.v AS SELECT nope FROM s.a;`, /unknown column nope/],
    [`${base}CREATE VIEW s.v AS SELECT id FROM s.a a JOIN s.b b ON b.aid = a.id;`, /ambiguous column id/],
    [`${base}CREATE VIEW s.v AS SELECT upper(code) FROM s.a;`, /without an AS alias/],
    [`${base}CREATE VIEW s.v AS SELECT id FROM (SELECT id FROM s.a) x;`, /selects from a subquery/],
    [`${base}CREATE VIEW s.v AS SELECT id FROM s.a UNION SELECT id FROM s.b;`, /set operation/],
    [`${base}CREATE VIEW s.v AS WITH q AS (SELECT 1) SELECT * FROM q;`, /uses a CTE/],
    [`${base}CREATE VIEW s.v (x) AS SELECT id, code FROM s.a;`, /declares 1 column names but its query produces 2/],
    [`${base}CREATE VIEW s.v AS SELECT 1 AS one;`, /must select FROM a relation/],
  ];
  for (const [ddl, expected] of cases) {
    assert.throws(() => parseSchemaCatalog(ddl), (error: SchemaInputError) => {
      assert.match(error.message, expected);
      return true;
    }, ddl);
  }
});

test('psql meta-commands in a real pg_dump are skipped, except file includes', () => {
  // Recent pg_dump wraps every dump in \restrict/\unrestrict. These are client
  // directives terminated by the line, not by a semicolon, so leaving one in place
  // merges it with the statement that follows and makes real dumps unparseable.
  const catalog = parseSchemaCatalog(`
    \\restrict qhneYxhQJX7gUmev9nTWP85cSdsz5V17MO54Kw55eAJhfT3hu2u1MAXlmILjGCI
    SET statement_timeout = 0;
    CREATE SCHEMA app;
    CREATE TABLE app.t (id bigint PRIMARY KEY, v text);
    \\unrestrict qhneYxhQJX7gUmev9nTWP85cSdsz5V17MO54Kw55eAJhfT3hu2u1MAXlmILjGCI
  `);
  assert.deepEqual(catalog.tables.map((table) => table.name), ['t']);
  assert.deepEqual(catalog.tables[0]!.columns.map((column) => column.name), ['id', 'v']);

  // A backslash inside a string is not a meta-command.
  const literal = parseSchemaCatalog(`CREATE TABLE t (id int, note text DEFAULT '\\restrict not a command');`);
  assert.equal(literal.tables[0]!.columns.length, 2);

  // \\i pulls in another file. Skipping it would return a catalog silently missing
  // whatever that file defined, so it fails rather than quietly under-reporting.
  for (const include of ['\\i other.sql', '\\ir other.sql']) {
    assert.throws(
      () => parseSchemaCatalog(`CREATE TABLE t (id int);\n${include}\n`),
      (error: SchemaInputError) => {
        assert.match(error.message, /includes another file with \\i/);
        return true;
      },
      include,
    );
  }
});
