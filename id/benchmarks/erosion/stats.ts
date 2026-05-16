/**
 * Wilson score interval for a binomial proportion. Returns [low, high] both in [0, 1].
 * Chosen over the normal-approximation interval because it stays well-behaved at the
 * boundaries (p ≈ 0 or p ≈ 1) and with small n, which a 50-run-per-arm benchmark hits.
 *
 * z = 1.96 → 95% interval.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  if (successes < 0 || successes > n) {
    throw new Error(`wilsonInterval: successes (${successes}) out of range for n=${n}`);
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Two intervals [a_low, a_high] and [b_low, b_high] overlap iff
 * a_low ≤ b_high AND b_low ≤ a_high. Closed-interval convention.
 */
export function intervalsOverlap(
  a: readonly [number, number],
  b: readonly [number, number],
): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}
