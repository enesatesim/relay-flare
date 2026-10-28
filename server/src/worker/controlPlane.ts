import { DurableObject } from "cloudflare:workers";
import { ControlCore, ControlError, type FolderMessage } from "../core/controlCore";
import { DoSql } from "./doSql";
import { folderStub, type Env } from "./env";

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

/** Singleton Durable Object holding identity, folders, memberships and signing keys. */
export class ControlPlane extends DurableObject<Env> {
	private core: ControlCore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.core = new ControlCore({
			sql: new DoSql(ctx.storage),
			now: () => Date.now(),
			setupPassphrase: env.SETUP_PASSPHRASE || undefined,
			folders: { send: (folderId, message) => this.sendToFolder(folderId, message) },
			log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
		});
	}

	private async sendToFolder(folderId: string, message: FolderMessage): Promise<void> {
		await folderStub(this.env, folderId).control(message);
	}

	/** Runs a core call and converts ControlErrors to a serializable result (errors lose their class over RPC). */
	private async run<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
		try {
			const value = await fn();
			const next = await this.core.drainOutbox().catch(() => null);
			if (next !== null) await this.ctx.storage.setAlarm(next);
			return { ok: true, value };
		} catch (err) {
			if (err instanceof ControlError) return { ok: false, status: err.status, code: err.code, message: err.message };
			console.error("control error", err);
			return { ok: false, status: 500, code: "internal", message: "Internal error." };
		}
	}

	override async alarm(): Promise<void> {
		const next = await this.core.drainOutbox();
		if (next !== null) await this.ctx.storage.setAlarm(next);
	}

	status() {
		return this.run(() => this.core.status());
	}
	keys() {
		return this.core.keys();
	}
	claim(input: { secret: string; ownerName: string }) {
		return this.run(() => this.core.claim(input));
	}
	pair(input: { code: string; deviceName: string; platform: string }) {
		return this.run(() => this.core.pair(input));
	}
	recover(input: { code: string }) {
		return this.run(() => this.core.recover(input));
	}
	session(input: { deviceId: string; deviceSecret: string }) {
		return this.run(() => this.core.session(input));
	}
	createPairing(userId: string) {
		return this.run(() => this.core.createPairing(userId));
	}
	listFolders(userId: string) {
		return this.run(() => this.core.listFolders(userId));
	}
	createFolder(userId: string, name: string) {
		return this.run(() => this.core.createFolder(userId, name));
	}
	listDevices(userId: string) {
		return this.run(() => this.core.listDevices(userId));
	}
	revokeDevice(userId: string, deviceId: string) {
		return this.run(() => this.core.revokeDevice(userId, deviceId));
	}
}
