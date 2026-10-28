import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { TreeEntry, TreeEvent, TreeOp, TreeResult } from "../tree/types";

// Binary frames on the folder socket. One socket per share per device carries every
// document of the share. JSON is used only for small structured control payloads.

export type Role = "owner" | "admin" | "editor" | "viewer";

export const T = {
	Hello: 0,
	Welcome: 1,
	Sync1: 2,
	Sync2: 3,
	Update: 4,
	Ack: 5,
	Bcast: 6,
	Heads: 7,
	TreeOp: 8,
	TreeResult: 9,
	TreeEvents: 10,
	TreeSnapshot: 11,
	Awareness: 12,
	Control: 13,
	CatchupDone: 14,
} as const;

export interface HelloFrame {
	type: "hello";
	protocol: number;
	schema: number;
	/** Epoch the client last saw; null for a device that never synced this share. */
	epoch: string | null;
	cursor: number;
	client: string;
}

export interface WelcomeFrame {
	type: "welcome";
	role: Role;
	readOnly: boolean;
	epoch: string;
	serverId: string;
	folderId: string;
	headSeq: number;
	durableDseq: number;
	minWriterSchema: number;
	serverVersion: string;
	/** True when the client's cursor is older than the retained tree log. */
	snapshot: boolean;
}

export interface Sync1Frame {
	type: "sync1";
	docId: string;
	sv: Uint8Array;
}

export interface Sync2Frame {
	type: "sync2";
	docId: string;
	update: Uint8Array;
	headSeq: number;
}

export interface UpdateFrame {
	type: "update";
	dseq: number;
	docId: string;
	update: Uint8Array;
}

export interface AckFrame {
	type: "ack";
	durableDseq: number;
}

export interface BcastFrame {
	type: "bcast";
	docId: string;
	update: Uint8Array;
	origin: string;
}

export interface HeadsFrame {
	type: "heads";
	cursor: number;
	heads: Array<[docId: string, seq: number]>;
}

export interface TreeOpFrame {
	type: "treeOp";
	op: TreeOp;
}

export interface TreeResultFrame {
	type: "treeResult";
	opId: string;
	result: TreeResult;
}

export interface TreeEventsFrame {
	type: "treeEvents";
	cursor: number;
	events: TreeEvent[];
}

export interface TreeSnapshotFrame {
	type: "treeSnapshot";
	cursor: number;
	entries: TreeEntry[];
	final: boolean;
}

export interface AwarenessFrame {
	type: "awareness";
	update: Uint8Array;
}

export type ControlMessage =
	| { t: "token"; token: string }
	| { t: "tokenExpiring"; exp: number }
	| { t: "error"; code: ErrorCode; message: string; fatal: boolean }
	| { t: "revoked" }
	| { t: "retryAfter"; ms: number }
	| { t: "rejoinRequired" }
	| { t: "presenceQuery" }
	| { t: "notice"; kind: string; detail: Record<string, unknown> };

export type ErrorCode =
	| "update_required"
	| "unauthorized"
	| "forbidden"
	| "bad_frame"
	| "too_large"
	| "read_only"
	| "storage_unavailable"
	| "rate_limited"
	| "epoch_changed";

export interface ControlFrame {
	type: "control";
	msg: ControlMessage;
}

export interface CatchupDoneFrame {
	type: "catchupDone";
	cursor: number;
}

export type Frame =
	| HelloFrame
	| WelcomeFrame
	| Sync1Frame
	| Sync2Frame
	| UpdateFrame
	| AckFrame
	| BcastFrame
	| HeadsFrame
	| TreeOpFrame
	| TreeResultFrame
	| TreeEventsFrame
	| TreeSnapshotFrame
	| AwarenessFrame
	| ControlFrame
	| CatchupDoneFrame;

function json(enc: encoding.Encoder, v: unknown): void {
	encoding.writeVarString(enc, JSON.stringify(v));
}

function readJson<T>(dec: decoding.Decoder): T {
	return JSON.parse(decoding.readVarString(dec)) as T;
}

