// ─────────────────────────────────────────────────────────────────────────────
// Rig: mengubah kanal gerak (derajat, intuitif) → quaternion LOKAL tiap tulang
// humanoid (normalized rig VRM: pose istirahat = rotasi identitas, T-pose).
//
// Strategi anti-salah-arah: tidak ada tanda (+/-) yang ditebak. Sumbu kiri/kanan
// dan depan dikalibrasi dari posisi tulang model, semua sumbu diturunkan dari
// geometri istirahat (arah tulang), lalu lengan memakai "aim" (arah tulang
// ditentukan langsung) bukan sudut Euler → tidak ada gimbal lock di tangan.
// ─────────────────────────────────────────────────────────────────────────────
import { CH_INDEX, N_CH } from "./channels";
import { Q, Vec, clamp, smoothstep, vadd, vcross, vdot, vlen, vmul, vnorm, vsub } from "./m3";

export type RestMap = Partial<Record<string, Vec>>;
export interface RigOut {
  quats: Record<string, Q>;
  /** offset posisi pinggul dari posisi istirahat (meter, bingkai model) */
  hips: Vec;
}

const FINGERS = ["Index", "Middle", "Ring", "Little"] as const;

export class Rig {
  readonly sx: number; // +1 jika "kiri karakter" = +X
  readonly fz: number; // +1 jika depan = +Z
  readonly F: Vec;
  readonly L: Vec;
  readonly U: Vec = [0, 1, 0];
  readonly axPitch: Vec; // putar + → condong ke depan
  readonly axYaw: Vec; // putar + → ke kiri
  readonly axRoll: Vec; // putar + → miring ke kiri
  private rest: RestMap;
  private L1: number;
  private L2: number;
  private dirCache = new Map<string, Vec>();

  constructor(rest: RestMap) {
    this.rest = rest;
    const lu = rest.leftUpperArm;
    const ru = rest.rightUpperArm;
    this.sx = lu && ru && Math.abs(lu[0] - ru[0]) > 1e-4 ? Math.sign(lu[0] - ru[0]) : 1;
    let fz = 0;
    const lf = rest.leftFoot;
    const lt = rest.leftToes;
    if (lf && lt && Math.abs(lt[2] - lf[2]) > 1e-3) fz = Math.sign(lt[2] - lf[2]);
    if (!fz) {
      const th = rest.leftThumbDistal;
      const ix = rest.leftIndexProximal;
      if (th && ix && Math.abs(th[2] - ix[2]) > 1e-3) fz = Math.sign(th[2] - ix[2]);
    }
    this.fz = fz || 1;
    this.F = [0, 0, this.fz];
    this.L = [this.sx, 0, 0];
    this.axPitch = vcross(this.U, this.F);
    this.axYaw = vcross(this.F, this.L);
    this.axRoll = vcross(this.U, this.L);
    const d = (a: string, b: string, def: number) => {
      const pa = rest[a];
      const pb = rest[b];
      return pa && pb ? vlen(vsub(pa, pb)) || def : def;
    };
    this.L1 = d("leftUpperLeg", "leftLowerLeg", 0.38);
    this.L2 = d("leftLowerLeg", "leftFoot", 0.4);
  }

  has(n: string): boolean {
    return !!this.rest[n];
  }

  /** Arah istirahat sebuah tulang (menuju tulang anak). */
  private dir(a: string, b: string, fallback: Vec): Vec {
    const key = a + ">" + b;
    const c = this.dirCache.get(key);
    if (c) return c;
    const pa = this.rest[a];
    const pb = this.rest[b];
    const v = pa && pb ? vnorm(vsub(pb, pa), fallback) : fallback;
    this.dirCache.set(key, v);
    return v;
  }

  private rotYPR(yaw: number, pitch: number, roll: number): Q {
    return Q.axisAngle(this.axYaw, yaw).mul(Q.axisAngle(this.axPitch, pitch)).mul(Q.axisAngle(this.axRoll, roll));
  }

