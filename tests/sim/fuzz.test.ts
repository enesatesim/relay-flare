import { describe, expect, it } from "vitest";
import { runSeed } from "./fuzzRunner";

// Randomized multi-device sessions. After everyone reconnects and the system settles, all
// devices must hold identical files, no engine task may have failed, and every line a
// device typed into a surviving note must still exist somewhere in the share.

describe("fuzz", () => {
	const seeds = Array.from({ length: Number(process.env.FUZZ_SEEDS ?? 200) }, (_, i) => i + 1);
	for (const seed of seeds) {
		it(`seed ${seed} converges without losing typed lines`, async () => {
			const { devices, typed, removed } = await runSeed(seed, Number(process.env.FUZZ_STEPS ?? 60));
			const [a, ...rest] = devices;
			for (const d of rest) expect(d.files(), `device ${d.id} vs A (seed ${seed})`).toEqual(a!.files());
			const present = new Set(Object.values(a!.files()).flatMap((t) => t.split("\n")));
			const lost = [...typed.keys()].filter((l) => !removed.has(l) && !present.has(l));
			expect(lost, `typed lines lost (seed ${seed})`).toEqual([]);
			for (const d of devices) {
				const errors = d.logs.filter((l) => l.level === "error");
				expect(errors, `engine errors on ${d.id}`).toEqual([]);
			}
		});
	}
});
