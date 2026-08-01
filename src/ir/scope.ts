/**
 * Name resolution.
 *
 * A `Scope` is one query block's FROM list plus a link to the block that
 * encloses it. Resolving a column walks outward: the innermost scope that
 * exposes the name wins, and a hit in an *enclosing* scope is by definition a
 * correlated reference.
 *
 * Postgres rules implemented here:
 *  - an alias hides the underlying table name (`shop.orders o` cannot be
 *    referred to as `orders`), so each relation exposes exactly one name;
 *  - a schema qualifier only matches an un-aliased relation from that schema;
 *  - an unqualified column is resolved by scanning the in-scope relations, and
 *    matching more than one of them is an error, not a coin flip;
 *  - a CTE name shadows a base table of the same name;
 *  - the same table joined twice under different aliases is two relations.
 */
import type { Catalog, RelationIR, ResolvedColumnRef, Table } from '../types.ts';

export interface ColumnNullability {
  nullable: boolean;
  reason: string;
}

const COLUMN_NULLABILITY = new WeakMap<object, ColumnNullability>();

/**
 * Nullability is absent from the shared ResolvedColumnRef contract. Keep it as
 * identity-keyed binding metadata so semantic analysis can still distinguish
 * NOT IN over a nullable projection from the safe case.
 */
export function columnNullability(ref: ResolvedColumnRef): ColumnNullability | undefined {
  if (ref.nullable !== undefined) {
    return {
      nullable: ref.nullable,
      reason: ref.nullabilityReason ?? 'nullability was serialized with the resolved column reference',
    };
  }
  return COLUMN_NULLABILITY.get(ref as object);
}

/** Internal companion for refs constructed outside Scope.resolve(). */
export function recordColumnNullability(
  ref: ResolvedColumnRef,
  nullable: boolean | undefined,
  reason: string,
): void {
  if (nullable === undefined) return;
  ref.nullable = nullable;
  ref.nullabilityReason = reason;
  COLUMN_NULLABILITY.set(ref as object, { nullable, reason });
}

export interface BoundColumn {
  name: string;
  dataType?: string;
  nullable?: boolean;
}

export interface BoundRelation {
  /** The single name this relation answers to inside the query. */
  alias: string;
  /** Base table name, CTE name, or a synthetic label for derived tables. */
  source: string;
  schema?: string;
  kind: RelationIR['kind'];
  /** Present when `kind === 'table'` and the table is in the catalog. */
  table?: Table;
  /** Output columns, when they are knowable. */
  columns: BoundColumn[];
  /**
   * False for set-returning functions and for derived tables whose projection
   * we could not name. Unqualified lookups then resolve optimistically instead
   * of reporting a spurious "unknown column".
   */
  columnsKnown: boolean;
  /** True when an alias was written; controls whether `schema.table` matches. */
  aliased: boolean;
  /** True when an outer join can null-extend every column of this relation. */
  nullExtended: boolean;
  /** For cte/subquery relations, the id of the block that produces the rows. */
  blockId?: string;
  /** Populated for derived tables/CTEs: grouping keys of the producing block. */
  uniqueOutputKeys?: string[][];
  /** A proven hard upper bound, as opposed to a planner cardinality estimate. */
  maxRows?: number;
  /** The syntactic proof behind `maxRows`. */
  maxRowsReason?: string;
}

export interface CteBinding {
  name: string;
  blockId: string;
  columns: BoundColumn[];
  columnsKnown: boolean;
  uniqueOutputKeys?: string[][];
  maxRows?: number;
  maxRowsReason?: string;
}

export interface Resolution {
  ref: ResolvedColumnRef;
  /** The relation the column came from, when it resolved. */
  relation?: BoundRelation;
  /** Set when the column resolved in an enclosing block (correlated). */
  outerScopeId?: string;
  /** Populated when the reference could not be bound. */
  error?: string;
}

/**
 * `pgsql-ast-parser` folds unquoted identifiers to lower case and preserves
 * quoted spelling. PostgreSQL therefore considers two parsed identifiers the
 * same when they are exactly equal; lower-casing them again would incorrectly
 * turn quoted "ORDER_ID" into the catalog column `order_id`.
 */
