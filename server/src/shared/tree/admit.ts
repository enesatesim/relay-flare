import { conflictName, nameKey, normalizeName, validateName } from "./names";
import {
	isLive,
	ROOT_ID,
	TEXT_KINDS,
	type CreateOp,
	type DeleteOp,
	type MoveOp,
	type ReviveOp,
	type SetBlobOp,
	type TreeEntry,
	type TreeOp,
	type TreeResult,
} from "./types";

/**
 * Read access to the confirmed tree. The server implements it over SQLite; tests and the
 * simulation implement it in memory. Implementations guarantee that live siblings have
 * unique name keys.
 */
export interface TreeReader {
	get(id: string): TreeEntry | null;
	liveChildByKey(parent: string, key: string): TreeEntry | null;
	liveChildren(parent: string): TreeEntry[];
	/**
	 * Newest seq at which the entry's content changed, or 0. With `exceptDevice`, changes by
	 * that device are ignored (a device's own edits never beat its own delete).
	 */
	docHeadSeq(id: string, exceptDevice?: string): number;
}

export interface AdmitContext {
	deviceId: string;
	/** Human-readable device label, used in conflict names. */
	deviceLabel: string;
	now: number;
	/** The seq every write of this admission gets. Consumed only if there are writes. */
	seq: number;
	/** Mints ids for entries the server creates itself (conflict copies). */
	mintId(): string;
}

export interface Admission {
	result: TreeResult;
	/** Full entry states to persist, in order. Empty when nothing changed. */
	writes: TreeEntry[];
}

/**
 * Deterministic admission of one tree operation against the confirmed tree. The caller
 * has already rejected viewers. Never mutates `reader`; returns the writes to apply.
 */
export function admit(op: TreeOp, reader: TreeReader, ctx: AdmitContext): Admission {
	const tx = new Overlay(reader);
	let result: TreeResult;
	switch (op.t) {
		case "create":
			result = admitCreate(op, tx, ctx);
			break;
		case "move":
			result = admitMove(op, tx, ctx);
			break;
		case "delete":
			result = admitDelete(op, tx, ctx);
			break;
		case "setBlob":
			result = admitSetBlob(op, tx, ctx);
			break;
		case "revive":
			result = admitRevive(op, tx, ctx);
			break;
	}
	if (result.r === "rejected" || result.r === "adopted") return { result, writes: [] };
	const writes = tx.ordered();
	// Every write of this admission is fresh: stamp who caused it.
	for (const w of writes) w.updatedBy = ctx.deviceId;
	return { result, writes };
}

/** A reader with this admission's pending writes layered on top. */
class Overlay implements TreeReader {
	private writes = new Map<string, TreeEntry>();
	private order: string[] = [];

	constructor(private base: TreeReader) {}

	put(e: TreeEntry): void {
		if (!this.writes.has(e.id)) this.order.push(e.id);
		this.writes.set(e.id, e);
	}

	ordered(): TreeEntry[] {
		return this.order.map((id) => this.writes.get(id)!);
	}

	get(id: string): TreeEntry | null {
		return this.writes.get(id) ?? this.base.get(id);
	}

	liveChildByKey(parent: string, key: string): TreeEntry | null {
		for (const w of this.writes.values()) {
			if (isLive(w) && w.parent === parent && nameKey(w.name) === key) return w;
		}
		const b = this.base.liveChildByKey(parent, key);
		if (b && this.writes.has(b.id)) return null; // moved, renamed or deleted in this admission
		return b;
	}

	liveChildren(parent: string): TreeEntry[] {
		const out = new Map<string, TreeEntry>();
		for (const b of this.base.liveChildren(parent)) out.set(b.id, b);
		for (const w of this.writes.values()) {
			if (isLive(w) && w.parent === parent) out.set(w.id, w);
			else out.delete(w.id);
		}
		return [...out.values()];
	}

