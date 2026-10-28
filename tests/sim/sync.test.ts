import { describe, expect, it } from "vitest";
import { Sim } from "./harness";

// End-to-end scenarios: real client engines, real FolderCore over node:sqlite, fake vaults
// and an in-process network with partitions, all on one deterministic clock.

async function pair() {
	const sim = new Sim();
	const a = sim.device("A", "Laptop");
	const b = sim.device("B", "Phone");
	await a.start();
	await b.start();
	await sim.settle();
	return { sim, a, b };
}

describe("sync scenarios", () => {
	it("propagates creates, edits, renames and deletes between two devices", async () => {
		const { sim, a, b } = await pair();
		a.vault.write("Shared/Notes/hello.md", "# Hello\n");
		await sim.settle();
		expect(b.files()).toEqual({ "Notes/hello.md": "# Hello\n" });

		b.vault.write("Shared/Notes/hello.md", "# Hello\nfrom the phone\n");
		await sim.settle();
		expect(a.files()["Notes/hello.md"]).toBe("# Hello\nfrom the phone\n");

		await a.vault.rename("Shared/Notes/hello.md", "Shared/Notes/greeting.md");
		await sim.settle();
		expect(b.files()).toEqual({ "Notes/greeting.md": "# Hello\nfrom the phone\n" });

		await b.vault.trash("Shared/Notes/greeting.md");
		await sim.settle();
		expect(a.files()).toEqual({});
		expect(a.vault.folderList("Shared")).toEqual(["Shared/Notes"]);
	});

	it("merges offline edits to different parts of a note", async () => {
		const { sim, a, b } = await pair();
		a.vault.write("Shared/plan.md", "intro\n\nmiddle\n\nend\n");
		await sim.settle();
		a.goOffline();
		b.goOffline();
		a.vault.write("Shared/plan.md", "INTRO (laptop)\n\nmiddle\n\nend\n");
		b.vault.write("Shared/plan.md", "intro\n\nmiddle\n\nEND (phone)\n");
		await sim.settle();
		a.goOnline();
		b.goOnline();
		await sim.settle();
		const expected = "INTRO (laptop)\n\nmiddle\n\nEND (phone)\n";
		expect(a.files()["plan.md"]).toBe(expected);
		expect(b.files()["plan.md"]).toBe(expected);
	});

	it("turns the same daily note created on two offline devices into one note", async () => {
		const { sim, a, b } = await pair();
		a.goOffline();
		b.goOffline();
		const template = "# 2026-10-28\n## Tasks\n";
		a.vault.write("Shared/Daily/2026-10-28.md", template + "- laptop task\n");
		b.vault.write("Shared/Daily/2026-10-28.md", template + "- phone task\n");
		await sim.settle();
		a.goOnline();
		await sim.settle();
		b.goOnline();
		await sim.settle();
		expect(Object.keys(a.files())).toEqual(["Daily/2026-10-28.md"]);
		expect(a.files()).toEqual(b.files());
		const text = a.files()["Daily/2026-10-28.md"]!;
		expect(text).toContain("- laptop task");
		expect(text).toContain("- phone task");
		expect(text.match(/## Tasks/g)).toHaveLength(1);
	});

	it("keeps a file created offline inside a folder that was renamed meanwhile", async () => {
		const { sim, a, b } = await pair();
		a.vault.write("Shared/Projects/a.md", "a\n");
		await sim.settle();
		b.goOffline();
		await a.vault.rename("Shared/Projects", "Shared/Work");
		await sim.settle();
		b.vault.write("Shared/Projects/new.md", "made offline\n");
		await sim.settle();
		b.goOnline();
		await sim.settle();
		const expected = { "Work/a.md": "a\n", "Work/new.md": "made offline\n" };
		expect(a.files()).toEqual(expected);
		expect(b.files()).toEqual(expected);
	});

	it("lets an edit win over a concurrent delete", async () => {
		const { sim, a, b } = await pair();
		a.vault.write("Shared/keep.md", "v1\n");
		await sim.settle();
		a.goOffline();
		await a.vault.trash("Shared/keep.md");
		b.vault.write("Shared/keep.md", "v2 edited\n");
		await sim.settle();
		a.goOnline();
		await sim.settle();
		expect(a.files()).toEqual({ "keep.md": "v2 edited\n" });
		expect(b.files()).toEqual({ "keep.md": "v2 edited\n" });
	});

	it("propagates a delete made while the plugin was off instead of resurrecting it (SYNC-01)", async () => {
		const { sim, a, b } = await pair();
		a.vault.write("Shared/old.md", "bye\n");
		await sim.settle();
		await a.stop();
		a.vault.remove("Shared/old.md", false); // deleted while the plugin was not running
		await a.start();
		await sim.settle();
		expect(a.files()).toEqual({});
		expect(b.files()).toEqual({});
	});

	it("survives a server eviction with unflushed changes (receipts are exact)", async () => {
		const { sim, a, b } = await pair();
		a.vault.write("Shared/x.md", "before eviction\n");
		// Let the change reach the server but evict before its flush timer runs.
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
		sim.server.evict();
		await sim.settle();
		expect(b.files()).toEqual({ "x.md": "before eviction\n" });
		expect(a.session.status().unconfirmed).toBe(0);
	});

	it("preserves CRLF and BOM on disk while syncing content", async () => {
		const { sim, a, b } = await pair();
		a.vault.write("Shared/win.md", "﻿line one\r\nline two\r\n");
		await sim.settle();
		expect(b.files()["win.md"]).toBe("line one\nline two\n");
		b.vault.write("Shared/win.md", "line one\nline two\nline three\n");
		await sim.settle();
		expect(a.files()["win.md"]).toBe("﻿line one\r\nline two\r\nline three\r\n");
	});

	it("brings a new device up to date from scratch", async () => {
		const sim = new Sim();
		const a = sim.device("A");
		await a.start();
		for (let i = 0; i < 30; i++) a.vault.write(`Shared/F${i % 3}/n${i}.md`, `note ${i}\n`);
		await sim.settle();
		const c = sim.device("C");
		await c.start();
		await sim.settle();
		expect(c.files()).toEqual(a.files());
		expect(Object.keys(c.files())).toHaveLength(30);
	});

	it("holds a remote mass delete behind the safety brake", async () => {
		const sim = new Sim();
		const a = sim.device("A");
		const b = sim.device("B");
		await a.start();
		await b.start();
		for (let i = 0; i < 60; i++) a.vault.write(`Shared/n${i}.md`, `${i}\n`);
		await sim.settle();
		expect(Object.keys(b.files())).toHaveLength(60);
		b.goOffline();
		for (let i = 0; i < 50; i++) await a.vault.trash(`Shared/n${i}.md`);
		await sim.settle();
		b.goOnline();
		await sim.settle();
		expect(Object.keys(b.files())).toHaveLength(60);
		expect(b.notices.some((n) => n.kind === "brake" && n.direction === "inbound")).toBe(true);
	});
});
