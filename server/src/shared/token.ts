import { fromBase64Url, fromUtf8Strict, toBase64Url, utf8 } from "./bytes";

// Compact HMAC-SHA256 tokens: base64url(JSON claims) "." base64url(signature).
// Used for access tokens (device sessions) and blob grants. Keys rotate by `kid`.

export interface AccessClaims {
	v: 1;
	typ: "access";
	kid: string;
	/** Server id; a token from another server never verifies. */
	sid: string;
	/** User id. */
	sub: string;
	/** Device id. */
	dev: string;
	/** Device name, used in conflict names and presence. */
	dn: string;
	/** Membership version of the user when the token was minted. */
	aclv: number;
	iat: number;
	exp: number;
}

export interface GrantClaims {
	v: 1;
	typ: "grant";
	kid: string;
	sid: string;
	/** Folder id. */
	fid: string;
	sha: string;
	op: "put" | "get";
	dev: string;
	size?: number;
	iat: number;
	exp: number;
}

export type Claims = AccessClaims | GrantClaims;

export interface SigningKey {
	kid: string;
	secret: Uint8Array;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(key: SigningKey): Promise<CryptoKey> {
	const cacheKey = `${key.kid}:${toBase64Url(key.secret)}`;
	let k = keyCache.get(cacheKey);
	if (!k) {
		k = crypto.subtle.importKey("raw", key.secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
		keyCache.set(cacheKey, k);
	}
	return k;
}

export async function signToken(claims: Claims, key: SigningKey): Promise<string> {
	if (claims.kid !== key.kid) throw new Error("kid mismatch");
	const body = toBase64Url(utf8(JSON.stringify(claims)));
	const sig = await crypto.subtle.sign("HMAC", await importKey(key), utf8(body) as BufferSource);
	return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Peeks at the claims without verifying the signature (for routing and expiry hints only). */
export function peekClaims(token: string): Claims | null {
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const raw = fromBase64Url(token.slice(0, dot));
	if (!raw) return null;
	const json = fromUtf8Strict(raw);
	if (!json) return null;
	try {
		const c = JSON.parse(json) as Claims;
		return c && c.v === 1 && typeof c.kid === "string" ? c : null;
	} catch {
		return null;
	}
}

/**
 * Verifies signature, version, expiry and type. `keys` maps kid to key. Returns null on any
 * failure, never throws.
 */
export async function verifyToken<T extends Claims["typ"]>(
	token: string,
	typ: T,
	keys: ReadonlyMap<string, SigningKey>,
	now: number,
): Promise<Extract<Claims, { typ: T }> | null> {
	const dot = token.indexOf(".");
	if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
	const claims = peekClaims(token);
	if (!claims || claims.typ !== typ) return null;
	const key = keys.get(claims.kid);
	if (!key) return null;
	const sig = fromBase64Url(token.slice(dot + 1));
	if (!sig) return null;
	const ok = await crypto.subtle.verify("HMAC", await importKey(key), sig as BufferSource, utf8(token.slice(0, dot)) as BufferSource);
	if (!ok) return null;
	if (typeof claims.exp !== "number" || claims.exp <= now) return null;
	return claims as Extract<Claims, { typ: T }>;
}

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const GRANT_TTL_MS = 10 * 60 * 1000;

/** WebSocket subprotocol carrying the bearer token (the URL never carries secrets). */
export const WS_PROTOCOL = "rf.v1";
export const WS_BEARER_PREFIX = "bearer.";

export function bearerFromProtocols(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(",")) {
		const p = part.trim();
		if (p.startsWith(WS_BEARER_PREFIX)) return p.slice(WS_BEARER_PREFIX.length);
	}
	return null;
}
