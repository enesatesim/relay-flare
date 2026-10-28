import * as Y from "yjs";
import { randomId } from "@shared/bytes";
import { kindForFile, TEXT_ROOT } from "@shared/docKinds";
import type { Frame, Role, WelcomeFrame } from "@shared/protocol/frames";
import { LIMITS, PROTOCOL_VERSION, SCHEMA_VERSION } from "@shared/protocol/version";
import { entryPath, MemoryTree } from "@shared/tree/admit";
import { nameKey } from "@shared/tree/names";
import { isLive, ROOT_ID, TEXT_KINDS, type Kind, type TreeEntry, type TreeOp, type TreeResult } from "@shared/tree/types";
import { basename, depth, dirname, isWithin, join, rebase, toRel, toVault } from "./paths";
import type { Clock, Logger, SocketFactory, VaultEntry, VaultEvent, VaultPort } from "./ports";
import { FolderSocket } from "./socket";
import type { DiskRecord, PendingOp, ShareMeta, ShareStore } from "./store";
import { canonicalize, DEFAULT_FORMAT, hashText, merge2, merge3, patchYText, toDisk, type Canonical } from "./text";

/** Transaction origin for updates that came from the server. */
export const REMOTE = Symbol("relay-flare:remote");
/** Transaction origin for changes the engine makes from disk (reconcile, seeding). */
export const DISK = Symbol("relay-flare:disk");

export interface ShareConfig {
	folderId: string;
	/** Vault path of the share root; "" mounts the share at the vault root. */
	mount: string;
	deviceId: string;
	deviceLabel: string;
	socketUrl: string;
	/** Per-device exclusions, given a vault path (configDir, trash, user globs). */
	isExcluded(vaultPath: string): boolean;
	/** Overlapping offline edits: merge both and flag (default), or keep both as a copy. */
	overlapPolicy?: "merge" | "copy";
	/** Stat-only drift scan for missed watcher events; 0 disables the timer (mobile rescans on resume). */
	driftScanMs?: number;
	/** Development: verify engine invariants after every task and log violations as errors. */
	checkInvariants?: boolean;
}

/** Lets the engine leave editor-bound documents to the editor binding. */
export interface EditorHost {
	isBound(docId: string): boolean;
}

export type EngineNotice =
	| { kind: "review"; path: string; detail: string }
	| { kind: "restored"; path: string; reason: string }
	| { kind: "held"; path: string; reason: string }
	| { kind: "brake"; direction: "inbound" | "outbound"; count: number; paths: string[] }
	| { kind: "error"; message: string }
	| { kind: "readOnly" }
	| { kind: "revoked" }
	| { kind: "updateRequired"; message: string }
	| { kind: "epochChanged" };

export interface ShareDeps {
	vault: VaultPort;
	store: ShareStore;
	clock: Clock;
	log: Logger;
	socketFactory: SocketFactory;
	getToken(): Promise<string>;
	editor?: EditorHost;
	notify?(n: EngineNotice): void;
	onAwareness?(update: Uint8Array): void;
}

export interface ShareStatus {
	connection: "offline" | "connecting" | "syncing" | "live" | "stopped";
	role: Role | null;
	readOnly: boolean;
	/** Local changes not yet durably stored on the server (exact, from receipts). */
	unconfirmed: number;
	pendingOps: number;
	files: number;
	held: string[];
}

const SYNCED_KINDS: ReadonlySet<Kind> = new Set<Kind>(["folder", "markdown", "text"]);
const OUTBOX_BATCH_MS = 150;
const RECONCILE_DEBOUNCE_MS = 300;
const MAX_INFLIGHT_PULLS = 32;
const MAX_WARM_DOCS = 64;
const DOC_COMPACT_UPDATES = 64;

interface CatchupState {
	snapshot: TreeEntry[] | null;
	isSnapshot: boolean;
	cursor: number;
	/** catchupDone arrived: every tree event and head before `cursor` was sent. */
	received: boolean;
	/** Every listed document was pulled and the structure was materialized. */
	done: boolean;
}

/**
 * One shared folder on this device. Every vault event, server frame and timer is funneled
 * through a single task queue, so engine state is only ever mutated by one task at a time.
 */
export class ShareSession {
	private readonly vault: VaultPort;
	private readonly store: ShareStore;
	private readonly clock: Clock;
	private readonly log: Logger;
	private readonly socket: FolderSocket;

	private meta!: ShareMeta;
	private readonly confirmed = new MemoryTree();
	private readonly pending = new Map<string, PendingOp>();
	/** Disk index: share-relative path → record. The record id is the tree entry id. */
	private readonly disk = new Map<string, DiskRecord>();
	private readonly diskById = new Map<string, DiskRecord>();
	/** Provisional ids replaced by adoption, so later ops can be corrected. */
	private readonly aliases = new Map<string, string>();

	private readonly docs = new Map<string, Y.Doc>();
	private readonly docLoads = new Map<string, Promise<Y.Doc>>();
	private readonly batch = new Map<string, Uint8Array[]>();
	private batchTimer: unknown = null;
	private unconfirmed = 0;

	private readonly dirty = new Set<string>();
	private reconcileTimer: unknown = null;

	// Echo tokens for structural changes we make ourselves (content echoes are recognized by hash).
	private readonly ownCreates = new Set<string>();
	private readonly ownDeletes = new Set<string>();
	private readonly ownRenames = new Set<string>();

	private queue: Promise<void> = Promise.resolve();
	private queued = 0;
	private stopped = false;
	private started = false;

	private welcome: WelcomeFrame | null = null;
	private catchup: CatchupState | null = null;
	private readonly pullQueue: string[] = [];
	private readonly pullQueued = new Set<string>();
	private readonly inflight = new Set<string>();
	private readonly held = new Map<string, string>();
	private heldDeletes: DiskRecord[] = [];
	private rescanTimer: unknown = null;
	/** Records displaced by an index collision; the next scan re-attaches them by content. */
	private readonly lost = new Map<string, DiskRecord>();
	/**
	 * Server seq up to which each document's content is in our local CRDT: set from sync replies
	 * (after applying them) and from live heads once caught up, never from catch-up heads, which
	 * announce content that has not been pulled yet.
	 */
	private readonly docSeq = new Map<string, number>();
	/** Docs pulled once while empty; the server had nothing more, so empty is the truth. */
	private readonly pulledEmpty = new Set<string>();
	private driftTimer: unknown = null;

	constructor(
		readonly config: ShareConfig,
		private readonly deps: ShareDeps,
	) {
		this.vault = deps.vault;
		this.store = deps.store;
		this.clock = deps.clock;
		this.log = deps.log;
		this.socket = new FolderSocket({
			url: config.socketUrl,
			getToken: deps.getToken,
			factory: deps.socketFactory,
			clock: deps.clock,
			log: deps.log,
			onOpen: () => this.enqueue("socket.open", () => this.onSocketOpen()),
			onClose: (info) => {
				// Synchronously: nothing may be sent on the next socket before its hello.
				this.welcome = null;
				void this.enqueue("socket.close", async () => this.onSocketClose(info));
			},
			onFrame: (frame) => this.enqueue(`frame.${frame.type}`, () => this.onFrame(frame)),
		});
	}

