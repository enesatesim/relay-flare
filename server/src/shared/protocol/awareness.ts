import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

// Minimal reader/writer for y-protocols awareness updates, so the server can track which
// awareness client ids belong to which socket and announce their removal on disconnect
// without depending on y-protocols or holding Awareness instances.

export interface AwarenessEntry {
	clientId: number;
	clock: number;
	/** JSON-encoded state; the literal "null" means the client was removed. */
	state: string;
}

export function readAwarenessUpdate(update: Uint8Array): AwarenessEntry[] | null {
	try {
		const dec = decoding.createDecoder(update);
		const n = decoding.readVarUint(dec);
		const out: AwarenessEntry[] = [];
		for (let i = 0; i < n; i++) {
			const clientId = decoding.readVarUint(dec);
			const clock = decoding.readVarUint(dec);
			const state = decoding.readVarString(dec);
			out.push({ clientId, clock, state });
		}
		return out;
	} catch {
		return null;
	}
}

export function writeAwarenessUpdate(entries: AwarenessEntry[]): Uint8Array {
	const enc = encoding.createEncoder();
	encoding.writeVarUint(enc, entries.length);
	for (const e of entries) {
		encoding.writeVarUint(enc, e.clientId);
		encoding.writeVarUint(enc, e.clock);
		encoding.writeVarString(enc, e.state);
	}
	return encoding.toUint8Array(enc);
}

/** An update that marks the given clients as removed (state null, clock bumped). */
export function removalUpdate(clients: Map<number, number>): Uint8Array {
	return writeAwarenessUpdate([...clients].map(([clientId, clock]) => ({ clientId, clock: clock + 1, state: "null" })));
}
