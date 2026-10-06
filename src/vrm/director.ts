// ─────────────────────────────────────────────────────────────────────────────
// MotionDirector = SUB-AGENT gerakan. Menerjemahkan teks {gerakan} dari AI utama
// menjadi rencana gerak yang valid. Dua tingkat, keduanya tidak pernah melempar error:
//   1. Lokal (instan, tanpa jaringan): pencocokan fuzzy Indonesia/Inggris + modifier
//      (pelan/cepat/kecil/besar/kiri/kanan) + gabungan "sambil/lalu".
//   2. LLM sub-agent (opsional, hanya jika lokal tidak mengenali): meminta AI menyusun
//      keyframe memakai kanal gerak, lalu hasilnya DIVALIDASI & dijepit sebelum dipakai.
// ─────────────────────────────────────────────────────────────────────────────
import { CHANNEL_DEFS, CH_INDEX, sanitizePose, type Pose } from "./channels";
import type { Key, MotionDef, Osc } from "./engine";
import { NAMED_MOTIONS } from "./motions";
import { clamp } from "./m3";

export interface PlanItem {
  def: MotionDef;
  mirror: boolean;
  speed: number;
  amp: number;
  delay: number;
}
export interface Plan {
  items: PlanItem[];
  /** 0 = tidak dikenali, 1 = cocok persis */
  confidence: number;
  raw: string;
}

export const NONE_WORDS = new Set(["", "-", "—", "–", "_", "none", "null", "nil", "n/a", "na", "tidak ada", "kosong", "nol", "nothing", "gak ada", "nggak ada", "ga ada", "tanpa gerakan", "diam"]);

export function normalize(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s,;+&/-]/g, " ")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoGesture(s: string): boolean {
  const n = normalize(s);
  return NONE_WORDS.has(n) || NONE_WORDS.has((s ?? "").trim().toLowerCase());
}

function lev1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || a.length < 5) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

interface AliasEntry {
  def: MotionDef;
  alias: string;
  tokens: string[];
}
const INDEX: AliasEntry[] = [];
for (const def of NAMED_MOTIONS) {
  const set = new Set([def.name, ...def.aliases].map(normalize).filter(Boolean));
  for (const alias of set) INDEX.push({ def, alias, tokens: alias.split(" ") });
}

function padded(s: string): string {
  return ` ${s} `;
}

function scoreClause(clause: string): { def: MotionDef; score: number } | null {
  const c = normalize(clause);
  if (!c) return null;
  const toks = c.split(" ");
  let best: { def: MotionDef; score: number } | null = null;
  for (const e of INDEX) {
    let s = 0;
    if (c === e.alias) s = 1;
    else if (padded(c).includes(padded(e.alias))) s = 0.78 + Math.min(0.2, e.alias.length / 80); // alias utuh ada di kalimat
    else if (c.length >= 5 && padded(e.alias).includes(padded(c))) s = 0.62;
    else {
      // token fuzzy (typo ≤1 huruf)
      let hit = 0;
      for (const t of e.tokens) if (t.length >= 5 && toks.some((x) => x[0] === t[0] && lev1(x, t))) hit++;
      const need = e.tokens.filter((t) => t.length >= 5).length;
      if (need && hit === need) s = 0.55 + 0.05 * Math.min(hit, 3);
    }
    if (s > 0 && (!best || s > best.score)) best = { def: e.def, score: s };
  }
  return best && best.score >= 0.55 ? best : null;
}

const SPLIT = /\s*(?:,|;|\+|&|\bsambil\b|\bsembari\b|\blalu\b|\bkemudian\b|\blantas\b|\bterus\b|\bsetelah itu\b|\bdan\b|\bwhile\b|\bthen\b|\band\b)\s*/g;
const SEQ = /^(?:lalu|kemudian|lantas|terus|setelah itu|then)$/;

export function resolveLocal(gesture: string): Plan {
  const raw = gesture ?? "";
  if (isNoGesture(raw)) return { items: [], confidence: 1, raw };
  const norm = normalize(raw);
  // pisah klausa sambil mengingat pemisah (berurutan atau paralel)
  const parts: { text: string; seq: boolean }[] = [];
  let last = 0;
  let pendingSeq = false;
  const re = new RegExp(SPLIT.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) {
    if (m[0].trim() === "" && m.index === re.lastIndex) {
      re.lastIndex++;
      continue;
    }
    const seg = norm.slice(last, m.index).trim();
    if (seg) parts.push({ text: seg, seq: pendingSeq });
    pendingSeq = SEQ.test(m[0].trim());
    last = m.index + m[0].length;
  }
  const tail = norm.slice(last).trim();
  if (tail) parts.push({ text: tail, seq: pendingSeq });
  if (!parts.length) parts.push({ text: norm, seq: false });

  // jika pemisah memecah frasa alias ("tangan di dada" tidak memuat pemisah, aman) → coba utuh dulu
  const whole = scoreClause(norm);
  const items: PlanItem[] = [];
  let conf = 0;
  let delay = 0;
  const used = new Set<string>();
  const clauses = whole && whole.score >= 0.78 && parts.length > 1 && !parts.some((p) => scoreClause(p.text)) ? [{ text: norm, seq: false }] : parts;
  for (const p of clauses.slice(0, 3)) {
    const hit = scoreClause(p.text);
    if (!hit || used.has(hit.def.name)) continue;
    used.add(hit.def.name);
    const t = " " + p.text + " ";
    const mirror = /\bkiri\b|\bleft\b/.test(t) && !/\bkanan\b|\bright\b/.test(t);
    let speed = 1;
    if (/\b(pelan|lambat|slow|perlahan|santai)\b/.test(t)) speed = 0.78;
    if (/\b(cepat|fast|buru buru|sigap|kilat)\b/.test(t)) speed = 1.3;
    let amp = 1;
    if (/\b(kecil|sedikit|tipis|halus|slight|small)\b/.test(t)) amp = 0.65;
    if (/\b(besar|lebar|heboh|keras|dramatis|big|large|exaggerated)\b/.test(t)) amp = 1.3;
    if (p.seq && items.length) {
      const prev = items[items.length - 1];
      delay = Math.min(10, prev.delay + prev.def.dur / prev.speed - 0.3);
    } else delay = 0;
    items.push({ def: hit.def, mirror, speed, amp, delay });
    conf = Math.max(conf, hit.score);
  }
  return { items, confidence: items.length ? conf : 0, raw };
}

