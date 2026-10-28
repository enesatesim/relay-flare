// The folder tree of a share. The server sequences every operation (one folder-wide seq
// space shared with document heads) and is the only writer of confirmed state.

export const ROOT_ID = "root";

export type Kind = "folder" | "markdown" | "text" | "canvas" | "blob";

export const TEXT_KINDS: ReadonlySet<Kind> = new Set<Kind>(["markdown", "text"]);
export const CONTENT_DOC_KINDS: ReadonlySet<Kind> = new Set<Kind>(["markdown", "text", "canvas"]);

export interface BlobRef {
	sha: string;
	size: number;
}

export interface TreeEntry {
	id: string;
	parent: string;
	name: string;
	kind: Kind;
	blob: BlobRef | null;
	createdBy: string;
	createdSeq: number;
	updatedSeq: number;
	deletedSeq: number | null;
	/** Device whose op produced this state. Only other devices' changes beat a delete. */
	updatedBy?: string;
}

interface OpBase {
	opId: string;
}

export interface CreateOp extends OpBase {
	t: "create";
	id: string;
	parent: string;
	name: string;
	kind: Kind;
	blob?: BlobRef | null;
	/**
	 * Never adopt an equivalent sibling; take a conflict name instead. Set when this device
	 * already backs the existing entry with another local file.
	 */
	noAdopt?: boolean;
}

export interface MoveOp extends OpBase {
	t: "move";
	id: string;
	parent: string;
	name: string;
	/** Where the client believed the entry was when it moved it. */
	expect: { parent: string; name: string };
	baseSeq: number;
}

export interface DeleteOp extends OpBase {
	t: "delete";
	id: string;
	/** The newest seq the client had seen for this entry (tree and content). */
	baseSeq: number;
	/**
	 * Server seq of the content the deleting device actually had on disk. Content changes by
	 * others after it were never seen by the deleter, so they beat the delete.
	 */
	contentSeq?: number;
}

export interface SetBlobOp extends OpBase {
	t: "setBlob";
	id: string;
	blob: BlobRef;
	/** The blob sha the client edited from; null for a first upload. */
	baseSha: string | null;
}

export interface ReviveOp extends OpBase {
	t: "revive";
	id: string;
}

export type TreeOp = CreateOp | MoveOp | DeleteOp | SetBlobOp | ReviveOp;

export type RejectReason =
	| "invalid-name"
	| "forbidden"
	| "not-found"
	| "deleted"
	| "parent-missing"
	| "parent-not-folder"
	| "cycle"
	| "stale"
	| "edited"
	| "kind-mismatch"
	| "id-taken";

export type TreeResult =
	| { r: "ok"; seq: number; entry: TreeEntry }
	/** A create collided with an equivalent sibling: use the existing entry instead. */
	| { r: "adopted"; existing: TreeEntry }
	/** The name was taken, so a deterministic conflict name was used. */
	| { r: "renamed"; seq: number; entry: TreeEntry }
	/** A blob update lost a race; the late version was kept as a sibling copy. */
	| { r: "conflictCopy"; seq: number; entry: TreeEntry; current: TreeEntry }
	/** A folder delete removed only the descendants nobody touched since baseSeq. */
	| { r: "partial"; seq: number; deleted: string[]; kept: string[] }
	| { r: "rejected"; reason: RejectReason; current: TreeEntry | null };

/** A confirmed change: the full entry state after a write. Idempotent to apply. */
export interface TreeEvent {
	seq: number;
	entry: TreeEntry;
}

export function isLive(e: TreeEntry | null | undefined): boolean {
	return !!e && e.deletedSeq === null;
}

export function sameEntry(a: TreeEntry, b: TreeEntry): boolean {
	return (
		a.id === b.id &&
		a.parent === b.parent &&
		a.name === b.name &&
		a.kind === b.kind &&
		a.deletedSeq === b.deletedSeq &&
		(a.blob?.sha ?? null) === (b.blob?.sha ?? null) &&
		(a.blob?.size ?? null) === (b.blob?.size ?? null)
	);
}
