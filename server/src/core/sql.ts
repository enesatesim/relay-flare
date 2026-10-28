// Storage port for server logic. The Durable Object adapter wraps `ctx.storage.sql`; tests
// and the simulation wrap Node's built-in `node:sqlite`. Keeping the core behind this port
// lets the exact server code run in-process with injected eviction and faults.

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface SqlPort {
	/** Runs one statement and returns all rows. BLOB columns come back as Uint8Array. */
	exec<T extends Row = Row>(query: string, ...params: SqlValue[]): T[];
	/** Runs `fn` atomically: every statement commits together or none does. */
	transaction<T>(fn: () => T): T;
	/** Total rows written so far by this port instance (for budget accounting and tests). */
	readonly rowsWritten: number;
}

export function one<T extends Row>(rows: T[]): T | null {
	return rows.length > 0 ? rows[0]! : null;
}

export function num(v: SqlValue | undefined): number {
	return typeof v === "number" ? v : v == null ? 0 : Number(v);
}

export function str(v: SqlValue | undefined): string {
	return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function strOrNull(v: SqlValue | undefined): string | null {
	return v == null ? null : str(v);
}

export function bytes(v: SqlValue | undefined): Uint8Array {
	if (v instanceof Uint8Array) return v;
	return new Uint8Array(0);
}

/**
 * Applies schema migrations tracked in a `_schema` table (PRAGMA user_version is not
 * available on Durable Object SQLite). Each migration runs once, in order, atomically.
 */
export function migrate(sql: SqlPort, migrations: readonly string[][]): void {
	sql.exec("CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)");
	const row = one(sql.exec<{ version: number }>("SELECT version FROM _schema LIMIT 1"));
	let version = row ? num(row.version) : 0;
	if (!row) sql.exec("INSERT INTO _schema (version) VALUES (0)");
	for (; version < migrations.length; version++) {
		const statements = migrations[version]!;
		sql.transaction(() => {
			for (const s of statements) sql.exec(s);
			sql.exec("UPDATE _schema SET version = ?", version + 1);
		});
	}
}