	docHeadSeq(id: string, exceptDevice?: string): number {
		return this.base.docHeadSeq(id, exceptDevice);
	}
}

function reject(reason: Extract<TreeResult, { r: "rejected" }>["reason"], current: TreeEntry | null): TreeResult {
	return { r: "rejected", reason, current };
}

/** Free name in `parent` for `name`, suffixing deterministically when taken by someone else. */
function freeName(tx: Overlay, ctx: AdmitContext, parent: string, name: string, isFolder: boolean, self: string | null) {
	const holder = tx.liveChildByKey(parent, nameKey(name));
	if (!holder || holder.id === self) return { name, renamed: false };
	const taken = (key: string) => {
		const h = tx.liveChildByKey(parent, key);
		return !!h && h.id !== self;
	};
	return { name: conflictName(name, isFolder, ctx.deviceLabel, ctx.now, taken), renamed: true };
}

/**
 * Makes `folderId` and all its ancestors live, reviving deleted ones top-down. Returns
 * false when the chain is broken (missing entry or a non-folder in the chain).
 */
function reviveChain(tx: Overlay, ctx: AdmitContext, folderId: string): boolean {
	const chain: TreeEntry[] = [];
	let id = folderId;
	const seen = new Set<string>();
	while (id !== ROOT_ID) {
		if (seen.has(id)) return false;
		seen.add(id);
		const e = tx.get(id);
		if (!e || e.kind !== "folder") return false;
		chain.push(e);
		id = e.parent;
	}
	for (const e of chain.reverse()) {
		if (isLive(e)) continue;
		const { name } = freeName(tx, ctx, e.parent, e.name, true, e.id);
		tx.put({ ...e, name, deletedSeq: null, updatedSeq: ctx.seq });
	}
	return true;
}

function admitCreate(op: CreateOp, tx: Overlay, ctx: AdmitContext): TreeResult {
	const name = normalizeName(op.name);
	if (validateName(name)) return reject("invalid-name", null);
	const existing = tx.get(op.id);
	if (existing) {
		// Idempotent resend of an already-admitted create.
		if (isLive(existing) && existing.parent === op.parent && existing.kind === op.kind) {
			return { r: "ok", seq: existing.updatedSeq, entry: existing };
		}
		return reject("id-taken", existing);
	}
	if (op.parent !== ROOT_ID) {
		const parent = tx.get(op.parent);
		if (!parent) return reject("parent-missing", null);
		if (parent.kind !== "folder") return reject("parent-not-folder", parent);
	}
	if (!reviveChain(tx, ctx, op.parent)) return reject("parent-missing", null);

	const holder = tx.liveChildByKey(op.parent, nameKey(name));
	if (holder) {
		const sameText = TEXT_KINDS.has(op.kind) && holder.kind === op.kind;
		const sameFolder = op.kind === "folder" && holder.kind === "folder";
		const sameBlob = op.kind === "blob" && holder.kind === "blob" && !!op.blob && holder.blob?.sha === op.blob.sha;
		if (!op.noAdopt && (sameText || sameFolder || sameBlob)) return { r: "adopted", existing: holder };
	}
	const free = freeName(tx, ctx, op.parent, name, op.kind === "folder", null);
	const entry: TreeEntry = {
		id: op.id,
		parent: op.parent,
		name: free.name,
		kind: op.kind,
		blob: op.kind === "blob" ? (op.blob ?? null) : null,
		createdBy: ctx.deviceId,
		createdSeq: ctx.seq,
		updatedSeq: ctx.seq,
		deletedSeq: null,
	};
	tx.put(entry);
	return free.renamed ? { r: "renamed", seq: ctx.seq, entry } : { r: "ok", seq: ctx.seq, entry };
}

