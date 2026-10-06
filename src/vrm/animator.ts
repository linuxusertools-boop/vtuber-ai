// ─────────────────────────────────────────────────────────────────────────────
// Animator: otak "hidup" karakter. Lapisan (dari bawah ke atas):
//  1. Pose istirahat + postur mood
//  2. Kehidupan: napas, goyang berat badan, noise mikro kepala, tatapan (saccade +
//     pointer), kedip alami, gerakan spontan tak terduga, beat saat bicara
//  3. Gerakan dari AI (rencana sub-agent), bertopeng per kanal dan di-blend halus
//  4. Penghalus spring kritis per kanal (tidak ada lompatan, ada follow-through)
// Semuanya deterministik terhadap RNG yang bisa disuntik → bisa diuji headless.
// ─────────────────────────────────────────────────────────────────────────────
import { CH_INDEX, CH_INFO, N_CH, REST_POSE, sanitizePose, type Pose } from "./channels";
import { Compiled, Filter, Instance, compileMotion, type MotionDef } from "./engine";
import { BEAT_MOTIONS, IDLE_MOTIONS } from "./motions";
import { Rig, type RigOut } from "./rig";
import type { Plan } from "./director";
import { Rng, clamp, lerp, makeNoise, mulberry32, pickWeighted, rand, springStep, Spring } from "./m3";
import { sampleEnvelope, type Envelope } from "../lib/lipsync";

export type Shot = "close" | "mid" | "full";

interface MoodRecipe {
  face: Pose;
  posture: Pose;
  breath: number; // pengali laju napas
  blink: number; // pengali laju kedip
  gazeAvert: number; // pengali frekuensi memalingkan pandangan
  energy: number; // pengali amplitudo gerak spontan
}
const M = (face: Pose, posture: Pose, breath = 1, blink = 1, gazeAvert = 1, energy = 1): MoodRecipe => ({ face, posture, breath, blink, gazeAvert, energy });
export const MOODS: Record<string, MoodRecipe> = {
  Senang: M({ fHappy: 0.55, fRelax: 0.1 }, { torsoP: -1.5, headP: -1.5, headR: 2 }, 1.05, 1, 0.8, 1.15),
  Sedih: M({ fSad: 0.6 }, { headP: 6, torsoP: 3, lShrug: -2, rShrug: -2 }, 0.85, 0.8, 1.4, 0.6),
  Malu: M({ fHappy: 0.3, fRelax: 0.45 }, { headP: 5, headR: 4, gazeY: -5, lShrug: 2, rShrug: 2 }, 1.15, 1.2, 2.2, 0.8),
  Tsundere: M({ fAngry: 0.3, fHappy: 0.1 }, { headY: 9, gazeX: 8, headP: -1, torsoY: 3 }, 1.05, 1, 1.6, 1),
  Marah: M({ fAngry: 0.85 }, { headP: 4, torsoP: 3, lShrug: 3, rShrug: 3 }, 1.25, 0.8, 0.5, 1.2),
  Kaget: M({ fSurp: 0.85 }, { headP: -3, torsoP: -3 }, 1.4, 0.5, 0.5, 1.2),
  Bingung: M({ fSad: 0.22, fSurp: 0.15 }, { headR: 7, headP: 1 }, 1, 1, 1.5, 0.9),
  Serius: M({ fAngry: 0.12 }, { headP: 1.5 }, 0.95, 0.85, 0.6, 0.7),
};
const DEFAULT_MOOD = MOODS.Senang;

export interface AnimOut {
  rig: RigOut;
  /** bobot ekspresi VRM (0..1) */
  expr: Record<string, number>;
  shot: Shot;
  /** 0..1 energi bicara (untuk efek cahaya) */
  voice: number;
}

