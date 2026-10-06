// ─────────────────────────────────────────────────────────────────────────────
// Engine gerak: preset/rencana → keyframe per-kanal (spline Catmull-Rom) + osilasi,
// dengan envelope masuk/keluar, lapisan (layer) bertopeng, dan penghalus spring.
// ─────────────────────────────────────────────────────────────────────────────
import { CH_INDEX, CH_INFO, N_CH, Pose, mirrorName, sanitizePose } from "./channels";
import { clamp, fin, smoothstep, springStep, Spring, wrap180 } from "./m3";

export interface Key {
  t: number; // detik
  pose: Pose;
}
export interface Osc {
  ch: string;
  amp: number;
  hz: number;
  phase?: number; // 0..1
  from?: number; // detik
  to?: number;
  offset?: number; // ditambahkan ke nilai dasar (mis. bobot rata-rata)
}
export interface MotionDef {
  name: string;
  aliases: string[];
  dur: number;
  keys: Key[];
  osc?: Osc[];
  inT?: number;
  outT?: number;
  /** indeks key tempat pose boleh ditahan selama bicara (sustain) */
  holdAt?: number;
  /** bobot untuk kejadian spontan saat diam (0 = bukan idle) */
  idle?: number;
  /** gerakan beat saat bicara */
  beat?: boolean;
  /** hanya wajah/ringan: boleh bertumpuk dengan gerakan lain */
  light?: boolean;
  shot?: "close" | "mid" | "full";
  /** mood yang cocok (untuk idle/beat) */
  moods?: string[];
}

interface Track {
  ch: number;
  t: number[];
  v: number[];
  m: number[]; // tangen Hermite
}
export interface Compiled {
  def: MotionDef;
  dur: number;
  inT: number;
  outT: number;
  tracks: Track[];
  osc: { ch: number; amp: number; hz: number; phase: number; from: number; to: number; offset: number }[];
  mask: Uint8Array;
}

export function compileMotion(def: MotionDef, mirror = false, speed = 1, amp = 1, holdExtra = 0): Compiled {
  const sp = clamp(fin(speed, 1), 0.3, 3);
  const A = clamp(fin(amp, 1), 0.2, 1.8);
  const stretchAt = def.holdAt !== undefined ? def.keys[def.holdAt]?.t ?? Infinity : Infinity;
  const extra = clamp(fin(holdExtra, 0), 0, 25);
  const T = (t: number) => (t > stretchAt ? t + extra : t) / sp;
  const dur = Math.max(0.2, T(def.dur));
  const mapName = (n: string): { name: string; neg: boolean } => (mirror ? mirrorName(n) : { name: n, neg: false });

  const byCh = new Map<number, { t: number; v: number }[]>();
  for (const k of [...def.keys].sort((a, b) => a.t - b.t)) {
    const pose = sanitizePose(k.pose);
    for (const [n0, v0] of Object.entries(pose)) {
      const { name, neg } = mapName(n0);
      const idx = CH_INDEX[name];
      if (idx === undefined) continue;
      const base = CH_INFO[idx].def;
      // amplitudo: skala simpangan dari posisi istirahat (kecuali kanal wajah/0-1 & turn)
      let v = neg ? -v0 : v0;
      if (name !== "turn") v = base + (v - base) * A;
      v = clamp(v, CH_INFO[idx].min, CH_INFO[idx].max);
      if (name === "turn") v = neg ? -v0 : v0;
      let arr = byCh.get(idx);
      if (!arr) byCh.set(idx, (arr = []));
      arr.push({ t: T(k.t), v });
    }
  }
  const tracks: Track[] = [];
  const mask = new Uint8Array(N_CH);
  for (const [ch, pts] of byCh) {
    pts.sort((a, b) => a.t - b.t);
    const n = pts.length;
    const m: number[] = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const dt = pts[i + 1].t - pts[i - 1].t;
      m[i] = dt > 1e-6 ? (pts[i + 1].v - pts[i - 1].v) / dt : 0;
    }
    tracks.push({ ch, t: pts.map((p) => p.t), v: pts.map((p) => p.v), m });
    mask[ch] = 1;
  }
  const osc = (def.osc ?? []).flatMap((o) => {
    const { name, neg } = mapName(o.ch);
    const ch = CH_INDEX[name];
    if (ch === undefined || !Number.isFinite(o.amp) || !Number.isFinite(o.hz)) return [];
    mask[ch] = 1;
    return [
      {
        ch,
        amp: (neg ? -1 : 1) * o.amp * A,
        hz: clamp(o.hz * sp, 0.1, 9),
        phase: fin(o.phase ?? 0),
        from: T(o.from ?? 0),
        to: T(o.to ?? def.dur),
        offset: fin(o.offset ?? 0),
      },
    ];
  });
  return {
    def,
    dur,
    inT: clamp((def.inT ?? 0.32) / Math.sqrt(sp), 0.05, dur * 0.45),
    outT: clamp((def.outT ?? 0.42) / Math.sqrt(sp), 0.05, dur * 0.5),
    tracks,
    osc,
    mask,
  };
}

