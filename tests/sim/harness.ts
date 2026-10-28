import { DatabaseSync } from "node:sqlite";
import { FolderCore, type ConnInfo, type Transport } from "../../server/src/core/folderCore";
import type { Role } from "@shared/protocol/frames";
import type { FileStat, Logger, SocketLike, VaultEntry, VaultEvent, VaultPort } from "../../src/engine/ports";
import { ShareSession, type EngineNotice } from "../../src/engine/session";
import { MemoryStore } from "../../src/engine/store";
import { isWithin } from "../../src/engine/paths";
import { FakeClock } from "./fakes";
import { NodeSql } from "./nodeSql";

const tick = () => new Promise<void>((r) => setImmediate(r));

/** In-memory vault with Obsidian-like event semantics (events fire after the operation). */
export class FakeVault implements VaultPort {
	files = new Map<string, { data: string; mtime: number }>();
	folders = new Set<string>();
	private listeners: Array<(ev: VaultEvent) => void> = [];
	private seq = 0;

	constructor(private clock: FakeClock) {}

	on(fn: (ev: VaultEvent) => void): void {
		this.listeners.push(fn);
	}

	private emit(ev: VaultEvent): void {
		const listeners = [...this.listeners];
		void Promise.resolve().then(() => listeners.forEach((l) => l(ev)));
	}

	private mtime(): number {
		return this.clock.now() + ++this.seq;
	}

	private ensureParents(path: string, emit: boolean): void {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (!this.folders.has(dir)) {
				this.folders.add(dir);
				if (emit) this.emit({ type: "create", path: dir, isFolder: true });
			}
		}
	}

	// ---- port (what the engine calls)

	async list(prefix: string): Promise<VaultEntry[]> {
		const out: VaultEntry[] = [];
		for (const f of this.folders) if (f !== prefix && isWithin(f, prefix)) out.push({ path: f, isFolder: true, mtime: 0, size: 0 });
		for (const [p, f] of this.files) if (isWithin(p, prefix)) out.push({ path: p, isFolder: false, mtime: f.mtime, size: f.data.length });
		return out;
	}

	async stat(path: string): Promise<FileStat | null> {
		const f = this.files.get(path);
		if (f) return { mtime: f.mtime, size: f.data.length, isFolder: false };
		if (this.folders.has(path)) return { mtime: 0, size: 0, isFolder: true };
		return null;
	}

	async readText(path: string): Promise<string> {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT ${path}`);
		return f.data;
	}

	async process(path: string, fn: (current: string) => string | null): Promise<boolean> {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT ${path}`);
		const next = fn(f.data);
		if (next === null) return false;
		if (next !== f.data) {
			this.files.set(path, { data: next, mtime: this.mtime() });
			this.emit({ type: "modify", path });
		}
		return true;
	}

	async createText(path: string, data: string): Promise<void> {
		if (this.files.has(path) || this.folders.has(path)) throw new Error(`EEXIST ${path}`);
		this.ensureParents(path, true);
		this.files.set(path, { data, mtime: this.mtime() });
		this.emit({ type: "create", path, isFolder: false });
	}

	async mkdir(path: string): Promise<void> {
		if (this.folders.has(path)) return;
		this.ensureParents(path, true);
		this.folders.add(path);
		this.emit({ type: "create", path, isFolder: true });
	}

	async rename(from: string, to: string): Promise<void> {
		if (this.files.has(to) || this.folders.has(to)) throw new Error(`EEXIST ${to}`);
		this.ensureParents(to, true);
		if (this.files.has(from)) {
			this.files.set(to, this.files.get(from)!);
			this.files.delete(from);
			this.emit({ type: "rename", path: to, oldPath: from, isFolder: false });
			return;
		}
		if (!this.folders.has(from)) throw new Error(`ENOENT ${from}`);
		const moved: Array<[string, string, boolean]> = [];
		for (const f of [...this.folders]) if (isWithin(f, from)) moved.push([f, to + f.slice(from.length), true]);
		for (const p of [...this.files.keys()]) if (isWithin(p, from)) moved.push([p, to + p.slice(from.length), false]);
		for (const [o, n, isFolder] of moved) {
			if (isFolder) {
				this.folders.delete(o);
				this.folders.add(n);
			} else {
				this.files.set(n, this.files.get(o)!);
				this.files.delete(o);
			}
		}
		// Obsidian reports the folder and then every descendant.
		for (const [o, n, isFolder] of moved) this.emit({ type: "rename", path: n, oldPath: o, isFolder });
	}

	async trash(path: string): Promise<void> {
		if (this.files.delete(path)) {
			this.emit({ type: "delete", path, isFolder: false });
			return;
		}
		if (this.folders.has(path)) {
			for (const p of [...this.files.keys()]) if (isWithin(p, path)) {
				this.files.delete(p);
				this.emit({ type: "delete", path: p, isFolder: false });
			}
			for (const f of [...this.folders].sort((a, b) => b.length - a.length)) if (isWithin(f, path)) {
				this.folders.delete(f);
				this.emit({ type: "delete", path: f, isFolder: true });
			}
		}
	}

	// ---- user actions (what a person or another tool does)

	write(path: string, data: string, emit = true): void {
		const existed = this.files.has(path);
		this.ensureParents(path, emit);
		this.files.set(path, { data, mtime: this.mtime() });
		if (emit) this.emit(existed ? { type: "modify", path } : { type: "create", path, isFolder: false });
	}

	remove(path: string, emit = true): void {
		if (this.files.delete(path) && emit) this.emit({ type: "delete", path, isFolder: false });
	}

	read(path: string): string | undefined {
		return this.files.get(path)?.data;
	}

	snapshot(prefix = ""): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [p, f] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) if (isWithin(p, prefix)) out[p] = f.data;
		return out;
	}

	folderList(prefix = ""): string[] {
		return [...this.folders].filter((f) => isWithin(f, prefix) && f !== prefix).sort();
	}
}

