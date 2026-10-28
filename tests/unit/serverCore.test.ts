import { describe, expect, it, beforeEach } from "vitest";
import * as Y from "yjs";
import { DatabaseSync } from "node:sqlite";
import { FolderCore, type ConnInfo } from "../../server/src/core/folderCore";
import { ControlCore, ControlError, type FolderMessage } from "../../server/src/core/controlCore";
import { encodeFrame, type Frame } from "@shared/protocol/frames";
import { verifyToken } from "@shared/token";
import { ROOT_ID } from "@shared/tree/types";
import { NodeSql } from "../sim/nodeSql";
import { FakeClock, FakeTransport } from "../sim/fakes";

function textUpdate(text: string, doc = new Y.Doc()): { doc: Y.Doc; update: Uint8Array } {
	const before = Y.encodeStateVector(doc);
	doc.getText("contents").insert(doc.getText("contents").length, text);
	return { doc, update: Y.encodeStateAsUpdate(doc, before) };
}

describe("ControlCore", () => {
	let clock: FakeClock;
	let delivered: Array<{ folderId: string; message: FolderMessage }>;
	let core: ControlCore;

	beforeEach(() => {
		clock = new FakeClock();
		delivered = [];
		core = new ControlCore({
			sql: new NodeSql(),
			now: () => clock.now(),
			setupPassphrase: "correct horse",
			folders: { send: async (folderId, message) => void delivered.push({ folderId, message }) },
		});
	});

	it("claims once with the passphrase, pairs a device and issues verifiable tokens", async () => {
		await expect(core.claim({ secret: "wrong", ownerName: "Ada" })).rejects.toBeInstanceOf(ControlError);
		const claim = await core.claim({ secret: "correct horse", ownerName: "Ada" });
		await expect(core.claim({ secret: "correct horse", ownerName: "Eve" })).rejects.toMatchObject({ code: "already_claimed" });

		const paired = await core.pair({ code: claim.pairingCode.toLowerCase(), deviceName: "Laptop", platform: "desktop" });
		await expect(core.pair({ code: claim.pairingCode, deviceName: "Again", platform: "desktop" })).rejects.toMatchObject({ code: "bad_code" });

		const session = await core.session({ deviceId: paired.deviceId, deviceSecret: paired.deviceSecret });
		const keys = new Map(core.keys().map((k) => [k.kid, k]));
		const claims = await verifyToken(session.token, "access", keys, clock.now());
		expect(claims).toMatchObject({ sub: claim.userId, dev: paired.deviceId, sid: claim.serverId });

		await expect(core.session({ deviceId: paired.deviceId, deviceSecret: "AAAA" })).rejects.toMatchObject({ status: 401 });
	});

	it("creates folders, pushes the ACL to the room and revokes devices", async () => {
		const claim = await core.claim({ secret: "correct horse", ownerName: "Ada" });
		const paired = await core.pair({ code: claim.pairingCode, deviceName: "Laptop", platform: "desktop" });
		const folder = await core.createFolder(claim.userId, "Notes");
		expect(delivered[0]).toMatchObject({ folderId: folder.id, message: { t: "init", acl: [{ userId: claim.userId, role: "owner" }] } });
		expect(core.listFolders(claim.userId)).toEqual([{ id: folder.id, name: "Notes", role: "owner" }]);

		await core.revokeDevice(claim.userId, paired.deviceId);
		expect(delivered.at(-1)).toMatchObject({ folderId: folder.id, message: { t: "revokeDevice", deviceId: paired.deviceId } });
		await expect(core.session({ deviceId: paired.deviceId, deviceSecret: paired.deviceSecret })).rejects.toMatchObject({ status: 401 });
	});

	it("parks undeliverable folder messages and retries them", async () => {
		let fail = true;
		const sent: FolderMessage[] = [];
		const c = new ControlCore({
			sql: new NodeSql(),
			now: () => clock.now(),
			setupPassphrase: "p",
			folders: {
				send: async (_f, m) => {
					if (fail) throw new Error("room unreachable");
					sent.push(m);
				},
			},
		});
		const claim = await c.claim({ secret: "p", ownerName: "Ada" });
		await c.createFolder(claim.userId, "Notes");
		expect(sent).toHaveLength(0);
		fail = false;
		clock.advance(10_000);
		expect(await c.drainOutbox()).toBeNull();
		expect(sent).toHaveLength(1);
	});
});

