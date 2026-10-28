import { DurableObject } from "cloudflare:workers";
import { randomId } from "../shared/bytes";
import { verifyToken, WS_PROTOCOL, type AccessClaims, type SigningKey } from "../shared/token";
import type { FolderMessage } from "../core/controlCore";
import { FolderCore, type ConnInfo, type Transport } from "../core/folderCore";
import { DoSql } from "./doSql";
import { controlStub, type Env } from "./env";

/** Claims the Worker verified before forwarding a socket upgrade (internal header). */
export const CLAIMS_HEADER = "x-rf-claims";

/** One Durable Object per shared folder, with hibernatable WebSockets. */
export class FolderRoom extends DurableObject<Env> {
	private core: FolderCore;
	private keyCache: { at: number; keys: Map<string, SigningKey> } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keepalive pings are answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		const transport: Transport = {
			send: (id, data) => {
				for (const ws of ctx.getWebSockets(id)) {
					try {
						ws.send(data);
					} catch {
						// The socket is closing; its close handler cleans up.
					}
				}
			},
			close: (id, code, reason) => {
				for (const ws of ctx.getWebSockets(id)) {
					try {
						ws.close(code, reason.slice(0, 120));
					} catch {
						// already closed
					}
				}
			},
			connections: () => {
				const out: ConnInfo[] = [];
				for (const ws of ctx.getWebSockets()) {
					const c = ws.deserializeAttachment() as ConnInfo | null;
					if (c && ws.readyState === WebSocket.OPEN) out.push(c);
				}
				return out;
			},
			update: (id, patch) => {
				for (const ws of ctx.getWebSockets(id)) {
					const c = ws.deserializeAttachment() as ConnInfo | null;
					if (c) ws.serializeAttachment({ ...c, ...patch });
				}
			},
		};
		this.core = new FolderCore({
			sql: new DoSql(ctx.storage),
			transport,
			clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as number) },
			verifyAccess: (token) => this.verifyAccess(token),
			log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
		});
	}

	private async keys(force = false): Promise<Map<string, SigningKey>> {
		if (!force && this.keyCache && Date.now() - this.keyCache.at < 5 * 60_000) return this.keyCache.keys;
		const keys = await controlStub(this.env).keys();
		this.keyCache = { at: Date.now(), keys: new Map(keys.map((k) => [k.kid, k])) };
		return this.keyCache.keys;
	}

	private async verifyAccess(token: string): Promise<AccessClaims | null> {
		let claims = await verifyToken(token, "access", await this.keys(), Date.now());
		if (!claims) claims = await verifyToken(token, "access", await this.keys(true), Date.now());
		return claims;
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const raw = request.headers.get(CLAIMS_HEADER);
		if (!raw) return new Response("missing claims", { status: 400 });
		const claims = JSON.parse(raw) as AccessClaims;
		const admission = this.core.admitConnection(claims);
		if (!admission.ok) return new Response(admission.reason, { status: admission.status });
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const conn: ConnInfo = {
			id: randomId(9),
			userId: claims.sub,
			deviceId: claims.dev,
			deviceLabel: claims.dn,
			role: admission.role,
			exp: claims.exp,
			aclv: claims.aclv,
			ready: false,
		};
		this.ctx.acceptWebSocket(server, [conn.id]);
		server.serializeAttachment(conn);
		this.core.onOpen(conn);
		return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL } });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const conn = ws.deserializeAttachment() as ConnInfo | null;
		if (!conn) return;
		await this.core.onMessage(conn.id, typeof message === "string" ? message : new Uint8Array(message));
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		const conn = ws.deserializeAttachment() as ConnInfo | null;
		if (conn) this.core.onClose(conn.id);
		try {
			ws.close(code === 1005 ? 1000 : code, reason);
		} catch {
			// already closed
		}
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		const conn = ws.deserializeAttachment() as ConnInfo | null;
		if (conn) this.core.onClose(conn.id);
	}

	/** Control-plane RPC: folder init, membership changes and revocations. */
	async control(message: FolderMessage): Promise<void> {
		switch (message.t) {
			case "init":
				this.core.init(message.folderId, message.serverId, message.acl);
				return;
			case "acl":
				this.core.setAcl(message.acl, false);
				return;
			case "removeMember":
				this.core.removeMember(message.userId);
				return;
			case "revokeDevice":
				this.core.revokeDevice(message.deviceId);
				return;
		}
	}

	/** Test/admin hook: persist buffered updates now. */
	async flushNow(): Promise<number> {
		this.core.flush();
		return this.core.currentSeq;
	}
}

/** Declared in v1 so future releases can add a durable class without a migration. */
export class ReservedObject extends DurableObject<Env> {
	override async fetch(): Promise<Response> {
		return new Response("not used", { status: 404 });
	}
}
