import type { Kind } from "./tree/types";

// File kinds by extension. Text kinds are merged character-by-character through Yjs;
// canvas is a structured CRDT; everything else is a content-addressed blob (needs R2).

const TEXT_EXTENSIONS = new Set(["base", "txt"]);

export function extensionOf(path: string): string {
	const slash = path.lastIndexOf("/");
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function kindForFile(path: string): Exclude<Kind, "folder"> {
	const ext = extensionOf(path);
	if (ext === "md") return "markdown";
	if (ext === "canvas") return "canvas";
	if (TEXT_EXTENSIONS.has(ext)) return "text";
	return "blob";
}

/** Content docs use the "contents" Y.Text; this name matches Relay's layout. */
export const TEXT_ROOT = "contents";
export const FRONTMATTER_ROOT = "frontmatter";