describe("FolderCore", () => {
	let clock: FakeClock;
	let transport: FakeTransport;
	let db: DatabaseSync;
	let core: FolderCore;

	const conn = (id: string, device: string, role: ConnInfo["role"] = "owner", user = "u1"): ConnInfo => ({
		id,
		userId: user,
		deviceId: device,
		deviceLabel: device,
		role,
		exp: clock.now() + 900_000,
		aclv: 1,
		ready: false,
	});

	function boot(): FolderCore {
		const c = new FolderCore({ sql: new NodeSql(db), transport, clock, verifyAccess: async () => null });
		return c;
	}

	async function send(connId: string, f: Frame) {
		await core.onMessage(connId, encodeFrame(f));
	}

	async function connect(c: ConnInfo, cursor = 0) {
		transport.add(c);
		core.onOpen(c);
		await send(c.id, { type: "hello", protocol: 1, schema: 1, epoch: null, cursor, client: "test" });
	}

	beforeEach(() => {
		clock = new FakeClock();
		transport = new FakeTransport();
		db = new DatabaseSync(":memory:");
		core = boot();
		core.init("folder1", "server1", [
			{ userId: "u1", role: "owner", aclv: 1 },
			{ userId: "u2", role: "viewer", aclv: 1 },
		]);
	});

	it("relays updates immediately and acknowledges only after the flush commits", async () => {
		await connect(conn("a", "devA"));
		await connect(conn("b", "devB"));
		transport.take("a");
		transport.take("b");
		const { update } = textUpdate("hello");
		await send("a", { type: "update", dseq: 1, docId: "doc1", update });
		expect(transport.of("b", "bcast")).toHaveLength(1);
		expect(transport.of("a", "ack")).toHaveLength(0);
		clock.advance(5_000);
		expect(transport.of("a", "ack")).toEqual([{ type: "ack", durableDseq: 1 }]);
		expect(transport.of("b", "heads")[0]!.heads[0]![0]).toBe("doc1");
	});

	it("serves state that is not flushed yet, and loses nothing when evicted before a flush", async () => {
		await connect(conn("a", "devA"));
		const { doc, update } = textUpdate("draft");
		await send("a", { type: "update", dseq: 1, docId: "doc1", update });

		// Evict: a fresh instance over the same storage, with the buffer gone.
		transport = new FakeTransport();
		core = boot();
		await connect(conn("a2", "devA"));
		const welcome = transport.of("a2", "welcome")[0]!;
		expect(welcome.durableDseq).toBe(0); // the client still holds dseq 1 in its outbox
		await send("a2", { type: "update", dseq: 1, docId: "doc1", update });
		core.flush();
		expect(transport.of("a2", "ack").at(-1)).toEqual({ type: "ack", durableDseq: 1 });

		await connect(conn("b", "devB"));
		await send("b", { type: "sync1", docId: "doc1", sv: new Uint8Array([0]) });
		const sync2 = transport.of("b", "sync2")[0]!;
		const copy = new Y.Doc();
		Y.applyUpdate(copy, sync2.update);
		expect(copy.getText("contents").toString()).toBe(doc.getText("contents").toString());
	});

	it("drops resent batches that are already durable and re-acknowledges them", async () => {
		await connect(conn("a", "devA"));
		const { update } = textUpdate("x");
		await send("a", { type: "update", dseq: 7, docId: "doc1", update });
		core.flush();
		transport.take("a");
		const rowsBefore = db.prepare("SELECT COUNT(*) AS n FROM doc_journal").get() as { n: number };
		await send("a", { type: "update", dseq: 7, docId: "doc1", update });
		expect(transport.of("a", "ack")).toEqual([{ type: "ack", durableDseq: 7 }]);
		core.flush();
		const rowsAfter = db.prepare("SELECT COUNT(*) AS n FROM doc_journal").get() as { n: number };
		expect(rowsAfter.n).toBe(rowsBefore.n);
	});

	it("compacts the journal and keeps the document intact", async () => {
		await connect(conn("a", "devA"));
		const doc = new Y.Doc();
		let dseq = 0;
		for (let i = 0; i < 40; i++) {
			const { update } = textUpdate(`line ${i}\n`, doc);
			await send("a", { type: "update", dseq: ++dseq, docId: "doc1", update });
			core.flush();
		}
		const journal = db.prepare("SELECT COUNT(*) AS n FROM doc_journal WHERE doc_id = 'doc1'").get() as { n: number };
		expect(journal.n).toBeLessThanOrEqual(33);
		const state = new Y.Doc();
		Y.applyUpdate(state, core.docState("doc1"));
		expect(state.getText("contents").toString()).toBe(doc.getText("contents").toString());
	});

	it("sequences tree ops, broadcasts confirmed events and replays them on catch-up", async () => {
		await connect(conn("a", "devA"));
		await connect(conn("b", "devB"));
		await send("a", { type: "treeOp", op: { t: "create", opId: "op1", id: "n1", parent: ROOT_ID, name: "a.md", kind: "markdown" } });
		expect(transport.of("a", "treeResult")[0]!.result).toMatchObject({ r: "ok", seq: 1 });
		expect(transport.of("b", "treeEvents")[0]!.events[0]!.entry.name).toBe("a.md");

		// A resent op gets the recorded answer, not a second write.
		await send("a", { type: "treeOp", op: { t: "create", opId: "op1", id: "n1", parent: ROOT_ID, name: "a.md", kind: "markdown" } });
		expect(transport.of("a", "treeResult")[1]!.result).toMatchObject({ r: "ok", seq: 1 });
		expect(core.currentSeq).toBe(1);

		await connect(conn("c", "devC"), 0);
		expect(transport.of("c", "treeSnapshot")[0]!.entries.map((e) => e.id)).toEqual(["n1"]);
		await connect(conn("d", "devD"), 1);
		expect(transport.of("d", "treeEvents")).toHaveLength(0);
		expect(transport.of("d", "catchupDone")[0]!.cursor).toBe(1);
	});

	it("revives a deleted note when another device's edit for it arrives (edits beat deletes)", async () => {
		await connect(conn("a", "devA"));
		await connect(conn("b", "devB"));
		await send("a", { type: "treeOp", op: { t: "create", opId: "op1", id: "n1", parent: ROOT_ID, name: "a.md", kind: "markdown" } });
		await send("a", { type: "treeOp", op: { t: "delete", opId: "op2", id: "n1", baseSeq: 1 } });
		expect(core.liveEntries()).toHaveLength(0);
		// The deleter's own trailing edit was made before its delete: no revival.
		await send("a", { type: "update", dseq: 1, docId: "n1", update: textUpdate("typed before deleting").update });
		expect(core.liveEntries()).toHaveLength(0);
		await send("b", { type: "update", dseq: 1, docId: "n1", update: textUpdate("concurrent edit").update });
		expect(core.liveEntries().map((e) => e.id)).toEqual(["n1"]);
	});

	it("does not let a device's own edits block its own delete", async () => {
		await connect(conn("a", "devA"));
		await send("a", { type: "treeOp", op: { t: "create", opId: "op1", id: "n1", parent: ROOT_ID, name: "a.md", kind: "markdown" } });
		await send("a", { type: "update", dseq: 1, docId: "n1", update: textUpdate("seed").update });
		core.flush(); // the device's own edit lands at a seq newer than its delete's base
		await send("a", { type: "treeOp", op: { t: "delete", opId: "op2", id: "n1", baseSeq: 1 } });
		expect(transport.of("a", "treeResult").at(-1)!.result.r).toBe("ok");
		expect(core.liveEntries()).toHaveLength(0);
	});

	it("keeps viewers read-only", async () => {
		await connect(conn("v", "devV", "viewer", "u2"));
		expect(transport.of("v", "welcome")[0]!.readOnly).toBe(true);
		await send("v", { type: "update", dseq: 1, docId: "doc1", update: textUpdate("nope").update });
		expect(transport.of("v", "control").some((f) => f.msg.t === "error" && f.msg.code === "read_only")).toBe(true);
		await send("v", { type: "treeOp", op: { t: "create", opId: "x", id: "n", parent: ROOT_ID, name: "a.md", kind: "markdown" } });
		expect(transport.of("v", "treeResult")[0]!.result).toMatchObject({ r: "rejected", reason: "forbidden" });
	});

	it("rejects tokens minted before a membership change and closes revoked devices", async () => {
		expect(core.admitConnection({ sub: "u1", dev: "devA", aclv: 1 })).toMatchObject({ ok: true, role: "owner" });
		expect(core.admitConnection({ sub: "stranger", dev: "devX", aclv: 1 })).toMatchObject({ ok: false, status: 403 });
		await connect(conn("a", "devA"));
		core.revokeDevice("devA");
		expect(transport.closed.map((c) => c.id)).toContain("a");
		expect(core.admitConnection({ sub: "u1", dev: "devA", aclv: 1 })).toMatchObject({ ok: false, status: 403 });
		core.setAcl([{ userId: "u1", role: "editor", aclv: 2 }], false);
		expect(core.admitConnection({ sub: "u1", dev: "devB", aclv: 1 })).toMatchObject({ ok: false, status: 401 });
	});

	it("stays within the row budget for an hour of typing", async () => {
		await connect(conn("a", "devA"));
		const doc = new Y.Doc();
		let dseq = 0;
		// One batch every 250 ms for an hour of continuous typing.
		for (let i = 0; i < 4 * 3600; i++) {
			const { update } = textUpdate("k", doc);
			await send("a", { type: "update", dseq: ++dseq, docId: "doc1", update });
			clock.advance(250);
		}
		clock.advance(60_000);
		const day = new Date(clock.now()).toISOString().slice(0, 10);
		const rows = core.rowsWrittenOn(day);
		expect(rows).toBeLessThan(2_000);
	});
});
