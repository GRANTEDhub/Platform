// TEST-ONLY in-memory fake of the tiny Supabase surface the AR-state modules use (grants +
// grant_monitor_state). Not imported by any route, so it is tree-shaken out of the app bundle; it
// exists so add-source / seed / monitor specs can run offline with no real DB. Supports exactly the
// chains those modules call: from().select().eq().order().limit(), .insert().select().single(),
// .update().eq(), and the listMonitorRows join grants(funder,title).

type Row = Record<string, unknown>;

export interface FakeWrite {
  op: "insert" | "update";
  table: string;
  row: Row;
  filters?: [string, unknown][];
}

export class FakeDb {
  grants: Row[] = [];
  monitor: Row[] = [];
  writes: FakeWrite[] = [];
  failInsertTables: Set<string>;
  private _id = 0;

  constructor(seed?: { grants?: Row[]; monitor?: Row[]; failInsert?: string[] }) {
    if (seed?.grants) this.grants = seed.grants.map((r) => ({ ...r }));
    if (seed?.monitor) this.monitor = seed.monitor.map((r) => ({ ...r }));
    this.failInsertTables = new Set(seed?.failInsert ?? []);
  }

  nextId(): string {
    return `id-${++this._id}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  private _filters: [string, unknown][] = [];
  private _insert?: Row;
  private _update?: Row;
  private _delete = false;
  private _single = false;

  constructor(private db: FakeDb, private table: string) {}

  select() {
    return this;
  }
  insert(row: Row) {
    this._insert = row;
    return this;
  }
  update(row: Row) {
    this._update = row;
    return this;
  }
  delete() {
    this._delete = true;
    return this;
  }
  eq(col: string, val: unknown) {
    this._filters.push([col, val]);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  single() {
    this._single = true;
    return this;
  }
  maybeSingle() {
    this._single = true;
    return this;
  }

  private match(r: Row): boolean {
    return this._filters.every(([c, v]) => r[c] === v);
  }

  private grantOf(grantId: unknown): { funder: unknown; title: unknown } | null {
    const g = this.db.grants.find((x) => x.id === grantId);
    return g ? { funder: g.funder ?? null, title: g.title ?? null } : null;
  }

  private resolve(): { data: unknown; error: unknown } {
    if (this._insert) {
      if (this.db.failInsertTables.has(this.table)) {
        return { data: null, error: { message: `insert failed: ${this.table}` } };
      }
      if (this.table === "grants") {
        const row = { id: this.db.nextId(), ...this._insert };
        this.db.grants.push(row);
        this.db.writes.push({ op: "insert", table: this.table, row: { ...row } }); // snapshot (live row is mutable)
        return { data: this._single ? { id: row.id } : [{ id: row.id }], error: null };
      }
      const row = { id: this.db.nextId(), ...this._insert };
      this.db[this.table === "grant_monitor_state" ? "monitor" : "grants"].push(row);
      this.db.writes.push({ op: "insert", table: this.table, row: { ...row } }); // snapshot (live row is mutable)
      return { data: null, error: null };
    }
    if (this._update) {
      const target = this.table === "grant_monitor_state" ? this.db.monitor : this.db.grants;
      for (const r of target) if (this.match(r)) Object.assign(r, this._update);
      this.db.writes.push({ op: "update", table: this.table, row: this._update, filters: this._filters });
      return { data: null, error: null };
    }
    if (this._delete) {
      const key = this.table === "grant_monitor_state" ? "monitor" : "grants";
      this.db[key] = this.db[key].filter((r) => !this.match(r));
      return { data: null, error: null };
    }
    // select
    if (this.table === "grants") {
      const rows = this.db.grants.filter((r) => this.match(r));
      return { data: this._single ? (rows[0] ?? null) : rows.map((r) => ({ id: r.id })), error: null };
    }
    if (this.table === "grant_monitor_state") {
      const rows = this.db.monitor.filter((r) => this.match(r)).map((r) => ({ ...r, grants: this.grantOf(r.grant_id) }));
      return { data: this._single ? (rows[0] ?? null) : rows, error: null };
    }
    return { data: null, error: null };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(onFulfilled: (v: { data: unknown; error: unknown }) => any, onRejected?: (e: unknown) => any) {
    return Promise.resolve(this.resolve()).then(onFulfilled, onRejected);
  }
}
