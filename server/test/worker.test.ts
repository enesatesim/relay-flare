import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeFrame, encodeFrame, type Frame } from "../src/shared/protocol/frames";
import { WS_PROTOCOL } from "../src/shared/token";
import type { FolderRoom } from "../src/worker/folderRoom";

// Runs the real Worker, Durable Objects and SQLite inside workerd.

const ORIGIN = "https://relay-flare.example";

async function post<T>(path: string, body: unknown, token?: string): Promise<{ status: number; json: T }> {
	const res = await SELF.fetch(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as T };
}

interface Session {
	token: string;
	folders: Array<{ id: string; name: string; role: string }>;
}

async function setupOwner(): Promise<{ token: string; folderId: string; deviceId: string }> {
	const claim = await post<{ pairingCode: string }>("/v1/claim", { secret: "test-passphrase", ownerName: "Ada" });
	expect(claim.status).toBe(200);
	const pair = await post<{ deviceId: string; deviceSecret: string }>("/v1/auth/pair", { code: claim.json.pairingCode, deviceName: "Laptop", platform: "desktop" });
	expect(pair.status).toBe(200);
	const session = await post<Session>("/v1/auth/session", pair.json);
	expect(session.status).toBe(200);
	const folder = await post<{ id: string }>("/v1/folders", { name: "Notes" }, session.json.token);
	expect(folder.status).toBe(200);
	return { token: session.json.token, folderId: folder.json.id, deviceId: pair.json.deviceId };
}

async function openSocket(folderId: string, token: string): Promise<{ ws: WebSocket; frames: Frame[]; next: (type: Frame["type"]) => Promise<Frame> }> {
	const res = await SELF.fetch(`${ORIGIN}/v1/folders/${folderId}/socket`, {
		headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `${WS_PROTOCOL}, bearer.${token}` },
	});
	expect(res.status).toBe(101);
	const ws = res.webSocket!;
	ws.accept();
	const frames: Frame[] = [];
	const waiters: Array<{ type: Frame["type"]; resolve: (f: Frame) => void }> = [];
	let chain = Promise.resolve();
	ws.addEventListener("message", (e) => {
		if (typeof e.data === "string") return;
		// Keep frame order even when some payloads arrive as Blobs.
		chain = chain.then(async () => {
			const data = e.data instanceof Blob ? await e.data.arrayBuffer() : (e.data as ArrayBuffer);
			handle(new Uint8Array(data));
		});
	});
	const handle = (bytes: Uint8Array) => {
		const f = decodeFrame(bytes);
		if (!f) return;
		const i = waiters.findIndex((w) => w.type === f.type);
		if (i >= 0) waiters.splice(i, 1)[0]!.resolve(f);
		else frames.push(f);
	};
	const next = (type: Frame["type"]) =>
		new Promise<Frame>((resolve) => {
			const i = frames.findIndex((f) => f.type === type);
			if (i >= 0) resolve(frames.splice(i, 1)[0]!);
			else waiters.push({ type, resolve });
		});
	return { ws, frames, next };
}

describe("worker", () => {
	it("serves the claim page before claiming and capabilities always", async () => {
		const page = await SELF.fetch(`${ORIGIN}/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Claim your Relay Flare server");
		const caps = await (await SELF.fetch(`${ORIGIN}/v1/capabilities`)).json<{ claimed: boolean; attachments: boolean }>();
		expect(caps).toMatchObject({ claimed: false, attachments: true });
	});

	it("rejects a wrong passphrase and unknown routes without touching rooms", async () => {
		const bad = await post<{ error: string }>("/v1/claim", { secret: "nope", ownerName: "Eve" });
		expect(bad.status).toBe(403);
		expect((await SELF.fetch(`${ORIGIN}/v1/whatever`)).status).toBe(401);
		expect((await SELF.fetch(`${ORIGIN}/nothing`)).status).toBe(404);
	});

	it("claims, pairs, opens a folder socket, syncs a document and acknowledges after commit", async () => {
		const { token, folderId } = await setupOwner();
		const noAuth = await SELF.fetch(`${ORIGIN}/v1/folders/${folderId}/socket`, { headers: { Upgrade: "websocket" } });
		expect(noAuth.status).toBe(401);

		const a = await openSocket(folderId, token);
		a.ws.send(encodeFrame({ type: "hello", protocol: 1, schema: 1, epoch: null, cursor: 0, client: "test" }));
		const welcome = (await a.next("welcome")) as Extract<Frame, { type: "welcome" }>;
		expect(welcome).toMatchObject({ role: "owner", readOnly: false, folderId });
		await a.next("catchupDone");

		a.ws.send(encodeFrame({ type: "treeOp", op: { t: "create", opId: "op1", id: "note1", parent: "root", name: "Hello.md", kind: "markdown" } }));
		expect(((await a.next("treeResult")) as Extract<Frame, { type: "treeResult" }>).result).toMatchObject({ r: "ok", seq: 1 });

		const doc = new Y.Doc();
		doc.getText("contents").insert(0, "Hello from the Worker test");
		a.ws.send(encodeFrame({ type: "update", dseq: 1, docId: "note1", update: Y.encodeStateAsUpdate(doc) }));

		// Force the flush instead of waiting for the idle timer.
		const stub = env.FOLDERS.get(env.FOLDERS.idFromName(folderId));
		await stub.flushNow();
		const ack = (await a.next("ack")) as Extract<Frame, { type: "ack" }>;
		expect(ack.durableDseq).toBe(1);

		// Survives a fresh instance: read straight from SQLite.
		const stored = await runInDurableObject(stub, async (_instance: FolderRoom, state) => {
			return state.storage.sql.exec("SELECT COUNT(*) AS n FROM doc_journal WHERE doc_id = 'note1'").one().n as number;
		});
		expect(stored).toBe(1);

		const b = await openSocket(folderId, token);
		b.ws.send(encodeFrame({ type: "hello", protocol: 1, schema: 1, epoch: null, cursor: 0, client: "test-b" }));
		const snapshot = (await b.next("treeSnapshot")) as Extract<Frame, { type: "treeSnapshot" }>;
		expect(snapshot.entries.map((e) => e.name)).toEqual(["Hello.md"]);
		b.ws.send(encodeFrame({ type: "sync1", docId: "note1", sv: Y.encodeStateVector(new Y.Doc()) }));
		const sync2 = (await b.next("sync2")) as Extract<Frame, { type: "sync2" }>;
		const copy = new Y.Doc();
		Y.applyUpdate(copy, sync2.update);
		expect(copy.getText("contents").toString()).toBe("Hello from the Worker test");
		a.ws.close();
		b.ws.close();
	});
});
