import type { Row, SqlPort, SqlValue } from "../core/sql";

/** SqlPort over Durable Object SQLite storage. */
export class DoSql implements SqlPort {
	rowsWritten = 0;

	constructor(private readonly storage: DurableObjectStorage) {}

	exec<T extends Row = Row>(query: string, ...params: SqlValue[]): T[] {
		const bound = params.map((p) => (p instanceof Uint8Array ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : p));
		const cursor = this.storage.sql.exec(query, ...bound);
		const rows = cursor.toArray();
		this.rowsWritten += cursor.rowsWritten;
		return rows.map((r) => {
			const out: Row = {};
			for (const [k, v] of Object.entries(r)) out[k] = v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SqlValue);
			return out as T;
		});
	}

	transaction<T>(fn: () => T): T {
		return this.storage.transactionSync(fn);
	}
}
