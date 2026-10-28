import { describe, expect, it } from "vitest";
import { admit, entryPath, MemoryTree, type AdmitContext } from "@shared/tree/admit";
import { ROOT_ID, type TreeEntry, type TreeOp } from "@shared/tree/types";

let seq = 0;
let ids = 0;
function ctx(device = "dev-a"): AdmitContext {
	return { deviceId: device, deviceLabel: device === "dev-a" ? "Laptop" : "Phone", now: Date.UTC(2026, 9, 28, 14, 3), seq: ++seq, mintId: () => `minted-${++ids}` };
}

function run(tree: MemoryTree, op: TreeOp, device?: string) {
	const a = admit(op, tree, ctx(device));
	for (const w of a.writes) tree.apply(w);
	return a;
}

function create(tree: MemoryTree, id: string, parent: string, name: string, kind: TreeEntry["kind"] = "markdown", device?: string) {
	return run(tree, { t: "create", opId: `op-${id}-${seq}`, id, parent, name, kind }, device);
}

describe("tree admission", () => {
	it("creates entries and derives paths", () => {
		const t = new MemoryTree();
		expect(create(t, "f1", ROOT_ID, "Daily", "folder").result.r).toBe("ok");
		expect(create(t, "n1", "f1", "2026-10-28.md").result.r).toBe("ok");
		expect(entryPath(t, "n1")).toBe("Daily/2026-10-28.md");
	});

	it("rejects names that are invalid on any platform", () => {
		const t = new MemoryTree();
		for (const bad of ["a:b.md", "con.md", "trailing.", "trailing ", ".hidden", "q?.md", "x|y"]) {
			expect(create(t, `b-${bad}`, ROOT_ID, bad).result).toMatchObject({ r: "rejected", reason: "invalid-name" });
		}
	});

	it("adopts the existing note when two devices create the same daily note", () => {
		const t = new MemoryTree();
		create(t, "a", ROOT_ID, "2026-10-28.md", "markdown", "dev-a");
		const r = create(t, "b", ROOT_ID, "2026-10-28.md", "markdown", "dev-b");
		expect(r.result).toMatchObject({ r: "adopted", existing: { id: "a" } });
		expect(r.writes).toHaveLength(0);
	});

	it("treats case and Unicode normalization variants as the same name", () => {
		const t = new MemoryTree();
		create(t, "a", ROOT_ID, "Café.md");
		const decomposed = "Café.md".toUpperCase();
		const r = create(t, "b", ROOT_ID, decomposed, "markdown", "dev-b");
		expect(r.result.r).toBe("adopted");
	});

	it("merges concurrently created folders by adoption", () => {
		const t = new MemoryTree();
		create(t, "f1", ROOT_ID, "Projects", "folder", "dev-a");
		expect(create(t, "f2", ROOT_ID, "projects", "folder", "dev-b").result).toMatchObject({ r: "adopted", existing: { id: "f1" } });
	});

	it("suffixes a create whose kind differs from the holder", () => {
		const t = new MemoryTree();
		create(t, "f1", ROOT_ID, "Notes", "folder");
		const r = create(t, "b", ROOT_ID, "Notes", "blob", "dev-b");
		expect(r.result.r).toBe("renamed");
		expect(t.get("b")!.name).toBe("Notes (conflict, Phone, 2026-10-28 1403)");
	});

	it("rejects a stale move: first admitted move wins", () => {
		const t = new MemoryTree();
		create(t, "n", ROOT_ID, "a.md");
		const base = seq;
		expect(run(t, { t: "move", opId: "m1", id: "n", parent: ROOT_ID, name: "b.md", expect: { parent: ROOT_ID, name: "a.md" }, baseSeq: base }).result.r).toBe("ok");
		const late = run(t, { t: "move", opId: "m2", id: "n", parent: ROOT_ID, name: "c.md", expect: { parent: ROOT_ID, name: "a.md" }, baseSeq: base }, "dev-b");
		expect(late.result).toMatchObject({ r: "rejected", reason: "stale" });
		expect(t.get("n")!.name).toBe("b.md");
	});

	it("rejects moves that would create a cycle", () => {
		const t = new MemoryTree();
		create(t, "a", ROOT_ID, "A", "folder");
		create(t, "b", "a", "B", "folder");
		const r = run(t, { t: "move", opId: "m", id: "a", parent: "b", name: "A", expect: { parent: ROOT_ID, name: "A" }, baseSeq: seq });
		expect(r.result).toMatchObject({ r: "rejected", reason: "cycle" });
	});

	it("allows a case-only rename of the same entry", () => {
		const t = new MemoryTree();
		create(t, "n", ROOT_ID, "note.md");
		const r = run(t, { t: "move", opId: "m", id: "n", parent: ROOT_ID, name: "Note.md", expect: { parent: ROOT_ID, name: "note.md" }, baseSeq: seq });
		expect(r.result.r).toBe("ok");
		expect(t.get("n")!.name).toBe("Note.md");
	});

	it("lets an edit beat a concurrent delete", () => {
		const t = new MemoryTree();
		create(t, "n", ROOT_ID, "a.md");
		const seenByDeleter = seq;
		t.heads.set("n", seenByDeleter + 5); // someone edited after the deleter's view
		const r = run(t, { t: "delete", opId: "d", id: "n", baseSeq: seenByDeleter }, "dev-b");
		expect(r.result).toMatchObject({ r: "rejected", reason: "edited" });
		expect(t.get("n")!.deletedSeq).toBeNull();
	});

	it("deletes a folder but keeps children created after the deleter's view", () => {
		const t = new MemoryTree();
		create(t, "f", ROOT_ID, "F", "folder");
		create(t, "old", "f", "old.md");
		const view = seq;
		create(t, "new", "f", "new.md", "markdown", "dev-b");
		const r = run(t, { t: "delete", opId: "d", id: "f", baseSeq: view });
		expect(r.result).toMatchObject({ r: "partial", deleted: ["old"], kept: expect.arrayContaining(["new", "f"]) });
		expect(t.get("f")!.deletedSeq).toBeNull();
		expect(t.get("old")!.deletedSeq).not.toBeNull();
	});

	it("revives a deleted parent folder when a child is created inside it offline", () => {
		const t = new MemoryTree();
		create(t, "f", ROOT_ID, "F", "folder");
		run(t, { t: "delete", opId: "d", id: "f", baseSeq: seq });
		expect(t.get("f")!.deletedSeq).not.toBeNull();
		const r = create(t, "n", "f", "late.md", "markdown", "dev-b");
		expect(r.result.r).toBe("ok");
		expect(t.get("f")!.deletedSeq).toBeNull();
		expect(entryPath(t, "n")).toBe("F/late.md");
	});

	it("keeps a lost attachment update as a sibling conflict copy", () => {
		const t = new MemoryTree();
		run(t, { t: "create", opId: "c", id: "img", parent: ROOT_ID, name: "photo.png", kind: "blob", blob: { sha: "s1", size: 1 } });
		run(t, { t: "setBlob", opId: "u1", id: "img", blob: { sha: "s2", size: 2 }, baseSha: "s1" });
		const late = run(t, { t: "setBlob", opId: "u2", id: "img", blob: { sha: "s3", size: 3 }, baseSha: "s1" }, "dev-b");
		expect(late.result.r).toBe("conflictCopy");
		expect(t.get("img")!.blob!.sha).toBe("s2");
		const copy = t.live().find((e) => e.blob?.sha === "s3")!;
		expect(copy.name).toBe("photo (conflict, Phone, 2026-10-28 1403).png");
	});

	it("is idempotent for a resent create", () => {
		const t = new MemoryTree();
		const op: TreeOp = { t: "create", opId: "c", id: "n", parent: ROOT_ID, name: "a.md", kind: "markdown" };
		run(t, op);
		const again = run(t, op);
		expect(again.result.r).toBe("ok");
		expect(again.writes).toHaveLength(0);
	});
});