export function sqlNameEquals(a: string, b: string): boolean {
  return a === b;
}

export function sqlNameKey(name: string): string {
  return name;
}

interface StarColumn {
  relation: BoundRelation;
  column: BoundColumn;
}

interface MergedColumn extends StarColumn {
  members: StarColumn[];
}

export class Scope {
  readonly relations: BoundRelation[] = [];
  readonly blockId: string;
  readonly parent?: Scope;
  /** CTEs visible here and in every nested scope. */
  readonly ctes: Map<string, CteBinding>;
  /** PostgreSQL's joined-table output namespace, including USING merges. */
  private starOutput: StarColumn[] = [];
  private readonly mergedColumns: MergedColumn[] = [];

  constructor(
    blockId: string,
    parent?: Scope,
    ctes: Map<string, CteBinding> = new Map(),
  ) {
    this.blockId = blockId;
    this.parent = parent;
    this.ctes = ctes;
  }

  add(rel: BoundRelation): BoundRelation {
    this.relations.push(rel);
    for (const column of rel.columns) this.starOutput.push({ relation: rel, column });
    return rel;
  }

  byAlias(alias: string): BoundRelation | undefined {
    return this.relations.find((r) => sqlNameEquals(r.alias, alias));
  }

  /** A child scope for a nested block; inherits CTE visibility. */
  child(blockId: string): Scope {
    return new Scope(blockId, this, this.ctes);
  }

  /**
   * A scope used for LATERAL / correlated-in-FROM binding: the same block, but
   * only the relations that appear to the left of the lateral item.
   */
  lateralSnapshot(): Scope {
    const s = new Scope(this.blockId, this.parent, this.ctes);
    s.relations.push(...this.relations);
    s.starOutput.push(...this.starOutput);
    s.mergedColumns.push(...this.mergedColumns);
    return s;
  }

  /**
   * Resolve a USING key against the joined output to the left of `right`.
   * This is deliberately not the same as scanning every base relation: a key
   * merged by an earlier USING clause is one output column, not an ambiguity.
   */
  usingLeftColumn(
    right: BoundRelation,
    previous: BoundRelation[],
    name: string,
  ): { relation: BoundRelation; column: BoundColumn } | { error: 'missing' | 'ambiguous' } {
    const allowed = new Set(previous);
    const hits = this.starOutput.filter(
      (entry) => entry.relation !== right && allowed.has(entry.relation) && sqlNameEquals(entry.column.name, name),
    );
    if (hits.length === 1) return hits[0]!;
    return { error: hits.length === 0 ? 'missing' : 'ambiguous' };
  }

  /**
   * Install PostgreSQL's merged USING-column namespace. Unqualified lookups
   * see one key and unqualified `*` emits it once; qualified aliases still
   * expose each input key independently.
   */
  mergeUsingColumns(
    pairs: Array<{
      left: { relation: BoundRelation; column: BoundColumn };
      right: { relation: BoundRelation; column: BoundColumn };
    }>,
    previous: BoundRelation[],
    joinType: 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti' | 'lateral',
  ): void {
    if (pairs.length === 0) return;
    const mergedForJoin: MergedColumn[] = [];
    for (const { left, right } of pairs) {
      const existing = this.mergedColumns.find((m) =>
        m.members.some(
          (member) => member.relation === left.relation && sqlNameEquals(member.column.name, left.column.name),
        ),
      );
      const nullable = mergedNullability(left.column, right.column, joinType);
      const representativeRelation = joinType === 'right' ? right.relation : left.relation;
      const representativeColumn: BoundColumn = {
        name: left.column.name,
        dataType: left.column.dataType ?? right.column.dataType,
        nullable,
      };
      const merged: MergedColumn = existing ?? {
        relation: representativeRelation,
        column: representativeColumn,
        members: [left],
      };
      merged.relation = representativeRelation;
      merged.column = representativeColumn;
      if (!merged.members.some((m) => m.relation === right.relation && m.column === right.column)) {
        merged.members.push(right);
      }
      if (!existing) this.mergedColumns.push(merged);
      mergedForJoin.push(merged);
    }

    const rightRelation = pairs[0]!.right.relation;
    const prefixRelations = new Set([...previous, rightRelation]);
    const priorRelations = new Set(previous);
    const prior = this.starOutput.filter((entry) => priorRelations.has(entry.relation));
    const rightEntries = this.starOutput.filter((entry) => entry.relation === rightRelation);
    const futureEntries = this.starOutput.filter((entry) => !prefixRelations.has(entry.relation));
    const isKey = (entry: StarColumn) =>
      mergedForJoin.some((merged) =>
        merged.members.some(
          (member) => member.relation === entry.relation && sqlNameEquals(member.column.name, entry.column.name),
        ),
      );
    // SQL specifies USING keys first, followed by the remaining left output,
    // then remaining right columns. Preserve earlier merged keys as entries.
    this.starOutput = [
      ...mergedForJoin,
      ...prior.filter((entry) => !isKey(entry)),
      ...rightEntries.filter((entry) => !isKey(entry)),
      ...futureEntries,
    ];
  }

