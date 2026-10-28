import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@shared\/(.*)$/, replacement: path.join(root, "server/src/shared/$1") },
			// Force a single Yjs copy across client and server-core code.
			{ find: /^yjs$/, replacement: path.join(root, "node_modules/yjs/dist/yjs.mjs") },
			{ find: /^obsidian$/, replacement: path.join(root, "tests/mocks/obsidian.ts") },
		],
	},
	test: {
		include: process.env.FUZZ_SEED ? ["tests/debug/**/*.test.ts"] : ["tests/unit/**/*.test.ts", "tests/sim/**/*.test.ts"],
		environment: "node",
		testTimeout: 60_000,
	},
});
