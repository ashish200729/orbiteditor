/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Rejects with a timeout error if `promise` hasn't settled within `ms`. Does not cancel `promise` itself. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`MCP tool "${label}" timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(val) => { clearTimeout(timer); resolve(val); },
			(err) => { clearTimeout(timer); reject(err); },
		);
	});
}

/** Maps inputs with bounded concurrency while preserving input order in the returned results. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	maxConcurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
		throw new Error('maxConcurrency must be a positive integer');
	}
	if (items.length === 0) return [];

	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index]!, index);
		}
	};

	const workerCount = Math.min(maxConcurrency, items.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