  /** Resolve `[schema.][qualifier.]name`, walking outward through parents. */
  resolve(qualifier: { name: string; schema?: string } | undefined, name: string): Resolution {
    let scope: Scope | undefined = this;
    let depth = 0;
    const ambiguousIn: string[] = [];
    while (scope) {
      const hit = scope.resolveLocal(qualifier, name);
      if (hit.kind === 'found') {
        return {
          ref: toRef(hit.relation, hit.column, name),
          relation: hit.relation,
          outerScopeId: depth > 0 ? scope.blockId : undefined,
        };
      }
      if (hit.kind === 'ambiguous') {
        // Once the nearest scope exposes an ambiguous name, an outer relation
        // may not rescue it. PostgreSQL reports ambiguity at that lexical
        // level rather than silently turning the reference into correlation.
        ambiguousIn.push(scope.blockId);
        break;
      }
      scope = scope.parent;
      depth++;
    }

    const written = qualifier ? `${qualifier.schema ? qualifier.schema + '.' : ''}${qualifier.name}.${name}` : name;
    if (ambiguousIn.length > 0) {
      return {
        ref: { alias: qualifier?.name, column: name, unresolved: true },
        error: `column "${written}" is ambiguous: more than one relation in scope exposes it`,
      };
    }
    return {
      ref: { alias: qualifier?.name, column: name, unresolved: true },
      error: qualifier
        ? `could not resolve "${written}": no relation named "${qualifier.name}" in scope exposes a column "${name}"`
        : `could not resolve column "${name}" against any relation in scope`,
    };
  }

  private resolveLocal(
    qualifier: { name: string; schema?: string } | undefined,
    name: string,
  ): { kind: 'found'; relation: BoundRelation; column?: BoundColumn } | { kind: 'ambiguous' } | { kind: 'miss' } {
    if (!qualifier) {
      // `starOutput` is the authoritative output namespace of this FROM
      // clause. In particular, it contains a USING key once for the joined
      // table, while retaining same-named columns exposed by separate FROM
      // items. Looking at `mergedColumns` first would incorrectly let that
      // merged key mask an unrelated hit (PostgreSQL reports the reference as
      // ambiguous in `(a JOIN b USING (k)), c` when c also exposes k).
      const outputHits = this.starOutput.filter((entry) => sqlNameEquals(entry.column.name, name));
      if (outputHits.length === 1) {
        return { kind: 'found', relation: outputHits[0]!.relation, column: outputHits[0]!.column };
      }
      if (outputHits.length > 1) return { kind: 'ambiguous' };

      // Opaque function/derived outputs have no entries in `starOutput`.
      // Preserve the binder's existing optimistic fallback when no known
      // output column matched, rather than inventing a missing-column error.
      const opaque = this.relations.filter((relation) => !relation.columnsKnown);
      if (opaque.length === 1) return { kind: 'found', relation: opaque[0]!, column: undefined };
      if (opaque.length > 1) return { kind: 'ambiguous' };
      return { kind: 'miss' };
    }

    const candidates = this.relations.filter((r) => matchesQualifier(r, qualifier));

    const hits: Array<{ relation: BoundRelation; column?: BoundColumn }> = [];
    for (const rel of candidates) {
      const cols = rel.columns.filter((c) => sqlNameEquals(c.name, name));
      if (cols.length > 1) return { kind: 'ambiguous' };
      if (cols.length === 1) hits.push({ relation: rel, column: cols[0] });
      else if (!rel.columnsKnown) hits.push({ relation: rel, column: undefined });
    }

    if (hits.length === 1) return { kind: 'found', relation: hits[0]!.relation, column: hits[0]!.column };
    if (hits.length > 1) {
      // A qualified reference cannot be ambiguous unless two relations answer
      // to the same name, which we treat as an error too.
      const named = hits.filter((h) => h.column);
      if (named.length === 1) return { kind: 'found', relation: named[0]!.relation, column: named[0]!.column };
      return { kind: 'ambiguous' };
    }
    return { kind: 'miss' };
  }

