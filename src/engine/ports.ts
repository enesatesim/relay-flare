// Platform ports. The engine never imports "obsidian": the plugin shell implements these
// over the Obsidian API, and the simulation implements them in memory.

export interface FileStat {
	mtime: number;
	size: number;
	isFolder: boolean;
}

export interface VaultEntry extends FileStat {
	path: string;
}

export interface VaultPort {
	/** Every file and folder under `prefix` ("" = vault root), recursively. Paths use "/". */
	list(prefix: string): Promise<VaultEntry[]>;
	stat(path: string): Promise<FileStat | null>;
	readText(path: string): Promise<string>;
	/**
	 * Atomic read-modify-write of an existing file. `fn` gets the current content and returns
	 * the new content, or null to leave the file untouched. Resolves true when it wrote.
	 */
	process(path: string, fn: (current: string) => string | null): Promise<boolean>;
	createText(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Moves to the user's configured trash (never a hard delete). */
	trash(path: string): Promise<void>;
}

export type VaultEvent =
	| { type: "create"; path: string; isFolder: boolean }
	| { type: "modify"; path: string }
	| { type: "delete"; path: string; isFolder: boolean }
	| { type: "rename"; path: string; oldPath: string; isFolder: boolean };

/** Minimal WebSocket surface used by the folder socket (browser/Electron WebSocket fits). */
export interface SocketLike {
	binaryType: string;
	readonly readyState: number;
	send(data: Uint8Array | string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, detail?: Record<string, unknown>) => void;

export const silentLogger: Logger = () => {};