export class Animator {
  readonly filter = new Filter();
  readonly rigOut: RigOut = { quats: {}, hips: [0, 0, 0] };
  private rng: Rng;
  private noise: (x: number) => number;
  private t = 0;
  private seed: number;
  private instances: Instance[] = [];
  private vals = new Float64Array(N_CH);
  private touched = new Uint8Array(N_CH);
  private moodName = "Senang";
  private moodCur = new Float64Array(N_CH);
  private moodTarget = new Float64Array(N_CH);
  private faceMood = new Float64Array(N_CH);
  private recipe: MoodRecipe = DEFAULT_MOOD;
  // napas
  private breathPhase = 0;
  private sigh = 0;
  // kedip
  private nextBlink = 1.2;
  private blinkT = -1;
  private blinkLen = 0.24;
  private doubleBlink = false;
  blinkValue = 0;
  // tatapan
  private gaze: { x: Spring; y: Spring } = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 } };
  private gazeTarget = { x: 0, y: 0 };
  private nextSaccade = 0.8;
  private avert = { until: 0, x: 0, y: 0 };
  private nextAvert = 4;
  private pointer = { x: 0, y: 0, at: -99 };
  // spontan
  private nextFidget = 6;
  private recent: string[] = [];
  private nextBeat = 2;
  private weightShiftT = 0;
  private shiftTarget = 0;
  private shift: Spring = { x: 0, v: 0 };
  private nodKick: Spring = { x: 0, v: 0 };
  // bicara
  private speaking = false;
  private env: Envelope | null = null;
  private clock: () => number = () => 0;
  private speechT0 = 0;
  private vowel = { aa: { x: 0, v: 0 }, ih: { x: 0, v: 0 }, ou: { x: 0, v: 0 }, ee: { x: 0, v: 0 }, oh: { x: 0, v: 0 } } as Record<string, Spring>;
  private syl = { next: 0, open: 0, vowel: "aa" };
  private lastAmp = 0;
  private voiceE = 0;
  // kamera
  shot: Shot = "mid";
  private shotUntil = 0;

  constructor(private rig: Rig, seed = (Math.random() * 1e9) | 0) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.noise = makeNoise(mulberry32(seed ^ 0x9e3779b9));
    this.setMood("Senang", true);
    this.moodCur.set(this.moodTarget);
    this.vals.set(REST_POSE);
    this.nextBlink = rand(this.rng, 1, 3);
    this.nextFidget = rand(this.rng, 5, 10);
  }

  // ── kontrol dari luar ──────────────────────────────────────────────────────
  setMood(name: string, instant = false): void {
    this.recipe = MOODS[name] ?? DEFAULT_MOOD;
    this.moodName = MOODS[name] ? name : "Senang";
    this.moodTarget.set(REST_POSE);
    this.faceMood.fill(0);
    for (const [k, v] of Object.entries(sanitizePose(this.recipe.posture))) this.moodTarget[CH_INDEX[k]] = v;
    for (const [k, v] of Object.entries(sanitizePose(this.recipe.face))) this.faceMood[CH_INDEX[k]] = v;
    if (instant) this.moodCur.set(this.moodTarget);
  }
  get mood(): string {
    return this.moodName;
  }
  setPointer(nx: number, ny: number): void {
    if (Number.isFinite(nx) && Number.isFinite(ny)) this.pointer = { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1), at: this.t };
  }
  startSpeech(env: Envelope | null, clock: () => number): void {
    this.speaking = true;
    this.env = env;
    this.clock = clock;
    this.speechT0 = this.t;
    this.nextBeat = this.t + rand(this.rng, 0.8, 1.8);
    this.syl.next = 0;
  }
  stopSpeech(): void {
    this.speaking = false;
    this.env = null;
  }
  /** Mainkan rencana sub-agent. holdSec = lama bicara (pose "sustain" ditahan sebanyak itu). */
  play(plan: Plan, holdSec = 0): void {
    if (!plan.items.length) return;
    this.releaseAll(false);
    for (const it of plan.items) this.start(it.def, { mirror: it.mirror, speed: it.speed, amp: it.amp, delay: it.delay, hold: holdSec, tag: "g" });
  }
  playDef(def: MotionDef, holdSec = 0, mirror = false): void {
    this.releaseAll(false);
    this.start(def, { mirror, speed: 1, amp: 1, delay: 0, hold: holdSec, tag: "g" });
  }
  releaseAll(includeLight = true): void {
    for (const i of this.instances) if (includeLight || !i.c.def.light) i.release();
  }
  private pending: { at: number; c: Compiled; tag: string }[] = [];
  private start(def: MotionDef, o: { mirror: boolean; speed: number; amp: number; delay: number; hold: number; tag: string }): void {
    let c: Compiled;
    try {
      const hold = def.holdAt !== undefined ? Math.max(0, o.hold - def.dur / Math.max(0.3, o.speed)) : 0;
      c = compileMotion(def, o.mirror, o.speed, o.amp, hold);
    } catch {
      return;
    }
    if (c.def.shot) {
      this.shot = c.def.shot;
      this.shotUntil = this.t + o.delay + c.dur + 0.6;
    }
    if (o.delay > 0.05) this.pending.push({ at: this.t + o.delay, c, tag: o.tag });
    else this.instances.push(new Instance(c, o.tag));
    if (this.instances.length > 8) this.instances.splice(0, this.instances.length - 8);
  }
  private armsBusy(): boolean {
    return this.instances.some((i) => !i.done && !i.c.def.light) || this.pending.length > 0;
  }

  // ── frame ────────────────────────────────────────────────────────────────
  update(dtIn: number): AnimOut {
    const dt = clamp(Number.isFinite(dtIn) ? dtIn : 0.016, 0.0005, 0.05);
    this.t += dt;
    const t = this.t;
    const v = this.vals;
    const mc = this.moodCur;
    const k = 1 - Math.exp(-dt * 2.2);
    for (let i = 0; i < N_CH; i++) mc[i] += (this.moodTarget[i] - mc[i]) * k;
    v.set(mc);
    const R = this.recipe;
    const E = R.energy;
    const n = this.noise;
    const s = this.seed % 97;

    // ── napas ──
    const rate = 0.23 * R.breath * (this.speaking ? 1.12 : 1) * (1 + 0.08 * n(t * 0.1 + s));
    this.breathPhase += dt * rate * Math.PI * 2;
    const bp = Math.sin(this.breathPhase);
    const breath = bp > 0 ? Math.pow(bp, 0.85) : -Math.pow(-bp, 1.25) * 0.8; // tarik cepat, hembus lambat
    this.sigh = Math.max(0, this.sigh - dt * 0.4);
    const depth = 1 + this.sigh * 2;
    v[CH_INDEX.torsoP] += -1.1 * breath * depth;
    v[CH_INDEX.lShrug] += 0.9 * breath * depth;
    v[CH_INDEX.rShrug] += 0.9 * breath * depth;
    v[CH_INDEX.headP] += 0.5 * breath;
    v[CH_INDEX.hipsDY] += 0.12 * breath;

    // ── berat badan & goyang halus ──
    this.weightShiftT -= dt;
    if (this.weightShiftT <= 0) {
      this.weightShiftT = rand(this.rng, 7, 16);
      this.shiftTarget = this.rng() < 0.3 ? 0 : (this.rng() < 0.5 ? -1 : 1) * rand(this.rng, 0.45, 0.9);
    }
    springStep(this.shift, this.shiftTarget, 1.6, 1, dt);
    v[CH_INDEX.shift] += this.shift.x;
    v[CH_INDEX.hipsR] += 1.0 * n(t * 0.17 + 10 + s) * E;
    v[CH_INDEX.hipsY] += 1.8 * n(t * 0.13 + 20 + s) * E;
    v[CH_INDEX.hipsX] += 0.5 * n(t * 0.15 + 30 + s);
    v[CH_INDEX.torsoY] += 1.5 * n(t * 0.14 + 40 + s) * E - v[CH_INDEX.hipsY] * 0.3;
    v[CH_INDEX.torsoR] += 0.9 * n(t * 0.19 + 50 + s) * E;

    // ── noise mikro kepala (2 oktaf) ──
    const hn = (a: number) => n(t * 0.31 + a + s) * 0.7 + n(t * 0.83 + a * 2 + s) * 0.3;
    v[CH_INDEX.headP] += 1.1 * hn(60) * E;
    v[CH_INDEX.headY] += 1.6 * hn(70) * E;
    v[CH_INDEX.headR] += 1.0 * hn(80) * E;

    // ── lengan/jari "bernapas" ──
    for (const side of ["l", "r"]) {
      const o = side === "l" ? 0 : 7;
      v[CH_INDEX[side + "Raise"]] += 1.4 * n(t * 0.21 + 90 + o + s) + 0.5 * breath;
      v[CH_INDEX[side + "Az"]] += 2 * n(t * 0.17 + 100 + o + s);
      v[CH_INDEX[side + "Elbow"]] += 2.5 * n(t * 0.19 + 110 + o + s);
      for (const f of ["Idx", "Mid", "Rng", "Thumb"]) v[CH_INDEX[side + f]] += 0.05 * n(t * 0.4 + 120 + o + f.length * 3 + s);
    }

    // ── tatapan ──
    this.updateGaze(dt, t, v);

    // ── kedip ──
    this.updateBlink(dt, t);

    // ── jadwal: gerakan spontan & beat ──
    this.pending = this.pending.filter((p) => {
      if (t >= p.at) {
        this.instances.push(new Instance(p.c, p.tag));
        return false;
      }
      return true;
    });
    if (!this.speaking && !this.armsBusy() && t >= this.nextFidget) {
      this.nextFidget = t + rand(this.rng, 5, 13);
      this.randomFidget();
    }
    if (this.speaking && t >= this.nextBeat) {
      this.nextBeat = t + rand(this.rng, 1.8, 4.2);
      if (!this.armsBusy() && this.rng() < 0.75) this.randomBeat();
    }

    // ── gerakan dari AI / spontan ──
    this.touched.fill(0);
    for (const inst of this.instances) {
      inst.sample(v, this.touched);
      inst.step(dt);
    }
    this.instances = this.instances.filter((i) => !i.done);
    if (t > this.shotUntil && this.shot !== "mid" && !this.instances.some((i) => i.c.def.shot)) this.shot = "mid";

    // ── bicara: kepala mengangguk mengikuti penekanan suara ──
    const mouth = this.updateSpeech(dt, t);
    v[CH_INDEX.headP] += this.nodKick.x;

    // wajah dasar dari mood (di bawah, gerakan boleh menaikkan)
    for (let i = 0; i < N_CH; i++) if (this.faceMood[i]) v[i] = Math.max(v[i], this.faceMood[i]);

    // ── penghalus ──
    for (let i = 0; i < N_CH; i++) if (!Number.isFinite(v[i])) v[i] = CH_INFO[i].def;
    const fast = this.instances.some((i) => i.c.def.name === "berputar" || i.c.def.name === "melompat") ? 1.5 : 1;
    this.filter.step(v, dt, fast);
    const f = this.filter.out;
    this.rig.solve(f, this.rigOut);

    // ── ekspresi VRM ──
    const g = (n2: string) => f[CH_INDEX[n2]];
    const happy = clamp(g("fHappy"), 0, 1);
    const emote = this.speaking ? 0.85 : 1;
    const talk = mouth.aa + mouth.ih + mouth.ou + mouth.ee + mouth.oh;
    const bl = Math.max(this.blinkValue, 0);
    const squint = clamp(happy * 0.35 + g("fSad") * 0.1, 0, 0.45);
    const expr: Record<string, number> = {
      happy: clamp(happy * 0.5 * emote, 0, 0.6),
      relaxed: clamp(g("fRelax") * 0.7 + happy * 0.45, 0, 0.8) * emote,
      sad: clamp(g("fSad") * emote, 0, 1),
      angry: clamp(g("fAngry") * emote, 0, 1),
      surprised: clamp(g("fSurp"), 0, 1),
      blink: clamp(Math.max(bl * (1 - squint), 0), 0, 1),
      blinkLeft: clamp(Math.max(0, g("fBlinkL") - bl), 0, 1),
      blinkRight: clamp(Math.max(0, g("fBlinkR") - bl), 0, 1),
      aa: clamp(mouth.aa + g("fMouthA") * (1 - talk), 0, 1),
      ih: clamp(mouth.ih, 0, 1),
      ou: clamp(mouth.ou + g("fMouthO") * (1 - talk), 0, 1),
      ee: clamp(mouth.ee, 0, 1),
      oh: clamp(mouth.oh, 0, 1),
    };
    // saat bicara, ekspresi dengan bentuk mulut kuat dikurangi agar vokal terbaca
    const damp = 1 - 0.5 * clamp(talk, 0, 1);
    expr.sad *= damp;
    expr.angry *= damp;
    expr.surprised *= 1 - 0.35 * clamp(talk, 0, 1);
    return { rig: this.rigOut, expr, shot: this.shot, voice: this.voiceE };
  }

  // ── tatapan ───────────────────────────────────────────────────────────────
  private updateGaze(dt: number, t: number, v: Float64Array): void {
    const R = this.recipe;
    let tx = 0;
    let ty = 0;
    const ptrActive = t - this.pointer.at < 3.5 && (Math.abs(this.pointer.x) > 0.02 || Math.abs(this.pointer.y) > 0.02);
    if (ptrActive) {
      tx = this.pointer.x * 22;
      ty = this.pointer.y * 12;
    }
    if (t >= this.nextAvert) {
      this.nextAvert = t + rand(this.rng, 3.5, 9) / (R.gazeAvert * (this.speaking ? 0.6 : 1));
      if (!ptrActive && this.rng() < 0.85) {
        const up = this.rng() < 0.35;
        this.avert = { until: t + rand(this.rng, 0.7, 2.2), x: (this.rng() < 0.5 ? -1 : 1) * rand(this.rng, 8, 20), y: up ? rand(this.rng, 4, 10) : -rand(this.rng, 3, 9) };
        if (this.rng() < 0.7) this.nextBlink = Math.min(this.nextBlink, t + 0.05);
      }
    }
    if (t < this.avert.until) {
      tx = this.avert.x;
      ty = this.avert.y;
    }
    // saccade: lompatan kecil di sekitar target tiap 0.4–1.6 dtk + mikro-saccade
    if (t >= this.nextSaccade) {
      this.nextSaccade = t + rand(this.rng, 0.4, 1.6);
      this.gazeTarget.x = rand(this.rng, -2.2, 2.2);
      this.gazeTarget.y = rand(this.rng, -1.5, 1.5);
    }
    const gx = tx + this.gazeTarget.x + 0.5 * this.noise(t * 3.1);
    const gy = ty + this.gazeTarget.y + 0.4 * this.noise(t * 2.7 + 5);
    springStep(this.gaze.x, gx, 38, 1, dt);
    springStep(this.gaze.y, gy, 38, 1, dt);
    v[CH_INDEX.gazeX] += this.gaze.x.x;
    v[CH_INDEX.gazeY] += this.gaze.y.x;
    // kepala menyusul mata (35%, terlambat karena spring kepala lebih lambat)
    v[CH_INDEX.headY] += this.gaze.x.x * 0.35;
    v[CH_INDEX.headP] += -this.gaze.y.x * 0.3;
    v[CH_INDEX.torsoY] += this.gaze.x.x * 0.06;
  }

  private updateBlink(dt: number, t: number): void {
    if (this.blinkT < 0 && t >= this.nextBlink) {
      this.blinkT = 0;
      this.blinkLen = rand(this.rng, 0.2, 0.3);
      this.doubleBlink = this.rng() < 0.12;
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / this.blinkLen;
      // menutup cepat (30%), tahan sebentar, membuka lebih lambat
      this.blinkValue = p < 0.3 ? p / 0.3 : p < 0.38 ? 1 : Math.max(0, 1 - (p - 0.38) / 0.62);
      if (p >= 1) {
        this.blinkT = -1;
        this.blinkValue = 0;
        const base = rand(this.rng, 1.8, 5.5) / this.recipe.blink;
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.nextBlink = t + 0.12;
        } else this.nextBlink = t + base;
      }
    } else this.blinkValue = 0;
  }

  // ── spontan ───────────────────────────────────────────────────────────────
  private randomFidget(): void {
    const pool = IDLE_MOTIONS.filter((m) => !this.recent.includes(m.name));
    const pickM = pickWeighted(this.rng, pool, (m) => (m.idle ?? 0) * (m.moods?.includes(this.moodName) ? 2.2 : 1) * (this.moodName === "Serius" && m.name === "tertawa" ? 0 : 1));
    if (!pickM) return;
    this.recent.push(pickM.name);
    if (this.recent.length > 3) this.recent.shift();
    if (pickM.name === "menghela napas") this.sigh = 1;
    this.start(pickM, { mirror: this.rng() < 0.4, speed: rand(this.rng, 0.85, 1.12), amp: rand(this.rng, 0.8, 1.1), delay: 0, hold: rand(this.rng, 0.5, 2), tag: "idle" });
  }
  private randomBeat(): void {
    const pickM = pickWeighted(this.rng, BEAT_MOTIONS, (m) => (m.moods?.includes(this.moodName) ? 2 : 1));
    if (!pickM) return;
    this.start(pickM, { mirror: this.rng() < 0.45, speed: rand(this.rng, 0.9, 1.15), amp: rand(this.rng, 0.7, 1.05) * this.recipe.energy, delay: 0, hold: 0, tag: "beat" });
  }

  // ── bicara / lip-sync ─────────────────────────────────────────────────────
  private updateSpeech(dt: number, t: number): Record<string, number> {
    let open = 0;
    let bright = 0.5;
    if (this.speaking) {
      const ct = this.clock();
      if (this.env && Number.isFinite(ct)) {
        const s = sampleEnvelope(this.env, ct + 0.02);
        open = s.amp;
        bright = s.bright;
      } else {
        // fallback prosedural: suku kata acak ±6/dtk (tetap terlihat berbicara)
        if (t >= this.syl.next) {
          this.syl.next = t + rand(this.rng, 0.12, 0.26);
          this.syl.open = this.rng() < 0.16 ? 0.05 : rand(this.rng, 0.35, 0.95);
          this.syl.vowel = ["aa", "ih", "ou", "ee", "oh"][Math.floor(this.rng() * 5)];
        }
        open = this.syl.open;
        bright = { aa: 0.5, ih: 0.85, ou: 0.1, ee: 0.8, oh: 0.25 }[this.syl.vowel] ?? 0.5;
      }
    }
    // penekanan → anggukan kecil
    const rise = open - this.lastAmp;
    if (this.speaking && rise > 0.35 && open > 0.55 && t - this.nodAt > 0.5) {
      this.nodAt = t;
      this.nodKick.v += 38 * this.recipe.energy;
    }
    this.lastAmp = open;
    springStep(this.nodKick, 0, 16, 0.55, dt);
    this.voiceE += (open - this.voiceE) * (1 - Math.exp(-dt * 8));

    const w = {
      aa: open * clamp(1.15 - Math.abs(bright - 0.5) * 1.6, 0.25, 1),
      ee: open * clamp((bright - 0.55) * 1.8, 0, 1) * 0.7,
      ih: open * clamp((bright - 0.55) * 1.8, 0, 1) * 0.5,
      ou: open * clamp((0.4 - bright) * 2, 0, 1) * 0.8,
      oh: open * clamp((0.4 - bright) * 2, 0, 1) * 0.5,
    } as Record<string, number>;
    for (const key of Object.keys(this.vowel)) {
      springStep(this.vowel[key], clamp(w[key], 0, 1), open > this.vowel[key].x ? 55 : 32, 1, dt);
      this.vowel[key].x = clamp(this.vowel[key].x, 0, 1);
    }
    return { aa: this.vowel.aa.x * 0.85, ih: this.vowel.ih.x, ou: this.vowel.ou.x, ee: this.vowel.ee.x, oh: this.vowel.oh.x };
  }
  private nodAt = -9;
}
