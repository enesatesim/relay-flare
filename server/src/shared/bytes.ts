// Small byte helpers shared by the plugin and the server. No Node, DOM or Workers APIs
// beyond TextEncoder/TextDecoder and WebCrypto, which all three runtimes provide.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(s: string): Uint8Array {
	return encoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
	return decoder.decode(b);
}

/** Decodes UTF-8, returning null when the bytes are not valid UTF-8. */
export function fromUtf8Strict(b: Uint8Array): string | null {
	try {
		return strictDecoder.decode(b);
	} catch {
		return null;
	}
}

export function utf8Length(s: string): number {
	return encoder.encode(s).length;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = (() => {
	const t = new Int16Array(128).fill(-1);
	for (let i = 0; i < B64URL.length; i++) t[B64URL.charCodeAt(i)] = i;
	return t;
})();

export function toBase64Url(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i]! << 16;
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
	} else if (rest === 2) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
	}
	return out;
}

/** Decodes unpadded base64url. Returns null on any invalid character. */
export function fromBase64Url(s: string): Uint8Array | null {
	if (s.length % 4 === 1) return null;
	const out = new Uint8Array(Math.floor((s.length * 3) / 4));
	let o = 0;
	let buf = 0;
	let bits = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const v = c < 128 ? B64URL_LOOKUP[c]! : -1;
		if (v < 0) return null;
		buf = (buf << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (buf >> bits) & 0xff;
		}
	}
	return out.subarray(0, o);
}

export function toHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

export function randomBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	crypto.getRandomValues(b);
	return b;
}

/** URL-safe random identifier with `bytes` bytes of entropy. */
export function randomId(bytes = 16): string {
	return toBase64Url(randomBytes(bytes));
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
	const input = typeof data === "string" ? utf8(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", input as BufferSource);
	return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	return toHex(await sha256(data));
}

/** Compares two byte arrays without an early exit on the first difference. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export function constantTimeEqualString(a: string, b: string): boolean {
	return constantTimeEqual(utf8(a), utf8(b));
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** Copies into a buffer that owns exactly its bytes (required for SQLite BLOB bindings). */
export function ownedBytes(b: Uint8Array): Uint8Array {
	return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice();
}