export function encodeFrame(f: Frame): Uint8Array {
	const enc = encoding.createEncoder();
	switch (f.type) {
		case "hello":
			encoding.writeUint8(enc, T.Hello);
			json(enc, { protocol: f.protocol, schema: f.schema, epoch: f.epoch, cursor: f.cursor, client: f.client });
			break;
		case "welcome": {
			encoding.writeUint8(enc, T.Welcome);
			const { type: _t, ...rest } = f;
			json(enc, rest);
			break;
		}
		case "sync1":
			encoding.writeUint8(enc, T.Sync1);
			encoding.writeVarString(enc, f.docId);
			encoding.writeVarUint8Array(enc, f.sv);
			break;
		case "sync2":
			encoding.writeUint8(enc, T.Sync2);
			encoding.writeVarString(enc, f.docId);
			encoding.writeVarUint(enc, f.headSeq);
			encoding.writeVarUint8Array(enc, f.update);
			break;
		case "update":
			encoding.writeUint8(enc, T.Update);
			encoding.writeVarUint(enc, f.dseq);
			encoding.writeVarString(enc, f.docId);
			encoding.writeVarUint8Array(enc, f.update);
			break;
		case "ack":
			encoding.writeUint8(enc, T.Ack);
			encoding.writeVarUint(enc, f.durableDseq);
			break;
		case "bcast":
			encoding.writeUint8(enc, T.Bcast);
			encoding.writeVarString(enc, f.docId);
			encoding.writeVarString(enc, f.origin);
			encoding.writeVarUint8Array(enc, f.update);
			break;
		case "heads":
			encoding.writeUint8(enc, T.Heads);
			encoding.writeVarUint(enc, f.cursor);
			encoding.writeVarUint(enc, f.heads.length);
			for (const [docId, seq] of f.heads) {
				encoding.writeVarString(enc, docId);
				encoding.writeVarUint(enc, seq);
			}
			break;
		case "treeOp":
			encoding.writeUint8(enc, T.TreeOp);
			json(enc, f.op);
			break;
		case "treeResult":
			encoding.writeUint8(enc, T.TreeResult);
			encoding.writeVarString(enc, f.opId);
			json(enc, f.result);
			break;
		case "treeEvents":
			encoding.writeUint8(enc, T.TreeEvents);
			encoding.writeVarUint(enc, f.cursor);
			json(enc, f.events);
			break;
		case "treeSnapshot":
			encoding.writeUint8(enc, T.TreeSnapshot);
			encoding.writeVarUint(enc, f.cursor);
			encoding.writeUint8(enc, f.final ? 1 : 0);
			json(enc, f.entries);
			break;
		case "awareness":
			encoding.writeUint8(enc, T.Awareness);
			encoding.writeVarUint8Array(enc, f.update);
			break;
		case "control":
			encoding.writeUint8(enc, T.Control);
			json(enc, f.msg);
			break;
		case "catchupDone":
			encoding.writeUint8(enc, T.CatchupDone);
			encoding.writeVarUint(enc, f.cursor);
			break;
	}
	return encoding.toUint8Array(enc);
}

/** Decodes one frame. Returns null for anything malformed; never throws. */
export function decodeFrame(data: Uint8Array): Frame | null {
	try {
		const dec = decoding.createDecoder(data);
		const type = decoding.readUint8(dec);
		let frame: Frame | null = null;
		switch (type) {
			case T.Hello: {
				const h = readJson<Omit<HelloFrame, "type">>(dec);
				if (typeof h.protocol !== "number" || typeof h.cursor !== "number") return null;
				frame = { type: "hello", protocol: h.protocol, schema: h.schema ?? 0, epoch: h.epoch ?? null, cursor: h.cursor, client: String(h.client ?? "") };
				break;
			}
			case T.Welcome:
				frame = { type: "welcome", ...readJson<Omit<WelcomeFrame, "type">>(dec) };
				break;
			case T.Sync1:
				frame = { type: "sync1", docId: decoding.readVarString(dec), sv: decoding.readVarUint8Array(dec) };
				break;
			case T.Sync2: {
				const docId = decoding.readVarString(dec);
				const headSeq = decoding.readVarUint(dec);
				frame = { type: "sync2", docId, headSeq, update: decoding.readVarUint8Array(dec) };
				break;
			}
			case T.Update: {
				const dseq = decoding.readVarUint(dec);
				const docId = decoding.readVarString(dec);
				frame = { type: "update", dseq, docId, update: decoding.readVarUint8Array(dec) };
				break;
			}
			case T.Ack:
				frame = { type: "ack", durableDseq: decoding.readVarUint(dec) };
				break;
			case T.Bcast: {
				const docId = decoding.readVarString(dec);
				const origin = decoding.readVarString(dec);
				frame = { type: "bcast", docId, origin, update: decoding.readVarUint8Array(dec) };
				break;
			}
			case T.Heads: {
				const cursor = decoding.readVarUint(dec);
				const n = decoding.readVarUint(dec);
				const heads: Array<[string, number]> = [];
				for (let i = 0; i < n; i++) heads.push([decoding.readVarString(dec), decoding.readVarUint(dec)]);
				frame = { type: "heads", cursor, heads };
				break;
			}
			case T.TreeOp:
				frame = { type: "treeOp", op: readJson<TreeOp>(dec) };
				break;
			case T.TreeResult: {
				const opId = decoding.readVarString(dec);
				frame = { type: "treeResult", opId, result: readJson<TreeResult>(dec) };
				break;
			}
			case T.TreeEvents: {
				const cursor = decoding.readVarUint(dec);
				frame = { type: "treeEvents", cursor, events: readJson<TreeEvent[]>(dec) };
				break;
			}
			case T.TreeSnapshot: {
				const cursor = decoding.readVarUint(dec);
				const final = decoding.readUint8(dec) === 1;
				frame = { type: "treeSnapshot", cursor, final, entries: readJson<TreeEntry[]>(dec) };
				break;
			}
			case T.Awareness:
				frame = { type: "awareness", update: decoding.readVarUint8Array(dec) };
				break;
			case T.Control:
				frame = { type: "control", msg: readJson<ControlMessage>(dec) };
				break;
			case T.CatchupDone:
				frame = { type: "catchupDone", cursor: decoding.readVarUint(dec) };
				break;
			default:
				return null;
		}
		// Trailing garbage means the frame is not what it claims to be.
		if (decoding.hasContent(dec)) return null;
		return frame;
	} catch {
		return null;
	}
}
