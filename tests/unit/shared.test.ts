import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeFrame, encodeFrame, type Frame } from "@shared/protocol/frames";
import { fromBase64Url, toBase64Url } from "@shared/bytes";
import { nameKey, validateName, conflictName } from "@shared/tree/names";
import { signToken, verifyToken, type AccessClaims } from "@shared/token";

describe("base64url", () => {
	it("round-trips arbitrary bytes", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
				expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
			}),
		);
	});
});

describe("frame codec", () => {
	const frames: Frame[] = [
		{ type: "hello", protocol: 1, schema: 1, epoch: null, cursor: 0, client: "test" },
		{ type: "sync1", docId: "d", sv: new Uint8Array([1, 2]) },
		{ type: "sync2", docId: "d", update: new Uint8Array([3]), headSeq: 9 },
		{ type: "update", dseq: 42, docId: "d", update: new Uint8Array([0, 0]) },
		{ type: "ack", durableDseq: 42 },
		{ type: "bcast", docId: "d", update: new Uint8Array([7]), origin: "dev" },
		{ type: "heads", cursor: 5, heads: [["a", 3], ["b", 5]] },
		{ type: "treeOp", op: { t: "create", opId: "o", id: "i", parent: "root", name: "n.md", kind: "markdown" } },
		{ type: "control", msg: { t: "retryAfter", ms: 1000 } },
		{ type: "catchupDone", cursor: 12 },
	];
	for (const f of frames) {
		it(`round-trips ${f.type}`, () => {
			expect(decodeFrame(encodeFrame(f))).toEqual(f);
		});
	}

	it("never throws on garbage", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
				expect(() => decodeFrame(bytes)).not.toThrow();
			}),
			{ numRuns: 2000 },
		);
	});
});

describe("names", () => {
	it("folds case and normalization into one key", () => {
		expect(nameKey("Café.MD")).toBe(nameKey("café.md"));
	});

	it("produces valid conflict names even for long names", () => {
		const long = "x".repeat(250) + ".md";
		const name = conflictName(long, false, "My Phone: 2", Date.UTC(2026, 0, 1), () => false);
		expect(validateName(name)).toBeNull();
		expect(name.endsWith(".md")).toBe(true);
	});
});

describe("tokens", () => {
	const key = { kid: "k1", secret: new Uint8Array(32).fill(7) };
	const keys = new Map([["k1", key]]);
	const claims: AccessClaims = { v: 1, typ: "access", kid: "k1", sid: "s", sub: "u", dev: "d", dn: "Laptop", aclv: 1, iat: 0, exp: 10_000 };

	it("verifies a valid token and rejects tampering, expiry and wrong type", async () => {
		const token = await signToken(claims, key);
		expect(await verifyToken(token, "access", keys, 5_000)).toMatchObject({ sub: "u" });
		expect(await verifyToken(token, "access", keys, 10_001)).toBeNull();
		expect(await verifyToken(token, "grant", keys, 5_000)).toBeNull();
		const [body, sig] = token.split(".");
		const forged = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...claims, sub: "admin" })));
		expect(await verifyToken(`${forged}.${sig}`, "access", keys, 5_000)).toBeNull();
		expect(await verifyToken(`${body}.${sig}x`, "access", keys, 5_000)).toBeNull();
		expect(await verifyToken(token, "access", new Map(), 5_000)).toBeNull();
	});
});