interface SimConn {
	info: ConnInfo;
	socket: SimSocket;
}

/** Client side of an in-process WebSocket. Delivery is asynchronous, like a real network. */
class SimSocket implements SocketLike {
	binaryType = "arraybuffer";
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	connId = "";

	constructor(private server: SimServer, readonly device: Device) {}

	send(data: Uint8Array | string): void {
		if (this.readyState !== 1) return;
		const copy = typeof data === "string" ? data : data.slice();
		this.server.inflight++;
		void tick().then(() => {
			this.server.inflight--;
			this.server.deliverToServer(this, copy);
		});
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.server.dropConn(this.connId);
		void tick().then(() => this.onclose?.({ code, reason }));
	}

	deliver(data: Uint8Array | string): void {
		if (this.readyState !== 1) return;
		const payload = typeof data === "string" ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
		this.onmessage?.({ data: payload });
	}
}

/** One FolderRoom (real FolderCore over node:sqlite) plus the in-process network. */
export class SimServer implements Transport {
	core!: FolderCore;
	db = new DatabaseSync(":memory:");
	conns = new Map<string, SimConn>();
	inflight = 0;
	private nextConn = 1;
	roles = new Map<string, Role>();

	constructor(readonly clock: FakeClock) {
		this.boot();
		this.core.init("folder-1", "server-1", [
			{ userId: "owner", role: "owner", aclv: 1 },
			{ userId: "viewer", role: "viewer", aclv: 1 },
		]);
	}

	/** (Re)creates the room over the same database: an eviction drops all memory. */
	boot(): void {
		this.core = new FolderCore({ sql: new NodeSql(this.db), transport: this, clock: this.clock, verifyAccess: async () => null });
	}

	evict(): void {
		for (const c of [...this.conns.values()]) c.socket.close(1012, "evicted");
		this.core.dispose();
		this.boot();
	}

	connect(device: Device): SimSocket {
		const s = new SimSocket(this, device);
		void tick().then(() => {
			if (!device.online) {
				s.readyState = 3;
				s.onclose?.({ code: 1006, reason: "offline" });
				return;
			}
			const info: ConnInfo = {
				id: `c${this.nextConn++}`,
				userId: device.userId,
				deviceId: device.id,
				deviceLabel: device.label,
				role: device.userId === "viewer" ? "viewer" : "owner",
				exp: this.clock.now() + 10 * 365 * 86400_000,
				aclv: 1,
				ready: false,
			};
			s.connId = info.id;
			this.conns.set(info.id, { info, socket: s });
			this.core.onOpen(info);
			s.readyState = 1;
			s.onopen?.({});
		});
		return s;
	}

