import type { Clock, ConnInfo, Transport } from "../../server/src/core/folderCore";
import { decodeFrame, type Frame } from "@shared/protocol/frames";

/** Manually advanced clock with timers, for deterministic tests. */
export class FakeClock implements Clock {
	t = Date.UTC(2026, 9, 28, 12, 0, 0);
	private timers = new Map<number, { at: number; fn: () => void }>();
	private nextId = 1;

	now(): number {
		return this.t;
	}

	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { at: this.t + ms, fn });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	/** Advances time, firing due timers in order (timers may schedule more timers). */
	advance(ms: number): void {
		const end = this.t + ms;
		for (;;) {
			let due: [number, { at: number; fn: () => void }] | null = null;
			for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
			if (!due) break;
			this.timers.delete(due[0]);
			this.t = Math.max(this.t, due[1].at);
			due[1].fn();
		}
		this.t = end;
	}

	pending(): number {
		return this.timers.size;
	}
}

/** Transport that records frames per connection. */
export class FakeTransport implements Transport {
	conns = new Map<string, ConnInfo>();
	inbox = new Map<string, Frame[]>();
	closed: Array<{ id: string; code: number; reason: string }> = [];
	onSend?: (connId: string, data: Uint8Array) => void;

	add(c: ConnInfo): void {
		this.conns.set(c.id, c);
		this.inbox.set(c.id, []);
	}

	send(connId: string, data: Uint8Array): void {
		const f = decodeFrame(data);
		if (f) this.inbox.get(connId)?.push(f);
		this.onSend?.(connId, data);
	}

	close(connId: string, code: number, reason: string): void {
		this.conns.delete(connId);
		this.closed.push({ id: connId, code, reason });
	}

	connections(): ConnInfo[] {
		return [...this.conns.values()];
	}

	update(connId: string, patch: Partial<ConnInfo>): void {
		const c = this.conns.get(connId);
		if (c) Object.assign(c, patch);
	}

	take(connId: string): Frame[] {
		const frames = this.inbox.get(connId) ?? [];
		this.inbox.set(connId, []);
		return frames;
	}

	of<T extends Frame["type"]>(connId: string, type: T): Array<Extract<Frame, { type: T }>> {
		return (this.inbox.get(connId) ?? []).filter((f): f is Extract<Frame, { type: T }> => f.type === type);
	}
}
