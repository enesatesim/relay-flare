import { constantTimeEqual, fromBase64Url, randomBytes, randomId, sha256, toBase64Url } from "../shared/bytes";
import type { Role } from "../shared/protocol/frames";
import { ACCESS_TOKEN_TTL_MS, signToken, type AccessClaims, type SigningKey } from "../shared/token";
import { normalizeName } from "../shared/tree/names";
import type { AclEntry } from "./folderCore";
import { migrate, num, one, str, strOrNull, type SqlPort } from "./sql";

// The control plane: one per server. Owns identity (users, devices), folders, memberships,
// invites and signing keys. Folder rooms receive membership changes through FolderPort.

const CONTROL_MIGRATIONS: readonly string[][] = [
	[
		`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE keys (kid TEXT PRIMARY KEY, secret BLOB NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER) WITHOUT ROWID`,
		`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, role TEXT NOT NULL, aclv INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, disabled_at INTEGER) WITHOUT ROWID`,
		`CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL, secret_hash BLOB NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER) WITHOUT ROWID`,
		`CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER) WITHOUT ROWID`,
		`CREATE TABLE memberships (folder_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (folder_id, user_id)) WITHOUT ROWID`,
		`CREATE TABLE pairings (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER) WITHOUT ROWID`,
		`CREATE TABLE recovery (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER) WITHOUT ROWID`,
		`CREATE TABLE invites (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, folder_ids TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, require_approval INTEGER NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL)`,
		`CREATE TABLE ratelimit (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT)`,
	],
];

export type FolderMessage =
	| { t: "init"; folderId: string; serverId: string; acl: AclEntry[] }
	| { t: "acl"; acl: AclEntry[] }
	| { t: "removeMember"; userId: string }
	| { t: "revokeDevice"; deviceId: string };

/** Delivers control-plane changes to folder rooms. Throws when the room is unreachable. */
export interface FolderPort {
	send(folderId: string, message: FolderMessage): Promise<void>;
}

export interface ControlEnv {
	sql: SqlPort;
	now(): number;
	folders: FolderPort;
	/** The SETUP_PASSPHRASE secret, when the deployer set one. */
	setupPassphrase?: string;
	log?: (event: string, detail?: Record<string, unknown>) => void;
}

export class ControlError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export interface FolderSummary {
	id: string;
	name: string;
	role: Role;
}

