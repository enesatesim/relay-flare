import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { canonicalize, merge2, merge3, patchYText, toDisk } from "../../src/engine/text";

describe("canonicalize / toDisk", () => {
	it("round-trips LF, CRLF, BOM and mixed files byte-for-byte", () => {
		for (const raw of ["a\nb\n", "a\r\nb\r\n", "﻿a\r\nb", "a\r\nb\nc", "", "﻿"]) {
			const c = canonicalize(raw);
			expect(toDisk(c.text, c.format)).toBe(raw);
		}
	});

	it("stores CRLF files as LF so an EOL conversion is not a content change", () => {
		expect(canonicalize("x\r\ny\r\n").text).toBe("x\ny\n");
	});
});

describe("patchYText", () => {
	it("reaches the target text for arbitrary edits, including emoji", () => {
		fc.assert(
			fc.property(fc.string({ unit: "grapheme" }), fc.string({ unit: "grapheme" }), (a, b) => {
				const doc = new Y.Doc();
				const t = doc.getText("contents");
				t.insert(0, a);
				patchYText(t, a, b, "test");
				expect(t.toString()).toBe(b);
			}),
			{ numRuns: 500 },
		);
	});

	it("produces identical operations for identical intents (no corruption from misaligned deletes)", () => {
		// Two devices delete the same line from differently-edited copies. A minimal character
		// diff may align the deletion as "3-C\nline-177-" on one side and "line-177-3-C\n" on
		// the other; the CRDT union of both would then eat the start of the next line.
		const base = new Y.Doc();
		base.getText("contents").insert(0, "line-177-3-C\nline-177-10-A\n");
		const b = new Y.Doc();
		const c = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
		Y.applyUpdate(c, Y.encodeStateAsUpdate(base));
		patchYText(b.getText("contents"), "line-177-3-C\nline-177-10-A\n", "line-177-10-A\n", "b");
		c.getText("contents").insert(0, "line-177-21-C\n");
		patchYText(c.getText("contents"), "line-177-21-C\nline-177-3-C\nline-177-10-A\n", "line-177-21-C\nline-177-10-A\n", "c");
		Y.applyUpdate(b, Y.encodeStateAsUpdate(c));
		Y.applyUpdate(c, Y.encodeStateAsUpdate(b));
		expect(b.getText("contents").toString()).toBe("line-177-21-C\nline-177-10-A\n");
		expect(c.getText("contents").toString()).toBe(b.getText("contents").toString());
	});

	it("keeps concurrent remote edits when applying a local disk change", () => {
		const a = new Y.Doc();
		a.getText("contents").insert(0, "one\ntwo\nthree\n");
		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		b.getText("contents").insert(0, "zero\n");
		patchYText(a.getText("contents"), "one\ntwo\nthree\n", "one\nTWO\nthree\n", "disk");
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		expect(a.getText("contents").toString()).toBe("zero\none\nTWO\nthree\n");
	});
});

describe("merge3", () => {
	it("merges edits to different lines", () => {
		expect(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual({ text: "A\nb\nC\n", conflicts: 0 });
	});

	it("collapses identical changes made on both sides (no duplicated link updates)", () => {
		const base = "see [[Old]]\nmore\n";
		const both = "see [[New]]\nmore\n";
		expect(merge3(base, both, both)).toEqual({ text: both, conflicts: 0 });
		expect(merge3(base, "see [[New]]\nmore!\n", "see [[New]]\nmore\n")).toEqual({ text: "see [[New]]\nmore!\n", conflicts: 0 });
	});

	it("keeps both versions of an overlapping change as whole lines, ours first", () => {
		const r = merge3("the cat sat\n", "the dog sat\n", "the cow sat\n");
		expect(r.conflicts).toBe(1);
		expect(r.text).toBe("the dog sat\nthe cow sat\n");
	});

	it("never loses a line from either side", () => {
		fc.assert(
			fc.property(fc.array(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 8 }), fc.array(fc.constantFrom("a", "b", "x", "y"), { maxLength: 8 }), fc.array(fc.constantFrom("a", "c", "z", "w"), { maxLength: 8 }), (base, ours, theirs) => {
				const j = (l: string[]) => l.map((x) => x + "\n").join("");
				const r = merge3(j(base), j(ours), j(theirs));
				const out = new Set(r.text.split("\n"));
				const baseSet = new Set<string>(base);
				// Every line a side added (not present in the base) survives.
				for (const l of [...ours, ...theirs]) if (!baseSet.has(l)) expect(out.has(l)).toBe(true);
			}),
			{ numRuns: 500 },
		);
	});
});

describe("merge2", () => {
	it("unions two independently created daily notes from the same template", () => {
		const template = "# 2026-10-28\n## Tasks\n";
		const r = merge2(template + "- laptop task\n", template + "- phone task\n");
		expect(r.text).toBe(template + "- laptop task\n- phone task\n");
	});
});
