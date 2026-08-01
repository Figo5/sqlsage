/**
 * M1 — the schema-bound query IR.
 *
 *   bindQuery(sql, catalog) -> QueryIR
 *
 * Parses SQL with `pgsql-ast-parser`, resolves every name against the catalog,
 * and produces the structure every downstream module reads. Design notes,
 * known gaps and self-assessment live in `NOTES.md` next to this file.
 *
 * Two invariants this file is built around:
 *   1. Never throw. Anything that cannot be bound becomes a `bindingErrors`
 *      entry and binding continues with the rest of the query.
 *   2. Never special-case a query. Every rule below is a rule about a *shape*
 *      and fires wherever that shape appears.
 */
import { parse, toSql } from 'pgsql-ast-parser';
import type {
  Expr,
  ExprCall,
  ExprRef,
  From,
  FromCall,
  FromStatement,
  FromTable,
  JoinClause,
  OrderByStatement,
  SelectedColumn,
  SelectFromStatement,
  SelectStatement,
  Statement,
} from 'pgsql-ast-parser';
import { findTable } from '../catalog.ts';
import type {
  Catalog,
  JoinIR,
  Predicate,
  QueryBlockIR,
  QueryIR,
  RelationIR,
  ResolvedColumnRef,
} from '../types.ts';
import { fmt, rowsPerKey, uniqueOnColumns } from './catalog-facts.ts';
import {
  analyzeOperand,
  conjuncts,
  containsAggregate,
  forEachCall,
  isAggregateCall,
  isWindowCall,
  qname,
} from './expressions.ts';
import { buildPredicate, relationsTouched, type Clause, type PredicateContext } from './predicates.ts';
import { analyzeNullRejection, recordPredicateExpression } from './null-rejection.ts';
import {
  columnNullability,
  recordColumnNullability,
  relationFromTable,
  Scope,
  sqlNameEquals,
  sqlNameKey,
  type BoundColumn,
  type BoundRelation,
  type CteBinding,
} from './scope.ts';
import { Source } from './text.ts';

export { Source } from './text.ts';
export { columnNullability } from './scope.ts';
export { analyzeNullRejection } from './null-rejection.ts';
export type { NullRejectionAnalysis, NullRejectionOutcome } from './null-rejection.ts';
export type { BoundRelation } from './scope.ts';

// ===========================================================================
// Side tables: information the IR needs to expose but `types.ts` has no field
// for. Keyed by object identity on the very objects inside the returned IR, so
// nothing is duplicated and nothing can drift. See NOTES.md.
// ===========================================================================

const SUBQUERY_BLOCKS = new WeakMap<object, string[]>();

/** Block ids of the subqueries nested inside a predicate or projection. */
export function nestedBlockIds(node: Predicate | QueryBlockIR['projections'][number]): string[] {
  return node.subqueryBlockIds ?? SUBQUERY_BLOCKS.get(node as object) ?? [];
}

// ===========================================================================
// Entry point
// ===========================================================================

export function bindQuery(sql: string, catalog: Catalog): QueryIR {
  const binder = new Binder(sql, catalog);
  return binder.run();
}

class Binder {
  readonly sql: string;
  readonly catalog: Catalog;
  readonly source: Source;
  readonly blocks: QueryBlockIR[] = [];
  readonly bindingErrors: QueryIR['bindingErrors'] = [];
  private subCounter = 0;
  private readonly resolutionCache = new WeakMap<ExprRef, ResolvedColumnRef>();
  private readonly starProjections = new WeakSet<object>();
  private readonly bareGroupKeys = new WeakMap<object, Set<string>>();
  /** Without routine metadata, a non-aggregate SELECT-list call may be an SRF. */
  private readonly blocksWithPossibleSrf = new WeakSet<object>();
  /** Blocks under construction, innermost last — used to record correlation. */
  private readonly blockStack: QueryBlockIR[] = [];
  /**
   * Aliases whose rows an earlier join has already duplicated, **keyed by block**.
   *
   * Multiplicity is cumulative *within* a block: once a relation is in the set,
   * any later join in that block sees a left input that is no longer unique on
   * the key. That is what keeps the verdict stable however the FROM clause is
   * ordered.
   *
   * ⚠️ It must NOT be shared across blocks. An earlier version used one set per
   * binder, which leaked: two identical side-by-side derived tables produced
   * different verdicts, and a CTE that multiplied `c` made an unrelated 1:1 join
   * in the main block report a fan-out it does not have. Aliases are block-scoped
   * names; treating them as global re-introduces exactly the context-dependence
   * this field exists to remove.
   */
  private readonly multipliedByBlock = new Map<string, Set<string>>();

  /** The multiplicity set for the block currently being bound. */
  private currentMultiplied(): Set<string> {
    const blockId = this.blockStack[this.blockStack.length - 1]?.id ?? 'main';
    let set = this.multipliedByBlock.get(blockId);
    if (!set) {
      set = new Set<string>();
      this.multipliedByBlock.set(blockId, set);
    }
    return set;
  }

  constructor(sql: string, catalog: Catalog) {
    this.sql = sql;
    this.catalog = catalog;
    this.source = new Source(sql);
  }

  run(): QueryIR {
    let statements: Statement[] = [];
    try {
      statements = parse(this.sql, { locationTracking: true });
    } catch (e) {
      this.error(`could not parse the statement: ${(e as Error).message.split('\n')[0]}`, undefined, 'error');
      return this.emptyIR('other');
    }

    if (statements.length === 0) {
      this.error('the input contained no statement', undefined, 'error');
      return this.emptyIR('other');
    }
    if (statements.length > 1) {
      this.error(
        `the input contained ${statements.length} statements; only the first was bound`,
        undefined,
        'warn',
      );
    }

    const stmt = statements[0]!;
    let rootBlockId = 'main';
    try {
      rootBlockId = this.bindStatement(stmt as SelectStatement, 'main', undefined, new Map());
    } catch (e) {
      this.error(`binding aborted: ${(e as Error).message}`, this.source.exact(stmt), 'error');
    }

    let normalizedSql: string | undefined;
    try {
      normalizedSql = toSql.statement(stmt);
    } catch {
      normalizedSql = undefined;
    }

    return {
      dialect: 'postgres',
      originalSql: this.sql,
      normalizedSql,
      statementType: statementTypeOf(stmt),
      blocks: this.blocks,
      rootBlockId,
      bindingErrors: this.bindingErrors,
    };
  }

