import * as Y from "yjs";
import { ownedBytes, randomId } from "../shared/bytes";
import { readAwarenessUpdate, removalUpdate, writeAwarenessUpdate, type AwarenessEntry } from "../shared/protocol/awareness";
import { decodeFrame, encodeFrame, type ControlMessage, type Frame, type Role } from "../shared/protocol/frames";
import { LIMITS, PROTOCOL_MIN, PROTOCOL_VERSION, SCHEMA_VERSION, SERVER_VERSION } from "../shared/protocol/version";
import { admit, type TreeReader } from "../shared/tree/admit";
import { nameKey } from "../shared/tree/names";
import { CONTENT_DOC_KINDS, type Kind, type TreeEntry, type TreeEvent, type TreeOp, type TreeResult } from "../shared/tree/types";
import type { AccessClaims } from "../shared/token";
import { FOLDER_MIGRATIONS } from "./folderSchema";
import { ByteLru } from "./lru";
import { bytes, migrate, num, one, str, strOrNull, type Row, type SqlPort } from "./sql";

export interface ConnInfo {
	id: string;
	userId: string;
	deviceId: string;
	deviceLabel: string;
	role: Role;
	/** Access-token expiry; refreshed in-band without reconnecting. */
	exp: number;
	aclv: number;
	/** True once HELLO was accepted. Survives hibernation via the socket attachment. */
	ready: boolean;
}

export interface Transport {
	send(connId: string, data: Uint8Array): void;
	close(connId: string, code: number, reason: string): void;
	/** All open connections, including ones restored after hibernation. */
	connections(): ConnInfo[];
	/** Persists changed connection fields (the socket attachment in a Durable Object). */
	update(connId: string, patch: Partial<ConnInfo>): void;
}

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface FolderCoreOptions {
	flushIdleMs: number;
	flushMaxMs: number;
	flushMaxBytes: number;
	compactJournalRows: number;
	compactMinJournalBytes: number;
	mergedCacheBytes: number;
	/** Grace period after token expiry before an un-refreshed connection is closed. */
	tokenGraceMs: number;
}

export const DEFAULT_FOLDER_OPTIONS: FolderCoreOptions = {
	flushIdleMs: 5_000,
	flushMaxMs: 30_000,
	flushMaxBytes: 256 * 1024,
	compactJournalRows: 32,
	compactMinJournalBytes: 64 * 1024,
	mergedCacheBytes: 16 * 1024 * 1024,
	tokenGraceMs: 60_000,
};

export interface FolderEnv {
	sql: SqlPort;
	transport: Transport;
	clock: Clock;
	/** Verifies an access token refreshed in-band. */
	verifyAccess(token: string): Promise<AccessClaims | null>;
	log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface AclEntry {
	userId: string;
	role: Role;
	aclv: number;
}

export type Admission = { ok: true; role: Role } | { ok: false; status: number; reason: string };

const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());
const CHUNK_BYTES = 1024 * 1024;
const INLINE_STATE_MAX = 1536 * 1024;
const DEEP_GC_MAX_BYTES = 2 * 1024 * 1024;

interface PendingDoc {
	updates: Uint8Array[];
	bytes: number;
	devices: Set<string>;
}

/**
 * One shared folder: the sequenced tree, the content document logs, exact receipts and
 * the fan-out to every connected device. Pure logic over SqlPort/Transport/Clock so the
 * same code runs in a Durable Object and in the Node simulation.
 */
export class FolderCore {
	private readonly sql: SqlPort;
	private readonly opts: FolderCoreOptions;
	private seq = 0;
	private epoch = "";
	private folderId = "";
	private serverId = "";
	private minWriterSchema = SCHEMA_VERSION;
	private initialized = false;

	private pending = new Map<string, PendingDoc>();
	private pendingBytes = 0;
	private pendingDevices = new Map<string, number>();
	private durable = new Map<string, number>();
	private firstPendingAt = 0;
	private flushTimer: unknown = null;
	private mergedCache: ByteLru;

	private awareness = new Map<number, { conn: string; clock: number; state: string }>();
	private connClients = new Map<string, Map<number, number>>();
	private presenceQueried = false;