/** Untuk parser: apakah teks ini terlihat seperti nama gerakan yang dikenal? */
export const recognizesGesture = (s: string): boolean => isNoGesture(s) || resolveLocal(s).confidence >= 0.55;

/** Nama gerakan untuk disuntik ke prompt AI utama. */
export const GESTURE_NAMES: string[] = NAMED_MOTIONS.map((m) => m.name);

// ───────────────────────── LLM sub-agent (opsional) ─────────────────────────
export function buildSubagentPrompt(gesture: string): string {
  const chans = Object.entries(CHANNEL_DEFS)
    .filter(([k]) => !k.startsWith("f") || k.startsWith("fH") || k.startsWith("fS") || k.startsWith("fA") || k.startsWith("fR") || k.startsWith("fB") || k.startsWith("fM"))
    .map(([k, c]) => `${k}[${c.min}..${c.max}]`)
    .join(", ");
  return `Kamu adalah ANIMATOR. Ubah deskripsi gerakan menjadi JSON keyframe untuk karakter humanoid. Balas HANYA JSON valid, tanpa teks lain.

Skema: {"dur":detik(0.8-8),"keys":[{"t":detik,"pose":{kanal:nilai}}],"osc":[{"ch":kanal,"amp":n,"hz":0.2-6,"from":detik,"to":detik}],"hold":true/false}
Maksimal 8 keys & 6 osc. Kanal yang tak disebut tetap santai. Sudut dalam derajat.
Arti: headP+ menunduk, headY+ menoleh kiri, headR+ miring kiri, torsoP+ membungkuk, turn=putar badan penuh (360), crouch 0..1.
Lengan (awalan l=kiri, r=kanan): Raise 0=turun 90=mendatar 180=atas; Az 0=samping 90=depan 180=silang; Elbow=tekuk siku; Plane=arah tekuk (-ke dalam, +ke atas/luar); jari Idx,Mid,Rng,Thumb 0=lurus 1=genggam.
Wajah 0..1: fHappy,fSad,fAngry,fSurp,fRelax,fBlinkL,fBlinkR,fMouthA,fMouthO.
Kanal: ${chans}

Contoh "melambai": {"dur":2.5,"keys":[{"t":0,"pose":{"rRaise":112,"rAz":35,"rElbow":100,"rPlane":75,"rIdx":0,"rMid":0,"rRng":0}}],"osc":[{"ch":"rPlane","amp":24,"hz":2.3,"from":0.3}],"hold":true}

Gerakan: ${String(gesture).slice(0, 120)}
JSON:`;
}

/** Validasi ketat hasil LLM. null = tolak (jatuh ke fallback lokal). */
export function validateAgentJson(text: string, name: string): MotionDef | null {
  try {
    const m = String(text ?? "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const dur = clamp(Number(j.dur), 0.8, 8);
    if (!Number.isFinite(dur) || !Array.isArray(j.keys) || !j.keys.length) return null;
    const keys: Key[] = [];
    for (const k of (j.keys as unknown[]).slice(0, 8)) {
      const o = k as { t?: unknown; pose?: unknown };
      const t = Number(o?.t);
      const pose: Pose = sanitizePose(o?.pose);
      if (!Number.isFinite(t) || !Object.keys(pose).length) continue;
      keys.push({ t: clamp(t, 0, dur), pose });
    }
    if (!keys.length) return null;
    keys.sort((a, b) => a.t - b.t);
    const osc: Osc[] = [];
    for (const o of Array.isArray(j.osc) ? (j.osc as unknown[]).slice(0, 6) : []) {
      const x = o as Record<string, unknown>;
      const ch = String(x?.ch);
      const info = CHANNEL_DEFS[ch];
      if (!info || CH_INDEX[ch] === undefined || info.angular) continue;
      const amp = Number(x.amp);
      const hz = Number(x.hz);
      if (!Number.isFinite(amp) || !Number.isFinite(hz)) continue;
      const span = (info.max - info.min) * 0.2;
      osc.push({ ch, amp: clamp(amp, -span, span), hz: clamp(hz, 0.2, 6), from: clamp(Number(x.from) || 0, 0, dur), to: clamp(Number(x.to) || dur, 0, dur) });
    }
    const hasTurn = keys.some((k) => k.pose.turn !== undefined);
    return {
      name: `ai:${name.slice(0, 30)}`,
      aliases: [],
      dur: hasTurn ? Math.max(dur, 1.2) : dur,
      keys,
      osc,
      holdAt: j.hold === false ? undefined : 0,
      shot: hasTurn || keys.some((k) => (k.pose.crouch ?? 0) > 0.3) ? "full" : undefined,
    };
  } catch {
    return null;
  }
}

/** Gerakan cadangan bila gerakan tak dikenali & LLM gagal: pilih yang cocok dengan mood, atau tidak ada. */
export function fallbackForMood(mood: string, pickIdx: number): MotionDef | null {
  const pool = NAMED_MOTIONS.filter((m) => m.moods?.includes(mood) && !m.shot);
  return pool.length ? pool[Math.abs(pickIdx) % pool.length] : null;
}
