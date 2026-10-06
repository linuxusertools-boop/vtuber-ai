// ─────────────────────────────────────────────────────────────────────────────
// Kanal gerak: SATU bahasa untuk semua (idle, preset gerakan, sub-agent AI).
// Semua sudut dalam derajat. Konvensi tubuh (dari sudut pandang karakter):
//   P (pitch) + = menunduk/condong ke depan    Y (yaw) + = menoleh/berputar ke KIRI karakter
//   R (roll)  + = miring ke KIRI karakter      lengan: Raise 0=turun, 90=mendatar, 180=lurus ke atas
//   Az: 0=ke samping, 90=ke depan, 180=menyilang ke dalam, negatif=ke belakang
// Arah sebenarnya dikalibrasi otomatis dari skeleton model (lihat rig.ts).
// ─────────────────────────────────────────────────────────────────────────────
export interface ChannelInfo {
  min: number;
  max: number;
  def: number;
  omega: number; // kekakuan spring penghalus
  zeta: number; // 1 = kritis, <1 = sedikit overshoot (follow-through alami)
  angular?: boolean;
  doc: string;
}

const arm = (s: "l" | "r", name: string) => {
  const S = s === "l" ? "kiri" : "kanan";
  return {
    [`${s}Raise`]: { min: 0, max: 180, def: 14, omega: 11, zeta: 0.82, doc: `lengan ${S}: angkat (0 turun,90 mendatar,180 atas)` },
    [`${s}Az`]: { min: -90, max: 180, def: 6, omega: 11, zeta: 0.82, doc: `lengan ${S}: arah (0 samping,90 depan,180 silang)` },
    [`${s}Elbow`]: { min: -5, max: 155, def: 14, omega: 12, zeta: 0.8, doc: `siku ${S}: tekuk 0..150` },
    [`${s}Plane`]: { min: -120, max: 120, def: 0, omega: 12, zeta: 0.85, doc: `bidang tekuk siku ${S} (+ ke atas/luar, - ke dalam)` },
    [`${s}Roll`]: { min: -90, max: 90, def: 0, omega: 12, zeta: 0.9, doc: `putar lengan bawah ${S}` },
    [`${s}Wrist`]: { min: -50, max: 50, def: 0, omega: 16, zeta: 0.75, doc: `tekuk pergelangan ${S}` },
    [`${s}Idx`]: { min: 0, max: 1, def: 0.14, omega: 16, zeta: 0.9, doc: `jari telunjuk ${S} (0 lurus,1 menekuk)` },
    [`${s}Mid`]: { min: 0, max: 1, def: 0.18, omega: 16, zeta: 0.9, doc: `jari tengah ${S}` },
    [`${s}Rng`]: { min: 0, max: 1, def: 0.24, omega: 16, zeta: 0.9, doc: `jari manis+kelingking ${S}` },
    [`${s}Thumb`]: { min: 0, max: 1, def: 0.18, omega: 16, zeta: 0.9, doc: `jempol ${S}` },
    [`${s}Spread`]: { min: 0, max: 1, def: 0.12, omega: 14, zeta: 0.9, doc: `jari merenggang ${S}` },
    [`${s}Shrug`]: { min: -10, max: 25, def: 0, omega: 14, zeta: 0.85, doc: `bahu ${S} naik` },
  } as Record<string, ChannelInfo>;
};

const b = (min: number, max: number, def: number, omega: number, zeta: number, doc: string, angular = false): ChannelInfo => ({
  min,
  max,
  def,
  omega,
  zeta,
  doc,
  angular,
});

