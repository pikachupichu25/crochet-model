// Small 3D vector helpers for symbol placement. Plain tuples, so scenes are
// easy to compare in tests and to send between threads.

export type Vec3 = [number, number, number];

export const vec = (p: readonly number[]): Vec3 => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** `a` scaled to length 1, or undefined when it has no direction. */
export function normalize(a: Vec3): Vec3 | undefined {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : undefined;
}

export function mean(points: Vec3[]): Vec3 {
  const sum = points.reduce(add, [0, 0, 0] as Vec3);
  return scale(sum, 1 / Math.max(points.length, 1));
}

/** Any unit vector perpendicular to `a` (a unit vector). */
export function perpendicular(a: Vec3): Vec3 {
  const helper: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return normalize(cross(helper, a))!;
}

/** `a` with its component along unit vector `n` removed. */
export const reject = (a: Vec3, n: Vec3): Vec3 => sub(a, scale(n, dot(a, n)));
