import { DatabaseSync } from "node:sqlite";
import type { Row, SqlPort, SqlValue } from "../../server/src/core/sql";

/**
 * SqlPort over Node's built-in SQLite, so the real FolderCore/ControlCore run in-process.
 * One database file per "Durable Object"; reopening the same file simulates eviction.
 */
export class NodeSql implements SqlPort {
	private depth = 0;
	rowsWritten = 0;

	constructor(readonly db: DatabaseSync = new DatabaseSync(":memory:")) {}

	exec<T extends Row = Row>(query: string, ...params: SqlValue[]): T[] {
		const stmt = this.db.prepare(query);
		const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
		if (isRead) {
			return stmt.all(...(params as never[])).map((row) => normalize(row as Record<string, unknown>)) as T[];
		}
		const res = stmt.run(...(params as never[]));
		this.rowsWritten += Number(res.changes);
		return [];
	}

	transaction<T>(fn: () => T): T {
		if (this.depth > 0) return fn();
		this.depth++;
		this.db.exec("BEGIN");
		try {
			const out = fn();
			this.db.exec("COMMIT");
			return out;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		} finally {
			this.depth--;
		}
	}
}

function normalize(row: Record<string, unknown>): Row {
	const out: Row = {};
	for (const [k, v] of Object.entries(row)) {
		if (v instanceof Uint8Array) out[k] = new Uint8Array(v);
		else if (typeof v === "bigint") out[k] = Number(v);
		else out[k] = v as SqlValue;
	}
	return out;
}
