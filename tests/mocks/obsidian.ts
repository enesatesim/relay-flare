// Minimal stand-in for the "obsidian" module in unit tests. Engine code never imports
// obsidian; only the plugin shell does, and the shell is exercised in the real app.
export class Notice {
	constructor(public message: string) {}
}

export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false };

export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/|\/$/g, "")
		.normalize("NFC");
}