	constructor(
		private readonly env: FolderEnv,
		options: Partial<FolderCoreOptions> = {},
	) {
		this.sql = env.sql;
		this.opts = { ...DEFAULT_FOLDER_OPTIONS, ...options };
		this.mergedCache = new ByteLru(this.opts.mergedCacheBytes);
		migrate(this.sql, FOLDER_MIGRATIONS);
		this.loadMeta();
	}

	// ---------------------------------------------------------------- lifecycle

	private loadMeta(): void {
		const meta = new Map(this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta").map((r) => [str(r.key), str(r.value)]));
		this.initialized = meta.has("folder_id");
		this.folderId = meta.get("folder_id") ?? "";
		this.serverId = meta.get("server_id") ?? "";
		this.seq = Number(meta.get("seq") ?? 0);
		this.minWriterSchema = Number(meta.get("min_writer_schema") ?? SCHEMA_VERSION);
		this.epoch = meta.get("epoch") ?? "";
		if (!this.epoch) {
			this.epoch = randomId(12);
			this.setMeta("epoch", this.epoch);
		}
	}

	private setMeta(key: string, value: string | number): void {
		this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
	}

	/** Called by the control plane when the folder is created. Idempotent. */
	init(folderId: string, serverId: string, acl: AclEntry[]): void {
		this.sql.transaction(() => {
			this.setMeta("folder_id", folderId);
			this.setMeta("server_id", serverId);
			if (!this.initialized) this.setMeta("min_writer_schema", SCHEMA_VERSION);
		});
		this.folderId = folderId;
		this.serverId = serverId;
		this.initialized = true;
		this.setAcl(acl, true);
	}

	/** Stops timers; the instance must not be used afterwards (eviction in tests). */
	dispose(): void {
		if (this.flushTimer !== null) this.env.clock.clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.pending.clear();
		this.pendingDevices.clear();
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get currentSeq(): number {
		return this.seq;
	}

	/** Replaces (or patches) the membership list and enforces it on open connections. */
	setAcl(entries: AclEntry[], replace: boolean): void {
		this.sql.transaction(() => {
			if (replace) this.sql.exec("DELETE FROM acl");
			for (const e of entries) {
				this.sql.exec(
					"INSERT INTO acl (user_id, role, aclv) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, aclv = excluded.aclv",
					e.userId,
					e.role,
					e.aclv,
				);
			}
		});
		for (const c of this.env.transport.connections()) {
			const row = this.aclFor(c.userId);
			if (!row) this.kick(c.id, "revoked", "membership removed");
			else if (row.aclv > c.aclv || row.role !== c.role) {
				// Role changed: the client must reconnect with a fresh token to learn it.
				this.kick(c.id, "revoked", "membership changed");
			}
		}
	}

	removeMember(userId: string): void {
		this.sql.exec("DELETE FROM acl WHERE user_id = ?", userId);
		for (const c of this.env.transport.connections()) if (c.userId === userId) this.kick(c.id, "revoked", "membership removed");
	}

	revokeDevice(deviceId: string): void {
		this.sql.exec("INSERT OR REPLACE INTO revoked_devices (device, at) VALUES (?, ?)", deviceId, this.env.clock.now());
		for (const c of this.env.transport.connections()) if (c.deviceId === deviceId) this.kick(c.id, "revoked", "device revoked");
	}

	private aclFor(userId: string): { role: Role; aclv: number } | null {
		const row = one(this.sql.exec<{ role: string; aclv: number }>("SELECT role, aclv FROM acl WHERE user_id = ?", userId));
		return row ? { role: str(row.role) as Role, aclv: num(row.aclv) } : null;
	}

	/** Decides whether a verified token may open a socket on this folder. */
	admitConnection(claims: Pick<AccessClaims, "sub" | "dev" | "aclv">): Admission {
		if (!this.initialized) return { ok: false, status: 404, reason: "unknown folder" };
		if (one(this.sql.exec("SELECT device FROM revoked_devices WHERE device = ?", claims.dev))) {
			return { ok: false, status: 403, reason: "device revoked" };
		}
		const acl = this.aclFor(claims.sub);
		if (!acl) return { ok: false, status: 403, reason: "not a member" };
		if (claims.aclv < acl.aclv) return { ok: false, status: 401, reason: "stale token" };
		return { ok: true, role: acl.role };
	}

	// ---------------------------------------------------------------- connections

	onOpen(conn: ConnInfo): void {
		this.connClients.set(conn.id, new Map());
	}

	onClose(connId: string): void {
		const clients = this.connClients.get(connId);
		this.connClients.delete(connId);
		if (clients && clients.size > 0) {
			for (const id of clients.keys()) this.awareness.delete(id);
			this.broadcast(encodeFrame({ type: "awareness", update: removalUpdate(clients) }), connId);
		}
	}

	private conn(connId: string): ConnInfo | null {
		return this.env.transport.connections().find((c) => c.id === connId) ?? null;
	}

	private send(connId: string, f: Frame): void {
		this.env.transport.send(connId, encodeFrame(f));
	}

	private control(connId: string, msg: ControlMessage): void {
		this.send(connId, { type: "control", msg });
	}

	private kick(connId: string, code: "revoked" | "unauthorized" | "update_required", reason: string): void {
		if (code === "revoked") this.control(connId, { t: "revoked" });
		else this.control(connId, { t: "error", code, message: reason, fatal: true });
		this.env.transport.close(connId, 4000 + (code === "revoked" ? 3 : code === "unauthorized" ? 1 : 26), reason);
		this.onClose(connId);
	}

	private broadcast(data: Uint8Array, exceptConn?: string): void {
		for (const c of this.env.transport.connections()) {
			if (c.id !== exceptConn && c.ready) this.env.transport.send(c.id, data);
		}
	}

	private canWrite(c: ConnInfo): boolean {
		return c.role !== "viewer" && this.minWriterSchema <= SCHEMA_VERSION;
	}

	async onMessage(connId: string, data: Uint8Array | string): Promise<void> {
		const c = this.conn(connId);
		if (!c) return;
		if (typeof data === "string") return; // pings are answered by the auto-response
		const now = this.env.clock.now();
		if (c.exp + this.opts.tokenGraceMs < now) {
			this.kick(connId, "unauthorized", "access token expired");
			return;
		}
		if (!this.presenceQueried && this.awareness.size === 0 && this.env.transport.connections().length > 1) {
			// After a wake from hibernation presence is gone; ask everyone to resend it.
			this.presenceQueried = true;
			this.broadcast(encodeFrame({ type: "control", msg: { t: "presenceQuery" } }));
		}
		const frame = decodeFrame(data);
		if (!frame) {
			this.control(connId, { t: "error", code: "bad_frame", message: "malformed frame", fatal: false });
			return;
		}
		if (!c.ready && frame.type !== "hello" && frame.type !== "control") {
			this.control(connId, { t: "error", code: "bad_frame", message: "hello required", fatal: false });
			return;
		}
		switch (frame.type) {
			case "hello":
				this.onHello(c, frame.protocol, frame.epoch, frame.cursor);
				return;
			case "sync1":
				this.onSync1(c, frame.docId, frame.sv);
				return;
			case "update":
				this.onUpdate(c, frame.dseq, frame.docId, frame.update);
				return;
			case "treeOp":
				this.onTreeOp(c, frame.op);
				return;
			case "awareness":
				this.onAwareness(c, frame.update);
				return;
			case "control":
				await this.onControl(c, frame.msg);
				return;
			default:
				this.control(connId, { t: "error", code: "bad_frame", message: `unexpected ${frame.type}`, fatal: false });
		}
	}

	private onHello(c: ConnInfo, protocol: number, epoch: string | null, cursor: number): void {
		if (protocol < PROTOCOL_MIN || protocol > PROTOCOL_VERSION) {
			this.kick(c.id, "update_required", `server speaks protocol ${PROTOCOL_MIN}-${PROTOCOL_VERSION}`);
			return;
		}
		const epochChanged = epoch !== null && epoch !== this.epoch;
		const from = epochChanged || cursor > this.seq ? 0 : cursor;
		const durableDseq = this.durableFor(c.deviceId);
		c.ready = true;
		this.env.transport.update(c.id, { ready: true });
		this.send(c.id, {
			type: "welcome",
			role: c.role,
			readOnly: !this.canWrite(c),
			epoch: this.epoch,
			serverId: this.serverId,
			folderId: this.folderId,
			headSeq: this.seq,
			durableDseq,
			minWriterSchema: this.minWriterSchema,
			serverVersion: SERVER_VERSION,
			snapshot: from === 0,
		});
		if (epochChanged) {
			this.control(c.id, { t: "error", code: "epoch_changed", message: "server storage was reset or restored", fatal: false });
		}
		this.sendCatchup(c.id, from);
		const states = [...this.awareness].filter(([, s]) => s.state !== "null");
		if (states.length > 0) {
			const update = writeAwarenessUpdate(states.map(([clientId, s]): AwarenessEntry => ({ clientId, clock: s.clock, state: s.state })));
			this.send(c.id, { type: "awareness", update });
		}
	}

	private sendCatchup(connId: string, from: number): void {
		const page = LIMITS.treePageSize;
		if (from === 0) {
			const rows = this.sql.exec("SELECT * FROM tree WHERE deleted_seq IS NULL ORDER BY updated_seq");
			if (rows.length === 0) this.send(connId, { type: "treeSnapshot", cursor: this.seq, entries: [], final: true });
			for (let i = 0; i < rows.length; i += page) {
				const entries = rows.slice(i, i + page).map(rowToEntry);
				this.send(connId, { type: "treeSnapshot", cursor: this.seq, entries, final: i + page >= rows.length });
			}
		} else {
			const rows = this.sql.exec("SELECT * FROM tree WHERE updated_seq > ? ORDER BY updated_seq", from);
			for (let i = 0; i < rows.length; i += page) {
				const events: TreeEvent[] = rows.slice(i, i + page).map((r) => ({ seq: num(r.updated_seq), entry: rowToEntry(r) }));
				this.send(connId, { type: "treeEvents", cursor: this.seq, events });
			}
		}
		const heads: Array<[string, number]> = this.sql
			.exec<{ id: string; head_seq: number }>("SELECT id, head_seq FROM docs WHERE head_seq > ? ORDER BY head_seq", from)
			.map((r) => [str(r.id), num(r.head_seq)]);
		const listed = new Set(heads.map(([id]) => id));
		// Unflushed docs are not in SQL yet but their bytes are served from memory.
		for (const docId of this.pending.keys()) if (!listed.has(docId)) heads.push([docId, this.seq]);
		for (let i = 0; i < heads.length; i += LIMITS.headsPageSize) {
			this.send(connId, { type: "heads", cursor: this.seq, heads: heads.slice(i, i + LIMITS.headsPageSize) });
		}
		this.send(connId, { type: "catchupDone", cursor: this.seq });
	}

	// ---------------------------------------------------------------- documents

	private durableFor(deviceId: string): number {
		let d = this.durable.get(deviceId);
		if (d === undefined) {
			const row = one(this.sql.exec<{ durable_dseq: number }>("SELECT durable_dseq FROM device_cursor WHERE device = ?", deviceId));
			d = row ? num(row.durable_dseq) : 0;
			this.durable.set(deviceId, d);
		}
		return d;
	}

	private headSeqOf(docId: string): number {
		const row = one(this.sql.exec<{ head_seq: number }>("SELECT head_seq FROM docs WHERE id = ?", docId));
		return row ? num(row.head_seq) : 0;
	}

	/** Durable state of a doc (compacted state plus journal), without unflushed updates. */
	private storedState(docId: string): Uint8Array | null {
		const cached = this.mergedCache.get(docId);
		if (cached) return cached;
		const row = one(this.sql.exec("SELECT state, chunks FROM docs WHERE id = ?", docId));
		if (!row) return null;
		const parts: Uint8Array[] = [];
		const chunks = num(row.chunks);
		if (chunks > 0) {
			const rows = this.sql.exec("SELECT data FROM doc_chunks WHERE doc_id = ? ORDER BY idx", docId);
			if (rows.length !== chunks) throw new Error(`doc ${docId}: expected ${chunks} chunks, found ${rows.length}`);
			const total = rows.reduce((n, r) => n + bytes(r.data).length, 0);
			const state = new Uint8Array(total);
			let o = 0;
			for (const r of rows) {
				const b = bytes(r.data);
				state.set(b, o);
				o += b.length;
			}
			parts.push(state);
		} else if (row.state instanceof Uint8Array && row.state.length > 0) {
			parts.push(row.state);
		}
		for (const r of this.sql.exec("SELECT data FROM doc_journal WHERE doc_id = ? ORDER BY seq", docId)) parts.push(bytes(r.data));
		const merged = parts.length === 0 ? EMPTY_UPDATE : parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
		this.mergedCache.set(docId, merged);
		return merged;
	}

	/** Everything the server knows about a doc, including unflushed updates. */
	docState(docId: string): Uint8Array {
		const stored = this.storedState(docId);
		const p = this.pending.get(docId);
		if (!p) return stored ?? EMPTY_UPDATE;
		return Y.mergeUpdates(stored ? [stored, ...p.updates] : p.updates);
	}

	private onSync1(c: ConnInfo, docId: string, sv: Uint8Array): void {
		let diff: Uint8Array;
		try {
			diff = Y.diffUpdate(this.docState(docId), sv);
		} catch {
			this.control(c.id, { t: "error", code: "bad_frame", message: "invalid state vector", fatal: false });
			return;
		}
		this.send(c.id, { type: "sync2", docId, update: diff, headSeq: this.headSeqOf(docId) });
	}

	private onUpdate(c: ConnInfo, dseq: number, docId: string, update: Uint8Array): void {
		if (!this.canWrite(c)) {
			this.control(c.id, { t: "error", code: "read_only", message: "this connection cannot write", fatal: false });
			return;
		}
		if (update.length > LIMITS.maxUpdateBytes) {
			this.control(c.id, { t: "error", code: "too_large", message: `update exceeds ${LIMITS.maxUpdateBytes} bytes`, fatal: false });
			return;
		}
		const durable = this.durableFor(c.deviceId);
		const pendingMax = this.pendingDevices.get(c.deviceId) ?? 0;
		if (dseq <= durable) {
			// Already stored: a resend after reconnect. Confirm again so the outbox drains.
			this.send(c.id, { type: "ack", durableDseq: durable });
			return;
		}
		if (dseq <= pendingMax) return; // buffered, will be acked at the next flush
		try {
			Y.decodeUpdate(update);
		} catch {
			this.control(c.id, { t: "error", code: "bad_frame", message: "invalid update", fatal: false });
			return;
		}
		this.reviveIfDeleted(c, docId);
		let p = this.pending.get(docId);
		if (!p) this.pending.set(docId, (p = { updates: [], bytes: 0, devices: new Set() }));
		p.devices.add(c.deviceId);
		p.updates.push(update);
		p.bytes += update.length;
		this.pendingBytes += update.length;
		this.pendingDevices.set(c.deviceId, dseq);
		if (this.firstPendingAt === 0) this.firstPendingAt = this.env.clock.now();
		this.broadcast(encodeFrame({ type: "bcast", docId, update, origin: c.deviceId }), c.id);
		this.scheduleFlush();
	}

	/** Edits beat deletes: content arriving for a deleted entry brings it back. */
	private reviveIfDeleted(c: ConnInfo, docId: string): void {
		const row = one(this.sql.exec("SELECT * FROM tree WHERE id = ?", docId));
		if (!row || row.deleted_seq == null) return;
		// The deleter's own trailing edit was made before its delete: it does not revive.
		if (strOrNull(row.updated_by) === c.deviceId) return;
		this.applyTreeOp(c, { t: "revive", opId: `revive:${docId}:${randomId(6)}`, id: docId }, false);
	}

	private scheduleFlush(): void {
		const now = this.env.clock.now();
		if (this.pendingBytes >= this.opts.flushMaxBytes || now - this.firstPendingAt >= this.opts.flushMaxMs) {
			this.flush();
			return;
		}
		if (this.flushTimer !== null) this.env.clock.clearTimeout(this.flushTimer);
		const wait = Math.min(this.opts.flushIdleMs, this.firstPendingAt + this.opts.flushMaxMs - now);
		this.flushTimer = this.env.clock.setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, Math.max(0, wait));
	}

	/**
	 * Persists every buffered update in one transaction, then sends receipts. Losing the
	 * buffer (eviction) is safe: unacknowledged batches stay in each client's outbox.
	 */
	flush(): void {
		if (this.flushTimer !== null) {
			this.env.clock.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.pending.size === 0 && this.pendingDevices.size === 0) return;
		const now = this.env.clock.now();
		const seq = this.seq + 1;
		const docs = [...this.pending].map(([docId, p]) => {
			const update = p.updates.length === 1 ? p.updates[0]! : Y.mergeUpdates(p.updates);
			return { docId, update, devices: [...p.devices] };
		});
		const devices = [...this.pendingDevices];
		const before = this.sql.rowsWritten;
		this.sql.transaction(() => {
			for (const { docId, update, devices: editors } of docs) {
				for (const device of editors) {
					this.sql.exec("INSERT INTO doc_edits (doc_id, device, seq) VALUES (?, ?, ?) ON CONFLICT(doc_id, device) DO UPDATE SET seq = excluded.seq", docId, device, seq);
				}
				this.sql.exec("INSERT INTO doc_journal (doc_id, seq, data) VALUES (?, ?, ?)", docId, seq, ownedBytes(update));
				this.sql.exec(
					`INSERT INTO docs (id, state, chunks, state_bytes, head_seq, jcount, jbytes, updated_at) VALUES (?, NULL, 0, 0, ?, 1, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET head_seq = excluded.head_seq, jcount = jcount + 1, jbytes = jbytes + excluded.jbytes, updated_at = excluded.updated_at`,
					docId,
					seq,
					update.length,
					now,
				);
			}
			for (const [device, dseq] of devices) {
				this.sql.exec(
					`INSERT INTO device_cursor (device, durable_dseq, updated_at) VALUES (?, ?, ?)
					 ON CONFLICT(device) DO UPDATE SET durable_dseq = MAX(durable_dseq, excluded.durable_dseq), updated_at = excluded.updated_at`,
					device,
					dseq,
					now,
				);
			}
			this.setMeta("seq", seq);
		});
		this.seq = seq;
		this.countRows(this.sql.rowsWritten - before, now);
		for (const { docId, update } of docs) {
			const cached = this.mergedCache.get(docId);
			if (cached) this.mergedCache.set(docId, Y.mergeUpdates([cached, update]));
		}
		this.pending.clear();
		this.pendingBytes = 0;
		this.pendingDevices.clear();
		this.firstPendingAt = 0;
		for (const [device, dseq] of devices) {
			const d = Math.max(this.durableFor(device), dseq);
			this.durable.set(device, d);
			const ack = encodeFrame({ type: "ack", durableDseq: d });
			for (const c of this.env.transport.connections()) if (c.deviceId === device && c.ready) this.env.transport.send(c.id, ack);
		}
		if (docs.length > 0) {
			this.broadcast(encodeFrame({ type: "heads", cursor: seq, heads: docs.map(({ docId }) => [docId, seq]) }));
			for (const { docId } of docs) this.maybeCompact(docId);
		}
	}

	private maybeCompact(docId: string): void {
		const row = one(this.sql.exec<{ jcount: number; jbytes: number; state_bytes: number }>("SELECT jcount, jbytes, state_bytes FROM docs WHERE id = ?", docId));
		if (!row) return;
		const jcount = num(row.jcount);
		const jbytes = num(row.jbytes);
		if (jcount > this.opts.compactJournalRows || (jcount > 1 && jbytes > Math.max(this.opts.compactMinJournalBytes, num(row.state_bytes) / 4))) {
			this.compact(docId);
		}
	}

	/** Folds the journal into a new state; small docs go through a Y.Doc so deletions are GC'd. */
	compact(docId: string): void {
		this.mergedCache.delete(docId);
		const merged = this.storedState(docId);
		if (!merged) return;
		let state = merged;
		if (merged.length <= DEEP_GC_MAX_BYTES) {
			const doc = new Y.Doc();
			Y.applyUpdate(doc, merged);
			state = Y.encodeStateAsUpdate(doc);
			doc.destroy();
		}
		const now = this.env.clock.now();
		const before = this.sql.rowsWritten;
		this.sql.transaction(() => {
			this.sql.exec("DELETE FROM doc_journal WHERE doc_id = ?", docId);
			this.sql.exec("DELETE FROM doc_chunks WHERE doc_id = ?", docId);
			if (state.length <= INLINE_STATE_MAX) {
				this.sql.exec("UPDATE docs SET state = ?, chunks = 0, state_bytes = ?, jcount = 0, jbytes = 0 WHERE id = ?", ownedBytes(state), state.length, docId);
			} else {
				let idx = 0;
				for (let o = 0; o < state.length; o += CHUNK_BYTES, idx++) {
					this.sql.exec("INSERT INTO doc_chunks (doc_id, idx, data) VALUES (?, ?, ?)", docId, idx, state.slice(o, o + CHUNK_BYTES));
				}
				this.sql.exec("UPDATE docs SET state = NULL, chunks = ?, state_bytes = ?, jcount = 0, jbytes = 0 WHERE id = ?", idx, state.length, docId);
			}
		});
		this.countRows(this.sql.rowsWritten - before, now);
		this.mergedCache.set(docId, state);
	}

	// ---------------------------------------------------------------- tree

	private reader(): TreeReader {
		return {
			get: (id) => {
				const r = one(this.sql.exec("SELECT * FROM tree WHERE id = ?", id));
				return r ? rowToEntry(r) : null;
			},
			liveChildByKey: (parent, key) => {
				const r = one(this.sql.exec("SELECT * FROM tree WHERE parent = ? AND name_key = ? AND deleted_seq IS NULL", parent, key));
				return r ? rowToEntry(r) : null;
			},
			liveChildren: (parent) => this.sql.exec("SELECT * FROM tree WHERE parent = ? AND deleted_seq IS NULL", parent).map(rowToEntry),
			// Unflushed edits by others count as newer than anything a deleter can have seen.
			docHeadSeq: (id, except) => {
				const p = this.pending.get(id);
				if (p && [...p.devices].some((d) => d !== except)) return this.seq + 1;
				const row = one(this.sql.exec<{ seq: number }>("SELECT MAX(seq) AS seq FROM doc_edits WHERE doc_id = ? AND device != ?", id, except ?? ""));
				return row ? num(row.seq) : 0;
			},
		};
	}

	private onTreeOp(c: ConnInfo, op: TreeOp): void {
		if (!op || typeof op.opId !== "string" || typeof op.t !== "string") {
			this.control(c.id, { t: "error", code: "bad_frame", message: "invalid tree op", fatal: false });
			return;
		}
		if (!this.canWrite(c)) {
			this.send(c.id, { type: "treeResult", opId: op.opId, result: { r: "rejected", reason: "forbidden", current: null } });
			return;
		}
		const prior = one(this.sql.exec<{ result: string }>("SELECT result FROM tree_ops WHERE op_id = ?", op.opId));
		if (prior) {
			this.send(c.id, { type: "treeResult", opId: op.opId, result: JSON.parse(str(prior.result)) as TreeResult });
			return;
		}
		const result = this.applyTreeOp(c, op, true);
		this.send(c.id, { type: "treeResult", opId: op.opId, result });
	}

	private applyTreeOp(c: ConnInfo, op: TreeOp, record: boolean): TreeResult {
		const now = this.env.clock.now();
		const seq = this.seq + 1;
		const admission = admit(op, this.reader(), { deviceId: c.deviceId, deviceLabel: c.deviceLabel, now, seq, mintId: () => randomId(16) });
		if (admission.writes.length === 0) return admission.result;
		const before = this.sql.rowsWritten;
		this.sql.transaction(() => {
			for (const e of admission.writes) {
				this.sql.exec(
					`INSERT INTO tree (id, parent, name, name_key, kind, blob_sha, blob_size, created_by, created_seq, updated_seq, deleted_seq, updated_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET parent = excluded.parent, name = excluded.name, name_key = excluded.name_key,
					   blob_sha = excluded.blob_sha, blob_size = excluded.blob_size, updated_seq = excluded.updated_seq,
					   deleted_seq = excluded.deleted_seq, updated_by = excluded.updated_by`,
					e.id,
					e.parent,
					e.name,
					nameKey(e.name),
					e.kind,
					e.blob?.sha ?? null,
					e.blob?.size ?? null,
					e.createdBy,
					e.createdSeq,
					e.updatedSeq,
					e.deletedSeq,
					e.updatedBy ?? null,
				);
			}
			if (record) {
				this.sql.exec("INSERT INTO tree_ops (op_id, seq, device, result, at) VALUES (?, ?, ?, ?, ?)", op.opId, seq, c.deviceId, JSON.stringify(admission.result), now);
			}
			this.setMeta("seq", seq);
		});
		this.seq = seq;
		this.countRows(this.sql.rowsWritten - before, now);
		// Tree changes are persisted before anyone hears about them: their seq is never reused.
		const events = admission.writes.map((entry) => ({ seq, entry }));
		this.broadcast(encodeFrame({ type: "treeEvents", cursor: seq, events }));
		return admission.result;
	}

	/** Live entries of the confirmed tree (for tests, history and admin tools). */
	liveEntries(): TreeEntry[] {
		return this.sql.exec("SELECT * FROM tree WHERE deleted_seq IS NULL").map(rowToEntry);
	}

	// ---------------------------------------------------------------- presence & control

	private onAwareness(c: ConnInfo, update: Uint8Array): void {
		const entries = readAwarenessUpdate(update);
		if (!entries) return;
		let mine = this.connClients.get(c.id);
		if (!mine) this.connClients.set(c.id, (mine = new Map()));
		for (const e of entries) {
			if (e.state === "null") {
				this.awareness.delete(e.clientId);
				mine.delete(e.clientId);
			} else {
				this.awareness.set(e.clientId, { conn: c.id, clock: e.clock, state: e.state });
				mine.set(e.clientId, e.clock);
			}
		}
		this.broadcast(encodeFrame({ type: "awareness", update }), c.id);
	}

	private async onControl(c: ConnInfo, msg: ControlMessage): Promise<void> {
		if (msg.t !== "token") return;
		const claims = await this.env.verifyAccess(msg.token);
		if (!claims || claims.dev !== c.deviceId || claims.sub !== c.userId) {
			this.kick(c.id, "unauthorized", "token refresh rejected");
			return;
		}
		const acl = this.aclFor(claims.sub);
		if (!acl || claims.aclv < acl.aclv) {
			this.kick(c.id, "revoked", "membership changed");
			return;
		}
		this.env.transport.update(c.id, { exp: claims.exp, aclv: claims.aclv });
	}

	// ---------------------------------------------------------------- budget

	private countRows(rows: number, now: number): void {
		if (rows <= 0) return;
		const day = new Date(now).toISOString().slice(0, 10);
		this.sql.exec("INSERT INTO budget (day, rows) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET rows = rows + excluded.rows", day, rows);
	}

	rowsWrittenOn(day: string): number {
		const row = one(this.sql.exec<{ rows: number }>("SELECT rows FROM budget WHERE day = ?", day));
		return row ? num(row.rows) : 0;
	}
}

export function rowToEntry(r: Row): TreeEntry {
	const sha = strOrNull(r.blob_sha);
	return {
		id: str(r.id),
		parent: str(r.parent),
		name: str(r.name),
		kind: str(r.kind) as Kind,
		blob: sha ? { sha, size: num(r.blob_size) } : null,
		createdBy: str(r.created_by),
		createdSeq: num(r.created_seq),
		updatedSeq: num(r.updated_seq),
		deletedSeq: r.deleted_seq == null ? null : num(r.deleted_seq),
		...(r.updated_by != null ? { updatedBy: str(r.updated_by) } : {}),
	};
}

export function isContentKind(kind: Kind): boolean {
	return CONTENT_DOC_KINDS.has(kind);
}