  private emptyIR(kind: QueryIR['statementType']): QueryIR {
    return {
      dialect: 'postgres',
      originalSql: this.sql,
      statementType: kind,
      blocks: this.blocks,
      rootBlockId: 'main',
      bindingErrors: this.bindingErrors,
    };
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  private error(message: string, sqlFragment: string | undefined, severity: 'warn' | 'error'): void {
    if (this.bindingErrors.some((e) => e.message === message && e.sqlFragment === sqlFragment)) return;
    this.bindingErrors.push({ message, sqlFragment, severity });
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private bindStatement(
    stmt: SelectStatement | Statement,
    id: string,
    parent: Scope | undefined,
    ctes: Map<string, CteBinding>,
  ): string {
    const type = (stmt as { type?: string }).type;

    if (type === 'with' || type === 'with recursive') {
      return this.bindWith(stmt as never, id, parent, ctes);
    }
    if (type === 'union' || type === 'union all') {
      return this.bindSetOp(stmt as never, id, parent, ctes);
    }
    if (type === 'select') {
      return this.bindSelect(stmt as SelectFromStatement, id, parent, ctes);
    }
    if (type === 'values') {
      const block = this.newBlock(id, 'select');
      const rowCount = ((stmt as unknown as { values?: unknown[][] }).values ?? []).length;
      block.relations.push({
        alias: 'values',
        source: 'VALUES',
        kind: 'values',
        localPredicates: [],
        estimatedRows: rowCount,
      });
      return id;
    }
    if (type === 'insert' || type === 'update' || type === 'delete') {
      return this.bindDml(stmt as never, id, parent, ctes, type);
    }

    this.error(
      `statement type "${type ?? 'unknown'}" is not bound by this module; the IR for it is empty`,
      this.source.exact(stmt),
      'warn',
    );
    this.newBlock(id, 'select');
    return id;
  }

  private bindWith(
    stmt: { type: 'with' | 'with recursive'; bind: unknown; in: SelectStatement; alias?: { name: string } },
    id: string,
    parent: Scope | undefined,
    ctes: Map<string, CteBinding>,
  ): string {
    const scoped = new Map(ctes);

    if (stmt.type === 'with recursive') {
      const rec = stmt as unknown as { alias: { name: string }; bind: SelectStatement; in: SelectStatement };
      const name = rec.alias?.name ?? 'recursive';
      const blockId = `cte:${name}`;
      // Register before binding so the recursive self-reference resolves; its
      // column list is not knowable until the non-recursive term is bound.
      scoped.set(sqlNameKey(name), { name, blockId, columns: [], columnsKnown: false });
      this.bindStatement(rec.bind, blockId, new Scope(id, parent, scoped), scoped);
      const produced = this.blocks.find((b) => b.id === blockId);
      if (produced) scoped.set(sqlNameKey(name), this.cteBindingFor(name, produced));
      this.error(
        'recursive CTEs are bound structurally only: the recursive term\'s column types are not propagated',
        this.source.exact(rec.bind),
        'warn',
      );
      return this.bindStatement(rec.in, id, parent, scoped);
    }

    const binds = (stmt.bind ?? []) as Array<{ alias: { name: string }; statement: SelectStatement }>;
    for (const b of binds) {
      const name = b.alias?.name;
      if (!name) continue;
      const blockId = `cte:${name}`;
      // Earlier CTEs are visible to later ones, which is Postgres' rule.
      this.bindStatement(b.statement, blockId, new Scope(id, parent, scoped), scoped);
      const produced = this.blocks.find((x) => x.id === blockId);
      if (produced) scoped.set(sqlNameKey(name), this.cteBindingFor(name, produced));
    }
    return this.bindStatement(stmt.in, id, parent, scoped);
  }

  /**
   * A set operation gets a block of its own (`kind: 'set-op'`) whose relations
   * are its two arms, each bound as a full block with id `<id>#1` / `<id>#2`.
   * `setOp.withBlock` names the right arm; the left arm is `relations[0]`.
   */
  private bindSetOp(
    stmt: { type: 'union' | 'union all'; left: SelectStatement; right: SelectStatement },
    id: string,
    parent: Scope | undefined,
    ctes: Map<string, CteBinding>,
  ): string {
    const leftId = `${id}#1`;
    const rightId = `${id}#2`;
    this.bindStatement(stmt.left, leftId, parent, ctes);
    this.bindStatement(stmt.right, rightId, parent, ctes);

    const block = this.newBlock(id, 'set-op');
    for (const [armId, alias] of [[leftId, 'left'], [rightId, 'right']] as const) {
      const arm = this.blocks.find((b) => b.id === armId);
      block.relations.push({
        alias,
        source: armId,
        kind: 'subquery',
        localPredicates: [],
        estimatedRows: arm ? undefined : undefined,
      });
    }
    block.setOp = { op: stmt.type === 'union all' ? 'union-all' : 'union', withBlock: rightId };
    // The parser folds the arms' projections; expose the left arm's shape.
    const leftBlock = this.blocks.find((b) => b.id === leftId);
    if (leftBlock) block.projections = leftBlock.projections;
    return id;
  }

  private bindDml(
    stmt: Record<string, unknown> & { type: string },
    id: string,
    parent: Scope | undefined,
    ctes: Map<string, CteBinding>,
    kind: 'insert' | 'update' | 'delete',
  ): string {
    const block = this.newBlock(id, kind);
    const scope = new Scope(id, parent, ctes);
    const target = (stmt.table ?? stmt.into ?? stmt.from) as
      | { name: string; schema?: string; alias?: string }
      | undefined;
    if (target?.name) {
      const rel = this.bindTableRelation(target.name, target.schema, target.alias, scope, ctes, target);
      if (rel) block.relations.push(relationIR(rel));
    }
    this.blockStack.push(block);
    if (stmt.where) {
      for (const c of conjuncts(stmt.where as Expr)) {
        block.predicates.push(this.predicate(c, 'where', scope));
      }
    }
    this.blockStack.pop();
    this.distributeLocalPredicates(block, scope);
    if (kind === 'insert') {
      const inner = stmt.insert as SelectStatement | undefined;
      if (inner) this.bindStatement(inner, this.nextSubId(), scope, ctes);
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // SELECT
  // -------------------------------------------------------------------------

  private bindSelect(
    stmt: SelectFromStatement,
    id: string,
    parent: Scope | undefined,
    ctes: Map<string, CteBinding>,
  ): string {
    const block = this.newBlock(id, id === 'main' ? 'select' : id.startsWith('cte:') ? 'cte' : 'subquery');
    const scope = new Scope(id, parent, ctes);
    this.blockStack.push(block);

    // --- FROM: relations first, so ON/WHERE can see all of them -----------
    const entries: Array<{ rel?: BoundRelation; node: From }> = [];
    for (const item of stmt.from ?? []) {
      const rel = this.bindFromItem(item, scope, ctes);
      entries.push({ rel, node: item });
      this.applyNullExtension(item.join, scope, rel);
    }
    for (const e of entries) if (e.rel) block.relations.push(relationIR(e.rel));

    // --- JOINs ------------------------------------------------------------
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const join = entry.node.join;
      if (!join || !entry.rel) continue;
      const previous = entries.slice(0, i).map((e) => e.rel).filter(Boolean) as BoundRelation[];
      const built = this.bindJoin(join, entry.rel, previous, scope, block);
      block.joins.push(built);
    }

    // --- WHERE ------------------------------------------------------------
    for (const c of conjuncts(stmt.where)) {
      block.predicates.push(this.predicate(c, 'where', scope));
    }

    // Old-style comma joins carry their join condition in WHERE, so they produce
    // no join node above and would otherwise contribute no JoinIR at all. That
    // silently erases fan-out: q06 written as `FROM c, o, oi WHERE ...` is just
    // as wrong as the ANSI form, and must report the same multiplicity.
    this.synthesizeCommaJoins(block, entries);

    // --- projections ------------------------------------------------------
    for (const col of stmt.columns ?? []) this.bindProjection(col, scope, block);

    // --- GROUP BY / HAVING ------------------------------------------------
    const bareGroupKeys = new Set<string>();
    for (const g of stmt.groupBy ?? []) {
      const bound = this.bindGroupKey(g, scope, block);
      block.groupByExpressions!.push(bound.expression);
      block.groupBy.push(...bound.refs);
      for (const ref of bound.bareRefs) bareGroupKeys.add(refKey(ref));
    }
    this.bareGroupKeys.set(block, bareGroupKeys);
    for (const h of conjuncts(stmt.having)) {
      const pred = this.predicate(h, 'having', scope);
      block.having.push(pred);
      block.predicates.push(pred);
    }

    // --- ORDER BY / LIMIT / DISTINCT --------------------------------------
    for (const o of stmt.orderBy ?? []) block.orderBy.push(this.bindOrderBy(o, scope, block));
    const limit = stmt.limit;
    if (limit) {
      const l = literalInt(limit.limit);
      const off = literalInt(limit.offset);
      if (l !== undefined) block.limit = l;
      else if (limit.limit) this.error('LIMIT is not an integer literal, so it is not recorded', this.source.exact(limit.limit), 'warn');
      if (off !== undefined) block.offset = off;
      else if (limit.offset) this.error('OFFSET is not an integer literal, so it is not recorded', this.source.exact(limit.offset), 'warn');
    }
    if (stmt.distinct) {
      block.distinct = true;
      if (Array.isArray(stmt.distinct)) {
        this.error(
          'DISTINCT ON key columns are not represented: `QueryBlockIR` has only a boolean `distinct` flag',
          this.source.exact(stmt.distinct[0]),
          'warn',
        );
      }
    }

    // --- aggregates and window functions ----------------------------------
    this.collectCalls(stmt, block, scope);

    this.blockStack.pop();
    this.distributeLocalPredicates(block, scope);
    this.estimateRelationRows(block);
    return id;
  }

  // -------------------------------------------------------------------------
  // FROM items
  // -------------------------------------------------------------------------

  private bindFromItem(
    item: From,
    scope: Scope,
    ctes: Map<string, CteBinding>,
  ): BoundRelation | undefined {
    if (item.type === 'table') {
      const t = item as FromTable;
      return this.bindTableRelation(t.name.name, t.name.schema, t.name.alias, scope, ctes, t.name);
    }
    if (item.type === 'statement') {
      const s = item as FromStatement;
      const blockId = this.nextSubId();
      // LATERAL (and any correlated derived table) sees the relations written
      // to its left; a plain derived table sees only the enclosing block.
      const parentScope = s.lateral ? scope.lateralSnapshot() : scope.parent;
      this.bindStatement(s.statement, blockId, parentScope, ctes);
      const produced = this.blocks.find((b) => b.id === blockId);
      let shape = produced ? this.outputShape(produced) : { columns: [], known: false };
      const columnNames = (s as unknown as { columnNames?: Array<{ name: string }> }).columnNames;
      if (columnNames?.length) {
        shape = {
          columns: columnNames.map((column, index) => ({
            name: column.name,
            dataType: shape.columns[index]?.dataType,
            nullable: shape.columns[index]?.nullable,
          })),
          known: true,
        };
      }
      const bound = produced ? this.blockRowBound(produced) : undefined;
      return scope.add({
        alias: s.alias ?? blockId,
        source: blockId,
        kind: 'subquery',
        columns: shape.columns,
        columnsKnown: shape.known,
        aliased: !!s.alias,
        nullExtended: false,
        blockId,
        uniqueOutputKeys: produced ? this.uniqueOutputKeys(produced) : undefined,
        maxRows: bound?.maxRows,
        maxRowsReason: bound?.reason,
      });
    }
    if (item.type === 'call') {
      const c = item as FromCall;
      const name = qname(c.function);
      return scope.add({
        alias: c.alias?.name ?? name,
        source: name,
        kind: 'function',
        columns: [],
        columnsKnown: false,
        aliased: !!c.alias,
        nullExtended: false,
      });
    }
    this.error(`FROM item of type "${(item as { type: string }).type}" is not supported`, this.source.exact(item), 'warn');
    return undefined;
  }

  private bindTableRelation(
    name: string,
    schema: string | undefined,
    alias: string | undefined,
    scope: Scope,
    ctes: Map<string, CteBinding>,
    node: unknown,
  ): BoundRelation | undefined {
    // A CTE name shadows a base table, but only when written unqualified.
    if (!schema) {
      const cte = ctes.get(sqlNameKey(name));
      if (cte) {
        return scope.add({
          alias: alias ?? cte.name,
          source: cte.name,
          kind: 'cte',
          columns: cte.columns,
          columnsKnown: cte.columnsKnown,
          aliased: alias !== undefined,
          nullExtended: false,
          blockId: cte.blockId,
          uniqueOutputKeys: cte.uniqueOutputKeys,
          maxRows: cte.maxRows,
          maxRowsReason: cte.maxRowsReason,
        });
      }
    }

    const rel = relationFromTable(this.catalog, name, schema, alias);
    if (rel) return scope.add(rel);

    const written = schema ? `${schema}.${name}` : name;
    const exists = this.catalog.tables.find((table) => sqlNameEquals(table.name, name));
    this.error(
      exists
        ? `relation "${written}" is not in schema "${exists.schema}" (the catalog has ${exists.schema}.${exists.name})`
        : `relation "${written}" is not in the catalog; columns from it cannot be resolved`,
      this.source.exact(node),
      'error',
    );
    // Keep the alias in scope with an unknown column list so that references
    // to it degrade to "unresolved column" instead of "unknown relation".
    return scope.add({
      alias: alias ?? name,
      source: name,
      schema,
      kind: 'table',
      columns: [],
      columnsKnown: false,
      aliased: alias !== undefined,
      nullExtended: false,
    });
  }

  /** Mark the relations an outer join can null-extend. */
  private applyNullExtension(join: JoinClause | null | undefined, scope: Scope, added?: BoundRelation): void {
    if (!join) return;
    const preceding = scope.relations.filter((r) => r !== added);
    switch (join.type) {
      case 'LEFT JOIN':
        if (added) added.nullExtended = true;
        break;
      case 'RIGHT JOIN':
        for (const r of preceding) r.nullExtended = true;
        break;
      case 'FULL JOIN':
        if (added) added.nullExtended = true;
        for (const r of preceding) r.nullExtended = true;
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Joins
  // -------------------------------------------------------------------------

  private bindJoin(
    join: JoinClause,
    right: BoundRelation,
    previous: BoundRelation[],
    scope: Scope,
    block: QueryBlockIR,
  ): JoinIR {
    const type = joinType(join.type);
    const equiKeys: JoinIR['equiKeys'] = [];
    const residual: Predicate[] = [];
    const leftCandidates = new Set<string>();

    if (join.using && join.using.length > 0) {
      const pred = this.syntheticUsingPredicate(join, type, right, previous, scope, equiKeys, leftCandidates);
      if (pred) block.predicates.push(pred);
    }

    for (const c of conjuncts(join.on)) {
      const pred = this.predicate(c, 'on', scope);
      block.predicates.push(pred);
      const key = this.asEquiKey(c, right, scope);
      if (key) {
        equiKeys.push(key);
        if (key.left.alias) leftCandidates.add(key.left.alias);
      } else {
        residual.push(pred);
        for (const alias of relationsTouched(pred.columns)) {
          if (alias !== right.alias) leftCandidates.add(alias);
        }
      }
    }

    const leftRelation =
      [...leftCandidates].find((a) => previous.some((p) => p.alias === a)) ??
      previous[previous.length - 1]?.alias ??
      '(unknown)';

    const fan = this.computeFanOut(type, right, equiKeys, previous, leftRelation);
    // Multiplicity is cumulative within this block: once a relation's rows are
    // duplicated, every later join here sees a left input that is no longer unique.
    // Block-scoped on purpose — see multipliedByBlock.
    const multiplied = this.currentMultiplied();
    for (const alias of fan.multiplied) multiplied.add(alias);

    return {
      type,
      leftRelation,
      rightRelation: right.alias,
      equiKeys,
      residualPredicates: residual,
      fanOut: fan.fanOut,
      fanOutReason: fan.reason,
      fanOutSide: fan.side,
      multipliedRelations: fan.multiplied,
    };
  }

  private syntheticUsingPredicate(
    join: JoinClause,
    joinIrType: JoinIR['type'],
    right: BoundRelation,
    previous: BoundRelation[],
    scope: Scope,
    equiKeys: JoinIR['equiKeys'],
    leftCandidates: Set<string>,
  ): Predicate | undefined {
    const cols = (join.using ?? []).map((n) => n.name);
    const refs: ResolvedColumnRef[] = [];
    const mergedPairs: Array<{
      left: { relation: BoundRelation; column: BoundColumn };
      right: { relation: BoundRelation; column: BoundColumn };
    }> = [];
    for (const col of cols) {
      const rightCols = right.columns.filter((c) => sqlNameEquals(c.name, col));
      const left = scope.usingLeftColumn(right, previous, col);
      if (rightCols.length !== 1 || 'error' in left) {
        const detail =
          rightCols.length > 1 || ('error' in left && left.error === 'ambiguous')
            ? 'the key is ambiguous on one side'
            : 'the key is missing on one side';
        this.error(`USING (${col}) does not resolve on both sides of the join`, this.source.exact(join), 'error');
        this.error(`USING (${col}) cannot form a merged output column: ${detail}`, this.source.exact(join), 'error');
        continue;
      }
      const rightCol = rightCols[0]!;
      const leftRel = left.relation;
      const leftCol = left.column;
      const l: ResolvedColumnRef = { alias: leftRel.alias, table: leftRel.source, column: leftCol.name, dataType: leftCol.dataType };
      const r: ResolvedColumnRef = { alias: right.alias, table: right.source, column: rightCol.name, dataType: rightCol.dataType };
      recordColumnNullability(
        l,
        leftCol.nullable === undefined ? undefined : leftCol.nullable || leftRel.nullExtended,
        `${leftRel.source}.${leftCol.name} nullability from the joined relation`,
      );
      recordColumnNullability(
        r,
        rightCol.nullable === undefined ? undefined : rightCol.nullable || right.nullExtended,
        `${right.source}.${rightCol.name} nullability from the joined relation`,
      );
      equiKeys.push({ left: l, right: r });
      leftCandidates.add(leftRel.alias);
      refs.push(l, r);
      mergedPairs.push({ left, right: { relation: right, column: rightCol } });
    }
    if (refs.length === 0) return undefined;
    scope.mergeUsingColumns(mergedPairs, previous, joinIrType);
    return {
      sql: `USING (${cols.join(', ')})`,
      kind: 'join',
      columns: refs,
      sargable: true,
      sargableReason: 'USING expands to equality between identically named columns of the two relations, which is a plain equi-join key.',
      clause: 'on',
    };
  }

  /** An ON conjunct that is `<bare col of right> = <bare col of another rel>`. */
  private asEquiKey(
    expr: Expr,
    right: BoundRelation,
    scope: Scope,
  ): { left: ResolvedColumnRef; right: ResolvedColumnRef } | undefined {
    const n = expr as { type?: string; op?: string; left?: Expr; right?: Expr };
    if (n.type !== 'binary' || n.op !== '=') return undefined;
    const a = analyzeOperand(n.left);
    const b = analyzeOperand(n.right);
    if (!a.bare || !b.bare) return undefined;
    const ra = this.resolveRefIn(scope, a.bare);
    const rb = this.resolveRefIn(scope, b.bare);
    if (ra.unresolved || rb.unresolved) return undefined;
    if (ra.alias === rb.alias) return undefined;
    if (ra.alias === right.alias) return { left: rb, right: ra };
    if (rb.alias === right.alias) return { left: ra, right: rb };
    return undefined;
  }

  /**
   * Builds the JoinIR entries that an old-style comma join implies.
   *
   * `FROM a, b WHERE a.k = b.k` is an inner join written with the condition in
   * WHERE. Without this, such a query yields zero joins and therefore reports no
   * fan-out — the same correctness signal loss as the orientation bug, reached by
   * a different spelling.
   *
   * A comma-joined relation with no equating WHERE predicate is a genuine cross
   * join and is left alone rather than guessed at.
   */
  private synthesizeCommaJoins(block: QueryBlockIR, entries: Array<{ rel?: BoundRelation; node: From }>): void {
    const aliasOf = (ref: ResolvedColumnRef): string | undefined => ref.alias ?? ref.table;

    for (let i = 1; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.node.join || !entry.rel) continue; // explicit join, already handled

      const rightAlias = entry.rel.alias;
      const previous = entries.slice(0, i).map((e) => e.rel).filter(Boolean) as BoundRelation[];
      const previousAliases = new Set(previous.map((p) => p.alias));

      const equiKeys: JoinIR['equiKeys'] = [];
      for (const predicate of block.predicates) {
        if (predicate.clause !== 'where') continue;
        if (predicate.kind !== 'equality' && predicate.kind !== 'join') continue;
        if (predicate.negated) continue;
        const cols = predicate.columns.filter((c) => !c.unresolved);
        if (cols.length !== 2) continue;
        const [a, b] = cols as [ResolvedColumnRef, ResolvedColumnRef];
        const aAlias = aliasOf(a);
        const bAlias = aliasOf(b);
        if (aAlias === rightAlias && bAlias && previousAliases.has(bAlias)) equiKeys.push({ left: b, right: a });
        else if (bAlias === rightAlias && aAlias && previousAliases.has(aAlias)) equiKeys.push({ left: a, right: b });
      }

      if (equiKeys.length === 0) continue; // genuine cross join; do not invent one

      const leftRelation = aliasOf(equiKeys[0]!.left) ?? previous[previous.length - 1]?.alias ?? '(unknown)';
      const fan = this.computeFanOut('inner', entry.rel, equiKeys, previous, leftRelation);
      const multiplied = this.currentMultiplied();
      for (const alias of fan.multiplied) multiplied.add(alias);

      block.joins.push({
        type: 'inner',
        leftRelation,
        rightRelation: rightAlias,
        equiKeys,
        residualPredicates: [],
        fanOut: fan.fanOut,
        fanOutReason: `${fan.reason} (implied by an old-style comma join whose condition is in WHERE)`,
        fanOutSide: fan.side,
        multipliedRelations: fan.multiplied,
      });
    }
  }

  /**
   * A join fans out when the right input is not unique on the join key: one
   * left row can then match several right rows, multiplying it. Uniqueness is
   * proven from the catalog (primary key / unique index) or, for a derived
   * table, from its own GROUP BY or DISTINCT.
   */
  private computeFanOut(
    type: JoinIR['type'],
    right: BoundRelation,
    equiKeys: JoinIR['equiKeys'],
    previous: BoundRelation[],
    leftRelation: string,
  ): { fanOut: boolean; reason: string; side: JoinIR['fanOutSide']; multiplied: string[] } {
    if (type === 'semi' || type === 'anti') {
      return { fanOut: false, side: 'none', multiplied: [], reason: `a ${type}-join emits each left row at most once regardless of how many right rows match.` };
    }
    if (type === 'cross') {
      if (right.maxRows !== undefined && right.maxRows <= 1) {
        return {
          fanOut: false,
          side: 'none',
          multiplied: [],
          reason:
            `${right.alias} is provably at most one row (${right.maxRowsReason ?? 'a hard derived-cardinality bound'}), ` +
            'so pairing it with each left row cannot multiply a left row.',
        };
      }
      const n = right.table?.rowCount;
      return {
        fanOut: true,
        side: 'both',
        multiplied: [...previous.map((p) => p.alias), right.alias],
        reason: `a cross join pairs every left row with every right row${n ? ` (${fmt(n)} of them)` : ''}, so it multiplies unconditionally.`,
      };
    }
    if (equiKeys.length === 0) {
      if (right.maxRows !== undefined && right.maxRows <= 1) {
        return {
          fanOut: false,
          side: 'none',
          multiplied: [],
          reason:
            `${right.alias} is provably at most one row (${right.maxRowsReason ?? 'a hard derived-cardinality bound'}), ` +
            'so this join cannot match more than one right row per left row even without an equality key.',
        };
      }
      // A correlated LATERAL spells its join condition inside its own block, so the
      // outer ON reads `ON true` and only *looks* keyless. Treating that as keyless
      // claims the lateral's own rows are multiplied, which is a false positive: an
      // aggregate over them is correct whenever the outer side is unique on the
      // correlation key. Recover the keys and reason as the equivalent plain join.
      const corr = this.lateralCorrelation(right, previous);
      if (corr) {
        const leftInput = previous.map((p) => p.alias);
        const leftProof = this.proveLeftUnique(previous, corr.keys, corr.leftAlias);
        const perOuter = corr.atMostOnePerOuterRow;
        if (perOuter && leftProof.unique) {
          return {
            fanOut: false,
            side: 'none',
            multiplied: [],
            reason:
              `the lateral is correlated on ${corr.description}, ${corr.uniqueReason}, and ${leftProof.reason}, ` +
              'so this join cannot multiply rows on either side.',
          };
        }
        if (perOuter) {
          return {
            fanOut: true,
            side: 'right',
            multiplied: [right.alias],
            reason:
              `the lateral is correlated on ${corr.description} and ${corr.uniqueReason}, so no left row is duplicated — ` +
              `but ${leftProof.reason}, so each ${right.alias} row is re-derived once per matching left row. ` +
              `An aggregate over ${right.alias}'s columns is therefore over-counted.`,
          };
        }
        if (leftProof.unique) {
          return {
            fanOut: true,
            side: 'left',
            multiplied: leftInput,
            reason:
              `the lateral is correlated on ${corr.description} and can return more than one row per left row, ` +
              `so left rows are multiplied. The left input is unique on the correlation key ` +
              `(${leftProof.via ?? 'proven'}), so ${right.alias}'s rows are not re-derived for a second left row — ` +
              `an aggregate over ${right.alias}'s columns is not over-counted.`,
          };
        }
        return {
          fanOut: true,
          side: 'both',
          multiplied: [...leftInput, right.alias],
          reason:
            `the lateral is correlated on ${corr.description}, can return more than one row per left row, and ` +
            'the left input is not unique on the correlation key, so rows multiply in both directions.',
        };
      }

      return {
        fanOut: true,
        side: 'both',
        multiplied: [...previous.map((p) => p.alias), right.alias],
        reason: 'there is no equality join key, so nothing bounds how many right rows a left row can match; every left row can be multiplied.',
      };
    }

    const rightCols = equiKeys.filter((k) => k.right.alias === right.alias).map((k) => k.right.column);
    if (rightCols.length === 0) {
      return { fanOut: true, side: 'both', multiplied: [...previous.map((p) => p.alias), right.alias], reason: 'the join key columns on the right side did not resolve, so uniqueness cannot be proven; assuming it can multiply.' };
    }

    const proof = this.proveUnique(right, rightCols);
    const leftProof = this.proveLeftUnique(previous, equiKeys, leftRelation);
    // Every relation joined so far shares the left input's fate: if the left
    // input is duplicated, all of them are.
    const leftInput = previous.map((p) => p.alias);

    if (proof.unique) {
      if (leftProof.unique) {
        return {
          fanOut: false,
          side: 'none',
          multiplied: [],
          reason: `${proof.reason}, and ${leftProof.reason}, so this join cannot multiply rows on either side.`,
        };
      }
      // The mirror-image fan-out. The left input is not unique on the key, so
      // each RIGHT row is repeated once per matching left row — which means an
      // aggregate over the right relation's columns is over-counted, even
      // though no left row is duplicated.
      const ratio = leftProof.ratio;
      const multiplier = ratio
        ? ` Each matching ${right.alias} row is therefore repeated about ${ratio.toFixed(1)}x.`
        : '';
      return {
        fanOut: true,
        side: 'right',
        multiplied: [right.alias],
        reason:
          `${proof.reason}, so no ${leftRelation} row is duplicated — but ${leftProof.reason}, ` +
          `so each ${right.alias} row is repeated once per matching left row.${multiplier} ` +
          `An aggregate over ${right.alias}'s columns is therefore over-counted.`,
      };
    }

    const ratio = right.kind === 'table' ? rowsPerKey(this.catalog, right.source, rightCols) : undefined;
    const multiplier = ratio ? ` Each matching ${leftRelation} row is therefore multiplied about ${ratio.toFixed(1)}x on average.` : '';

    if (leftProof.unique) {
      return {
        fanOut: true,
        side: 'left',
        multiplied: leftInput,
        reason:
          `${proof.reason}.${multiplier} The left input is unique on the key (${leftProof.via ?? 'proven'}), ` +
          `so ${right.alias}'s rows are not duplicated in the other direction.`,
      };
    }
    return {
      fanOut: true,
      side: 'both',
      multiplied: [...leftInput, right.alias],
      reason: `${proof.reason}.${multiplier} Neither side is unique on the key, so rows multiply in both directions.`,
    };
  }

  /**
   * Recover the equi-keys of a correlated LATERAL, whose join condition lives
   * inside its own block rather than in the outer ON clause.
   *
   * A predicate inside the derived block equating one of that block's relations
   * to a relation written to its *left* is exactly the key an equivalent plain
   * join would have spelled in ON. Only a lateral can produce one: a plain
   * derived table is bound against the enclosing scope and cannot see `previous`
   * at all, so a resolved reference to one of those aliases is itself the proof
   * of correlation. That makes this structural rather than syntax-sniffing.
   *
   * Returns undefined when nothing correlates, leaving the conservative keyless
   * verdict in place.
   */
  private lateralCorrelation(
    right: BoundRelation,
    previous: BoundRelation[],
  ): { keys: JoinIR['equiKeys']; leftAlias: string; description: string; atMostOnePerOuterRow: boolean; uniqueReason: string } | undefined {
    if (!right.blockId || previous.length === 0) return undefined;
    const block = this.blocks.find((b) => b.id === right.blockId);
    if (!block) return undefined;

    const outer = new Set(previous.map((p) => p.alias));
    const inner = new Set(block.relations.map((r) => r.alias));
    const aliasOf = (ref: ResolvedColumnRef): string | undefined => ref.alias ?? ref.table;

    const keys: JoinIR['equiKeys'] = [];
    const innerCols: string[] = [];
    for (const predicate of block.predicates) {
      if (predicate.kind !== 'equality' && predicate.kind !== 'join') continue;
      if (predicate.negated) continue;
      const cols = predicate.columns.filter((c) => !c.unresolved);
      if (cols.length !== 2) continue;
      const [a, b] = cols as [ResolvedColumnRef, ResolvedColumnRef];
      const aA = aliasOf(a);
      const bA = aliasOf(b);
      if (aA && bA && inner.has(aA) && outer.has(bA)) { keys.push({ left: b, right: a }); innerCols.push(a.column); }
      else if (aA && bA && inner.has(bA) && outer.has(aA)) { keys.push({ left: a, right: b }); innerCols.push(b.column); }
    }
    if (keys.length === 0) return undefined;

    const leftAlias = aliasOf(keys[0]!.left);
    if (!leftAlias) return undefined;

    // How many rows the lateral can return per outer row. Provable only in the
    // simple shape: one base relation, no joins of its own, correlated on a key
    // that relation is unique over. Anything richer -- extra joins, set
    // operations, a second source -- is left as "can return many", which costs a
    // noisier verdict rather than a missed correctness signal.
    let atMostOnePerOuterRow = false;
    let uniqueReason = '';
    const only = block.relations.length === 1 ? block.relations[0] : undefined;
    if (only && only.kind === 'table' && block.joins.length === 0 && innerCols.length > 0) {
      const proof = uniqueOnColumns(this.catalog, only.source, innerCols);
      if (proof.unique) {
        atMostOnePerOuterRow = true;
        uniqueReason = proof.reason;
      }
    }

    return {
      keys,
      leftAlias,
      description: keys.map((k) => `${aliasOf(k.right)}.${k.right.column} = ${aliasOf(k.left)}.${k.left.column}`).join(' and '),
      atMostOnePerOuterRow,
      uniqueReason,
    };
  }

  /**
   * Whether the *left input* — the joined product of everything so far, not one
   * base table — is unique on its side of the join key.
   *
   * Conservative by construction: uniqueness must be provable from the catalog
   * for the relation supplying the key, and that relation must not already have
   * been duplicated by an earlier join. Anything else reports not-unique, which
   * costs a noisier verdict rather than a missed correctness signal.
   */
  private proveLeftUnique(
    previous: BoundRelation[],
    equiKeys: JoinIR['equiKeys'],
    leftRelation: string,
  ): { unique: boolean; reason: string; via?: string; ratio?: number } {
    const leftRel = previous.find((p) => p.alias === leftRelation);
    const cols = equiKeys.filter((k) => k.left.alias === leftRelation).map((k) => k.left.column);
    if (!leftRel || cols.length === 0) {
      return {
        unique: false,
        reason: 'the left input\'s uniqueness on the join key could not be established',
      };
    }
    if (this.currentMultiplied().has(leftRelation)) {
      return {
        unique: false,
        reason: `${leftRelation} has already been duplicated by an earlier join, so the left input is not unique on the key`,
      };
    }
    const proof = this.proveUnique(leftRel, cols);
    if (proof.unique) return { unique: true, reason: proof.reason, via: (proof as { via?: string }).via };
    const ratio = leftRel.kind === 'table' ? rowsPerKey(this.catalog, leftRel.source, cols) : undefined;
    return { unique: false, reason: proof.reason, ratio };
  }

  private proveUnique(rel: BoundRelation, cols: string[]) {
    if (rel.kind === 'table') return uniqueOnColumns(this.catalog, rel.source, cols);
    if (rel.uniqueOutputKeys?.length) {
      for (const key of rel.uniqueOutputKeys) {
        if (key.length > 0 && key.every((k) => cols.some((c) => sqlNameEquals(c, k)))) {
          return {
            unique: true,
            reason: `${rel.alias} is grouped/deduplicated on (${key.join(', ')}), which the join key covers, so it emits at most one row per key value`,
          };
        }
      }
    }
    return {
      unique: false,
      reason: `${rel.alias} is a ${rel.kind} whose output is not provably unique on (${cols.join(', ')})`,
    };
  }

  /** Whether the *other* input can also be multiplied — useful, not the contract. */
  private leftUniquenessNote(previous: BoundRelation[], equiKeys: JoinIR['equiKeys'], leftRelation: string): string {
    const leftRel = previous.find((p) => p.alias === leftRelation);
    if (!leftRel || leftRel.kind !== 'table') return '';
    const cols = equiKeys.filter((k) => k.left.alias === leftRelation).map((k) => k.left.column);
    if (cols.length === 0) return '';
    const proof = uniqueOnColumns(this.catalog, leftRel.source, cols);
    return proof.unique
      ? ` The left input is unique on the key (${proof.via}), so right-side rows are not duplicated in the other direction.`
      : ' Neither side is unique on the key, so rows multiply in both directions.';
  }

  // -------------------------------------------------------------------------
  // Projections, grouping, ordering
  // -------------------------------------------------------------------------

  private bindProjection(col: SelectedColumn, scope: Scope, block: QueryBlockIR): void {
    const expr = col.expr;
    const isStar = (expr as { type?: string }).type === 'ref' && (expr as ExprRef).name === '*';
    const projection: QueryBlockIR['projections'][number] = {
      sql: this.source.of(expr),
      alias: col.alias?.name,
      columns: [],
    };

    if (isStar) {
      const qualifier = (expr as ExprRef).table?.name;
      projection.columns = scope.starColumns(qualifier);
      this.starProjections.add(projection);
      if (projection.columns.length === 0) {
        this.error(
          `"${projection.sql}" could not be expanded: no in-scope relation has a known column list`,
          projection.sql,
          'warn',
        );
      }
    } else {
      projection.columns = analyzeOperand(expr).refs.map((r) => this.resolveRefIn(scope, r));
      const dedup = new Map<string, ResolvedColumnRef>();
      for (const r of projection.columns) dedup.set(`${r.alias}.${r.column}`, r);
      projection.columns = [...dedup.values()];
    }

    const subs: string[] = [];
    for (const sub of subqueriesOf(expr)) subs.push(this.bindSubqueryIn(sub, scope, 'projection'));
    if (subs.length) {
      projection.subqueryBlockIds = subs;
      SUBQUERY_BLOCKS.set(projection, subs);
    }

    block.projections.push(projection);
  }

  /** Bind one lossless GROUP BY item plus its backwards-compatible base refs. */
  private bindGroupKey(
    expr: Expr,
    scope: Scope,
    block: QueryBlockIR,
  ): {
    expression: NonNullable<QueryBlockIR['groupByExpressions']>[number];
    refs: ResolvedColumnRef[];
    bareRefs: ResolvedColumnRef[];
  } {
    const sql = this.source.of(expr);
    const ordinal = literalInt(expr);
    if (ordinal !== undefined && (expr as { type?: string }).type === 'integer') {
      const projection = block.projections[ordinal - 1];
      if (!projection) {
        this.error(`GROUP BY ${ordinal} refers to a select-list position that does not exist`, this.source.of(expr), 'error');
        return { expression: { sql, columns: [], ordinal }, refs: [], bareRefs: [] };
      }
      const refs = projection.columns.filter((ref) => !ref.unresolved);
      return {
        expression: { sql, columns: refs, ordinal },
        refs,
        bareRefs: projection.columns.length === 1 && isBareColumnText(projection.sql) ? refs : [],
      };
    }

    const op = analyzeOperand(expr);
    if (op.bare) {
      // PostgreSQL resolves a simple GROUP BY name against input columns
      // first, then against select-list aliases. (ORDER BY intentionally uses
      // the opposite preference.) Probe without recording an error so a real
      // output alias can be the fallback.
      if (!op.bare.table) {
        const input = scope.resolve(undefined, op.bare.name);
        if (!input.error) {
          const ref = this.resolveRefIn(scope, op.bare);
          return { expression: { sql, columns: [ref] }, refs: [ref], bareRefs: [ref] };
        }
        const named = block.projections.filter(
          (p) => p.alias && sqlNameEquals(p.alias, op.bare!.name),
        );
        if (named.length > 1 && !input.error.includes('ambiguous')) {
          this.error(`GROUP BY "${op.bare.name}" is ambiguous: more than one output column has that name`, sql, 'error');
          return { expression: { sql, columns: [] }, refs: [], bareRefs: [] };
        }
        if (named.length === 1 && !input.error.includes('ambiguous')) {
          const refs = named[0]!.columns.filter((ref) => !ref.unresolved);
          const bareRefs = named[0]!.columns.length === 1 && isBareColumnText(named[0]!.sql) ? refs : [];
          return { expression: { sql, columns: refs }, refs, bareRefs };
        }
      }
      const ref = this.resolveRefIn(scope, op.bare);
      return { expression: { sql, columns: [ref] }, refs: [ref], bareRefs: [ref] };
    }

    const refs = dedupeRefs(op.refs.map((r) => this.resolveRefIn(scope, r)));
    return { expression: { sql, columns: refs }, refs, bareRefs: [] };
  }

  private bindOrderBy(o: OrderByStatement, scope: Scope, block: QueryBlockIR): QueryBlockIR['orderBy'][number] {
    const sql = this.source.of(o.by);
    const direction: 'asc' | 'desc' = o.order === 'DESC' ? 'desc' : 'asc';
    const nulls = o.nulls === 'FIRST' ? 'first' : o.nulls === 'LAST' ? 'last' : undefined;

    let column: ResolvedColumnRef | null = null;
    const ordinal = (o.by as { type?: string }).type === 'integer' ? literalInt(o.by) : undefined;
    if (ordinal !== undefined) {
      const projection = block.projections[ordinal - 1];
      if (projection && projection.columns.length === 1 && isBareColumnText(projection.sql)) column = projection.columns[0]!;
      else if (!projection) this.error(`ORDER BY ${ordinal} refers to a select-list position that does not exist`, sql, 'error');
    } else {
      const op = analyzeOperand(o.by);
      if (op.bare) {
        // An unqualified name may be an output alias, which shadows nothing in
        // Postgres' ORDER BY but must not be reported as an unknown column.
        const bare = op.bare;
        const named = !bare.table
          ? block.projections.filter((p) => p.alias && sqlNameEquals(p.alias, bare.name))
          : [];
        if (named.length > 1) {
          this.error(`ORDER BY "${bare.name}" is ambiguous: more than one output column has that name`, sql, 'error');
        } else if (named.length === 1) {
          const projection = named[0]!;
          column = projection.columns.length === 1 && isBareColumnText(projection.sql) ? projection.columns[0]! : null;
        } else {
          const resolved = this.resolveRefIn(scope, bare);
          column = resolved.unresolved ? null : resolved;
        }
      }
    }
    const entry: QueryBlockIR['orderBy'][number] = { column, sql, direction };
    if (nulls) entry.nulls = nulls;
    return entry;
  }

  private collectCalls(stmt: SelectFromStatement, block: QueryBlockIR, scope: Scope): void {
    const seen = new Set<string>();
    const visit = (e: Expr | null | undefined, projectionContext = false) => {
      forEachCall(e, (c: ExprCall) => {
        const sql = this.source.of(c);
        if (isWindowCall(c)) {
          if (seen.has('w:' + sql)) return;
          seen.add('w:' + sql);
          block.windowFunctions.push({
            sql,
            partitionBy: (c.over?.partitionBy ?? []).flatMap((p) =>
              analyzeOperand(p).refs.map((r) => this.resolveRefIn(scope, r)),
            ),
            orderBy: (c.over?.orderBy ?? []).map((o) => this.source.of(o)),
          });
          return;
        }
        if (isAggregateCall(c)) {
          if (seen.has('a:' + sql)) return;
          seen.add('a:' + sql);
          block.aggregates.push({
            sql,
            func: qname(c.function).toLowerCase(),
            distinct: c.distinct === 'distinct' ? true : undefined,
          });
          return;
        }
        if (projectionContext) this.blocksWithPossibleSrf.add(block);
      });
    };
    for (const c of stmt.columns ?? []) visit(c.expr, true);
    visit(stmt.having);
    for (const o of stmt.orderBy ?? []) visit(o.by);
    visit(stmt.where);
  }

  // -------------------------------------------------------------------------
  // Predicate plumbing
  // -------------------------------------------------------------------------

  private predicate(expr: Expr, clause: Clause, scope: Scope): Predicate {
    const ctx = this.contextFor(scope);
    const pred = buildPredicate(expr, clause, ctx);
    recordPredicateExpression(pred, expr);
    const subs = subqueriesOf(expr).map((s) => this.bindSubqueryIn(s, scope, clause));
    if (subs.length) {
      pred.subqueryBlockIds = subs;
      SUBQUERY_BLOCKS.set(pred, subs);
    }
    return pred;
  }

  private contextFor(scope: Scope): PredicateContext {
    return {
      source: this.source,
      catalog: this.catalog,
      resolveRef: (node) => this.resolveRefIn(scope, node),
      // Subqueries are bound by the caller (once, not once per assessment
      // pass), so this is a no-op that keeps `buildPredicate` self-contained.
      bindSubquery: () => '',
    };
  }

  private bindSubqueryIn(stmt: SelectStatement, scope: Scope, _role: string): string {
    const id = this.nextSubId();
    if (this.blocks.some((b) => b.id === id)) return id;
    this.bindStatement(stmt, id, scope, scope.ctes);
    return id;
  }

  /** Cached so repeated assessment passes resolve a node once. */
  private resolveRefIn(scope: Scope, node: ExprRef): ResolvedColumnRef {
    const cached = this.resolutionCache.get(node);
    if (cached) return cached;

    const resolution = scope.resolve(node.table, node.name);
    if (resolution.error) {
      this.error(resolution.error, this.source.exact(node), 'error');
    }
    if (resolution.outerScopeId) {
      const block = this.blockStack[this.blockStack.length - 1];
      if (block) {
        block.correlated = true;
        block.correlationRefs ??= [];
        const key = `${resolution.ref.alias}.${resolution.ref.column}`;
        if (!block.correlationRefs.some((r) => `${r.alias}.${r.column}` === key)) {
          block.correlationRefs.push(resolution.ref);
        }
      }
    }
    this.resolutionCache.set(node, resolution.ref);
    return resolution.ref;
  }

  // -------------------------------------------------------------------------
  // Local-predicate distribution and row estimates
  // -------------------------------------------------------------------------

  /**
   * Attach single-relation predicates to the relation whose scan can evaluate
   * them.
   *
   *  - WHERE conjuncts touching exactly one relation always qualify. That
   *    includes a conjunct on an outer-joined relation: Postgres demotes the
   *    outer join and pushes the filter into the scan, which is precisely why
   *    the demotion is silent.
   *  - HAVING conjuncts qualify only when they contain no aggregate and every
   *    column they touch is a grouping key — that is exactly the condition
   *    under which Postgres pushes the predicate below the aggregation.
   *  - ON conjuncts qualify on the null-supplying side of an outer join, and
   *    on either side of an inner join, but never on the preserved side of an
   *    outer join, where they control matching rather than filtering.
   */
  private distributeLocalPredicates(block: QueryBlockIR, scope: Scope): void {
    const byAlias = new Map(block.relations.map((r) => [r.alias, r]));
    // Only a true bare grouped column permits HAVING pushdown. Merely
    // appearing underneath `date_trunc(col)` or a cast does not group `col`
    // itself, even though `groupBy` exposes the expression's lineage refs.
    const groupKeys = this.bareGroupKeys.get(block) ?? new Set<string>();

    const push = (alias: string, pred: Predicate) => {
      const rel = byAlias.get(alias);
      if (rel && !rel.localPredicates.includes(pred)) rel.localPredicates.push(pred);
    };

    for (const pred of block.predicates) {
      // Correlated outer refs act as parameters during this block's scan. A
      // predicate that mentions one local relation plus outer refs is still a
      // local parameterized access restriction on that one inner relation.
      const touched = relationsTouched(pred.columns).filter((alias) => byAlias.has(alias));
      if (touched.length !== 1) continue;
      const alias = touched[0]!;

      if (pred.clause === 'where') {
        push(alias, pred);
        continue;
      }
      if (pred.clause === 'having') {
        if (containsAggregateText(pred)) continue;
        const allGrouped = pred.columns.every((c) => groupKeys.has(refKey(c)));
        if (allGrouped && groupKeys.size > 0) push(alias, pred);
        continue;
      }
      if (pred.clause === 'on') {
        const join = block.joins.find((j) => j.residualPredicates.includes(pred));
        if (!join || join.type === 'inner' || join.type === 'cross') {
          push(alias, pred);
        } else if (join.type === 'left' && alias === join.rightRelation) {
          push(alias, pred);
        } else if (join.type === 'right' && alias === join.leftRelation) {
          push(alias, pred);
        }
        // A FULL JOIN preserves both inputs. A one-sided ON condition controls
        // matching but cannot filter either base scan without dropping rows
        // that must instead be emitted as unmatched.
      }
    }
  }

  private estimateRelationRows(block: QueryBlockIR): void {
    for (const rel of block.relations) {
      if (rel.kind !== 'table') continue;
      const table = findTable(this.catalog, rel.source);
      if (!table?.rowCount) continue;
      // `estimatedRows` is presented as the post-filter estimate. Multiplying
      // only the selectivities we happen to know would instead be an
      // unlabelled partial upper bound, so omit it whenever any local conjunct
      // is unknown.
      if (rel.localPredicates.some((pred) => pred.selectivity === undefined)) continue;
      let rows = table.rowCount;
      for (const pred of rel.localPredicates) {
        if (pred.selectivity !== undefined) rows *= pred.selectivity;
      }
      rel.estimatedRows = Math.max(1, Math.round(rows));
    }
  }

  // -------------------------------------------------------------------------
  // Block bookkeeping
  // -------------------------------------------------------------------------

  private newBlock(id: string, kind: QueryBlockIR['kind']): QueryBlockIR {
    const block: QueryBlockIR = {
      id,
      kind,
      relations: [],
      joins: [],
      predicates: [],
      projections: [],
      groupBy: [],
      groupByExpressions: [],
      having: [],
      orderBy: [],
      windowFunctions: [],
      aggregates: [],
    };
    this.blocks.push(block);
    return block;
  }

  private nextSubId(): string {
    return `sub:${++this.subCounter}`;
  }

  private cteBindingFor(name: string, block: QueryBlockIR): CteBinding {
    const shape = this.outputShape(block);
    const bound = this.blockRowBound(block);
    return {
      name,
      blockId: block.id,
      columns: shape.columns,
      columnsKnown: shape.known,
      uniqueOutputKeys: this.uniqueOutputKeys(block),
      maxRows: bound?.maxRows,
      maxRowsReason: bound?.reason,
    };
  }

  /** Hard cardinality proofs used for fan-out, never planner estimates. */
  private blockRowBound(block: QueryBlockIR): { maxRows: number; reason: string } | undefined {
    let bound: { maxRows: number; reason: string } | undefined;
    const values = block.relations.length === 1 && block.relations[0]!.kind === 'values'
      ? block.relations[0]!.estimatedRows
      : undefined;
    if (values !== undefined) {
      bound = { maxRows: values, reason: `the VALUES constructor contains exactly ${values} row${values === 1 ? '' : 's'}` };
    } else if (
      block.aggregates.length > 0 &&
      (block.groupByExpressions?.length ?? 0) === 0 &&
      !this.blocksWithPossibleSrf.has(block)
    ) {
      bound = {
        maxRows: 1,
        reason: block.having.length > 0
          ? 'an aggregate query without GROUP BY emits zero or one row when HAVING is present'
          : 'an aggregate query without GROUP BY emits exactly one row',
      };
    } else if (
      (block.kind === 'select' || block.kind === 'subquery' || block.kind === 'cte') &&
      block.relations.length === 0 &&
      !this.blocksWithPossibleSrf.has(block)
    ) {
      bound = { maxRows: 1, reason: 'a SELECT without a FROM input emits at most one row' };
    }

    if (block.limit !== undefined) {
      const limitBound = Math.max(0, block.limit);
      if (!bound || limitBound < bound.maxRows) {
        bound = { maxRows: limitBound, reason: `LIMIT ${block.limit} is a hard output-row bound` };
      }
    }
    return bound;
  }

  /** Output column names and types of a block, for use as a relation. */
  private outputShape(block: QueryBlockIR): { columns: BoundColumn[]; known: boolean } {
    const columns: BoundColumn[] = [];
    let known = block.projections.length > 0;
    for (const p of block.projections) {
      if (this.starProjections.has(p)) {
        for (const c of p.columns) {
          columns.push({ name: c.column, dataType: c.dataType, nullable: columnNullability(c)?.nullable });
        }
        if (p.columns.length === 0) known = false;
        continue;
      }
      if (p.alias) {
        const bare = p.columns.length === 1 && isBareColumnText(p.sql);
        columns.push({
          name: p.alias,
          dataType: p.columns.length === 1 ? p.columns[0]!.dataType : undefined,
          // Do not inherit nullability through arbitrary expressions. max()
          // can return NULL over an empty input even when its argument is NOT
          // NULL, and jsonb extraction can produce NULL for a missing key.
          nullable: bare ? columnNullability(p.columns[0]!)?.nullable : undefined,
        });
        continue;
      }
      if (p.columns.length === 1 && isBareColumnText(p.sql)) {
        columns.push({
          name: p.columns[0]!.column,
          dataType: p.columns[0]!.dataType,
          nullable: columnNullability(p.columns[0]!)?.nullable,
        });
        continue;
      }
      known = false;
    }
    return { columns, known };
  }

  /** Column sets on which a block's output is provably unique. */
  private uniqueOutputKeys(block: QueryBlockIR): string[][] | undefined {
    const keys: string[][] = [];
    const grouping = block.groupByExpressions ?? [];
    if (grouping.length > 0) {
      const names = grouping.map((g) => this.outputNameForGroup(block, g)).filter(Boolean) as string[];
      if (names.length === grouping.length) keys.push(names);
    }
    if (block.distinct && block.projections.length > 0) {
      const names = block.projections.map((p) => (this.starProjections.has(p) ? undefined : p.alias ?? (p.columns.length === 1 && isBareColumnText(p.sql) ? p.columns[0]!.column : undefined)));
      if (names.every(Boolean)) keys.push(names as string[]);
    }
    return keys.length ? keys : undefined;
  }

  private outputNameForGroup(
    block: QueryBlockIR,
    group: NonNullable<QueryBlockIR['groupByExpressions']>[number],
  ): string | undefined {
    if (group.ordinal !== undefined) {
      const projection = block.projections[group.ordinal - 1];
      return projection ? projectionOutputName(projection, this.starProjections.has(projection)) : undefined;
    }
    for (const projection of block.projections) {
      if (projection.sql === group.sql) return projectionOutputName(projection, this.starProjections.has(projection));
      if (projection.alias && sqlNameEquals(projection.alias, unquoteIdentifier(group.sql))) {
        return projection.alias;
      }
    }
    if (group.columns.length === 1) return this.outputNameFor(block, group.columns[0]!);
    return undefined;
  }

  private outputNameFor(block: QueryBlockIR, key: ResolvedColumnRef): string | undefined {
    for (const p of block.projections) {
      if (this.starProjections.has(p)) {
        if (p.columns.some((c) => c.column === key.column && c.alias === key.alias)) return key.column;
        continue;
      }
      if (p.columns.length === 1 && p.columns[0]!.column === key.column && p.columns[0]!.alias === key.alias && isBareColumnText(p.sql)) {
        return p.alias ?? key.column;
      }
    }
    return undefined;
  }
}

// ===========================================================================
// Derived views over the IR.
//
// `types.ts` has no field for "this relation is null-extended" or "this outer
// join was demoted". Rather than bend an existing field into a shape it was
// not declared for, the facts stay derivable from what the IR already records
// and these helpers do the deriving once, here, so five modules do not each
// re-implement join-tree reasoning slightly differently.
// ===========================================================================

/** Aliases of relations an outer join in this block can null-extend. */
export function nullExtendedRelations(block: QueryBlockIR): Set<string> {
  const out = new Set<string>();
  const order = block.relations.map((r) => r.alias);
  for (const join of block.joins) {
    if (join.type === 'left') out.add(join.rightRelation);
    else if (join.type === 'right') {
      for (const a of order) {
        if (a === join.rightRelation) break;
        out.add(a);
      }
    } else if (join.type === 'full') {
      out.add(join.rightRelation);
      for (const a of order) {
        if (a === join.rightRelation) break;
        out.add(a);
      }
    }
  }
  return out;
}

export interface OuterJoinDemotion {
  blockId: string;
  join: JoinIR;
  /** The WHERE predicate that eliminates the null-extended rows. */
  predicate: Predicate;
  relation: string;
  reason: string;
}

/**
 * Outer joins that a WHERE predicate silently turns into inner joins.
 *
 * A predicate demotes the join when it is in the WHERE clause and SQL
 * three-valued evaluation proves it rejects every null-extension scenario for
 * that join. FULL joins therefore require proofs for both unmatched sides;
 * composite left inputs of RIGHT/FULL joins are substituted together.
 */
export function outerJoinDemotions(ir: QueryIR): OuterJoinDemotion[] {
  const out: OuterJoinDemotion[] = [];
  for (const block of ir.blocks) {
    const order = block.relations.map((relation) => relation.alias);
    for (const join of block.joins) {
      if (join.type !== 'left' && join.type !== 'right' && join.type !== 'full') continue;
      const rightIndex = order.indexOf(join.rightRelation);
      const leftInput = rightIndex < 0 ? [join.leftRelation] : order.slice(0, rightIndex);
      const scenarios: string[][] = join.type === 'left'
        ? [[join.rightRelation]]
        : join.type === 'right'
          ? [leftInput]
          : [leftInput, [join.rightRelation]];

      for (const pred of block.predicates) {
        if (pred.clause !== 'where') continue;
        const touched = new Set(relationsTouched(pred.columns));
        // Attribute a demotion only when the predicate actually depends on a
        // null-supplied input in every scenario that must be eliminated.
        if (scenarios.some((scenario) => !scenario.some((alias) => touched.has(alias)))) continue;
        const analyses = scenarios.map((scenario) => analyzeNullRejection(pred, scenario));
        if (analyses.some((analysis) => analysis.outcome !== 'rejecting')) continue;
        const aliases = [...new Set(scenarios.flat())];
        out.push({
          blockId: block.id,
          join,
          predicate: pred,
          relation: aliases.join(', '),
          reason:
            `\`${pred.sql}\` is in WHERE and references ${aliases.join(', ')}, which the ${join.type.toUpperCase()} JOIN can null-extend. ` +
            `${analyses.map((analysis) => analysis.reason).join(' ')} ` +
            'Every unmatched-side scenario is rejected, so the outer join behaves exactly like an inner join for this predicate. ' +
            'Moving the predicate into the ON clause preserves the outer-join semantics.',
        });
      }
    }
  }
  return out;
}

/** Convenience lookup used by every downstream module. */
export function blockById(ir: QueryIR, id: string): QueryBlockIR | undefined {
  return ir.blocks.find((b) => b.id === id);
}

// ===========================================================================
// Small helpers
// ===========================================================================

function relationIR(rel: BoundRelation): RelationIR {
  return {
    alias: rel.alias,
    source: rel.source,
    kind: rel.kind,
    localPredicates: [],
  };
}

function joinType(t: JoinClause['type']): JoinIR['type'] {
  switch (t) {
    case 'LEFT JOIN':
      return 'left';
    case 'RIGHT JOIN':
      return 'right';
    case 'FULL JOIN':
      return 'full';
    case 'CROSS JOIN':
      return 'cross';
    default:
      return 'inner';
  }
}

function statementTypeOf(stmt: Statement): QueryIR['statementType'] {
  const t = (stmt as { type?: string }).type;
  if (t === 'with' || t === 'with recursive') {
    return statementTypeOf((stmt as unknown as { in: Statement }).in);
  }
  if (t === 'select' || t === 'union' || t === 'union all' || t === 'values') return 'select';
  if (t === 'insert' || t === 'update' || t === 'delete') return t;
  return 'other';
}

function literalInt(e: Expr | null | undefined): number | undefined {
  if (!e) return undefined;
  const t = (e as { type?: string }).type;
  if (t === 'integer' || t === 'numeric') {
    const v = (e as { value: number }).value;
    return Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

/** Is this projection source text a plain column reference? */
function isBareColumnText(sql: string): boolean {
  const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)';
  return new RegExp(`^${identifier}(?:\\.${identifier}){0,2}$`).test(sql);
}

function refKey(ref: ResolvedColumnRef): string {
  return `${ref.alias ?? ref.table ?? ''}\u0000${ref.column}`;
}

function dedupeRefs(refs: ResolvedColumnRef[]): ResolvedColumnRef[] {
  const seen = new Set<string>();
  const out: ResolvedColumnRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function unquoteIdentifier(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function projectionOutputName(
  projection: QueryBlockIR['projections'][number],
  star: boolean,
): string | undefined {
  if (star) return undefined;
  if (projection.alias) return projection.alias;
  if (projection.columns.length === 1 && isBareColumnText(projection.sql)) {
    return projection.columns[0]!.column;
  }
  return undefined;
}

function containsAggregateText(pred: Predicate): boolean {
  return pred.kind === 'other' && /\b(count|sum|avg|min|max|bool_and|bool_or|array_agg|string_agg)\s*\(/i.test(pred.sql);
}

function subqueriesOf(expr: Expr | null | undefined): SelectStatement[] {
  const out: SelectStatement[] = [];
  collectSubqueries(expr, out);
  return out;
}

const SUBQUERY_TYPES = new Set(['select', 'union', 'union all', 'with', 'with recursive']);

function collectSubqueries(e: unknown, out: SelectStatement[]): void {
  if (!e || typeof e !== 'object') return;
  const t = (e as { type?: string }).type;
  if (t && SUBQUERY_TYPES.has(t)) {
    out.push(e as SelectStatement);
    return; // nested-inside-nested is bound recursively by bindStatement
  }
  for (const key of Object.keys(e)) {
    if (key === '_location' || key === 'table') continue;
    const v = (e as Record<string, unknown>)[key];
    if (Array.isArray(v)) for (const x of v) collectSubqueries(x, out);
    else if (v && typeof v === 'object') collectSubqueries(v, out);
  }
}
