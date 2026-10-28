// SQLite schema of one FolderRoom (one shared folder). Append-only list of migrations.
export const FOLDER_MIGRATIONS: readonly string[][] = [
	[
		`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
		// The tree is the server-sequenced folder structure. One row per entry, tombstones kept.
		`CREATE TABLE tree (
			id TEXT PRIMARY KEY,
			parent TEXT NOT NULL,
			name TEXT NOT NULL,
			name_key TEXT NOT NULL,
			kind TEXT NOT NULL,
			blob_sha TEXT,
			blob_size INTEGER,
			created_by TEXT NOT NULL,
			created_seq INTEGER NOT NULL,
			updated_seq INTEGER NOT NULL,
			deleted_seq INTEGER
		) WITHOUT ROWID`,
		// Backstop for the admission rules: two live siblings can never share a name key.
		`CREATE UNIQUE INDEX tree_live_key ON tree (parent, name_key) WHERE deleted_seq IS NULL`,
		`CREATE INDEX tree_updated ON tree (updated_seq)`,
		// Results of admitted ops, so a resent op gets the same answer.
		`CREATE TABLE tree_ops (op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, device TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID`,
		// Content documents: a compacted state plus a short journal of flushed deltas.
		`CREATE TABLE docs (
			id TEXT PRIMARY KEY,
			state BLOB,
			chunks INTEGER NOT NULL DEFAULT 0,
			state_bytes INTEGER NOT NULL DEFAULT 0,
			head_seq INTEGER NOT NULL,
			jcount INTEGER NOT NULL DEFAULT 0,
			jbytes INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL
		) WITHOUT ROWID`,
		`CREATE INDEX docs_head ON docs (head_seq)`,
		`CREATE TABLE doc_chunks (doc_id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (doc_id, idx)) WITHOUT ROWID`,
		`CREATE TABLE doc_journal (doc_id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (doc_id, seq)) WITHOUT ROWID`,
		// Highest per-device update sequence that is durably stored (exact receipts).
		`CREATE TABLE device_cursor (device TEXT PRIMARY KEY, durable_dseq INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID`,
		// Local copy of folder memberships, pushed by the control plane.
		`CREATE TABLE acl (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, aclv INTEGER NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE revoked_devices (device TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE budget (day TEXT PRIMARY KEY, rows INTEGER NOT NULL) WITHOUT ROWID`,
	],
	[
		// Who caused each tree state, and each device's last content edit per document: only
		// changes by others beat a delete, and a deleter's own trailing edit never revives.
		`ALTER TABLE tree ADD COLUMN updated_by TEXT`,
		`CREATE TABLE doc_edits (doc_id TEXT NOT NULL, device TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (doc_id, device)) WITHOUT ROWID`,
	],
];