  solve(ch: ArrayLike<number>, out: RigOut): void {
    const g = (n: string) => {
      const v = ch[CH_INDEX[n]];
      return Number.isFinite(v) ? v : 0;
    };
    const q = out.quats;
    const { F, U } = this;

    // ── pinggul ────────────────────────────────────────────────────────────
    const shift = clamp(g("shift"), -1, 1);
    const hipsY = g("hipsY");
    const hipsR = g("hipsR") - 3 * shift; // sisi tak bertumpu turun
    const hipsP = g("hipsP");
    const Rsmall = this.rotYPR(hipsY, hipsP, hipsR);
    const Rturn = Q.axisAngle(this.axYaw, g("turn"));
    q.hips = Rturn.mul(Rsmall);

    // ── kaki (dunia-terkunci: tidak ikut goyangan pinggul kecil) ─────────────
    const crouch = clamp(g("crouch"), 0, 1);
    const legs = (s: "l" | "r") => {
      const unload = s === "l" ? Math.max(0, -shift) : Math.max(0, shift);
      const a = g(s + "LegFwd") + crouch * 38 + unload * 5;
      const b = g(s + "Knee") + crouch * 70 + unload * 10;
      const side = s === "l" ? "left" : "right";
      q[side + "UpperLeg"] = Rsmall.inv().mul(Q.axisAngle(this.axPitch, -a));
      q[side + "LowerLeg"] = Q.axisAngle(this.axPitch, b);
      const ar = (a * Math.PI) / 180;
      const br = ((a - b) * Math.PI) / 180;
      return {
        side,
        a,
        b,
        drop: this.L1 * (1 - Math.cos(ar)) + this.L2 * (1 - Math.cos(br)),
        h: this.L1 * Math.sin(ar) + this.L2 * Math.sin(br),
      };
    };
    const ll = legs("l");
    const rl = legs("r");
    const planted = ll.drop <= rl.drop ? ll : rl;
    for (const lg of [ll, rl]) {
      // telapak kaki rata di lantai; hanya kaki yang terangkat dibiarkan rileks
      const k = 1 - clamp((lg.drop - planted.drop) / 0.06, 0, 1) * 0.6;
      q[lg.side + "Foot"] = Q.axisAngle(this.axPitch, (lg.a - lg.b) * k);
    }
    const dy = -planted.drop + g("hipsDY") * 0.01;
    const dz = -planted.h + g("hipsZ") * 0.01;
    const dx = g("hipsX") * 0.01 + shift * 0.022;
    out.hips = vadd(vadd(vmul(this.L, dx), vmul(F, dz)), vmul(U, dy));

    // ── badan: spine/chest/upperChest + kontra-rotasi pinggul (lekuk S) ──────
    const hasUC = this.has("upperChest");
    const wts = hasUC ? [0.25, 0.4, 0.35] : [0.4, 0.6, 0];
    const tP = g("torsoP");
    const tY = g("torsoY");
    const tR = g("torsoR");
    const names = ["spine", "chest", "upperChest"];
    for (let i = 0; i < 3; i++) {
      if (!wts[i]) continue;
      let y = tY * wts[i];
      let r = tR * wts[i];
      if (i === 0) {
        y -= hipsY * 0.45;
        r -= hipsR * 0.55;
      }
      q[names[i]] = this.rotYPR(y, tP * wts[i], r);
    }

    // ── leher & kepala ──────────────────────────────────────────────────────
    const hP = g("headP");
    const hY = g("headY");
    const hR = g("headR");
    q.neck = this.rotYPR(hY * 0.4, hP * 0.4, hR * 0.4);
    q.head = this.rotYPR(hY * 0.6, hP * 0.6, hR * 0.6);

    // ── mata ────────────────────────────────────────────────────────────────
    const gy = clamp(g("gazeX") * 0.6, -16, 16);
    const gp = clamp(g("gazeY") * 0.6, -10, 10);
    const eye = Q.axisAngle(this.axYaw, gy).mul(Q.axisAngle(vcross(F, U), gp));
    q.leftEye = eye;
    q.rightEye = eye;

    // ── lengan + tangan ─────────────────────────────────────────────────────
    this.arm("left", ch, q);
    this.arm("right", ch, q);
  }

  private arm(side: "left" | "right", ch: ArrayLike<number>, q: Record<string, Q>): void {
    const s = side === "left" ? "l" : "r";
    const g = (n: string) => {
      const v = ch[CH_INDEX[s + n]];
      return Number.isFinite(v) ? v : 0;
    };
    const { F, U } = this;
    const O: Vec = side === "left" ? this.L : vmul(this.L, -1);
    const raiseDeg = g("Raise");
    const raise = (clamp(raiseDeg, 0, 180) * Math.PI) / 180;
    const az = (clamp(g("Az"), -90, 180) * Math.PI) / 180;
    const plane = (g("Plane") * Math.PI) / 180;

    // bahu: naik otomatis saat lengan terangkat tinggi (ritme skapulohumeral)
    const auto = smoothstep(55, 175, raiseDeg) * 16;
    q[side + "Shoulder"] = Q.axisAngle(vcross(O, U), g("Shrug") + auto);

    // arah lengan atas (bingkai bahu)
    const horiz = vadd(vmul(O, Math.cos(az)), vmul(F, Math.sin(az)));
    const u = vnorm(vadd(vmul(U, -Math.cos(raise)), vmul(horiz, Math.sin(raise))), vmul(U, -1));
    const Qu = Q.fromUnitVectors(vmul(U, -1), u); // bingkai pelacak: b0=Qu·F, c=Qu·O
    const restUA = this.dir(side + "UpperArm", side + "LowerArm", O);
    const Qrest = Q.fromUnitVectors(restUA, vmul(U, -1));
    const QU = Qu.mul(Qrest); // rotasi lengan atas (lokal terhadap bahu)
    q[side + "UpperArm"] = QU;

    // siku = engsel murni: u berputar menuju arah tekuk b
    const b0 = Qu.rotate(F);
    const c = Qu.rotate(O);
    const b = vnorm(vadd(vmul(b0, Math.cos(plane)), vmul(c, Math.sin(plane))), b0);
    const hinge = vnorm(vcross(u, b), c);
    const elbow = g("Elbow");
    const f = vnorm(vadd(vmul(u, Math.cos((elbow * Math.PI) / 180)), vmul(b, Math.sin((elbow * Math.PI) / 180))), u);
    const Qhinge = Q.axisAngle(hinge, elbow);
    const Qroll = Q.axisAngle(f, g("Roll"));
    const Qlow = Qroll.mul(Qhinge).mul(QU); // rotasi lengan bawah (bingkai bahu)
    q[side + "LowerArm"] = QU.inv().mul(Qlow);
    const Qhand = Q.axisAngle(hinge, g("Wrist")).mul(Qlow);
    q[side + "Hand"] = Qlow.inv().mul(Qhand);

    this.hand(side, s, g, q);
  }

