import type { Kind, TreeEntry, TreeOp } from "@shared/tree/types";
import type { DiskFormat } from "./text";

// Per-share, per-device persistent state. The plugin implements it over IndexedDB (one
// database per share); tests use MemoryStore. Nothing here ever lives in data.json.

export interface DiskRecord {
	/** Path relative to the share root. */
	path: string;
	id: string;
	kind: Kind;
	/** Hash of the canonical content last seen on disk (text) or the blob sha. */
	hash: string | null;
	mtime: number;
	size: number;
	format: DiskFormat;
	/** Server seq of the content last materialized on this disk (what a delete here has seen). */
	seenSeq?: number;
}

export interface Lca {
	text: string;
	hash: string;
}

export interface OutboxItem {
	dseq: number;
	docId: string;
	update: Uint8Array;
}

export interface PendingOp {
	op: TreeOp;
	/** Local bookkeeping for what to do when the result arrives. */
	intent: "create" | "mkdir" | "move" | "delete" | "revive";
	at: number;
}

export interface ShareMeta {
	cursor: number;
	epoch: string | null;
	nextDseq: number;
	/** Set once the first full catch-up completed (the device has seen the whole share). */
	caughtUp: boolean;
}

export interface ShareStore {
	getMeta(): Promise<ShareMeta>;
	setMeta(patch: Partial<ShareMeta>): Promise<void>;

	loadDoc(docId: string): Promise<Uint8Array[]>;
	appendDoc(docId: string, update: Uint8Array): Promise<void>;
	replaceDoc(docId: string, state: Uint8Array): Promise<void>;
	deleteDoc(docId: string): Promise<void>;

	outboxAll(): Promise<OutboxItem[]>;
	outboxPut(item: OutboxItem): Promise<void>;
	outboxDrop(upToDseq: number): Promise<void>;

	treeAll(): Promise<TreeEntry[]>;
	treePut(entries: TreeEntry[]): Promise<void>;
	treeClear(): Promise<void>;

	opsAll(): Promise<PendingOp[]>;
	opPut(op: PendingOp): Promise<void>;
	opDelete(opId: string): Promise<void>;

	diskAll(): Promise<DiskRecord[]>;
	diskPut(rec: DiskRecord): Promise<void>;
	diskDelete(path: string): Promise<void>;

	lcaGet(docId: string): Promise<Lca | undefined>;
	lcaPut(docId: string, lca: Lca): Promise<void>;
	lcaDelete(docId: string): Promise<void>;
}

export const DEFAULT_META: ShareMeta = { cursor: 0, epoch: null, nextDseq: 1, caughtUp: false };

/** In-memory store for tests and the simulation. `wipe()` simulates IndexedDB eviction. */
export class MemoryStore implements ShareStore {
	meta: ShareMeta = { ...DEFAULT_META };
	docs = new Map<string, Uint8Array[]>();
	outbox = new Map<number, OutboxItem>();
	tree = new Map<string, TreeEntry>();
	ops = new Map<string, PendingOp>();
	disk = new Map<string, DiskRecord>();
	lcas = new Map<string, Lca>();

	wipe(): void {
		this.meta = { ...DEFAULT_META };
		this.docs.clear();
		this.outbox.clear();
		this.tree.clear();
		this.ops.clear();
		this.disk.clear();
		this.lcas.clear();
	}

	async getMeta() {
		return { ...this.meta };
	}
	async setMeta(patch: Partial<ShareMeta>) {
		this.meta = { ...this.meta, ...patch };
	}
	async loadDoc(docId: string) {
		return [...(this.docs.get(docId) ?? [])];
	}
	async appendDoc(docId: string, update: Uint8Array) {
		const list = this.docs.get(docId) ?? [];
		list.push(update);
		this.docs.set(docId, list);
	}
	async replaceDoc(docId: string, state: Uint8Array) {
		this.docs.set(docId, [state]);
	}
	async deleteDoc(docId: string) {
		this.docs.delete(docId);
	}
	async outboxAll() {
		return [...this.outbox.values()].sort((a, b) => a.dseq - b.dseq);
	}
	async outboxPut(item: OutboxItem) {
		this.outbox.set(item.dseq, item);
	}
	async outboxDrop(upTo: number) {
		for (const k of [...this.outbox.keys()]) if (k <= upTo) this.outbox.delete(k);
	}
	async treeAll() {
		return [...this.tree.values()];
	}
	async treePut(entries: TreeEntry[]) {
		for (const e of entries) this.tree.set(e.id, e);
	}
	async treeClear() {
		this.tree.clear();
	}
	async opsAll() {
		return [...this.ops.values()].sort((a, b) => a.at - b.at);
	}
	async opPut(op: PendingOp) {
		this.ops.set(op.op.opId, op);
	}
	async opDelete(opId: string) {
		this.ops.delete(opId);
	}
	async diskAll() {
		return [...this.disk.values()];
	}
	async diskPut(rec: DiskRecord) {
		this.disk.set(rec.path, { ...rec });
	}
	async diskDelete(path: string) {
		this.disk.delete(path);
	}
	async lcaGet(docId: string) {
		return this.lcas.get(docId);
	}
	async lcaPut(docId: string, lca: Lca) {
		this.lcas.set(docId, lca);
	}
	async lcaDelete(docId: string) {
		this.lcas.delete(docId);
	}
}
