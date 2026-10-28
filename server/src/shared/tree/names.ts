import { utf8Length } from "../bytes";

// Names must be valid on every platform a share may be materialized on (Windows, macOS,
// Linux, iOS, Android), so the rules here are the union of every platform's restrictions.

const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const RESERVED_DOS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.[^.]*)?$/i;
export const MAX_NAME_BYTES = 255;

export type NameProblem =
	| "empty"
	| "dot-segment"
	| "invalid-character"
	| "trailing-dot-or-space"
	| "leading-dot"
	| "reserved-name"
	| "too-long"
	| "not-normalized";

/** Canonical stored form of a name: Unicode NFC. */
export function normalizeName(name: string): string {
	return name.normalize("NFC");
}

/**
 * Collision key for siblings: NFC plus lowercase. Stricter than any filesystem, so two
 * siblings can never alias each other on a case-insensitive or normalizing disk.
 */
export function nameKey(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

/** Returns why `name` is not portable, or null when it is valid. Expects an NFC name. */
export function validateName(name: string): NameProblem | null {
	if (name.length === 0) return "empty";
	if (name === "." || name === "..") return "dot-segment";
	if (name !== name.normalize("NFC")) return "not-normalized";
	if (INVALID_CHARS.test(name)) return "invalid-character";
	if (name.endsWith(".") || name.endsWith(" ")) return "trailing-dot-or-space";
	if (name.startsWith(".")) return "leading-dot";
	if (RESERVED_DOS.test(name)) return "reserved-name";
	if (utf8Length(name) > MAX_NAME_BYTES) return "too-long";
	return null;
}

/** Splits "name.ext" into ["name", ".ext"]; folders and dotless names get an empty extension. */
export function splitExtension(name: string, isFolder: boolean): [string, string] {
	if (isFolder) return [name, ""];
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return [name, ""];
	// Keep compound Obsidian extensions such as ".excalidraw.md" together.
	const lower = name.toLowerCase();
	if (lower.endsWith(".excalidraw.md")) return [name.slice(0, -".excalidraw.md".length), name.slice(-".excalidraw.md".length)];
	return [name.slice(0, dot), name.slice(dot)];
}

/** Makes a device label safe to embed in a file name. */
export function sanitizeLabel(label: string): string {
	const cleaned = label
		.normalize("NFC")
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "");
	return (cleaned || "device").slice(0, 40);
}

function stamp(now: number): string {
	const d = new Date(now);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/**
 * Deterministic conflict name: "name (conflict, <device>, <yyyy-mm-dd hhmm>).ext".
 * `taken` reports whether a candidate key is already used; a counter is added until free.
 */
export function conflictName(
	name: string,
	isFolder: boolean,
	deviceLabel: string,
	now: number,
	taken: (key: string) => boolean,
): string {
	const [base, ext] = splitExtension(name, isFolder);
	const label = sanitizeLabel(deviceLabel);
	const head = `${base} (conflict, ${label}, ${stamp(now)}`;
	for (let i = 1; ; i++) {
		const candidate = normalizeName(`${head}${i === 1 ? "" : ` ${i}`})${ext}`);
		const trimmed = trimToLimit(candidate, ext);
		if (!taken(nameKey(trimmed))) return trimmed;
	}
}

function trimToLimit(name: string, ext: string): string {
	if (utf8Length(name) <= MAX_NAME_BYTES) return name;
	let base = name.slice(0, name.length - ext.length);
	while (utf8Length(base + ext) > MAX_NAME_BYTES && base.length > 1) base = base.slice(0, -1);
	return base + ext;
}