	// ------------------------------------------------------------------ lifecycle

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.meta = await this.store.getMeta();
		for (const e of await this.store.treeAll()) this.confirmed.apply(e);
		for (const op of await this.store.opsAll()) this.pending.set(op.op.opId, op);
		for (const rec of await this.store.diskAll()) this.indexPut(rec);
		this.unconfirmed = (await this.store.outboxAll()).length;
		await this.enqueue("startup.scan", () => this.startupScan());
		this.socket.start();
		this.armDriftScan();
	}

	private armDriftScan(): void {
		const every = this.config.driftScanMs ?? 60_000;
		if (every <= 0 || this.stopped) return;
		this.driftTimer = this.clock.setTimeout(() => {
			this.driftTimer = null;
			void this.enqueue("drift.scan", () => this.startupScan()).then(() => this.armDriftScan());
		}, every);
	}

	/** Something on disk did not match the index: re-check soon (coalesced). */
	private scheduleRescan(reason: string): void {
		this.log("info", "rescan.scheduled", { reason });
		if (this.rescanTimer !== null) return;
		this.rescanTimer = this.clock.setTimeout(() => {
			this.rescanTimer = null;
			void this.enqueue("rescan", () => this.startupScan());
		}, 500);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.socket.stop();
		if (this.batchTimer !== null) this.clock.clearTimeout(this.batchTimer);
		if (this.reconcileTimer !== null) this.clock.clearTimeout(this.reconcileTimer);
		if (this.rescanTimer !== null) this.clock.clearTimeout(this.rescanTimer);
		if (this.driftTimer !== null) this.clock.clearTimeout(this.driftTimer);
		await this.flushBatch();
		await this.queue;
		for (const doc of this.docs.values()) doc.destroy();
		this.docs.clear();
	}

	/** Reconnects immediately (after a network change or when the app resumes). */
	reconnect(): void {
		this.socket.reconnectNow();
	}

	/** Re-checks the disk against the index (missed watcher events, mobile resume). */
	rescan(): Promise<void> {
		return this.enqueue("rescan", () => this.startupScan());
	}

	status(): ShareStatus {
		const s = this.socket.status;
		const connection: ShareStatus["connection"] =
			s === "stopped" ? "stopped" : s === "open" ? (this.catchup && !this.catchup.done ? "syncing" : this.welcome ? "live" : "connecting") : s === "connecting" ? "connecting" : "offline";
		return {
			connection,
			role: this.welcome?.role ?? null,
			readOnly: this.welcome?.readOnly ?? false,
			unconfirmed: this.unconfirmed,
			pendingOps: this.pending.size,
			files: this.disk.size,
			held: [...this.held.keys()],
		};
	}

	/** Resolves once every queued task has run (tests and the simulation). */
	async settled(): Promise<void> {
		while (this.queued > 0) await this.queue;
	}

	/** True when nothing is queued, batched, debounced or waiting on the server. */
	isQuiet(): boolean {
		return this.queued === 0 && this.rescanTimer === null && this.batch.size === 0 && this.dirty.size === 0 && this.inflight.size === 0 && this.pullQueue.length === 0 && this.pending.size === 0 && this.unconfirmed === 0 && !!this.catchup?.done;
	}

	private enqueue(label: string, task: () => Promise<void> | void): Promise<void> {
		this.queued++;
		const run = this.queue.then(async () => {
			if (this.stopped && !label.startsWith("flush")) return;
			try {
				await task();
			} catch (err) {
				this.log("error", "task.failed", { task: label, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
			} finally {
				this.queued--;
				if (this.config.checkInvariants) this.checkInvariants(label);
			}
		});
		this.queue = run;
		return run;
	}

	/** Index consistency: every id maps to exactly one path and every path to exactly one id. */
	private checkInvariants(label: string): void {
		for (const [id, rec] of this.diskById) {
			const atPath = this.disk.get(rec.path);
			if (atPath?.id !== id) this.log("error", "invariant.index", { task: label, id, path: rec.path, pathHolder: atPath?.id ?? null });
		}
		for (const [path, rec] of this.disk) {
			if (rec.path !== path || this.diskById.get(rec.id) !== rec) this.log("error", "invariant.index", { task: label, path, id: rec.id, recPath: rec.path });
		}
	}

	// ------------------------------------------------------------------ disk index

	private indexPut(rec: DiskRecord): void {
		const prev = this.diskById.get(rec.id);
		if (prev && prev.path !== rec.path && this.disk.get(prev.path)?.id === rec.id) this.disk.delete(prev.path);
		const holder = this.disk.get(rec.path);
		if (holder && holder.id !== rec.id) {
			// One path, one entry. The previous holder's record is stale (its file cannot be here
			// too): park it so the next scan can find where its file really is.
			this.log("warn", "index.collision", { path: rec.path, holder: holder.id, incoming: rec.id, at: new Error().stack?.split("\n").slice(2, 6).join(" | ") });
			if (this.diskById.get(holder.id)?.path === holder.path) this.diskById.delete(holder.id);
			this.lost.set(holder.id, holder);
			this.scheduleRescan("index collision");
		}
		this.disk.set(rec.path, rec);
		this.diskById.set(rec.id, rec);
		this.lost.delete(rec.id);
	}

	private indexDelete(rec: DiskRecord): void {
		if (this.disk.get(rec.path)?.id === rec.id) this.disk.delete(rec.path);
		// Compare by value: callers often pass an updated copy of the stored record.
		if (this.diskById.get(rec.id)?.path === rec.path) this.diskById.delete(rec.id);
	}

	private async saveRec(rec: DiskRecord, oldPath?: string): Promise<void> {
		if (oldPath !== undefined && oldPath !== rec.path && this.disk.get(oldPath)?.id === rec.id) {
			// Only release the old path if this entry held it (it may belong to someone else now).
			this.disk.delete(oldPath);
			await this.store.diskDelete(oldPath);
		}
		this.indexPut(rec);
		await this.store.diskPut(rec);
	}

	private async dropRec(rec: DiskRecord): Promise<void> {
		const held = this.disk.get(rec.path)?.id === rec.id;
		this.indexDelete(rec);
		this.lost.delete(rec.id);
		if (held) await this.store.diskDelete(rec.path);
	}

	/** Records under a folder path (excluding the folder itself). */
	private descendants(relFolder: string): DiskRecord[] {
		const out: DiskRecord[] = [];
		for (const r of this.disk.values()) if (r.path !== relFolder && isWithin(r.path, relFolder)) out.push(r);
		return out;
	}

	/** Reads and canonicalizes a file; null when it vanished or cannot be read (never a crash). */
	private async read(vp: string): Promise<Canonical | null> {
		try {
			return canonicalize(await this.vault.readText(vp));
		} catch (err) {
			this.log("debug", "read.failed", { error: String(err) });
			return null;
		}
	}

	private vaultPath(rel: string): string {
		return toVault(this.config.mount, rel);
	}

	private relPath(vaultPath: string): string | null {
		const rel = toRel(this.config.mount, vaultPath);
		if (rel === null || rel === "") return null;
		if (this.config.isExcluded(vaultPath)) return null;
		// Hidden segments are never synced (and are invalid names on the server anyway).
		if (rel.split("/").some((s) => s.startsWith("."))) return null;
		return rel;
	}

	private kindOf(rel: string, isFolder: boolean): Kind {
		return isFolder ? "folder" : kindForFile(rel);
	}

	// ------------------------------------------------------------------ local view

	/** Confirmed entry with this device's pending ops layered on top. */
	private viewEntry(id: string): TreeEntry | null {
		let e = this.confirmed.get(id);
		for (const p of this.pending.values()) {
			const op = p.op;
			if (op.id !== id) continue;
			if (op.t === "create") e = { id, parent: op.parent, name: op.name, kind: op.kind, blob: null, createdBy: this.config.deviceId, createdSeq: 0, updatedSeq: 0, deletedSeq: null };
			else if (op.t === "move" && e) e = { ...e, parent: op.parent, name: op.name };
			else if (op.t === "delete" && e) e = { ...e, deletedSeq: -1 };
			else if (op.t === "revive" && e) e = { ...e, deletedSeq: null };
		}
		return e;
	}

	/** Paths of every live entry in the local view (confirmed + pending). */
	private viewPaths(): Map<string, string> {
		const ids = new Set<string>(this.confirmed.entries.keys());
		for (const p of this.pending.values()) ids.add(p.op.id);
		const view = new Map<string, TreeEntry>();
		for (const id of ids) {
			const e = this.viewEntry(id);
			if (e && isLive(e)) view.set(id, e);
		}
		const reader = { get: (id: string) => view.get(id) ?? null };
		const out = new Map<string, string>();
		for (const id of view.keys()) {
			const p = entryPath(reader, id);
			if (p !== null) out.set(id, p);
		}
		return out;
	}

	// ------------------------------------------------------------------ startup scan

	/**
	 * Finds what changed on disk while the engine was not running. A path that was indexed
	 * and is now absent is a local delete, never "missing, download again" (YAOS SYNC-01).
	 */
	private async startupScan(): Promise<void> {
		const listing = await this.vault.list(this.config.mount);
		const present = new Map<string, VaultEntry>();
		for (const e of listing) {
			const rel = this.relPath(e.path);
			if (rel === null) continue;
			if (!SYNCED_KINDS.has(this.kindOf(rel, e.isFolder))) continue;
			present.set(rel, e);
		}
		const missing: DiskRecord[] = [];
		for (const rec of this.disk.values()) {
			const e = present.get(rec.path);
			if (!e || e.isFolder !== (rec.kind === "folder")) missing.push(rec);
			else if (!e.isFolder && (e.mtime !== rec.mtime || e.size !== rec.size)) this.markDirty(rec.id);
		}
		const added = [...present.values()].filter((e) => !this.disk.has(this.relPath(e.path)!));
		// Displaced records can be re-attached by content, but are never treated as deletes:
		// their files went missing from the index, not necessarily from the disk.
		const lost = [...this.lost.values()].filter((l) => !this.diskById.has(l.id));
		this.lost.clear();

		// Renames while offline: a missing file whose content now sits at a new path.
		const byHash = new Map<string, DiskRecord>();
		for (const m of [...missing, ...lost]) if (m.kind !== "folder" && m.hash) byHash.set(`${m.size}:${m.hash}`, m);
		const renamed = new Set<DiskRecord>();
		const createdFiles: VaultEntry[] = [];
		for (const e of added.filter((x) => !x.isFolder)) {
			const candidates = [...byHash.entries()].filter(([k]) => k.startsWith(`${e.size}:`));
			if (candidates.length === 0) {
				createdFiles.push(e);
				continue;
			}
			const content = await this.read(e.path);
			if (!content) continue;
			const hash = hashText(content.text);
			const match = byHash.get(`${e.size}:${hash}`);
			if (match && !renamed.has(match)) {
				renamed.add(match);
				byHash.delete(`${e.size}:${hash}`);
				await this.localMove(match, this.relPath(e.path)!);
			} else createdFiles.push(e);
		}

		const deletes = missing.filter((m) => !renamed.has(m));
		const fileDeletes = deletes.filter((d) => d.kind !== "folder");
		if (fileDeletes.length > Math.max(20, this.disk.size * 0.25) && this.disk.size > 0) {
			// Outbound safety brake: e.g. an unmounted drive or a folder moved out of the share.
			this.heldDeletes = deletes;
			this.deps.notify?.({ kind: "brake", direction: "outbound", count: fileDeletes.length, paths: fileDeletes.slice(0, 20).map((d) => d.path) });
		} else {
			for (const d of deletes.sort((a, b) => depth(b.path) - depth(a.path))) {
				if (this.disk.get(d.path)?.id === d.id) await this.localDelete(d);
			}
		}

		for (const e of added.filter((x) => x.isFolder).sort((a, b) => depth(a.path) - depth(b.path))) {
			await this.localCreate(this.relPath(e.path)!, true, e);
		}
		for (const e of createdFiles) await this.localCreate(this.relPath(e.path)!, false, e);
	}

	/** User decision for a held outbound mass delete. */
	resolveOutboundBrake(accept: boolean): Promise<void> {
		return this.enqueue("brake.resolve", async () => {
			const held = this.heldDeletes;
			this.heldDeletes = [];
			if (accept) {
				for (const d of held.sort((a, b) => depth(b.path) - depth(a.path))) if (this.disk.get(d.path)?.id === d.id) await this.localDelete(d);
			} else {
				// Restore the files from the share instead of deleting them for everyone.
				for (const d of held) {
					await this.dropRec(d);
					await this.store.lcaDelete(d.id);
				}
				await this.syncStructure();
			}
		});
	}

	// ------------------------------------------------------------------ vault events

	onVaultEvent(ev: VaultEvent): void {
		if (!this.started) return;
		void this.enqueue(`vault.${ev.type}`, () => this.handleVaultEvent(ev));
	}

	private async handleVaultEvent(ev: VaultEvent): Promise<void> {
		this.log("debug", "vault.event", { ...ev });
		switch (ev.type) {
			case "create": {
				const rel = this.relPath(ev.path);
				// Our own create, but only if the index still says so (the user may have moved
				// things between our write and this event).
				if (this.ownCreates.delete(ev.path) && (rel === null || this.disk.has(rel))) return;
				if (rel === null) return;
				const stat = await this.vault.stat(ev.path);
				if (!stat) return;
				await this.localCreate(rel, ev.isFolder, { path: ev.path, ...stat });
				return;
			}
			case "modify": {
				const rel = this.relPath(ev.path);
				if (rel === null) return;
				const rec = this.disk.get(rel);
				if (rec) this.markDirty(rec.id);
				else {
					const stat = await this.vault.stat(ev.path);
					if (stat) await this.localCreate(rel, false, { path: ev.path, ...stat });
				}
				return;
			}
			case "delete": {
				if (this.ownDeletes.delete(ev.path)) return;
				const rel = this.relPath(ev.path);
				if (rel === null) return;
				const rec = this.disk.get(rel);
				if (rec) await this.localDelete(rec);
				return;
			}
			case "rename": {
				if (this.ownRenames.delete(`${ev.oldPath}\u0000${ev.path}`)) return;
				const oldRel = this.relPath(ev.oldPath);
				const newRel = this.relPath(ev.path);
				const rec = oldRel !== null ? this.disk.get(oldRel) : undefined;
				if (!rec) {
					// A descendant of a folder we already moved: nothing left to do.
					if (newRel !== null && this.disk.has(newRel)) return;
					if (newRel !== null) {
						const stat = await this.vault.stat(ev.path);
						if (stat) await this.localCreate(newRel, ev.isFolder, { path: ev.path, ...stat });
					}
					return;
				}
				if (newRel === null) {
					await this.localDelete(rec);
					return;
				}
				if (rec.kind !== "folder" && rec.kind !== this.kindOf(newRel, false)) {
					// The kind changed (e.g. .md → .txt): a different document.
					await this.localDelete(rec);
					const stat = await this.vault.stat(ev.path);
					if (stat) await this.localCreate(newRel, false, { path: ev.path, ...stat });
					return;
				}
				await this.localMove(rec, newRel);
				return;
			}
		}
	}

	// ------------------------------------------------------------------ local structural changes

	private async queueOp(op: TreeOp, intent: PendingOp["intent"]): Promise<void> {
		this.log("debug", "op.queue", { op });
		const p: PendingOp = { op, intent, at: this.clock.now() };
		this.pending.set(op.opId, p);
		await this.store.opPut(p);
		if (this.welcome) this.socket.send({ type: "treeOp", op });
	}

	/** Entry id for a share-relative folder path, creating folder entries as needed. */
	private async ensureFolder(rel: string): Promise<string | null> {
		if (rel === "") return ROOT_ID;
		const rec = this.disk.get(rel);
		if (rec) return rec.kind === "folder" ? rec.id : null;
		const parent = await this.ensureFolder(dirname(rel));
		if (parent === null) return null;
		// A confirmed folder already lives here but has no local record: link instead of minting.
		const twin = this.confirmed.liveChildByKey(parent, nameKey(basename(rel)));
		if (twin && twin.kind === "folder" && !this.diskById.has(twin.id) && isLive(this.viewEntry(twin.id))) {
			await this.saveRec({ path: rel, id: twin.id, kind: "folder", hash: null, mtime: 0, size: 0, format: DEFAULT_FORMAT });
			return twin.id;
		}
		const id = randomId(16);
		await this.saveRec({ path: rel, id, kind: "folder", hash: null, mtime: 0, size: 0, format: DEFAULT_FORMAT });
		await this.queueOp({ t: "create", opId: randomId(12), id, parent, name: basename(rel), kind: "folder" }, "mkdir");
		return id;
	}

	private async localCreate(rel: string, isFolder: boolean, stat: VaultEntry | null): Promise<void> {
		const existing = this.disk.get(rel);
		if (existing) {
			if (!isFolder && existing.kind !== "folder") this.markDirty(existing.id);
			return;
		}
		const kind = this.kindOf(rel, isFolder);
		if (!SYNCED_KINDS.has(kind)) return;
		const parent = await this.ensureFolder(dirname(rel));
		if (parent === null) return;
		// A confirmed entry already sits at this path but was never materialized here: link to it.
		const twin = this.confirmed.liveChildByKey(parent, nameKey(basename(rel)));
		// ...unless this device just deleted it (a pending delete makes it dead in the local view).
		if (twin && !this.diskById.has(twin.id) && twin.kind === kind && isLive(this.viewEntry(twin.id))) {
			await this.saveRec({ path: rel, id: twin.id, kind, hash: null, mtime: stat?.mtime ?? 0, size: stat?.size ?? 0, format: DEFAULT_FORMAT });
			if (kind !== "folder") this.markDirty(twin.id);
			return;
		}
		const id = randomId(16);
		await this.saveRec({ path: rel, id, kind, hash: null, mtime: stat?.mtime ?? 0, size: stat?.size ?? 0, format: DEFAULT_FORMAT });
		await this.queueOp({ t: "create", opId: randomId(12), id, parent, name: basename(rel), kind }, isFolder ? "mkdir" : "create");
	}

	private async localDelete(rec: DiskRecord): Promise<void> {
		// Edits made before the delete must reach the server before it.
		await this.flushBatch();
		const victims = rec.kind === "folder" ? [...this.descendants(rec.path), rec] : [rec];
		for (const v of victims) {
			await this.dropRec(v);
			await this.store.lcaDelete(v.id);
		}
		const contentSeq = rec.kind === "folder" ? undefined : (rec.seenSeq ?? 0);
		await this.queueOp({ t: "delete", opId: randomId(12), id: rec.id, baseSeq: this.meta.cursor, ...(contentSeq !== undefined ? { contentSeq } : {}) }, "delete");
	}

	private async localMove(rec: DiskRecord, newRel: string): Promise<void> {
		const entry = this.viewEntry(rec.id);
		const parent = await this.ensureFolder(dirname(newRel));
		if (parent === null) return;
		const oldPath = rec.path;
		if (rec.kind === "folder") {
			for (const d of this.descendants(oldPath)) {
				const moved = rebase(d.path, oldPath, newRel);
				// Only what is really in the new place moved with the folder (a file written into
				// the old path after the rename stays where it is).
				if (await this.vault.stat(this.vaultPath(moved))) await this.saveRec({ ...d, path: moved }, d.path);
				else if (!(await this.vault.stat(this.vaultPath(d.path)))) this.scheduleRescan("folder move: descendant vanished");
			}
		}
		await this.saveRec({ ...rec, path: newRel }, oldPath);
		if (!entry || !isLive(entry)) {
			// Moving something the server no longer has: keep the content as a new file.
			await this.dropRec({ ...rec, path: newRel });
			await this.localCreate(newRel, rec.kind === "folder", null);
			return;
		}
		await this.queueOp(
			{ t: "move", opId: randomId(12), id: rec.id, parent, name: basename(newRel), expect: { parent: entry.parent, name: entry.name }, baseSeq: this.meta.cursor },
			"move",
		);
	}

	// ------------------------------------------------------------------ socket & frames

	private async onSocketOpen(): Promise<void> {
		this.socket.send({ type: "hello", protocol: PROTOCOL_VERSION, schema: SCHEMA_VERSION, epoch: this.meta.epoch, cursor: this.meta.cursor, client: "relay-flare" });
	}

	private onSocketClose(info: { code: number; reason: string }): void {
		this.log("info", "socket.closed", info);
		this.welcome = null;
		this.catchup = null;
		this.inflight.clear();
		this.pullQueue.length = 0;
		this.pullQueued.clear();
	}

	private async onFrame(f: Frame): Promise<void> {
		switch (f.type) {
			case "welcome":
				return this.onWelcome(f);
			case "treeSnapshot":
				if (!this.catchup) return;
				this.catchup.snapshot = [...(this.catchup.snapshot ?? []), ...f.entries];
				if (f.final) {
					const snap = this.catchup.snapshot;
					this.catchup.snapshot = null;
					await this.applySnapshot(snap);
				}
				return;
			case "treeEvents":
				await this.applyEntries(f.events.map((e) => e.entry));
				if (this.catchup?.done) await this.advanceCursor(f.cursor);
				return;
			case "treeResult":
				return this.onTreeResult(f.opId, f.result);
			case "heads":
				for (const [docId, seq] of f.heads) {
					if (this.catchup && !this.catchup.done) this.requestPull(docId);
					else this.noteDocSeq(docId, seq);
				}
				if (this.catchup?.done) await this.advanceCursor(f.cursor);
				return;
			case "catchupDone":
				if (this.catchup) {
					this.catchup.cursor = f.cursor;
					this.catchup.received = true;
				}
				return this.maybeFinishCatchup();
			case "sync2":
				await this.applyRemote(f.docId, f.update);
				this.noteDocSeq(f.docId, f.headSeq);
				this.inflight.delete(f.docId);
				this.pumpPulls();
				return this.maybeFinishCatchup();
			case "bcast":
				return this.applyRemote(f.docId, f.update);
			case "ack":
				return this.onAck(f.durableDseq);
			case "awareness":
				this.deps.onAwareness?.(f.update);
				return;
			case "control":
				return this.onControl(f.msg);
			default:
				return;
		}
	}

	private async onWelcome(f: WelcomeFrame): Promise<void> {
		if (this.meta.epoch !== null && this.meta.epoch !== f.epoch) {
			this.log("warn", "server.epoch_changed", { was: this.meta.epoch, now: f.epoch });
			this.deps.notify?.({ kind: "epochChanged" });
			await this.setMeta({ cursor: 0 });
		}
		this.welcome = f;
		this.catchup = { snapshot: null, isSnapshot: f.snapshot, cursor: f.headSeq, received: false, done: false };
		await this.setMeta({ epoch: f.epoch });
		if (f.readOnly) this.deps.notify?.({ kind: "readOnly" });
		// Drop what the server already stored, resend the rest in order.
		await this.onAck(f.durableDseq);
		if (!f.readOnly) {
			for (const p of this.pending.values()) this.socket.send({ type: "treeOp", op: p.op });
			for (const item of await this.store.outboxAll()) this.socket.send({ type: "update", dseq: item.dseq, docId: item.docId, update: item.update });
		}
	}

	private async setMeta(patch: Partial<ShareMeta>): Promise<void> {
		this.meta = { ...this.meta, ...patch };
		await this.store.setMeta(patch);
	}

	private async advanceCursor(cursor: number): Promise<void> {
		if (cursor > this.meta.cursor) await this.setMeta({ cursor });
	}

	private noteDocSeq(docId: string, seq: number): void {
		if (seq > (this.docSeq.get(docId) ?? 0)) this.docSeq.set(docId, seq);
	}

	private requestPull(docId: string): void {
		if (this.pullQueued.has(docId) || this.inflight.has(docId)) return;
		this.pullQueued.add(docId);
		this.pullQueue.push(docId);
		this.pumpPulls();
	}

	private pumpPulls(): void {
		while (this.inflight.size < MAX_INFLIGHT_PULLS && this.pullQueue.length > 0) {
			const docId = this.pullQueue.shift()!;
			this.pullQueued.delete(docId);
			this.inflight.add(docId);
			void this.enqueue("pull", async () => {
				const doc = await this.getDoc(docId);
				if (!this.socket.send({ type: "sync1", docId, sv: Y.encodeStateVector(doc) })) this.inflight.delete(docId);
			});
		}
	}

	private async maybeFinishCatchup(): Promise<void> {
		const c = this.catchup;
		if (!c || c.done || !c.received || c.snapshot !== null) return;
		if (this.inflight.size > 0 || this.pullQueue.length > 0) return;
		if (!this.welcome) return;
		c.done = true;
		await this.setMeta({ cursor: Math.max(this.meta.cursor, c.cursor), caughtUp: true });
		await this.syncStructure();
	}

	private async onAck(durable: number): Promise<void> {
		await this.store.outboxDrop(durable);
		this.unconfirmed = (await this.store.outboxAll()).length;
	}

	private async onControl(msg: Extract<Frame, { type: "control" }>["msg"]): Promise<void> {
		switch (msg.t) {
			case "revoked":
				this.socket.stop();
				this.deps.notify?.({ kind: "revoked" });
				return;
			case "error":
				this.log(msg.fatal ? "error" : "warn", "server.error", { code: msg.code, message: msg.message });
				if (msg.code === "update_required") {
					this.socket.stop();
					this.deps.notify?.({ kind: "updateRequired", message: msg.message });
				} else if (msg.code === "unauthorized") {
					// The socket closes; the next connect fetches a fresh token.
				}
				return;
			case "presenceQuery":
				return;
			case "tokenExpiring": {
				const token = await this.deps.getToken();
				this.socket.send({ type: "control", msg: { t: "token", token } });
				return;
			}
			default:
				return;
		}
	}

	/** Sends a fresh access token in-band so a long-lived socket never expires. */
	refreshToken(token: string): void {
		this.socket.send({ type: "control", msg: { t: "token", token } });
	}

	sendAwareness(update: Uint8Array): void {
		this.socket.send({ type: "awareness", update });
	}

	// ------------------------------------------------------------------ tree results & events

	private async applySnapshot(entries: TreeEntry[]): Promise<void> {
		const live = new Set(entries.map((e) => e.id));
		const gone: TreeEntry[] = [];
		for (const e of this.confirmed.entries.values()) {
			if (isLive(e) && !live.has(e.id)) gone.push({ ...e, deletedSeq: this.catchup?.cursor ?? this.meta.cursor });
		}
		await this.applyEntries([...entries, ...gone], false);
	}

	private async applyEntries(entries: TreeEntry[], sync = true): Promise<void> {
		await this.confirm(entries);
		// During catch-up, structure is materialized once all documents are pulled.
		if (sync && this.catchup?.done) await this.syncStructure();
	}

	/**
	 * Applies confirmed entry states, never moving an entry backwards: a replayed result for a
	 * resent op carries the state from when it was first admitted, which may be older than
	 * what catch-up already delivered.
	 */
	private async confirm(entries: TreeEntry[]): Promise<void> {
		const fresh = entries.filter((e) => {
			const cur = this.confirmed.get(e.id);
			return !cur || cur.updatedSeq <= e.updatedSeq;
		});
		for (const e of fresh) this.confirmed.apply(e);
		if (fresh.length > 0) await this.store.treePut(fresh);
	}

	private async onTreeResult(opId: string, result: TreeResult): Promise<void> {
		const p = this.pending.get(opId);
		this.log("debug", "op.result", { opId, known: !!p, result });
		if (!p) return;
		this.pending.delete(opId);
		await this.store.opDelete(opId);
		const op = p.op;
		switch (result.r) {
			case "ok":
			case "renamed":
				await this.confirm([result.entry]);
				if (op.t === "create" && p.intent === "create") await this.seedDoc(op.id);
				break;
			case "adopted":
				await this.adopt(p, result.existing);
				break;
			case "partial":
				break;
			case "conflictCopy":
				break;
			case "rejected":
				await this.onRejected(p, result.reason, result.current);
				break;
		}
		if (this.catchup?.done) await this.syncStructure();
	}

	/** Our create collided with an equivalent entry: use the existing one. */
	private async adopt(p: PendingOp, existing: TreeEntry): Promise<void> {
		const provisional = p.op.id;
		await this.confirm([existing]);
		const rec = this.diskById.get(provisional);
		const bound = this.diskById.get(existing.id);
		if (rec && bound && bound !== rec && p.op.t === "create") {
			// The existing entry already backs another local file here (for example one we moved
			// away while this create was in flight). Keep this file as its own entry: resend the
			// create with a fresh id; the server takes a conflict name instead of adopting again.
			const fresh = randomId(16);
			await this.dropRec(rec);
			await this.saveRec({ ...rec, id: fresh });
			await this.repoint(provisional, fresh);
			await this.queueOp({ ...p.op, opId: randomId(12), id: fresh, noAdopt: true }, p.intent);
			return;
		}
		this.aliases.set(provisional, existing.id);
		if (rec) {
			await this.dropRec(rec);
			await this.saveRec({ ...rec, id: existing.id, hash: null });
		}
		await this.repoint(provisional, existing.id);
		if (existing.kind !== "folder") {
			// No common ancestor: the reconcile does a two-way union merge once content arrives.
			await this.store.lcaDelete(existing.id);
			if (this.welcome) this.requestPull(existing.id);
			this.markDirty(existing.id);
		}
	}

	/** Re-points pending ops that reference an id this device replaced. */
	private async repoint(from: string, to: string): Promise<void> {
		// Rewritten ops go to the back of the queue, so every op after the first rewritten one
		// is resent too: the server must still see a parent's create before its children.
		// Admission is idempotent per entry id, so a duplicate of an already-admitted op is harmless.
		let resend = false;
		for (const pending of [...this.pending.values()]) {
			const op = pending.op;
			let changed: TreeOp | null = null;
			if ((op.t === "create" || op.t === "move") && op.parent === from) changed = { ...op, parent: to };
			if (op.t === "move" && op.expect.parent === from) {
				const base = (changed ?? op) as typeof op;
				changed = { ...base, expect: { ...base.expect, parent: to } };
			}
			if (op.id === from) changed = { ...(changed ?? op), id: to } as TreeOp;
			if (!changed && !resend) continue;
			resend = true;
			this.pending.delete(op.opId);
			await this.store.opDelete(op.opId);
			await this.queueOp({ ...(changed ?? op), opId: randomId(12) } as TreeOp, pending.intent);
		}
	}

	private async onRejected(p: PendingOp, reason: string, current: TreeEntry | null): Promise<void> {
		const op = p.op;
		if (current) {
			await this.confirm([current]);
		}
		const rec = this.diskById.get(op.id);
		const path = rec?.path ?? (op.t === "create" || op.t === "move" ? join(dirname(rec?.path ?? ""), op.name) : op.id);
		switch (reason) {
			case "edited":
				// Someone changed it after we deleted it: it comes back (structure sync re-materializes).
				this.deps.notify?.({ kind: "restored", path: current ? (entryPath(this.confirmed, current.id) ?? path) : path, reason: "edited on another device after you deleted it" });
				return;
			case "stale":
			case "cycle":
				this.deps.notify?.({ kind: "restored", path, reason: reason === "stale" ? "it was moved on another device first" : "the move would put a folder inside itself" });
				return;
			case "parent-missing": {
				if (op.t === "create" || op.t === "move") {
					const parent = this.aliases.get(op.parent) ?? op.parent;
					const parentPending = [...this.pending.values()].some((q) => q.op.t === "create" && q.op.id === parent);
					// The parent exists (or is about to): this op merely overtook it. Retry after it.
					if (parent !== op.parent || parentPending || isLive(this.confirmed.get(parent))) {
						await this.queueOp({ ...op, parent, opId: randomId(12) }, p.intent);
						return;
					}
				}
				if (rec && op.t === "create") {
					// The parent was removed: recreate the chain and retry.
					await this.dropRec(rec);
					const parentRec = this.disk.get(dirname(rec.path));
					if (parentRec) await this.dropRec(parentRec);
					await this.localCreate(rec.path, rec.kind === "folder", null);
				}
				return;
			}
			case "deleted":
				if (rec) {
					// Moved locally, deleted remotely: keep the local content as a new file.
					await this.dropRec(rec);
					await this.localCreate(rec.path, rec.kind === "folder", null);
				}
				return;
			case "id-taken":
				if (op.t === "create" && rec) {
					await this.dropRec(rec);
					await this.localCreate(rec.path, rec.kind === "folder", null);
				}
				return;
			case "invalid-name":
				this.held.set(path, "name is not valid on every platform");
				this.deps.notify?.({ kind: "held", path, reason: "This name contains characters that are not allowed on some devices. Rename it to sync." });
				if (rec) await this.dropRec(rec);
				return;
			case "forbidden":
				this.deps.notify?.({ kind: "readOnly" });
				return;
			default:
				this.log("warn", "op.rejected", { reason, op: op.t });
		}
	}

	// ------------------------------------------------------------------ structure: confirmed → disk

	/**
	 * Brings the disk in line with the local view: remote creates, moves and deletes.
	 * Pending local ops are part of the view, so nothing the user just did is undone.
	 */
	private async syncStructure(): Promise<void> {
		const view = this.viewPaths();

		// Inbound safety brake: a remote batch that would remove a large part of the share.
		const removals = [...this.disk.values()].filter((r) => r.kind !== "folder" && !view.has(r.id));
		if (removals.length > Math.max(20, this.disk.size * 0.25) && this.disk.size > 40) {
			this.deps.notify?.({ kind: "brake", direction: "inbound", count: removals.length, paths: removals.slice(0, 20).map((r) => r.path) });
			return;
		}

		// Operations depend on each other (a move into a folder this pass creates, a create in a
		// path a move vacates), so run passes until one makes no progress.
		for (let pass = 0; pass < 8; pass++) {
			if (!(await this.structurePass(this.viewPaths()))) break;
		}
	}

	private async structurePass(view: Map<string, string>): Promise<boolean> {
		let progress = false;
		// 1. Moves, shallowest first so folder moves carry their children.
		const moves = [...this.disk.values()]
			.filter((r) => view.has(r.id) && view.get(r.id) !== r.path)
			.sort((a, b) => depth(a.path) - depth(b.path));
		for (const rec of moves) {
			const current = this.diskById.get(rec.id);
			const target = view.get(rec.id);
			if (!current || target === undefined || current.path === target) continue;
			if (!this.parentBound(rec.id)) continue;
			if (await this.moveOnDisk(current, target)) progress = true;
		}

		// 2. Deletes: indexed entries that are no longer live. Files first, then empty folders.
		const deletions = [...this.disk.values()].filter((r) => !view.has(r.id)).sort((a, b) => depth(b.path) - depth(a.path));
		for (const rec of deletions) if (await this.remoteDelete(rec)) progress = true;

		// 3. Creates: live entries with nothing on disk yet. Folders first.
		const creates = [...view.entries()].filter(([id]) => !this.diskById.has(id)).sort((a, b) => depth(a[1]) - depth(b[1]));
		for (const [id, rel] of creates) {
			const entry = this.viewEntry(id);
			if (!entry || !SYNCED_KINDS.has(entry.kind)) continue;
			// One of our pending creates is about to be adopted into this entry: materializing it
			// now would put a second local copy next to ours. Wait for the server's answer.
			if (this.awaitingAdoption(entry)) continue;
			// Children only go into a parent that is bound here (never into a same-named stranger).
			if (!this.parentBound(id)) continue;
			if (await this.materialize(entry, rel)) progress = true;
		}
		return progress;
	}

	/** True when the entry's parent (in the local view) is the root or has a local record. */
	private parentBound(id: string): boolean {
		const parent = this.viewEntry(id)?.parent;
		return parent === ROOT_ID || (parent !== undefined && this.diskById.has(parent));
	}

	/** True when a pending create of ours will be adopted into `entry` by the server. */
	private awaitingAdoption(entry: TreeEntry): boolean {
		if (entry.kind !== "folder" && !TEXT_KINDS.has(entry.kind)) return false;
		const key = nameKey(entry.name);
		for (const p of this.pending.values()) {
			const op = p.op;
			if (op.t !== "create" || op.noAdopt || op.kind !== entry.kind || op.id === entry.id) continue;
			if ((this.aliases.get(op.parent) ?? op.parent) === entry.parent && nameKey(op.name) === key) return true;
		}
		return false;
	}

	/** Returns true when the index changed. */
	private async moveOnDisk(rec: DiskRecord, target: string): Promise<boolean> {
		this.log("debug", "disk.move", { id: rec.id, from: rec.path, to: target });
		const holder = this.disk.get(target);
		if (holder && holder.id !== rec.id) return false; // wait until the holder moves away
		const from = this.vaultPath(rec.path);
		const to = this.vaultPath(target);
		const occupied = await this.vault.stat(to);
		if (occupied) {
			// An unindexed local item sits there (its create event is still queued, or it is
			// untracked). Wait; once it is indexed the server sorts out the name.
			this.log("info", "move.target_occupied", { from: rec.path, to: target });
			this.held.set(target, "a local file already uses this name");
			return false;
		}
		const fromStat = await this.vault.stat(from);
		if (!fromStat) {
			this.scheduleRescan("move source vanished");
			return false;
		}
		if (!(await this.parentReady(target))) return false;
		this.ownRenames.add(`${from}\u0000${to}`);
		if (rec.kind === "folder") {
			for (const d of this.descendants(rec.path)) {
				this.ownRenames.add(`${this.vaultPath(d.path)}\u0000${this.vaultPath(rebase(d.path, rec.path, target))}`);
			}
		}
		await this.vault.rename(from, to);
		if (rec.kind === "folder") {
			for (const d of this.descendants(rec.path)) await this.saveRec({ ...d, path: rebase(d.path, rec.path, target) }, d.path);
		}
		await this.saveRec({ ...rec, path: target }, rec.path);
		this.held.delete(target);
		return true;
	}

	/**
	 * True when the parent folder of `rel` exists on disk. An indexed folder that vanished
	 * means an external change we have not processed yet: never recreate it, rescan instead.
	 */
	private async parentReady(rel: string): Promise<boolean> {
		const parentRel = dirname(rel);
		if (parentRel === "") return true;
		const stat = await this.vault.stat(this.vaultPath(parentRel));
		if (stat?.isFolder) return true;
		if (stat || this.disk.has(parentRel)) {
			this.scheduleRescan(`parent ${parentRel} is missing or not a folder`);
			return false;
		}
		// Parent is not indexed yet (materialized later in this pass): defer to the next pass.
		return false;
	}

	/** Returns true when the index changed. */
	private async remoteDelete(rec: DiskRecord): Promise<boolean> {
		this.log("debug", "disk.delete", { id: rec.id, path: rec.path });
		const vp = this.vaultPath(rec.path);
		const stat = await this.vault.stat(vp);
		if (!stat) {
			await this.dropRec(rec);
			await this.store.lcaDelete(rec.id);
			return true;
		}
		if (rec.kind === "folder") {
			// Indexed children still inside (moving out later in this pass) keep it for now.
			if (this.descendants(rec.path).length > 0) return false;
			const children = (await this.vault.list(vp)).filter((e) => e.path !== vp);
			if (children.length > 0) {
				// Untracked local files are inside: keep the folder (and the files) locally.
				await this.dropRec(rec);
				return true;
			}
			this.ownDeletes.add(vp);
			await this.vault.trash(vp);
			await this.dropRec(rec);
			return true;
		}
		const content = await this.read(vp);
		if (!content) {
			await this.dropRec(rec);
			await this.store.lcaDelete(rec.id);
			return true;
		}
		const hash = hashText(content.text);
		if (rec.hash !== null && hash === rec.hash) {
			this.ownDeletes.add(vp);
			await this.vault.trash(vp);
			await this.dropRec(rec);
			await this.store.lcaDelete(rec.id);
			// Keep the CRDT state: a delete can be undone (edits beat deletes), and the revived
			// entry arrives as a tree event without its content.
			return true;
		}
		// Changed here since the last sync: the edit wins over the remote delete.
		if ([...this.pending.values()].some((p) => p.op.t === "revive" && p.op.id === rec.id)) return false;
		this.deps.notify?.({ kind: "restored", path: rec.path, reason: "you changed it after it was deleted on another device" });
		await this.queueOp({ t: "revive", opId: randomId(12), id: rec.id }, "revive");
		this.markDirty(rec.id);
		return true;
	}

	/** Returns true when the index changed. */
	private async materialize(entry: TreeEntry, rel: string): Promise<boolean> {
		// Never let two entries share one disk path: another entry (typically one of our pending
		// moves) holds it until the server answers, then this runs again.
		const holder = this.disk.get(rel);
		this.log("debug", "disk.materialize", { id: entry.id, path: rel, heldBy: holder && holder.id !== entry.id ? holder.id : null });
		if (holder && holder.id !== entry.id) return false;
		const vp = this.vaultPath(rel);
		const stat = await this.vault.stat(vp);
		if (entry.kind === "folder") {
			if (!stat) {
				if (!(await this.parentReady(rel))) return false;
				this.ownCreates.add(vp);
				try {
					await this.vault.mkdir(vp);
				} catch (err) {
					this.ownCreates.delete(vp);
					// Someone created it meanwhile; a folder is a folder.
					if (!(await this.vault.stat(vp))?.isFolder) throw err;
				}
			} else if (!stat.isFolder) {
				this.held.set(rel, "a local file has the same name as a shared folder");
				return false;
			}
			await this.saveRec({ path: rel, id: entry.id, kind: "folder", hash: null, mtime: 0, size: 0, format: DEFAULT_FORMAT });
			return true;
		}
		if (stat) return this.linkExisting(entry, rel, stat);
		if (!(await this.parentReady(rel))) return false;
		const doc = await this.getDoc(entry.id);
		if (Y.encodeStateVector(doc).length <= 1 && !this.pulledEmpty.has(entry.id)) {
			// Never written anything for this doc here: fetch it before creating the file, so a
			// revived or re-shared note is not materialized empty.
			if (this.welcome) {
				this.pulledEmpty.add(entry.id);
				this.requestPull(entry.id);
			}
			return false;
		}
		const text = doc.getText(TEXT_ROOT).toString();
		const hash = hashText(text);
		this.ownCreates.add(vp);
		try {
			await this.vault.createText(vp, toDisk(text, DEFAULT_FORMAT));
		} catch (err) {
			this.ownCreates.delete(vp);
			// A local file appeared at this path while we were preparing the write.
			const now = await this.vault.stat(vp);
			if (now) return this.linkExisting(entry, rel, now);
			throw err;
		}
		const written = await this.vault.stat(vp);
		await this.saveRec({ path: rel, id: entry.id, kind: entry.kind, hash, mtime: written?.mtime ?? 0, size: written?.size ?? 0, format: DEFAULT_FORMAT, seenSeq: this.docSeq.get(entry.id) ?? 0 });
		await this.store.lcaPut(entry.id, { text, hash });
		return true;
	}

	/** An unindexed local file already sits where a shared file belongs: link and merge two-way. */
	private async linkExisting(entry: TreeEntry, rel: string, stat: { isFolder: boolean; mtime: number; size: number }): Promise<boolean> {
		if (stat.isFolder) {
			this.held.set(rel, "a local folder has the same name as a shared file");
			return false;
		}
		await this.saveRec({ path: rel, id: entry.id, kind: entry.kind, hash: null, mtime: stat.mtime, size: stat.size, format: DEFAULT_FORMAT });
		await this.store.lcaDelete(entry.id);
		this.markDirty(entry.id);
		return true;
	}

	// ------------------------------------------------------------------ documents

	/** Loads (or returns) the local Y.Doc for a content entry. */
	getDoc(docId: string): Promise<Y.Doc> {
		const warm = this.docs.get(docId);
		if (warm) return Promise.resolve(warm);
		let loading = this.docLoads.get(docId);
		if (!loading) {
			loading = this.loadDoc(docId).finally(() => this.docLoads.delete(docId));
			this.docLoads.set(docId, loading);
		}
		return loading;
	}

	private async loadDoc(docId: string): Promise<Y.Doc> {
		const doc = new Y.Doc({ guid: docId });
		const updates = await this.store.loadDoc(docId);
		if (updates.length > 0) {
			Y.applyUpdate(doc, updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates), REMOTE);
			if (updates.length > DOC_COMPACT_UPDATES) await this.store.replaceDoc(docId, Y.encodeStateAsUpdate(doc));
		}
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			void this.store.appendDoc(docId, update);
			if (origin !== REMOTE) this.addToBatch(docId, update);
		});
		this.docs.set(docId, doc);
		this.evictDocs();
		return doc;
	}

	private evictDocs(): void {
		if (this.docs.size <= MAX_WARM_DOCS) return;
		for (const [id, doc] of this.docs) {
			if (this.docs.size <= MAX_WARM_DOCS) break;
			if (this.deps.editor?.isBound(id) || this.dirty.has(id) || this.inflight.has(id) || this.batch.has(id)) continue;
			this.docs.delete(id);
			doc.destroy();
		}
	}

	private async dropDoc(docId: string): Promise<void> {
		const doc = this.docs.get(docId);
		if (doc) {
			this.docs.delete(docId);
			doc.destroy();
		}
		await this.store.deleteDoc(docId);
	}

	/** Document id behind a vault path, for the editor binding. */
	docIdForPath(vaultPath: string): string | null {
		const rel = this.relPath(vaultPath);
		if (rel === null) return null;
		const rec = this.disk.get(rel);
		return rec && rec.kind !== "folder" ? rec.id : null;
	}

	private async applyRemote(docId: string, update: Uint8Array): Promise<void> {
		const doc = await this.getDoc(docId);
		Y.applyUpdate(doc, update, REMOTE);
		if (this.diskById.has(docId)) this.markDirty(docId);
		else if (this.catchup?.done) await this.syncStructure();
	}

	private async seedDoc(docId: string): Promise<void> {
		const rec = this.diskById.get(docId);
		if (!rec) return;
		const vp = this.vaultPath(rec.path);
		const stat = await this.vault.stat(vp);
		if (!stat) return;
		const content = await this.read(vp);
		if (!content) return;
		const { text, format } = content;
		const doc = await this.getDoc(docId);
		const ytext = doc.getText(TEXT_ROOT);
		const current = ytext.toString();
		if (current.length > 0 && current !== text) {
			// Someone else's content reached this doc first. The baseline must only ever be text
			// that is on disk, so leave it unset and let a two-way reconcile merge and write both.
			await this.store.lcaDelete(docId);
			await this.saveRec({ ...rec, hash: null, mtime: stat.mtime, size: stat.size, format });
			this.markDirty(docId);
			return;
		}
		if (current.length === 0) doc.transact(() => ytext.insert(0, text), DISK);
		const hash = hashText(text);
		await this.saveRec({ ...rec, hash, mtime: stat.mtime, size: stat.size, format, seenSeq: this.docSeq.get(docId) ?? 0 });
		await this.store.lcaPut(docId, { text, hash });
	}

	// ------------------------------------------------------------------ outbox

	private addToBatch(docId: string, update: Uint8Array): void {
		const list = this.batch.get(docId) ?? [];
		list.push(update);
		this.batch.set(docId, list);
		if (this.batchTimer === null) {
			this.batchTimer = this.clock.setTimeout(() => {
				this.batchTimer = null;
				void this.enqueue("flush.batch", () => this.flushBatch());
			}, OUTBOX_BATCH_MS);
		}
	}

	private async flushBatch(): Promise<void> {
		if (this.batch.size === 0) return;
		const entries = [...this.batch];
		this.batch.clear();
		for (const [docId, updates] of entries) {
			const update = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
			const dseq = this.meta.nextDseq;
			await this.setMeta({ nextDseq: dseq + 1 });
			await this.store.outboxPut({ dseq, docId, update });
			this.unconfirmed++;
			if (this.welcome && !this.welcome.readOnly) this.socket.send({ type: "update", dseq, docId, update });
		}
	}

	// ------------------------------------------------------------------ reconcile (disk ↔ CRDT)

	markDirty(docId: string): void {
		this.dirty.add(docId);
		if (this.reconcileTimer !== null) return;
		this.reconcileTimer = this.clock.setTimeout(() => {
			this.reconcileTimer = null;
			const ids = [...this.dirty];
			this.dirty.clear();
			void this.enqueue("reconcile", async () => {
				for (const id of ids) await this.reconcile(id);
			});
		}, RECONCILE_DEBOUNCE_MS);
	}

	/**
	 * Three-way reconcile of one closed document. D = disk, C = CRDT, B = last agreed (LCA).
	 * Writes use compare-and-swap so a concurrent edit on disk is never overwritten.
	 */
	private async reconcile(docId: string): Promise<void> {
		const rec = this.diskById.get(docId);
		if (!rec || rec.kind === "folder") return;
		if (this.deps.editor?.isBound(docId)) return; // the editor binding is the writer
		// Content is seeded only after the server admits the create (enrolment once).
		for (const p of this.pending.values()) if (p.op.t === "create" && p.op.id === docId) return;
		const vp = this.vaultPath(rec.path);
		const stat = await this.vault.stat(vp);
		if (!stat || stat.isFolder) return;
		const content = await this.read(vp);
		if (!content) return;
		const { text: D, format } = content;
		const doc = await this.getDoc(docId);
		const ytext = doc.getText(TEXT_ROOT);
		const C = ytext.toString();
		const lca = await this.store.lcaGet(docId);
		const readOnly = this.welcome?.readOnly ?? false;

		if (D === C) {
			const hash = hashText(D);
			if (!lca || lca.hash !== hash) await this.store.lcaPut(docId, { text: D, hash });
			await this.saveRec({ ...rec, hash, mtime: stat.mtime, size: stat.size, format, seenSeq: this.docSeq.get(rec.id) ?? 0 });
			return;
		}

		let M: string;
		let conflicts = 0;
		if (!lca) {
			const r = merge2(D, C);
			M = r.text;
			conflicts = r.conflicts;
		} else if (D === lca.text) {
			M = C; // remote ahead
		} else if (C === lca.text) {
			M = D; // disk ahead
		} else {
			const r = merge3(lca.text, D, C);
			M = r.text;
			conflicts = r.conflicts;
		}

		if (readOnly && lca && D !== lca.text) {
			// A viewer's local edits stay a local divergence: never pushed, never overwritten.
			this.held.set(rec.path, "read-only share: local changes are not synced");
			return;
		}
		this.log("debug", "reconcile", { id: docId, path: rec.path, disk: D.slice(0, 200), crdt: C.slice(0, 200), lca: lca ? lca.text.slice(0, 200) : null, merged: M.slice(0, 200), conflicts });
		if (M !== C && !readOnly) patchYText(ytext, C, M, DISK);
		const merged = readOnly ? C : ytext.toString();
		if (merged !== D) {
			const expectedHash = hashText(D);
			const wrote = await this.vault
				.process(vp, (current) => {
					// Only write if the disk still holds what we merged from.
					return canonicalize(current).text === D ? toDisk(merged, format) : null;
				})
				.catch(() => false);
			if (!wrote) {
				this.log("info", "reconcile.disk_changed", { path: rec.path, expectedHash });
				this.markDirty(docId);
				return;
			}
		}
		const hash = hashText(merged);
		const after = await this.vault.stat(vp);
		await this.store.lcaPut(docId, { text: merged, hash });
		await this.saveRec({ ...rec, hash, mtime: after?.mtime ?? stat.mtime, size: after?.size ?? stat.size, format, seenSeq: this.docSeq.get(docId) ?? 0 });
		if (conflicts > 0) {
			this.deps.notify?.({ kind: "review", path: rec.path, detail: `${conflicts} overlapping change${conflicts === 1 ? "" : "s"} merged; both versions kept` });
		}
	}

	/** Called by the editor binding after Obsidian saved a bound file: disk == CRDT. */
	async noteSaved(docId: string): Promise<void> {
		await this.enqueue("editor.saved", async () => {
			const rec = this.diskById.get(docId);
			if (!rec) return;
			const vp = this.vaultPath(rec.path);
			const stat = await this.vault.stat(vp);
			if (!stat) return;
			const content = await this.read(vp);
			if (!content) return;
			const { text, format } = content;
			const doc = await this.getDoc(docId);
			if (doc.getText(TEXT_ROOT).toString() !== text) return;
			const hash = hashText(text);
			await this.store.lcaPut(docId, { text, hash });
			await this.saveRec({ ...rec, hash, mtime: stat.mtime, size: stat.size, format, seenSeq: this.docSeq.get(rec.id) ?? 0 });
		});
	}

	/** Reconciles a document now (the editor binding calls this before binding). */
	reconcileNow(docId: string): Promise<void> {
		return this.enqueue("reconcile.now", () => this.reconcile(docId));
	}

	/** Diagnostics: what this device believes about a share-relative path. */
	async inspect(rel: string): Promise<{ recId: string | null; recHash: string | null; confirmedId: string | null; crdt: string | null; lca: string | null; pending: string[] }> {
		const rec = this.disk.get(rel) ?? null;
		const confirmedId = this.confirmedPaths().get(rel) ?? null;
		const id = rec?.id ?? confirmedId;
		const crdt = id ? (await this.getDoc(id)).getText(TEXT_ROOT).toString() : null;
		const lca = id ? ((await this.store.lcaGet(id))?.text ?? null) : null;
		const pending = [...this.pending.values()].filter((p) => p.op.id === id).map((p) => p.op.t);
		return { recId: rec?.id ?? null, recHash: rec?.hash ?? null, confirmedId, crdt, lca, pending };
	}

	/** Snapshot of confirmed live entries with their paths (diagnostics and tests). */
	confirmedPaths(): Map<string, string> {
		const out = new Map<string, string>();
		for (const e of this.confirmed.live()) {
			const p = entryPath(this.confirmed, e.id);
			if (p !== null) out.set(p, e.id);
		}
		return out;
	}

	/** Exposed for diagnostics: page size of catch-up heads. */
	static readonly limits = LIMITS;
}
