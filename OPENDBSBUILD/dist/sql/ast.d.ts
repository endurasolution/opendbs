/** Syntax tree for the OpenDBS SQL dialect (see parser.ts for the grammar). */
export type SQLValue = string | number | boolean | null;
export interface ColumnDef {
    type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'array' | 'object';
    required?: boolean;
    unique?: boolean;
    defaultValue?: SQLValue;
}
export type Expr = {
    k: 'lit';
    v: any;
} | {
    k: 'param';
    i: number;
}
/** Identifier chain as written: col, t.col, t.col.nested, col.nested … resolved at compile time. */
 | {
    k: 'ref';
    parts: string[];
} | {
    k: 'star';
    table?: string;
} | {
    k: 'un';
    op: '-' | '+' | 'NOT';
    e: Expr;
} | {
    k: 'bin';
    op: string;
    l: Expr;
    r: Expr;
} | {
    k: 'like';
    e: Expr;
    pat: Expr;
    esc?: Expr;
    not: boolean;
    regexp: boolean;
} | {
    k: 'between';
    e: Expr;
    lo: Expr;
    hi: Expr;
    not: boolean;
} | {
    k: 'in';
    e: Expr;
    list?: Expr[];
    sub?: Query;
    not: boolean;
} | {
    k: 'is';
    e: Expr;
    what: 'null' | 'true' | 'false' | 'unknown';
    not: boolean;
} | {
    k: 'distinctfrom';
    l: Expr;
    r: Expr;
    not: boolean;
} | {
    k: 'exists';
    sub: Query;
    not: boolean;
} | {
    k: 'subq';
    sub: Query;
}
/** expr op ANY|ALL (subquery) */
 | {
    k: 'quant';
    op: string;
    quant: 'any' | 'all';
    e: Expr;
    sub: Query;
} | {
    k: 'case';
    base?: Expr;
    whens: Array<[Expr, Expr]>;
    else?: Expr;
} | {
    k: 'cast';
    e: Expr;
    to: string;
} | {
    k: 'interval';
    v: Expr;
    unit: string;
} | {
    k: 'fn';
    name: string;
    args: Expr[];
    distinct?: boolean;
    star?: boolean;
    over?: WindowSpec;
    filter?: Expr;
    orderBy?: OrderItem[];
    sep?: Expr;
};
export interface WindowSpec {
    /** OVER w / OVER (w ORDER BY …): a named window from the WINDOW clause to start from. */
    ref?: string;
    partition: Expr[];
    order: OrderItem[];
    frame?: {
        unit: 'rows' | 'range';
        start: FrameBound;
        end: FrameBound;
    };
}
export type FrameBound = {
    kind: 'unbounded_preceding';
} | {
    kind: 'preceding';
    n: number;
} | {
    kind: 'current';
} | {
    kind: 'following';
    n: number;
} | {
    kind: 'unbounded_following';
};
export interface OrderItem {
    e: Expr;
    desc: boolean;
    nulls?: 'first' | 'last';
}
export type SelectItem = {
    star: true;
    table?: string;
} | {
    star?: false;
    e: Expr;
    alias?: string;
    text: string;
};
export type FromItem = {
    k: 'table';
    name: string;
    alias: string;
} | {
    k: 'sub';
    q: Query;
    alias: string;
    cols?: string[];
} | {
    k: 'join';
    type: 'inner' | 'left' | 'right' | 'full' | 'cross';
    l: FromItem;
    r: FromItem;
    on?: Expr;
    using?: string[];
};
export interface Select {
    k: 'select';
    distinct: boolean;
    items: SelectItem[];
    from: FromItem | null;
    where?: Expr;
    groupBy: Expr[];
    having?: Expr;
    windows: Record<string, WindowSpec>;
    orderBy: OrderItem[];
    limit?: Expr;
    offset?: Expr;
}
export interface SetOp {
    k: 'setop';
    op: 'union' | 'intersect' | 'except';
    all: boolean;
    l: Query;
    r: Query;
    orderBy: OrderItem[];
    limit?: Expr;
    offset?: Expr;
}
export interface With {
    k: 'with';
    recursive: boolean;
    ctes: Array<{
        name: string;
        cols?: string[];
        q: Query;
    }>;
    body: Query;
}
export type Query = Select | SetOp | With;
export type ReturningList = SelectItem[] | undefined;
export type AlterAction = {
    kind: 'add';
    name: string;
    def: ColumnDef;
} | {
    kind: 'drop';
    name: string;
} | {
    kind: 'modify';
    name: string;
    def: ColumnDef;
} | {
    kind: 'rename';
    from: string;
    to: string;
} | {
    kind: 'add_index';
    fields: string[];
    unique: boolean;
} | {
    kind: 'drop_index';
    name: string;
};
export type Statement = {
    type: 'select';
    q: Query;
} | {
    type: 'explain';
    q: Query;
} | {
    type: 'begin';
} | {
    type: 'commit';
} | {
    type: 'rollback';
} | {
    type: 'insert';
    table: string;
    columns?: string[];
    rows?: Expr[][];
    query?: Query;
    conflict?: {
        target?: string[];
        action: 'nothing' | 'update';
        set: Array<[string, Expr]>;
        where?: Expr;
    };
    ignore: boolean;
    returning: ReturningList;
} | {
    type: 'update';
    table: string;
    alias: string;
    set: Array<[string, Expr]>;
    where: Expr;
    returning: ReturningList;
} | {
    type: 'delete';
    table: string;
    alias: string;
    where: Expr;
    returning: ReturningList;
} | {
    type: 'create';
    table: string;
    ifNotExists: boolean;
    columns: Record<string, ColumnDef>;
    asQuery?: Query;
} | {
    type: 'drop';
    table: string;
    ifExists: boolean;
} | {
    type: 'truncate';
    table: string;
} | {
    type: 'alter';
    table: string;
    action: AlterAction;
} | {
    type: 'create_index';
    table: string;
    fields: string[];
    unique: boolean;
    ifNotExists: boolean;
} | {
    type: 'drop_index';
    table: string;
    name: string;
    ifExists: boolean;
} | {
    type: 'show_tables';
} | {
    type: 'show_indexes';
    table: string;
} | {
    type: 'describe';
    table: string;
};
//# sourceMappingURL=ast.d.ts.map