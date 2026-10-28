import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import builtins from "node:module";

const root = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

// One copy of Yjs for the whole bundle, including code imported from server/src/shared.
const singleYjs = {
	name: "single-yjs",
	setup(build) {
		build.onResolve({ filter: /^(yjs|lib0(\/.*)?|y-protocols(\/.*)?)$/ }, async (args) => {
			if (args.resolveDir.startsWith(root) && !args.resolveDir.includes(`${path.sep}server${path.sep}`)) return undefined;
			const result = await build.resolve(args.path, { kind: args.kind, resolveDir: root });
			return { path: result.path };
		});
	},
};

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins.builtinModules,
	],
	alias: { "@shared": path.join(root, "server/src/shared") },
	plugins: [singleYjs],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
