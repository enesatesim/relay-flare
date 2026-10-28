import { decodeFrame, encodeFrame, type Frame } from "@shared/protocol/frames";
import { WS_BEARER_PREFIX, WS_PROTOCOL } from "@shared/token";
import type { Clock, Logger, SocketFactory, SocketLike } from "./ports";

export type SocketState = "idle" | "connecting" | "open" | "closed" | "stopped";

export interface FolderSocketOptions {
	url: string;
	/** Returns a fresh access token (the token manager refreshes it before expiry). */
	getToken(): Promise<string>;
	factory: SocketFactory;
	clock: Clock;
	log: Logger;
	onFrame(frame: Frame): void;
	onOpen(): void;
	onClose(info: { code: number; reason: string }): void;
	/** Base and cap for full-jitter backoff. */
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	pingIntervalMs?: number;
	pongTimeoutMs?: number;
}

/**
 * One multiplexed socket per share. Reconnects with full-jitter backoff, detects half-open
 * connections with ping/pong (answered by the server without waking the room) and never
 * puts the bearer token in the URL.
 */
export class FolderSocket {
	private ws: SocketLike | null = null;
	private state: SocketState = "idle";
	private attempt = 0;
	private retryTimer: unknown = null;
	private pingTimer: unknown = null;
	private pongTimer: unknown = null;
	private openedAt = 0;
	private generation = 0;

	constructor(private readonly o: FolderSocketOptions) {}

	get status(): SocketState {
		return this.state;
	}

	get isOpen(): boolean {
		return this.state === "open";
	}

	start(): void {
		if (this.state === "connecting" || this.state === "open") return;
		this.state = "idle";
		void this.connect();
	}

	/** Stops for good (until start()). Used on revoke, update_required and plugin unload. */
	stop(): void {
		this.state = "stopped";
		this.clearTimers();
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			ws.onclose = null;
			ws.onmessage = null;
			try {
				ws.close(1000, "stopped");
			} catch {
				// ignore
			}
		}
	}

	/** Drops the current connection and reconnects right away (network change, resume). */
	reconnectNow(): void {
		if (this.state === "stopped") return;
		this.attempt = 0;
		this.dropSocket("reconnect");
		void this.connect();
	}

	send(frame: Frame): boolean {
		if (this.state !== "open" || !this.ws) return false;
		try {
			this.ws.send(encodeFrame(frame));
			return true;
		} catch {
			return false;
		}
	}

	private async connect(): Promise<void> {
		if (this.state === "stopped") return;
		this.clearTimers();
		this.state = "connecting";
		const gen = ++this.generation;
		let token: string;
		try {
			token = await this.o.getToken();
		} catch (err) {
			this.o.log("warn", "socket.token_failed", { error: String(err) });
			if (gen === this.generation) this.scheduleRetry();
			return;
		}
		if (gen !== this.generation || (this.state as SocketState) === "stopped") return;
		let ws: SocketLike;
		try {
			ws = this.o.factory(this.o.url, [WS_PROTOCOL, `${WS_BEARER_PREFIX}${token}`]);
		} catch (err) {
			this.o.log("warn", "socket.create_failed", { error: String(err) });
			this.scheduleRetry();
			return;
		}
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			if (gen !== this.generation) return;
			this.state = "open";
			this.openedAt = this.o.clock.now();
			this.schedulePing();
			this.o.onOpen();
		};
		ws.onmessage = (ev) => {
			if (gen !== this.generation) return;
			if (typeof ev.data === "string") {
				if (ev.data === "pong") this.onPong();
				return;
			}
			const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data instanceof Uint8Array ? ev.data : null;
			if (!bytes) return;
			const frame = decodeFrame(bytes);
			if (frame) this.o.onFrame(frame);
			else this.o.log("warn", "socket.bad_frame", { bytes: bytes.length });
		};
		ws.onclose = (ev) => {
			if (gen !== this.generation) return;
			this.ws = null;
			const wasOpen = this.state === "open";
			this.clearTimers();
			if (this.state !== "stopped") this.state = "closed";
			if (wasOpen && this.o.clock.now() - this.openedAt > 30_000) this.attempt = 0;
			this.o.onClose({ code: ev.code, reason: ev.reason });
			if (this.state !== "stopped") this.scheduleRetry();
		};
		ws.onerror = () => {
			// onclose follows; nothing to do here.
		};
	}

	private scheduleRetry(): void {
		if (this.state === "stopped") return;
		this.state = "closed";
		const base = this.o.backoffBaseMs ?? 500;
		const max = this.o.backoffMaxMs ?? 30_000;
		const cap = Math.min(max, base * 2 ** this.attempt);
		this.attempt = Math.min(this.attempt + 1, 16);
		const delay = Math.floor(Math.random() * (cap + 1));
		this.retryTimer = this.o.clock.setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, delay);
	}

	private schedulePing(): void {
		const interval = this.o.pingIntervalMs ?? 20_000;
		this.pingTimer = this.o.clock.setTimeout(() => {
			this.pingTimer = null;
			if (this.state !== "open" || !this.ws) return;
			try {
				this.ws.send("ping");
			} catch {
				return;
			}
			this.pongTimer = this.o.clock.setTimeout(() => {
				this.o.log("info", "socket.pong_timeout");
				this.dropSocket("pong timeout");
				this.scheduleRetry();
			}, this.o.pongTimeoutMs ?? 10_000);
		}, interval);
	}

	private onPong(): void {
		if (this.pongTimer !== null) {
			this.o.clock.clearTimeout(this.pongTimer);
			this.pongTimer = null;
		}
		this.schedulePing();
	}

	private dropSocket(reason: string): void {
		this.generation++;
		const ws = this.ws;
		this.ws = null;
		this.clearTimers();
		if (ws) {
			ws.onclose = null;
			ws.onmessage = null;
			ws.onopen = null;
			try {
				ws.close(4000, reason);
			} catch {
				// ignore
			}
			if (this.state === "open") this.o.onClose({ code: 4000, reason });
		}
		if (this.state !== "stopped") this.state = "closed";
	}

	private clearTimers(): void {
		for (const t of [this.retryTimer, this.pingTimer, this.pongTimer]) if (t !== null) this.o.clock.clearTimeout(t);
		this.retryTimer = this.pingTimer = this.pongTimer = null;
	}
}