function admitMove(op: MoveOp, tx: Overlay, ctx: AdmitContext): TreeResult {
	const current = tx.get(op.id);
	if (!current) return reject("not-found", null);
	if (!isLive(current)) return reject("deleted", current);
	const name = normalizeName(op.name);
	if (validateName(name)) return reject("invalid-name", current);
	if (current.parent === op.parent && current.name === name) return { r: "ok", seq: current.updatedSeq, entry: current };
	// First admitted move wins: a move based on a location that has since changed is stale.
	if (current.parent !== op.expect.parent || current.name !== normalizeName(op.expect.name)) {
		return reject("stale", current);
	}
	if (op.parent !== ROOT_ID) {
		const parent = tx.get(op.parent);
		if (!parent) return reject("parent-missing", current);
		if (parent.kind !== "folder") return reject("parent-not-folder", current);
		// The new parent must not be the entry itself or one of its descendants.
		let walk: string = op.parent;
		const seen = new Set<string>();
		while (walk !== ROOT_ID) {
			if (walk === op.id) return reject("cycle", current);
			if (seen.has(walk)) return reject("cycle", current);
			seen.add(walk);
			const e = tx.get(walk);
			if (!e) return reject("parent-missing", current);
			walk = e.parent;
		}
	}
	if (!reviveChain(tx, ctx, op.parent)) return reject("parent-missing", current);
	const free = freeName(tx, ctx, op.parent, name, current.kind === "folder", current.id);
	const entry: TreeEntry = { ...current, parent: op.parent, name: free.name, updatedSeq: ctx.seq };
	tx.put(entry);
	return free.renamed ? { r: "renamed", seq: ctx.seq, entry } : { r: "ok", seq: ctx.seq, entry };
}

/**
 * Changed by someone other than `device` after what the deleter had seen: `baseSeq` for the
 * tree, `contentSeq` for the content it actually had on disk.
 */
function touchedSince(e: TreeEntry, tx: Overlay, baseSeq: number, device: string, contentSeq = baseSeq): boolean {
	if (e.updatedSeq > baseSeq && e.updatedBy !== device) return true;
	return tx.docHeadSeq(e.id, device) > Math.min(baseSeq, contentSeq);
}

function admitDelete(op: DeleteOp, tx: Overlay, ctx: AdmitContext): TreeResult {
	const current = tx.get(op.id);
	if (!current) return reject("not-found", null);
	if (!isLive(current)) return { r: "ok", seq: current.deletedSeq!, entry: current };
	if (current.kind !== "folder") {
		// Edits beat deletes: anything changed after what the deleter saw survives.
		if (touchedSince(current, tx, op.baseSeq, ctx.deviceId, op.contentSeq)) return reject("edited", current);
		const entry = { ...current, deletedSeq: ctx.seq, updatedSeq: ctx.seq };
		tx.put(entry);
		return { r: "ok", seq: ctx.seq, entry };
	}
	const deleted: string[] = [];
	const kept: string[] = [];
	const visit = (e: TreeEntry): boolean => {
		let allGone = true;
		if (e.kind === "folder") {
			for (const child of tx.liveChildren(e.id)) {
				if (!visit(child)) allGone = false;
			}
		}
		const removable = allGone && !touchedSince(e, tx, op.baseSeq, ctx.deviceId);
		if (removable) {
			tx.put({ ...e, deletedSeq: ctx.seq, updatedSeq: ctx.seq });
			deleted.push(e.id);
		} else {
			kept.push(e.id);
		}
		return removable;
	};
	const gone = visit(current);
	if (gone) return { r: "ok", seq: ctx.seq, entry: tx.get(current.id)! };
	if (deleted.length === 0) return reject("edited", current);
	return { r: "partial", seq: ctx.seq, deleted, kept };
}

