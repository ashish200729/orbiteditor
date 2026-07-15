/**
 * Small deterministic locality-sensitive hash index. It narrows large vector sets before
 * exact cosine reranking without adding a native dependency to the workbench renderer.
 */
export class SemanticVectorIndex {
	private readonly buckets = new Map<string, number[]>();
	private size = 0;

	rebuild(vectors: readonly (readonly number[])[]): void {
		this.buckets.clear();
		this.size = vectors.length;
		for (let index = 0; index < vectors.length; index++) {
			for (let table = 0; table < 4; table++) {
				const key = this.signature(vectors[index], table);
				const bucket = this.buckets.get(key);
				if (bucket) bucket.push(index); else this.buckets.set(key, [index]);
			}
		}
	}

	candidates(vector: readonly number[], minimum = 256): number[] {
		if (this.size <= 2_000) return Array.from({ length: this.size }, (_, index) => index);
		const candidates = new Set<number>();
		for (let table = 0; table < 4; table++) {
			const bits = this.signatureBits(vector, table);
			this.addBucket(candidates, `${table}:${bits}`);
			for (let bit = 0; bit < 12 && candidates.size < minimum; bit++) {
				const neighbor = `${bits.slice(0, bit)}${bits[bit] === '1' ? '0' : '1'}${bits.slice(bit + 1)}`;
				this.addBucket(candidates, `${table}:${neighbor}`);
			}
		}
		// Sparse or unusual queries must favor recall over speed.
		if (candidates.size < minimum) return Array.from({ length: this.size }, (_, index) => index);
		return [...candidates];
	}

	private addBucket(target: Set<number>, key: string): void {
		for (const index of this.buckets.get(key) ?? []) target.add(index);
	}

	private signature(vector: readonly number[], table: number): string {
		return `${table}:${this.signatureBits(vector, table)}`;
	}

	private signatureBits(vector: readonly number[], table: number): string {
		let result = '';
		for (let bit = 0; bit < 12; bit++) {
			let projection = 0;
			for (let sample = 0; sample < 24; sample++) {
				const seed = (((table + 1) * 73856093) ^ ((bit + 1) * 19349663) ^ ((sample + 1) * 83492791)) >>> 0;
				const index = seed % vector.length;
				projection += vector[index] * ((seed & 0x100) === 0 ? -1 : 1);
			}
			result += projection >= 0 ? '1' : '0';
		}
		return result;
	}
}
