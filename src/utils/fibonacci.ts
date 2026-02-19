/**
 * Fibonacci sequence utilities.
 */

/**
 * Computes the nth Fibonacci number using iterative approach.
 * Uses 0-indexed sequence where fib(0) = 0, fib(1) = 1.
 *
 * @param n - The position in the Fibonacci sequence (must be non-negative)
 * @returns The nth Fibonacci number
 * @throws Error if n is negative
 */
export function fibonacci(n: number): bigint {
	if (n < 0n) {
		throw new Error("Fibonacci sequence is undefined for negative indices");
	}

	if (n === 0n || n === 1n) {
		return n;
	}

	let a = 0n;
	let b = 1n;

	for (let i = 2n; i <= n; i++) {
		const temp = a + b;
		a = b;
		b = temp;
	}

	return b;
}

/**
 * Generates Fibonacci sequence up to n (exclusive).
 *
 * @param n - Number of Fibonacci numbers to generate
 * @returns Array of Fibonacci numbers
 */
export function fibonacciSequence(n: number): bigint[] {
	if (n <= 0) {
		return [];
	}

	const sequence: bigint[] = [];

	for (let i = 0; i < n; i++) {
		sequence.push(fibonacci(BigInt(i)));
	}

	return sequence;
}
