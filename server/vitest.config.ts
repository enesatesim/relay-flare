import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: { SETUP_PASSPHRASE: "test-passphrase" },
				r2Buckets: ["BLOBS"],
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
