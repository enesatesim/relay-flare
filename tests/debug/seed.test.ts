import { it } from "vitest";
import { appendFileSync, writeFileSync } from "node:fs";
import { runSeed } from "../sim/fuzzRunner";

// Debug helper: FUZZ_SEED=<n> FUZZ_LOG=<file> npx vitest run
const out = process.env.FUZZ_LOG ?? "fuzz-debug.log";
const log = (...a: unknown[]) => appendFileSync(out, a.map(String).join(" ") + "\n");

it("debug one seed", async () => {
	writeFileSync(out, "");
	const seed = Number(process.env.FUZZ_SEED ?? 2);
	const steps = Number(process.env.FUZZ_STEPS ?? 60);
	let early: import("../sim/harness").Device[] = [];
	let devices: import("../sim/harness").Device[];
	try {
		({ devices } = await runSeed(seed, steps, log, (d) => (early = d)));
	} catch (err) {
		log("RUN FAILED", String(err).slice(0, 2000));
		for (const d of early) for (const l of d.logs.slice(-Number(process.env.FUZZ_TAIL ?? 80))) log(d.id, l.level, l.event, JSON.stringify(l.detail ?? {}).slice(0, 500));
		throw err;
	}
	const [a, ...rest] = devices;
	const af = a!.files();
	for (const d of rest) {
		const df = d.files();
		const keys = new Set([...Object.keys(af), ...Object.keys(df)]);
		for (const k of [...keys].sort()) {
			if (af[k] === df[k]) continue;
			log(`DIFF ${d.id} ${k}: A=${JSON.stringify(af[k])} ${d.id}=${JSON.stringify(df[k])}`);
			for (const x of devices) log(`   ${x.id} inspect ${k}: ${JSON.stringify(await x.session.inspect(k))}`);
		}
	}
	const find = process.env.FUZZ_FIND;
	if (find) for (const d of devices) for (const [k, v] of Object.entries(d.files())) if (v.includes(find)) log("FOUND", d.id, k, JSON.stringify(v));
	if (find) for (const d of devices) log("FILES", d.id, JSON.stringify(Object.keys(d.files())));
	for (const d of devices) {
		log(d.id, "status", JSON.stringify(d.session.status()));
		for (const n of d.notices) log(d.id, "notice", JSON.stringify(n));
		for (const l of d.logs.filter((x) => process.env.FUZZ_DEBUG === d.id || x.level !== "debug")) log(d.id, l.level, l.event, JSON.stringify(l.detail ?? {}).slice(0, 600));
	}
});