  private hand(side: "left" | "right", s: string, g: (n: string) => number, q: Record<string, Q>): void {
    const { F, U } = this;
    const amounts: Record<string, number> = {
      Index: g("Idx"),
      Middle: g("Mid"),
      Ring: g("Rng"),
      Little: g("Rng") * 1.06,
    };
    const spread = clamp(g("Spread"), 0, 1);
    const spreadDeg: Record<string, number> = { Index: 7, Middle: 1, Ring: -5, Little: -11 };
    const MAXC = [72, 92, 62];
    for (const fn of FINGERS) {
      const bones = [side + fn + "Proximal", side + fn + "Intermediate", side + fn + "Distal"];
      const amt = clamp(amounts[fn], 0, 1);
      for (let j = 0; j < 3; j++) {
        if (!this.has(bones[j])) continue;
        const nextName = bones[j + 1] ?? null;
        const d = nextName && this.has(nextName)
          ? this.dir(bones[j], nextName, vnorm(vmul(this.L, side === "left" ? 1 : -1)))
          : this.dir(bones[j - 1] ?? bones[j], bones[j], vnorm(vmul(this.L, side === "left" ? 1 : -1)));
        // sumbu tekuk jari = arah jari × normal telapak (telapak menghadap -Y saat T-pose)
        const n = vnorm(vsub(vmul(U, -1), vmul(d, vdot(d, vmul(U, -1)))), vmul(U, -1));
        const axis = vnorm(vcross(d, n), [0, 0, 1]);
        let rot = Q.axisAngle(axis, MAXC[j] * amt);
        if (j === 0 && spread > 0) {
          const fp = vnorm(vsub(F, vmul(d, vdot(d, F))), F);
          rot = Q.axisAngle(vnorm(vcross(d, fp), [0, 1, 0]), spreadDeg[fn] * spread).mul(rot);
        }
        q[bones[j]] = rot;
      }
    }
    // jempol
    const tb = [side + "ThumbMetacarpal", side + "ThumbProximal", side + "ThumbDistal"];
    const tAmt = clamp(g("Thumb"), 0, 1);
    const TMAX = [24, 34, 42];
    for (let j = 0; j < 3; j++) {
      if (!this.has(tb[j])) continue;
      const next = tb[j + 1];
      const d = next && this.has(next)
        ? this.dir(tb[j], next, vnorm(vadd(vmul(this.L, side === "left" ? 1 : -1), F)))
        : this.dir(tb[j - 1] ?? tb[j], tb[j], vnorm(vadd(vmul(this.L, side === "left" ? 1 : -1), F)));
      const target = vnorm(vadd(vmul(U, -0.5), vmul(F, -0.5)));
      const n = vnorm(vsub(target, vmul(d, vdot(d, target))), target);
      const axis = vnorm(vcross(d, n), [0, 0, 1]);
      q[tb[j]] = Q.axisAngle(axis, TMAX[j] * tAmt);
    }
  }
}

/** Menyusun array kanal penuh dari map sebagian (sisanya default istirahat). */
export function poseToArray(p: Record<string, number>, base: ArrayLike<number>): Float64Array {
  const a = Float64Array.from(base as ArrayLike<number>);
  for (const [k, v] of Object.entries(p)) {
    const i = CH_INDEX[k];
    if (i !== undefined && Number.isFinite(v)) a[i] = v;
  }
  return a.length === N_CH ? a : new Float64Array(N_CH);
}