export interface SessionResult {
	token: string;
	exp: number;
	serverId: string;
	user: { id: string; name: string; color: string; role: string };
	device: { id: string; name: string };
	folders: FolderSummary[];
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PALETTE = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

function codeAlphabet(n: number): string {
	// Unambiguous characters only, grouped for reading aloud: XXXX-XXXX-XXXX.
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
	const bytes = randomBytes(n);
	let out = "";
	for (let i = 0; i < n; i++) {
		if (i > 0 && i % 4 === 0) out += "-";
		out += alphabet[bytes[i]! % alphabet.length];
	}
	return out;
}

function normalizeCode(code: string): string {
	return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function hashCode(code: string): Promise<string> {
	return toBase64Url(await sha256(normalizeCode(code)));
}

export class ControlCore {
	private readonly sql: SqlPort;

	constructor(private readonly env: ControlEnv) {
		this.sql = env.sql;
		migrate(this.sql, CONTROL_MIGRATIONS);
	}

	private get(key: string): string | null {
		const row = one(this.sql.exec<{ value: string }>("SELECT value FROM config WHERE key = ?", key));
		return row ? str(row.value) : null;
	}

	private set(key: string, value: string): void {
		this.sql.exec("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
	}

	private audit(actor: string | null, action: string, detail?: Record<string, unknown>): void {
		this.sql.exec("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", this.env.now(), actor, action, detail ? JSON.stringify(detail) : null);
	}

	serverId(): string {
		let id = this.get("server_id");
		if (!id) {
			id = randomId(12);
			this.set("server_id", id);
		}
		return id;
	}

	isClaimed(): boolean {
		return this.get("claimed_at") !== null;
	}

	/**
	 * When the deployer set no SETUP_PASSPHRASE, a one-time claim code is generated and
	 * written to the Worker log. Only someone with access to the Cloudflare account can see it.
	 */
	claimSecretHint(): "passphrase" | "log-code" {
		if (this.env.setupPassphrase) return "passphrase";
		if (!this.get("claim_code")) {
			const code = codeAlphabet(12);
			this.set("claim_code", code);
			console.log(`[relay-flare] One-time claim code: ${code}  (shown because SETUP_PASSPHRASE is not set)`);
		}
		return "log-code";
	}

	/** Limits attempts per key within a window. Throws 429 when exceeded. */
	rateLimit(key: string, max: number, windowMs: number): void {
		const now = this.env.now();
		const row = one(this.sql.exec<{ window_start: number; count: number }>("SELECT window_start, count FROM ratelimit WHERE key = ?", key));
		if (!row || now - num(row.window_start) >= windowMs) {
			this.sql.exec("INSERT OR REPLACE INTO ratelimit (key, window_start, count) VALUES (?, ?, 1)", key, now);
			return;
		}
		if (num(row.count) >= max) throw new ControlError(429, "rate_limited", "Too many attempts. Try again later.");
		this.sql.exec("UPDATE ratelimit SET count = count + 1 WHERE key = ?", key);
	}

	async claim(input: { secret: string; ownerName: string }): Promise<{ pairingCode: string; recoveryCode: string; serverId: string; userId: string }> {
		this.rateLimit("claim", 10, 10 * 60 * 1000);
		if (this.isClaimed()) throw new ControlError(409, "already_claimed", "This server has already been claimed.");
		const hint = this.claimSecretHint();
		const expected = hint === "passphrase" ? this.env.setupPassphrase! : normalizeCode(this.get("claim_code") ?? "");
		const given = hint === "passphrase" ? input.secret : normalizeCode(input.secret);
		if (!expected || !constantTimeEqual(await sha256(given), await sha256(expected))) {
			throw new ControlError(403, "bad_secret", hint === "passphrase" ? "The setup passphrase is not correct." : "The claim code is not correct.");
		}
		const name = normalizeName(input.ownerName.trim()).slice(0, 60);
		if (!name) throw new ControlError(400, "bad_name", "Enter your name.");
		const now = this.env.now();
		const userId = randomId(12);
		const recoveryCode = codeAlphabet(20);
		const pairingCode = codeAlphabet(12);
		const recoveryHash = await hashCode(recoveryCode);
		const pairingHash = await hashCode(pairingCode);
		this.sql.transaction(() => {
			if (this.isClaimed()) throw new ControlError(409, "already_claimed", "This server has already been claimed.");
			this.sql.exec("INSERT INTO users (id, name, color, role, aclv, created_at) VALUES (?, ?, ?, 'owner', 1, ?)", userId, name, PALETTE[0]!, now);
			this.sql.exec("INSERT INTO recovery (code_hash, user_id, created_at) VALUES (?, ?, ?)", recoveryHash, userId, now);
			this.sql.exec("INSERT INTO pairings (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", pairingHash, userId, now, now + PAIRING_TTL_MS);
			this.set("claimed_at", String(now));
			this.sql.exec("DELETE FROM config WHERE key = 'claim_code'");
			this.ensureKey();
			this.audit(userId, "claim", { name });
		});
		return { pairingCode, recoveryCode, serverId: this.serverId(), userId };
	}

	/** Current signing keys (active first). Generated on first use. */
	keys(): SigningKey[] {
		this.ensureKey();
		return this.sql
			.exec<{ kid: string; secret: Uint8Array }>("SELECT kid, secret FROM keys WHERE retired_at IS NULL ORDER BY created_at DESC")
			.map((r) => ({ kid: str(r.kid), secret: r.secret instanceof Uint8Array ? r.secret : new Uint8Array(0) }));
	}

	private ensureKey(): void {
		if (!one(this.sql.exec("SELECT kid FROM keys WHERE retired_at IS NULL LIMIT 1"))) {
			this.sql.exec("INSERT INTO keys (kid, secret, created_at) VALUES (?, ?, ?)", randomId(6), randomBytes(32), this.env.now());
		}
	}

	async createPairing(userId: string): Promise<{ code: string; expiresAt: number }> {
		this.requireUser(userId);
		const code = codeAlphabet(12);
		const now = this.env.now();
		this.sql.exec("INSERT INTO pairings (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", await hashCode(code), userId, now, now + PAIRING_TTL_MS);
		this.audit(userId, "pairing.create");
		return { code, expiresAt: now + PAIRING_TTL_MS };
	}

	async pair(input: { code: string; deviceName: string; platform: string }): Promise<{ deviceId: string; deviceSecret: string; userId: string; serverId: string }> {
		this.rateLimit("pair", 20, 10 * 60 * 1000);
		const now = this.env.now();
		const codeHash = await hashCode(input.code);
		const row = one(this.sql.exec("SELECT user_id, expires_at, used_at FROM pairings WHERE code_hash = ?", codeHash));
		if (!row || row.used_at != null || num(row.expires_at) < now) {
			throw new ControlError(403, "bad_code", "This pairing code is invalid or has expired. Create a new one.");
		}
		const userId = str(row.user_id);
		this.requireUser(userId);
		const deviceId = randomId(12);
		const secret = randomBytes(32);
		const secretHash = await sha256(secret);
		const deviceName = normalizeName(input.deviceName.trim()).slice(0, 60) || "Device";
		this.sql.transaction(() => {
			// Re-check inside the transaction: a code is single-use even under concurrent redeems.
			const again = one(this.sql.exec("SELECT used_at FROM pairings WHERE code_hash = ?", codeHash));
			if (!again || again.used_at != null) throw new ControlError(403, "bad_code", "This pairing code was already used.");
			this.sql.exec("UPDATE pairings SET used_at = ? WHERE code_hash = ?", now, codeHash);
			this.sql.exec(
				"INSERT INTO devices (id, user_id, name, platform, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				deviceId,
				userId,
				deviceName,
				input.platform.slice(0, 20),
				secretHash,
				now,
			);
			this.audit(userId, "device.pair", { deviceId, deviceName });
		});
		return { deviceId, deviceSecret: toBase64Url(secret), userId, serverId: this.serverId() };
	}

	async recover(input: { code: string }): Promise<{ pairingCode: string }> {
		this.rateLimit("recover", 5, 60 * 60 * 1000);
		const codeHash = await hashCode(input.code);
		const row = one(this.sql.exec("SELECT user_id, used_at FROM recovery WHERE code_hash = ?", codeHash));
		if (!row || row.used_at != null) throw new ControlError(403, "bad_code", "This recovery code is not valid.");
		const userId = str(row.user_id);
		this.sql.exec("UPDATE recovery SET used_at = ? WHERE code_hash = ?", this.env.now(), codeHash);
		const pairing = await this.createPairing(userId);
		this.audit(userId, "recover");
		return { pairingCode: pairing.code };
	}

	async session(input: { deviceId: string; deviceSecret: string }): Promise<SessionResult> {
		this.rateLimit(`session:${input.deviceId}`, 120, 60 * 60 * 1000);
		const device = one(this.sql.exec("SELECT id, user_id, name, secret_hash, revoked_at FROM devices WHERE id = ?", input.deviceId));
		const secret = fromBase64Url(input.deviceSecret);
		const expected = device?.secret_hash instanceof Uint8Array ? device.secret_hash : new Uint8Array(32);
		const actual = await sha256(secret ?? new Uint8Array(0));
		if (!device || !secret || !constantTimeEqual(actual, expected) || device.revoked_at != null) {
			throw new ControlError(401, "unauthorized", "This device is not authorized. Pair it again.");
		}
		const user = this.requireUser(str(device.user_id));
		const now = this.env.now();
		this.sql.exec("UPDATE devices SET last_seen = ? WHERE id = ?", now, input.deviceId);
		const key = this.keys()[0]!;
		const exp = now + ACCESS_TOKEN_TTL_MS;
		const claims: AccessClaims = { v: 1, typ: "access", kid: key.kid, sid: this.serverId(), sub: user.id, dev: input.deviceId, dn: str(device.name), aclv: user.aclv, iat: now, exp };
		return {
			token: await signToken(claims, key),
			exp,
			serverId: this.serverId(),
			user: { id: user.id, name: user.name, color: user.color, role: user.role },
			device: { id: input.deviceId, name: str(device.name) },
			folders: this.listFolders(user.id),
		};
	}

	private requireUser(userId: string): { id: string; name: string; color: string; role: string; aclv: number } {
		const u = one(this.sql.exec("SELECT id, name, color, role, aclv, disabled_at FROM users WHERE id = ?", userId));
		if (!u || u.disabled_at != null) throw new ControlError(401, "unauthorized", "This account is disabled.");
		return { id: str(u.id), name: str(u.name), color: str(u.color), role: str(u.role), aclv: num(u.aclv) };
	}

	/** Device name for display in conflict names and presence. */
	deviceLabel(deviceId: string): string {
		const d = one(this.sql.exec("SELECT name FROM devices WHERE id = ?", deviceId));
		return d ? str(d.name) : "device";
	}

	listFolders(userId: string): FolderSummary[] {
		return this.sql
			.exec("SELECT f.id, f.name, m.role FROM folders f JOIN memberships m ON m.folder_id = f.id WHERE m.user_id = ? AND f.deleted_at IS NULL ORDER BY f.name", userId)
			.map((r) => ({ id: str(r.id), name: str(r.name), role: str(r.role) as Role }));
	}

	private aclFor(folderId: string): AclEntry[] {
		return this.sql
			.exec("SELECT m.user_id, m.role, u.aclv FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.folder_id = ? AND u.disabled_at IS NULL", folderId)
			.map((r) => ({ userId: str(r.user_id), role: str(r.role) as Role, aclv: num(r.aclv) }));
	}

	async createFolder(userId: string, name: string): Promise<FolderSummary> {
		const user = this.requireUser(userId);
		if (user.role !== "owner") throw new ControlError(403, "forbidden", "Only the server owner can create shared folders.");
		const clean = normalizeName(name.trim()).slice(0, 120);
		if (!clean) throw new ControlError(400, "bad_name", "Enter a folder name.");
		const id = randomId(12);
		const now = this.env.now();
		this.sql.transaction(() => {
			this.sql.exec("INSERT INTO folders (id, name, created_by, created_at) VALUES (?, ?, ?, ?)", id, clean, userId, now);
			this.sql.exec("INSERT INTO memberships (folder_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", id, userId, now);
			this.audit(userId, "folder.create", { id, name: clean });
		});
		await this.deliver(id, { t: "init", folderId: id, serverId: this.serverId(), acl: this.aclFor(id) });
		return { id, name: clean, role: "owner" };
	}

	async revokeDevice(actorId: string, deviceId: string): Promise<void> {
		const actor = this.requireUser(actorId);
		const device = one(this.sql.exec("SELECT user_id FROM devices WHERE id = ?", deviceId));
		if (!device) throw new ControlError(404, "not_found", "Unknown device.");
		if (str(device.user_id) !== actorId && actor.role !== "owner") throw new ControlError(403, "forbidden", "You can only revoke your own devices.");
		this.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", this.env.now(), deviceId);
		this.audit(actorId, "device.revoke", { deviceId });
		const folders = this.sql.exec("SELECT folder_id FROM memberships WHERE user_id = ?", str(device.user_id)).map((r) => str(r.folder_id));
		await Promise.all(folders.map((f) => this.deliver(f, { t: "revokeDevice", deviceId })));
	}

	listDevices(userId: string): Array<{ id: string; name: string; platform: string; createdAt: number; lastSeen: number | null; revoked: boolean }> {
		return this.sql
			.exec("SELECT id, name, platform, created_at, last_seen, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at", userId)
			.map((r) => ({ id: str(r.id), name: str(r.name), platform: str(r.platform), createdAt: num(r.created_at), lastSeen: r.last_seen == null ? null : num(r.last_seen), revoked: r.revoked_at != null }));
	}

	/** Sends to a folder room, parking the message in the outbox when the room is unreachable. */
	private async deliver(folderId: string, message: FolderMessage): Promise<void> {
		try {
			await this.env.folders.send(folderId, message);
		} catch (err) {
			this.env.log?.("outbox.park", { folderId, error: String(err) });
			this.sql.exec("INSERT INTO outbox (folder_id, payload, next_at) VALUES (?, ?, ?)", folderId, JSON.stringify(message), this.env.now() + 5_000);
		}
	}

	/** Retries parked folder messages. Returns the time of the next due retry, if any. */
	async drainOutbox(): Promise<number | null> {
		const now = this.env.now();
		for (const r of this.sql.exec("SELECT id, folder_id, payload, attempts FROM outbox WHERE next_at <= ? ORDER BY id LIMIT 50", now)) {
			try {
				await this.env.folders.send(str(r.folder_id), JSON.parse(str(r.payload)) as FolderMessage);
				this.sql.exec("DELETE FROM outbox WHERE id = ?", num(r.id));
			} catch {
				const attempts = num(r.attempts) + 1;
				this.sql.exec("UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?", attempts, now + Math.min(3_600_000, 5_000 * 2 ** attempts), num(r.id));
			}
		}
		const next = one(this.sql.exec<{ next_at: number }>("SELECT MIN(next_at) AS next_at FROM outbox"));
		return next && next.next_at != null ? num(next.next_at) : null;
	}

	status(): { claimed: boolean; serverId: string; claimSecret: "passphrase" | "log-code" | null } {
		const claimed = this.isClaimed();
		return { claimed, serverId: this.serverId(), claimSecret: claimed ? null : this.claimSecretHint() };
	}

	userName(userId: string): string | null {
		const u = one(this.sql.exec("SELECT name FROM users WHERE id = ?", userId));
		return u ? strOrNull(u.name) : null;
	}
}
