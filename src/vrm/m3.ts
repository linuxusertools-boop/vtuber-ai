// ─────────────────────────────────────────────────────────────────────────────
// Matematika kecil mandiri (tanpa three.js) → seluruh mesin gerak bisa diuji
// secara headless. Semua fungsi aman dari NaN: input buruk → hasil identitas/0.
// ─────────────────────────────────────────────────────────────────────────────
export type Vec = [number, number, number];

export const D2R = Math.PI / 180;
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);
export const smoothstep = (a: number, b: number, x: number): number => {
  if (b === a) return x >= b ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const wrap180 = (a: number): number => {
  let x = a % 360;
  if (x > 180) x -= 360;
  else if (x <= -180) x += 360;
  return x;
};

export const vadd = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a: Vec, fallback: Vec = [0, 1, 0]): Vec => {
  const l = vlen(a);
  return l > 1e-9 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : [fallback[0], fallback[1], fallback[2]];
};

/** Quaternion (x,y,z,w) immutable-style. */
export class Q {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}
  static id(): Q {
    return new Q(0, 0, 0, 1);
  }
  static axisAngle(axis: Vec, deg: number): Q {
    const a = vnorm(axis, [0, 1, 0]);
    const h = fin(deg) * D2R * 0.5;
    const s = Math.sin(h);
    return new Q(a[0] * s, a[1] * s, a[2] * s, Math.cos(h));
  }
  /** Rotasi terkecil yang memutar arah a menjadi b. */
  static fromUnitVectors(a: Vec, b: Vec): Q {
    const u = vnorm(a);
    const v = vnorm(b);
    const d = vdot(u, v);
    if (d > 0.999999) return Q.id();
    if (d < -0.999999) {
      // berlawanan arah: pilih sumbu tegak lurus mana pun
      let ax = vcross([1, 0, 0], u);
      if (vlen(ax) < 1e-6) ax = vcross([0, 1, 0], u);
      return Q.axisAngle(ax, 180);
    }
    const c = vcross(u, v);
    return new Q(c[0], c[1], c[2], 1 + d).norm();
  }
  norm(): Q {
    const l = Math.hypot(this.x, this.y, this.z, this.w);
    if (!(l > 1e-12) || !Number.isFinite(l)) return Q.id();
    return new Q(this.x / l, this.y / l, this.z / l, this.w / l);
  }
  mul(o: Q): Q {
    return new Q(
      this.w * o.x + this.x * o.w + this.y * o.z - this.z * o.y,
      this.w * o.y - this.x * o.z + this.y * o.w + this.z * o.x,
      this.w * o.z + this.x * o.y - this.y * o.x + this.z * o.w,
      this.w * o.w - this.x * o.x - this.y * o.y - this.z * o.z,
    );
  }
  inv(): Q {
    return new Q(-this.x, -this.y, -this.z, this.w);
  }
  rotate(v: Vec): Vec {
    const q = this;
    const ix = q.w * v[0] + q.y * v[2] - q.z * v[1];
    const iy = q.w * v[1] + q.z * v[0] - q.x * v[2];
    const iz = q.w * v[2] + q.x * v[1] - q.y * v[0];
    const iw = -q.x * v[0] - q.y * v[1] - q.z * v[2];
    return [
      ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
      iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
      iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    ];
  }
  isFinite(): boolean {
    return Number.isFinite(this.x + this.y + this.z + this.w);
  }
}

// ─── Spring kritis (implicit Euler → stabil tanpa batas dt) ───────────────────
export interface Spring {
  x: number;
  v: number;
}
export function springStep(s: Spring, target: number, omega: number, zeta: number, dt: number): void {
  const h = clamp(dt, 0, 0.1);
  const f = 1 + 2 * h * zeta * omega;
  const oo = omega * omega;
  const hoo = h * oo;
  const hhoo = h * hoo;
  const det = 1 / (f + hhoo);
  const nx = (f * s.x + h * s.v + hhoo * target) * det;
  const nv = (s.v + hoo * (target - s.x)) * det;
  s.x = Number.isFinite(nx) ? nx : target;
  s.v = Number.isFinite(nv) ? nv : 0;
}

// ─── RNG + noise halus ───────────────────────────────────────────────────────
export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Value-noise 1D halus, rentang ≈ -1..1. */
export function makeNoise(rng: Rng): (x: number) => number {
  const N = 256;
  const tab = new Float64Array(N);
  for (let i = 0; i < N; i++) tab[i] = rng() * 2 - 1;
  return (x: number) => {
    const xi = Math.floor(x);
    const f = x - xi;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = tab[((xi % N) + N) % N];
    const b = tab[(((xi + 1) % N) + N) % N];
    return a + (b - a) * u;
  };
}
export const rand = (rng: Rng, a: number, b: number): number => a + (b - a) * rng();
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}
export function pickWeighted<T>(rng: Rng, items: readonly T[], w: (t: T) => number): T | null {
  let sum = 0;
  for (const it of items) sum += Math.max(0, w(it));
  if (sum <= 0) return null;
  let r = rng() * sum;
  for (const it of items) {
    r -= Math.max(0, w(it));
    if (r <= 0) return it;
  }
  return items[items.length - 1] ?? null;
}