function admitSetBlob(op: SetBlobOp, tx: Overlay, ctx: AdmitContext): TreeResult {
	const current = tx.get(op.id);
	if (!current) return reject("not-found", null);
	if (!isLive(current)) return reject("deleted", current);
	if (current.kind !== "blob") return reject("kind-mismatch", current);
	if (current.blob?.sha === op.blob.sha) return { r: "ok", seq: current.updatedSeq, entry: current };
	if ((current.blob?.sha ?? null) !== op.baseSha) {
		// Lost update: keep the version already at the path, preserve the late one beside it.
		const name = conflictName(current.name, false, ctx.deviceLabel, ctx.now, (key) => !!tx.liveChildByKey(current.parent, key));
		const entry: TreeEntry = {
			id: ctx.mintId(),
			parent: current.parent,
			name,
			kind: "blob",
			blob: op.blob,
			createdBy: ctx.deviceId,
			createdSeq: ctx.seq,
			updatedSeq: ctx.seq,
			deletedSeq: null,
		};
		tx.put(entry);
		return { r: "conflictCopy", seq: ctx.seq, entry, current };
	}
	const entry = { ...current, blob: op.blob, updatedSeq: ctx.seq };
	tx.put(entry);
	return { r: "ok", seq: ctx.seq, entry };
}

function admitRevive(op: ReviveOp, tx: Overlay, ctx: AdmitContext): TreeResult {
	const current = tx.get(op.id);
	if (!current) return reject("not-found", null);
	if (isLive(current)) return { r: "ok", seq: current.updatedSeq, entry: current };
	if (!reviveChain(tx, ctx, current.parent)) return reject("parent-missing", current);
	const free = freeName(tx, ctx, current.parent, current.name, current.kind === "folder", current.id);
	const entry = { ...current, name: free.name, deletedSeq: null, updatedSeq: ctx.seq };
	tx.put(entry);
	return free.renamed ? { r: "renamed", seq: ctx.seq, entry } : { r: "ok", seq: ctx.seq, entry };
}

/** In-memory TreeReader used by tests, the simulation and the client's confirmed tree. */
export class MemoryTree implements TreeReader {
	readonly entries = new Map<string, TreeEntry>();
	private byKey = new Map<string, string>();
	private children = new Map<string, Set<string>>();
	heads = new Map<string, number>();

	get(id: string): TreeEntry | null {
		return this.entries.get(id) ?? null;
	}

	liveChildByKey(parent: string, key: string): TreeEntry | null {
		const id = this.byKey.get(`${parent}\u0000${key}`);
		return id ? (this.entries.get(id) ?? null) : null;
	}

	liveChildren(parent: string): TreeEntry[] {
		const ids = this.children.get(parent);
		return ids ? [...ids].map((id) => this.entries.get(id)!) : [];
	}

	docHeadSeq(id: string): number {
		return this.heads.get(id) ?? 0;
	}

	apply(entry: TreeEntry): void {
		const prev = this.entries.get(entry.id);
		if (prev && isLive(prev)) {
			this.byKey.delete(`${prev.parent}\u0000${nameKey(prev.name)}`);
			this.children.get(prev.parent)?.delete(prev.id);
		}
		this.entries.set(entry.id, entry);
		if (isLive(entry)) {
			this.byKey.set(`${entry.parent}\u0000${nameKey(entry.name)}`, entry.id);
			let set = this.children.get(entry.parent);
			if (!set) this.children.set(entry.parent, (set = new Set()));
			set.add(entry.id);
		}
	}

	live(): TreeEntry[] {
		return [...this.entries.values()].filter(isLive);
	}
}

/** Path of a live entry relative to the share root, or null when its chain is broken. */
export function entryPath(reader: Pick<TreeReader, "get">, id: string): string | null {
	const parts: string[] = [];
	let walk = id;
	const seen = new Set<string>();
	while (walk !== ROOT_ID) {
		if (seen.has(walk)) return null;
		seen.add(walk);
		const e = reader.get(walk);
		if (!e || !isLive(e)) return null;
		parts.push(e.name);
		walk = e.parent;
	}
	return parts.reverse().join("/");
}