  /** Every column of every in-scope relation, for expanding `*`. */
  starColumns(qualifier?: string): ResolvedColumnRef[] {
    const out: ResolvedColumnRef[] = [];
    if (!qualifier) {
      for (const entry of this.starOutput) out.push(toRef(entry.relation, entry.column, entry.column.name));
      return out;
    }
    const rels = this.relations.filter((r) => sqlNameEquals(r.alias, qualifier));
    for (const rel of rels) {
      for (const col of rel.columns) out.push(toRef(rel, col, col.name));
    }
    return out;
  }
}

function matchesQualifier(rel: BoundRelation, q: { name: string; schema?: string }): boolean {
  if (!sqlNameEquals(rel.alias, q.name)) return false;
  // `shop.orders.created_at` only names a relation written without an alias.
  if (q.schema && rel.schema && !sqlNameEquals(q.schema, rel.schema)) return false;
  if (q.schema && rel.aliased) return false;
  return true;
}

function mergedNullability(
  left: BoundColumn,
  right: BoundColumn,
  joinType: 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti' | 'lateral',
): boolean | undefined {
  if (joinType === 'inner') return false; // equality cannot match a NULL key
  if (joinType === 'left') return left.nullable;
  if (joinType === 'right') return right.nullable;
  if (joinType === 'full') {
    if (left.nullable === undefined || right.nullable === undefined) return undefined;
    return left.nullable || right.nullable;
  }
  return left.nullable ?? right.nullable;
}

function toRef(rel: BoundRelation, col: BoundColumn | undefined, name: string): ResolvedColumnRef {
  const ref: ResolvedColumnRef = {
    alias: rel.alias,
    table: rel.source,
    column: col?.name ?? name,
  };
  if (col?.dataType) ref.dataType = col.dataType;
  if (!col && !rel.columnsKnown) {
    // Bound to a relation, but its column list is opaque (function scan, or a
    // derived table we could not name). Say so rather than inventing a type.
    ref.unresolved = true;
  }
  if (col?.nullable !== undefined) {
    recordColumnNullability(
      ref,
      col.nullable || rel.nullExtended,
      rel.nullExtended
        ? `${rel.alias}.${col.name} is nullable in this block because an outer join can null-extend ${rel.alias}`
        : `${rel.source}.${col.name} is declared ${col.nullable ? 'nullable' : 'NOT NULL'} by its producing relation`,
    );
  }
  return ref;
}

/** Build the bound-relation view of a catalog table. */
export function relationFromTable(
  catalog: Catalog,
  tableName: string,
  schema: string | undefined,
  alias: string | undefined,
): BoundRelation | undefined {
  // Do not use the catalog helper's case-folding here: the parser already
  // folded unquoted identifiers, while a surviving upper-case character is
  // evidence that PostgreSQL must compare a quoted identifier exactly.
  const table = catalog.tables.find((candidate) => sqlNameEquals(candidate.name, tableName));
  if (!table) return undefined;
  if (schema && !sqlNameEquals(schema, table.schema)) return undefined;
  return {
    alias: alias ?? table.name,
    source: table.name,
    schema: table.schema,
    kind: 'table',
    table,
    columns: table.columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable })),
    columnsKnown: true,
    aliased: alias !== undefined,
    nullExtended: false,
  };
}
