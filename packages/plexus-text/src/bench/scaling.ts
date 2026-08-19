/** Least-squares slope of log(y) vs log(n). All-equal (or all-zero) ⇒ 0. */
export function alpha(points: Array<{ n: number; y: number }>): number {
  if (points.length < 2) return 0;
  const ys = points.map((p) => p.y);
  if (ys.every((y) => y === ys[0])) return 0;

  const logs = points
    .filter((p) => p.n > 0 && p.y > 0)
    .map((p) => ({ x: Math.log(p.n), y: Math.log(p.y) }));
  if (logs.length < 2) return 0;

  const n = logs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of logs) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return 0;
  return (n * sxy - sx * sy) / denom;
}

export function assertConstant(
  points: Array<{ n: number; y: number }>,
  opts: { label: string; maxAlpha?: number } = { label: "metric" },
): void {
  const a = alpha(points);
  const max = opts.maxAlpha ?? 0.05;
  if (Math.abs(a) > max) {
    throw new Error(
      `${opts.label}: expected α≈0 (constant), got α=${a.toFixed(3)} points=${JSON.stringify(points)}`,
    );
  }
}

/** Quadratic detector — legitimately O(n) paths use max≈1.15. */
export function assertAtMostLinear(
  points: Array<{ n: number; y: number }>,
  opts: { label: string; max?: number } = { label: "metric" },
): void {
  const a = alpha(points);
  const max = opts.max ?? 1.15;
  if (a > max) {
    throw new Error(
      `${opts.label}: expected α≤${max} (at most linear), got α=${a.toFixed(3)} points=${JSON.stringify(points)}`,
    );
  }
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[i]!;
}

export function summarizeTimes(samples: number[]): { p50: number; p95: number; max: number; mean: number } {
  if (samples.length === 0) return { p50: 0, p95: 0, max: 0, mean: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1]!,
    mean: sum / s.length,
  };
}
