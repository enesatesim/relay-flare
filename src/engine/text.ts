import diff from "fast-diff";
import * as Y from "yjs";
import { diff3Merge, diffComm } from "node-diff3";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// Text canonicalization, minimal Y.Text patching and line-level merges.

export type Eol = "lf" | "crlf" | "mixed";

/** How a file looks on this device's disk. The CRDT always holds the canonical form. */
export interface DiskFormat {
	eol: Eol;
	bom: boolean;
}

export interface Canonical {
	text: string;
	format: DiskFormat;
}

const BOM = "﻿";

/** Strips a BOM and normalizes CRLF to LF; remembers how to restore both on write. */
export function canonicalize(raw: string): Canonical {
	const bom = raw.startsWith(BOM);
	const body = bom ? raw.slice(1) : raw;
	const crlf = (body.match(/\r\n/g) ?? []).length;
	const lf = (body.match(/\n/g) ?? []).length;
	// "mixed" files keep their bytes: we cannot know which lines were CRLF, so we do not touch \r.
	const eol: Eol = crlf === 0 ? "lf" : crlf === lf ? "crlf" : "mixed";
	return { text: eol === "crlf" ? body.replace(/\r\n/g, "\n") : body, format: { eol, bom } };
}

/** Inverse of canonicalize for a given disk format. */
export function toDisk(text: string, format: DiskFormat): string {
	const body = format.eol === "crlf" ? text.replace(/\r?\n/g, "\r\n") : text;
	return format.bom ? BOM + body : body;
}

export const DEFAULT_FORMAT: DiskFormat = { eol: "lf", bom: false };

/**
 * SHA-256 of the canonical text, computed synchronously. Async WebCrypto digests resolve at
 * unpredictable times and would let other engine work interleave around a hash.
 */
export function hashText(text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text)));
}

type Op = [op: -1 | 0 | 1, text: string];

/** Encodes each distinct line as one UTF-16 unit so fast-diff compares whole lines. */
function encodeLines(a: string[], b: string[]): { ea: string; eb: string; table: string[] } | null {
	const index = new Map<string, number>();
	const table: string[] = [];
	const code = (line: string): string => {
		let i = index.get(line);
		if (i === undefined) {
			i = table.length;
			index.set(line, i);
			table.push(line);
		}
		// Skip the surrogate range so every unit is a valid, standalone character.
		const unit = 0x100 + i;
		return String.fromCharCode(unit < 0xd800 ? unit : unit + 0x800);
	};
	const ea = a.map(code).join("");
	const eb = b.map(code).join("");
	return table.length > 0xffff - 0x900 ? null : { ea, eb, table };
}

function decodeLines(encoded: string, table: string[]): string {
	let out = "";
	for (let k = 0; k < encoded.length; k++) {
		const unit = encoded.charCodeAt(k);
		out += table[(unit < 0xd800 ? unit : unit - 0x800) - 0x100]!;
	}
	return out;
}

/**
 * Line-granular diff for changes that come from disk (external edits, merges, catch-up).
 * Whole lines are the unit: a changed line is deleted and its new version inserted.
 *
 * Character-level patches are unsafe here. The same intent can align differently on two
 * devices, and a "replace this line" on one device combined with a "delete this line" on
 * another leaves fragments (the reused characters are deleted, the new ones survive). With
 * whole lines, the new line survives intact, and concurrent edits of one line keep both
 * versions instead of interleaving characters. Live typing goes through the editor binding,
 * which keeps character-level operations.
 */
export function textDiff(from: string, to: string, granularity: "line" | "char" = "line"): Op[] {
	if (from === to) return from ? [[0, from]] : [];
	if (granularity === "char") return diff(from, to) as Op[];
	const enc = encodeLines(lines(from), lines(to));
	if (!enc) return diff(from, to) as Op[];
	const out: Op[] = [];
	let del = "";
	let ins = "";
	const flush = () => {
		if (del) out.push([-1, del]);
		if (ins) out.push([1, ins]);
		del = ins = "";
	};
	for (const [op, chunk] of diff(enc.ea, enc.eb) as Op[]) {
		const text = decodeLines(chunk, enc.table);
		if (op === 0) {
			flush();
			out.push([0, text]);
		} else if (op === -1) del += text;
		else ins += text;
	}
	flush();
	return out;
}