function hermite(tr: Track, t: number): number {
  const n = tr.t.length;
  if (n === 1 || t <= tr.t[0]) return tr.v[0];
  if (t >= tr.t[n - 1]) return tr.v[n - 1];
  let i = 0;
  while (i < n - 2 && t > tr.t[i + 1]) i++;
  const t0 = tr.t[i];
  const t1 = tr.t[i + 1];
  const h = t1 - t0;
  if (h < 1e-6) return tr.v[i + 1];
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * tr.v[i] +
    (s3 - 2 * s2 + s) * h * tr.m[i] +
    (-2 * s3 + 3 * s2) * tr.v[i + 1] +
    (s3 - s2) * h * tr.m[i + 1]
  );
}

export class Instance {
  elapsed = 0;
  done = false;
  /** akhiri lebih awal dengan keluar halus */
  releaseAt = Infinity;
  constructor(public c: Compiled, public tag = "") {}

  weight(): number {
    const { dur, inT, outT } = this.c;
    const end = Math.min(dur, this.releaseAt + outT);
    const wIn = smoothstep(0, inT, this.elapsed);
    const wOut = 1 - smoothstep(Math.min(dur - outT, this.releaseAt), end, this.elapsed);
    return clamp(wIn * wOut, 0, 1);
  }
  release(): void {
    if (this.releaseAt === Infinity) this.releaseAt = this.elapsed;
  }
  step(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed >= this.c.dur || this.elapsed >= this.releaseAt + this.c.outT) this.done = true;
  }
  /** menulis nilai target ke `vals` dengan bobot `w` (blend terhadap isi `vals` yang ada) */
  sample(vals: Float64Array, touched: Uint8Array): void {
    const w = this.weight();
    if (w <= 0) return;
    const t = this.elapsed;
    const c = this.c;
    for (const tr of c.tracks) {
      const target = hermite(tr, t);
      const cur = vals[tr.ch];
      // kanal sudut (turn): nilai tak boleh di-wrap/di-blend, kalau tidak putaran 360° hilang.
      // Keyframe-nya selalu mulai & berakhir di kelipatan 360 sehingga aman tanpa envelope.
      if (CH_INFO[tr.ch].angular) vals[tr.ch] = cur + target;
      else vals[tr.ch] = cur + (target - cur) * w;
      touched[tr.ch] = 1;
    }
    for (const o of c.osc) {
      if (t < o.from || t > o.to) continue;
      const k = smoothstep(o.from, o.from + 0.25, t) * (1 - smoothstep(o.to - 0.25, o.to, t));
      const add = (o.offset + o.amp * Math.sin((t * o.hz + o.phase) * Math.PI * 2)) * k * w;
      vals[o.ch] += add;
      touched[o.ch] = 1;
    }
  }
}

/** Satu set spring penghalus untuk seluruh kanal. */
export class Filter {
  readonly s: Spring[] = Array.from({ length: N_CH }, (_, i) => ({ x: CH_INFO[i].def, v: 0 }));
  readonly out = new Float64Array(N_CH);
  constructor() {
    for (let i = 0; i < N_CH; i++) this.out[i] = CH_INFO[i].def;
  }
  /** `speed` mengalikan kekakuan (mis. 1.4 saat gerak cepat) */
  step(target: ArrayLike<number>, dt: number, speed = 1): void {
    for (let i = 0; i < N_CH; i++) {
      const info = CH_INFO[i];
      const st = this.s[i];
      let tg = fin(target[i], info.def);
      if (info.angular) {
        tg = st.x + wrap180(tg - st.x);
      } else {
        tg = clamp(tg, info.min, info.max);
      }
      springStep(st, tg, info.omega * speed, info.zeta, dt);
      if (info.angular) st.x = wrap180(st.x);
      else if (st.x < info.min - 5 || st.x > info.max + 5) st.x = clamp(st.x, info.min - 5, info.max + 5);
      this.out[i] = st.x;
    }
  }
}
