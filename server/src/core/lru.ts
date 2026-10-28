/** Byte-bounded LRU cache for merged document states. */
export class ByteLru {
	private map = new Map<string, Uint8Array>();
	private total = 0;

	constructor(private readonly maxBytes: number) {}

	get(key: string): Uint8Array | undefined {
		const v = this.map.get(key);
		if (v) {
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}

	set(key: string, value: Uint8Array): void {
		this.delete(key);
		if (value.length > this.maxBytes / 4) return; // never let one doc evict everything
		this.map.set(key, value);
		this.total += value.length;
		while (this.total > this.maxBytes) {
			const oldest = this.map.keys().next().value as string;
			this.delete(oldest);
		}
	}

	delete(key: string): void {
		const v = this.map.get(key);
		if (v) {
			this.total -= v.length;
			this.map.delete(key);
		}
	}

	get bytes(): number {
		return this.total;
	}
}
