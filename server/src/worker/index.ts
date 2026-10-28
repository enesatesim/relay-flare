import { PROTOCOL_MIN, PROTOCOL_VERSION, SCHEMA_VERSION, SERVER_VERSION } from "../shared/protocol/version";
import { bearerFromProtocols, verifyToken, type AccessClaims, type SigningKey } from "../shared/token";
import type { Result } from "./controlPlane";
import { controlStub, folderStub, type Env } from "./env";
import { CLAIMS_HEADER } from "./folderRoom";
import { claimPage, claimResultHtml, pairPage, statusPage } from "./pages";

export { ControlPlane } from "./controlPlane";
export { FolderRoom, ReservedObject } from "./folderRoom";

// Every route is classified here before any Durable Object is touched; unknown paths 404.

let keyCache: { at: number; keys: Map<string, SigningKey> } | null = null;

async function signingKeys(env: Env, force = false): Promise<Map<string, SigningKey>> {
	if (!force && keyCache && Date.now() - keyCache.at < 5 * 60_000) return keyCache.keys;
	const keys = await controlStub(env).keys();
	keyCache = { at: Date.now(), keys: new Map(keys.map((k) => [k.kid, k])) };
	return keyCache.keys;
}

async function authenticate(env: Env, token: string | null): Promise<AccessClaims | null> {
	if (!token) return null;
	const claims = await verifyToken(token, "access", await signingKeys(env), Date.now());
	if (claims) return claims;
	// Unknown kid after a rotation: refresh once.
	return verifyToken(token, "access", await signingKeys(env, true), Date.now());
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

function error(status: number, code: string, message: string): Response {
	return json({ error: code, message }, status);
}

function fromResult<T>(r: Result<T>, map: (v: T) => unknown = (v) => v): Response {
	return r.ok ? json(map(r.value)) : error(r.status, r.code, r.message);
}

async function readJson<T>(request: Request, maxBytes = 16 * 1024): Promise<T | null> {
	const len = Number(request.headers.get("content-length") ?? "0");
	if (len > maxBytes) return null;
	try {
		const text = await request.text();
		if (text.length > maxBytes) return null;
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function str(v: unknown, max = 200): string {
	return typeof v === "string" ? v.slice(0, max) : "";
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const method = request.method;
		const control = () => controlStub(env);

		try {
			if (method === "GET" && pathname === "/") {
				const status = await control().status();
				if (!status.ok) return error(500, "internal", "Server unavailable.");
				return status.value.claimed ? statusPage(url.origin, !!env.BLOBS) : claimPage(status.value.claimSecret ?? "passphrase");
			}
			if (method === "GET" && pathname === "/pair") return pairPage(url.origin);

			if (method === "GET" && pathname === "/v1/capabilities") {
				const status = await control().status();
				return json({
					serverVersion: SERVER_VERSION,
					protocol: { min: PROTOCOL_MIN, max: PROTOCOL_VERSION },
					schema: SCHEMA_VERSION,
					attachments: !!env.BLOBS,
					claimed: status.ok ? status.value.claimed : false,
					serverId: status.ok ? status.value.serverId : null,
				});
			}

			if (method === "POST" && pathname === "/v1/claim") {
				const body = await readJson<{ secret?: unknown; ownerName?: unknown }>(request);
				if (!body) return error(400, "bad_request", "Invalid request.");
				const r = await control().claim({ secret: str(body.secret), ownerName: str(body.ownerName, 60) });
				return fromResult(r, (v) => ({ ...v, html: claimResultHtml(url.origin, v.pairingCode, v.recoveryCode) }));
			}
			if (method === "POST" && pathname === "/v1/auth/pair") {
				const body = await readJson<{ code?: unknown; deviceName?: unknown; platform?: unknown }>(request);
				if (!body) return error(400, "bad_request", "Invalid request.");
				return fromResult(await control().pair({ code: str(body.code), deviceName: str(body.deviceName, 60), platform: str(body.platform, 20) }));
			}
			if (method === "POST" && pathname === "/v1/auth/session") {
				const body = await readJson<{ deviceId?: unknown; deviceSecret?: unknown }>(request);
				if (!body) return error(400, "bad_request", "Invalid request.");
				return fromResult(await control().session({ deviceId: str(body.deviceId), deviceSecret: str(body.deviceSecret, 100) }));
			}
			if (method === "POST" && pathname === "/v1/auth/recover") {
				const body = await readJson<{ code?: unknown }>(request);
				if (!body) return error(400, "bad_request", "Invalid request.");
				return fromResult(await control().recover({ code: str(body.code) }));
			}

			const socket = /^\/v1\/folders\/([A-Za-z0-9_-]{8,64})\/socket$/.exec(pathname);
			if (socket && method === "GET") {
				if (request.headers.get("Upgrade") !== "websocket") return error(426, "upgrade_required", "Expected a WebSocket upgrade.");
				const claims = await authenticate(env, bearerFromProtocols(request.headers.get("Sec-WebSocket-Protocol")));
				if (!claims) return error(401, "unauthorized", "Invalid or expired access token.");
				const headers = new Headers(request.headers);
				headers.set(CLAIMS_HEADER, JSON.stringify(claims));
				// Strip the bearer from what the room sees; the room trusts the verified claims.
				headers.delete("Sec-WebSocket-Protocol");
				return folderStub(env, socket[1]!).fetch(new Request(request.url, { method: "GET", headers }));
			}

			if (pathname.startsWith("/v1/")) {
				const auth = request.headers.get("Authorization");
				const claims = await authenticate(env, auth?.startsWith("Bearer ") ? auth.slice(7) : null);
				if (!claims) return error(401, "unauthorized", "Invalid or expired access token.");
				if (method === "GET" && pathname === "/v1/folders") return fromResult(await control().listFolders(claims.sub));
				if (method === "POST" && pathname === "/v1/folders") {
					const body = await readJson<{ name?: unknown }>(request);
					if (!body) return error(400, "bad_request", "Invalid request.");
					return fromResult(await control().createFolder(claims.sub, str(body.name, 120)));
				}
				if (method === "POST" && pathname === "/v1/pairings") {
					return fromResult(await control().createPairing(claims.sub), (v) => ({ ...v, pairUrl: `${url.origin}/pair#code=${encodeURIComponent(v.code)}` }));
				}
				if (method === "GET" && pathname === "/v1/devices") return fromResult(await control().listDevices(claims.sub));
				const revoke = /^\/v1\/devices\/([A-Za-z0-9_-]{8,64})\/revoke$/.exec(pathname);
				if (revoke && method === "POST") return fromResult(await control().revokeDevice(claims.sub, revoke[1]!));
				if (/^\/v1\/folders\/[A-Za-z0-9_-]{8,64}\/blobs\//.test(pathname)) {
					return env.BLOBS ? error(501, "not_implemented", "Attachment sync arrives in a later release.") : error(503, "r2_not_configured", "This server has no R2 bucket bound, so attachments are off.");
				}
			}
			return error(404, "not_found", "Not found.");
		} catch (err) {
			console.error("unhandled", err);
			return error(500, "internal", "Internal error.");
		}
	},
} satisfies ExportedHandler<Env>;