	deliverToServer(s: SimSocket, data: Uint8Array | string): void {
		if (!this.conns.has(s.connId)) return;
		if (data === "ping") {
			this.send(s.connId, "pong");
			return;
		}
		void this.core.onMessage(s.connId, data);
	}

	dropConn(id: string): void {
		if (this.conns.delete(id)) this.core.onClose(id);
	}

	disconnectDevice(device: Device): void {
		for (const c of [...this.conns.values()]) if (c.info.deviceId === device.id) c.socket.close(1006, "network lost");
	}

	// Transport
	send(connId: string, data: Uint8Array | string): void {
		const c = this.conns.get(connId);
		if (!c) return;
		const copy = typeof data === "string" ? data : data.slice();
		this.inflight++;
		void tick().then(() => {
			this.inflight--;
			c.socket.deliver(copy);
		});
	}
	close(connId: string, code: number, reason: string): void {
		this.conns.get(connId)?.socket.close(code, reason);
	}
	connections(): ConnInfo[] {
		return [...this.conns.values()].map((c) => c.info);
	}
	update(connId: string, patch: Partial<ConnInfo>): void {
		const c = this.conns.get(connId);
		if (c) Object.assign(c.info, patch);
	}
}

export class Device {
	vault: FakeVault;
	store = new MemoryStore();
	session!: ShareSession;
	online = true;
	notices: EngineNotice[] = [];
	logs: Array<{ level: string; event: string; detail?: unknown }> = [];

	constructor(
		readonly id: string,
		readonly label: string,
		readonly sim: Sim,
		readonly mount = "Shared",
		readonly userId = "owner",
	) {
		this.vault = new FakeVault(sim.clock);
		this.vault.folders.add(mount);
		this.vault.on((ev) => this.session?.onVaultEvent(ev));
	}

	async start(): Promise<void> {
		const log: Logger = (level, event, detail) => {
			this.logs.push({ level, event, detail });
			if (level === "error") console.error(this.id, event, detail);
		};
		this.session = new ShareSession(
			{
				folderId: "folder-1",
				mount: this.mount,
				deviceId: this.id,
				deviceLabel: this.label,
				socketUrl: "sim://folder-1",
				isExcluded: (p) => p.startsWith(".obsidian") || p.startsWith(".trash"),
				checkInvariants: true,
			},
			{
				vault: this.vault,
				store: this.store,
				clock: this.sim.clock,
				log,
				socketFactory: () => this.sim.server.connect(this),
				getToken: async () => "sim-token",
				notify: (n) => this.notices.push(n),
			},
		);
		await this.session.start();
	}

	async stop(): Promise<void> {
		await this.session.stop();
	}

	goOffline(): void {
		this.online = false;
		this.sim.server.disconnectDevice(this);
	}

	goOnline(): void {
		this.online = true;
		this.session.reconnect();
	}

	files(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [p, data] of Object.entries(this.vault.snapshot(this.mount))) out[p.slice(this.mount.length + 1)] = data;
		return out;
	}
}

export class Sim {
	clock = new FakeClock();
	server = new SimServer(this.clock);
	devices: Device[] = [];

	device(id: string, label = id, mount = "Shared", userId = "owner"): Device {
		const d = new Device(id, label, this, mount, userId);
		this.devices.push(d);
		return d;
	}

	/** Runs network, timers and engine tasks until everything is quiet. */
	async settle(maxSteps = Number(process.env.SIM_MAX_STEPS ?? 4000)): Promise<void> {
		let quietRounds = 0;
		for (let i = 0; i < maxSteps; i++) {
			for (let k = 0; k < 5; k++) await tick();
			const online = this.devices.filter((d) => d.online && d.session);
			const quiet = this.server.inflight === 0 && online.every((d) => d.session.isQuiet());
			if (quiet) {
				quietRounds++;
				// The server flushes on a timer; give it time, then require a few quiet rounds.
				this.clock.advance(6_000);
				if (quietRounds >= 3) return;
			} else {
				quietRounds = 0;
				this.clock.advance(200);
			}
		}
		const states = this.devices.map((d) => ({ id: d.id, status: d.session?.status(), quiet: d.session?.isQuiet() }));
		throw new Error(`simulation did not settle: ${JSON.stringify(states)} inflight=${this.server.inflight}`);
	}
}