export const CHANNEL_DEFS: Record<string, ChannelInfo> = {
  hipsY: b(-35, 35, 0, 8, 1, "pinggul memutar"),
  hipsR: b(-15, 15, 0, 8, 1, "pinggul miring"),
  hipsP: b(-25, 25, 0, 8, 1, "pinggul condong"),
  hipsX: b(-15, 15, 0, 8, 1, "pinggul geser samping (cm, + kiri)"),
  hipsZ: b(-20, 20, 0, 8, 1, "pinggul geser depan (cm)"),
  hipsDY: b(-25, 35, 0, 12, 0.9, "pinggul naik/turun (cm)"),
  turn: b(-720, 720, 0, 9, 1, "putar seluruh badan", true),
  torsoP: b(-30, 45, 0, 10, 1, "badan membungkuk (+) / membusung (-)"),
  torsoY: b(-50, 50, 0, 10, 1, "badan menoleh"),
  torsoR: b(-25, 25, 0, 10, 1, "badan miring"),
  headP: b(-40, 45, 0, 14, 1, "kepala menunduk (+) / mendongak (-)"),
  headY: b(-70, 70, 0, 14, 1, "kepala menoleh (+ kiri)"),
  headR: b(-35, 35, 0, 14, 1, "kepala miring (+ kiri)"),
  gazeX: b(-45, 45, 0, 42, 1, "arah mata horizontal"),
  gazeY: b(-30, 30, 0, 42, 1, "arah mata vertikal (+ atas)"),
  ...arm("l", "l"),
  ...arm("r", "r"),
  crouch: b(0, 1, 0, 10, 1, "berjongkok/menekuk lutut 0..1"),
  shift: b(-1, 1, 0, 7, 1, "tumpuan berat badan (+ kaki kiri)"),
  lLegFwd: b(-30, 60, 0, 12, 0.9, "paha kiri maju"),
  rLegFwd: b(-30, 60, 0, 12, 0.9, "paha kanan maju"),
  lKnee: b(0, 120, 0, 12, 0.9, "lutut kiri menekuk"),
  rKnee: b(0, 120, 0, 12, 0.9, "lutut kanan menekuk"),
  fHappy: b(0, 1, 0, 16, 1, "wajah senang"),
  fSad: b(0, 1, 0, 16, 1, "wajah sedih"),
  fAngry: b(0, 1, 0, 16, 1, "wajah marah"),
  fSurp: b(0, 1, 0, 22, 0.9, "wajah kaget"),
  fRelax: b(0, 1, 0, 14, 1, "wajah tenang/lembut"),
  fBlinkL: b(0, 1, 0, 40, 1, "mata kiri menutup"),
  fBlinkR: b(0, 1, 0, 40, 1, "mata kanan menutup"),
  fMouthA: b(0, 1, 0, 30, 0.9, "mulut terbuka (aa)"),
  fMouthO: b(0, 1, 0, 30, 0.9, "mulut membulat (ou)"),
};

export const CHANNELS = Object.keys(CHANNEL_DEFS);
export const N_CH = CHANNELS.length;
export const CH_INDEX: Record<string, number> = Object.fromEntries(CHANNELS.map((n, i) => [n, i]));
export const CH_INFO: ChannelInfo[] = CHANNELS.map((n) => CHANNEL_DEFS[n]);
export const REST_POSE: Float64Array = Float64Array.from(CH_INFO.map((c) => c.def));

export type Pose = Record<string, number>;

/** Membersihkan pose dari sumber tak tepercaya (preset / AI): buang kanal asing & NaN, jepit ke rentang. */
export function sanitizePose(input: unknown): Pose {
  const out: Pose = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const i = CH_INDEX[k];
    if (i === undefined || typeof v !== "number" || !Number.isFinite(v)) continue;
    const c = CH_INFO[i];
    out[k] = c.angular ? Math.max(c.min, Math.min(c.max, v)) : Math.max(c.min, Math.min(c.max, v));
  }
  return out;
}

/** Cermin kiri↔kanan untuk satu pose (dipakai agar satu preset bisa tangan kiri/kanan). */
const SIDE_NEG = new Set(["hipsY", "hipsR", "hipsX", "turn", "torsoY", "torsoR", "headY", "headR", "gazeX", "shift"]);
export function mirrorName(n: string): { name: string; neg: boolean } {
  if (n.length > 1 && (n[0] === "l" || n[0] === "r") && n[1] === n[1].toUpperCase() && n[1] !== n[1].toLowerCase()) {
    const flipped = (n[0] === "l" ? "r" : "l") + n.slice(1);
    if (flipped in CHANNEL_DEFS) return { name: flipped, neg: n.endsWith("Plane") || n.endsWith("Roll") || n.endsWith("Wrist") ? false : false };
  }
  if (n === "fBlinkL") return { name: "fBlinkR", neg: false };
  if (n === "fBlinkR") return { name: "fBlinkL", neg: false };
  return { name: n, neg: SIDE_NEG.has(n) };
}
