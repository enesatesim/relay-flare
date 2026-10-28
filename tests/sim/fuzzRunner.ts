import { Sim, type Device } from "./harness";

// Randomized multi-device session driver shared by the fuzz suite and seed debugging.

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FOLDERS = ["", "Inbox", "Projects", "Projects/Alpha", "Archive"];
const NAMES = ["a.md", "b.md", "c.md", "todo.md", "notes.txt"];

export async function runSeed(seed: number, steps: number, trace: (...a: unknown[]) => void = () => {}, onDevices?: (devices: Device[]) => void) {
	const r = rng(seed);
	const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
	// Deterministic ids (randomId uses crypto.getRandomValues) so a failing seed reproduces.
	const idRng = rng(seed ^ 0x9e3779b9);
	const realGetRandomValues = crypto.getRandomValues.bind(crypto);
	const realRandom = Math.random;
	const jitter = rng(seed ^ 0x51ed270b);
	Math.random = jitter;
	(crypto as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
		if (array) {
			const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
			for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(idRng() * 256);
		}
		return array;
	}) as typeof crypto.getRandomValues;
	const sim = new Sim();
	const devices = [sim.device("A", "Laptop"), sim.device("B", "Phone"), sim.device("C", "Tablet")];
	onDevices?.(devices);
	for (const d of devices) await d.start();
	await sim.settle();
	let token = 0;
	const typed = new Map<string, string>(); // unique line -> device
	const removed = new Set<string>(); // lines an action deliberately removed

	const files = (d: Device) => Object.keys(d.vault.snapshot(d.mount)).map((p) => p.slice(d.mount.length + 1));

	for (let step = 0; step < steps; step++) {
		const d = pick(devices);
		const roll = r();
		const existing = files(d);
		if (roll < 0.08) {
			trace(step, d.id, d.online ? "offline" : "online");
			if (d.online) d.goOffline();
			else d.goOnline();
		} else if (roll < 0.45 || existing.length === 0) {
			const folder = pick(FOLDERS);
			const path = `${d.mount}/${folder ? folder + "/" : ""}${pick(NAMES)}`;
			const line = `line-${seed}-${++token}-${d.id}`;
			typed.set(line, d.id);
			const cur = d.vault.read(path);
			trace(step, d.id, cur === undefined ? "create" : "append", path, line);
			d.vault.write(path, cur === undefined ? `${line}\n` : r() < 0.5 ? `${line}\n${cur}` : `${cur}${line}\n`);
		} else if (roll < 0.6) {
			const rel = pick(existing);
			const cur = d.vault.read(`${d.mount}/${rel}`)!;
			const lines = cur.split("\n").filter(Boolean);
			if (lines.length > 1) {
				const at = Math.floor(r() * lines.length);
				trace(step, d.id, "drop-line", rel, lines[at]);
				removed.add(lines[at]!);
				lines.splice(at, 1);
				d.vault.write(`${d.mount}/${rel}`, lines.join("\n") + "\n");
			}
		} else if (roll < 0.75) {
			const rel = pick(existing);
			const folder = pick(FOLDERS);
			const target = `${d.mount}/${folder ? folder + "/" : ""}${pick(NAMES)}`;
			trace(step, d.id, "rename", rel, target);
			if (!d.vault.read(target) && !d.vault.folders.has(target)) await d.vault.rename(`${d.mount}/${rel}`, target).catch(() => {});
		} else if (roll < 0.82) {
			const folders = d.vault.folderList(d.mount).filter((f) => f !== d.mount);
			if (folders.length > 0) {
				const f = pick(folders);
				const to = `${d.mount}/Moved-${++token}`;
				trace(step, d.id, "move-folder", f, to);
				await d.vault.rename(f, to).catch(() => {});
			}
		} else if (roll < 0.9) {
			const victim = pick(existing);
			trace(step, d.id, "trash", victim);
			for (const l of (d.vault.read(`${d.mount}/${victim}`) ?? "").split("\n")) if (l) removed.add(l);
			await d.vault.trash(`${d.mount}/${victim}`);
		}
		// Let some work happen between actions, sometimes a lot, sometimes none.
		if (r() < 0.5) {
			sim.clock.advance(Math.floor(r() * 2000));
			for (let k = 0; k < 5; k++) await new Promise((res) => setImmediate(res));
		}
		if (r() < 0.03) {
			trace(step, "server", "evict");
			sim.server.evict();
		}
	}
	for (const d of devices) if (!d.online) d.goOnline();
	try {
		await sim.settle();
		// The periodic drift scan would run here in the app; run it once everywhere.
		for (const d of devices) await d.session.rescan();
		await sim.settle();
	} finally {
		(crypto as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues = realGetRandomValues;
		Math.random = realRandom;
	}
	return { sim, devices, typed, removed };
}