/**
 * Applies the line-aligned diff from `from` to `to` onto `ytext`, in one transaction.
 * `from` must equal the current content of `ytext`. fast-diff keeps surrogate pairs intact.
 */
export function patchYText(ytext: Y.Text, from: string, to: string, origin: unknown): void {
	if (from === to) return;
	const doc = ytext.doc;
	const apply = () => {
		let pos = 0;
		for (const [op, chunk] of textDiff(from, to)) {
			if (op === 0) pos += chunk.length;
			else if (op === -1) ytext.delete(pos, chunk.length);
			else {
				ytext.insert(pos, chunk);
				pos += chunk.length;
			}
		}
	};
	if (doc) doc.transact(apply, origin);
	else apply();
}

/** Splits into lines that keep their "\n", so joining reproduces the text exactly. */
export function lines(text: string): string[] {
	return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

export interface MergeResult {
	text: string;
	/** Number of regions where both sides changed the same lines differently. */
	conflicts: number;
}

/** Ensures a block ends with a newline before more lines are appended after it. */
function terminated(block: string[]): string[] {
	if (block.length === 0) return block;
	const last = block[block.length - 1]!;
	return last.endsWith("\n") ? block : [...block.slice(0, -1), last + "\n"];
}

/**
 * Three-way line merge. Identical changes on both sides collapse (no duplicated link
 * updates or plugin edits). Overlapping changes keep both versions as whole lines,
 * `ours` first, never interleaved characters.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
	if (ours === theirs) return { text: ours, conflicts: 0 };
	if (base === ours) return { text: theirs, conflicts: 0 };
	if (base === theirs) return { text: ours, conflicts: 0 };
	const blocks = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true });
	const out: string[] = [];
	let conflicts = 0;
	for (const b of blocks) {
		if (b.ok) out.push(...b.ok);
		else if (b.conflict) {
			// Overlapping line hunks often touch different words (or make the same change next
			// to a one-sided change). Retry the region word by word before declaring a conflict.
			const fine = mergeWords(b.conflict.o.join(""), b.conflict.a.join(""), b.conflict.b.join(""));
			if (fine !== null) out.push(fine);
			else {
				conflicts++;
				out.push(...unionLines(b.conflict.a, b.conflict.b));
			}
		}
	}
	return { text: out.join(""), conflicts };
}

/** Words, whitespace runs and single punctuation characters; joining restores the text. */
function tokens(text: string): string[] {
	return text.split(/(\s+|[^\p{L}\p{N}_])/u).filter((t) => t !== "");
}

/** Word-level three-way merge of one region; null when the words themselves conflict. */
function mergeWords(base: string, ours: string, theirs: string): string | null {
	const blocks = diff3Merge(tokens(ours), tokens(base), tokens(theirs), { excludeFalseConflicts: true });
	let text = "";
	for (const b of blocks) {
		if (!b.ok) return null;
		text += b.ok.join("");
	}
	return text;
}

/** Both blocks, ours first, without repeating lines that appear in both. */
function unionLines(a: string[], b: string[]): string[] {
	const seen = new Set(a.map((l) => l.replace(/\n$/, "")));
	const extra = b.filter((l) => !seen.has(l.replace(/\n$/, "")));
	if (extra.length === 0) return a;
	return [...terminated(a), ...extra];
}

/**
 * Two-way union merge for content with no common ancestor (the same note created on two
 * offline devices, or a lost local baseline). Shared lines appear once; differing runs
 * keep both versions, `ours` first.
 */
export function merge2(ours: string, theirs: string): MergeResult {
	if (ours === theirs) return { text: ours, conflicts: 0 };
	if (ours.length === 0) return { text: theirs, conflicts: 0 };
	if (theirs.length === 0) return { text: ours, conflicts: 0 };
	const out: string[] = [];
	let conflicts = 0;
	for (const part of diffComm(lines(ours), lines(theirs))) {
		if (part.common) out.push(...part.common);
		else {
			const a = part.buffer1 ?? [];
			const b = part.buffer2 ?? [];
			if (a.length > 0 && b.length > 0) conflicts++;
			out.push(...unionLines(a, b));
		}
	}
	return { text: out.join(""), conflicts };
}
