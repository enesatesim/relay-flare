// Path helpers. Engine paths always use "/" and never start or end with "/".
// "rel" paths are relative to a share root; "vault" paths are relative to the vault root.

export function dirname(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? p : p.slice(i + 1);
}

export function join(a: string, b: string): string {
	return !a ? b : !b ? a : `${a}/${b}`;
}

export function depth(p: string): number {
	return p ? p.split("/").length : 0;
}

/** True when `p` equals `prefix` or lies below it. */
export function isWithin(p: string, prefix: string): boolean {
	return prefix === "" || p === prefix || p.startsWith(`${prefix}/`);
}

export function toVault(mount: string, rel: string): string {
	return join(mount, rel);
}

/** Share-relative path of a vault path, or null when it is outside the mount. */
export function toRel(mount: string, vaultPath: string): string | null {
	if (mount === "") return vaultPath;
	if (vaultPath === mount) return "";
	return vaultPath.startsWith(`${mount}/`) ? vaultPath.slice(mount.length + 1) : null;
}

/** Re-roots `p` from `from` to `to` (for folder moves). */
export function rebase(p: string, from: string, to: string): string {
	return p === from ? to : join(to, p.slice(from.length + 1));
}
