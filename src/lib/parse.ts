// Parser balasan AI: {mood}|{pesan}|{gerakan} — dirancang ANTI SALAH FORMAT.
// Apa pun yang dikirim AI (kurang bagian, kelebihan "|", markdown, label, kurung, urutan terbalik,
// gaya lama 2 kalimat, tanpa pemisah sama sekali) selalu menghasilkan hasil valid.
export const EXPRESSIONS = ["Senang", "Sedih", "Malu", "Tsundere", "Marah", "Kaget", "Bingung", "Serius"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export interface Parsed {
  expression: Expression;
  text1: string; // pesan (dipertahankan nama field lama agar UI tidak berubah)
  text2: string; // selalu "" pada format baru
  gesture: string; // "-" = tanpa gerakan khusus
}

const MOOD_WORDS: Record<string, Expression> = {
  senang: "Senang", happy: "Senang", gembira: "Senang", bahagia: "Senang", ceria: "Senang", joy: "Senang", excited: "Senang", semangat: "Senang", tenang: "Senang", relaxed: "Senang", lega: "Senang", antusias: "Senang", bangga: "Senang", suka: "Senang",
  sedih: "Sedih", sad: "Sedih", kecewa: "Sedih", galau: "Sedih", murung: "Sedih", menangis: "Sedih", cry: "Sedih", terharu: "Sedih", khawatir: "Sedih", cemas: "Sedih",
  malu: "Malu", shy: "Malu", tersipu: "Malu", embarrassed: "Malu", blush: "Malu", grogi: "Malu", gugup: "Malu",
  tsundere: "Tsundere", tsun: "Tsundere", ketus: "Tsundere", gengsi: "Tsundere", cuek: "Tsundere",
  marah: "Marah", angry: "Marah", kesal: "Marah", mad: "Marah", jengkel: "Marah", emosi: "Marah", sebal: "Marah", bete: "Marah",
  kaget: "Kaget", terkejut: "Kaget", surprised: "Kaget", shock: "Kaget", shocked: "Kaget", wow: "Kaget",
  bingung: "Bingung", confused: "Bingung", heran: "Bingung", penasaran: "Bingung", ragu: "Bingung", puzzled: "Bingung", curious: "Bingung",
  serius: "Serius", serious: "Serius", tegas: "Serius", netral: "Serius", neutral: "Serius", datar: "Serius", fokus: "Serius", formal: "Serius",
};
const WORD_KEYS = Object.keys(MOOD_WORDS);
const NONE = /^(?:-+|—|–|_|none|null|nil|n\/a|na|tidak ada|ga ada|gak ada|nggak ada|kosong|nol|nothing|diam|tanpa gerakan|no gesture)$/i;
const LABEL = /^\s*(?:mood|ekspresi|expresi|expression|emosi|emotion|pesan|text|teks|message|kalimat|jawaban|gerakan|gesture|aksi|action|motion)\s*[:=]\s*/i;

function lev1(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function matchMood(s: string | undefined | null): Expression | null {
  if (!s) return null;
  const k = s.replace(LABEL, "").replace(/[{}[\]()"'*:.!?~♡,;]/g, "").trim().toLowerCase();
  if (!k || k.length > 18) return null;
  if (MOOD_WORDS[k]) return MOOD_WORDS[k];
  const w = k.split(/\s+/)[0];
  if (MOOD_WORDS[w] && k.split(/\s+/).length <= 2) return MOOD_WORDS[w];
  for (const key of WORD_KEYS) if (lev1(w, key)) return MOOD_WORDS[key];
  return null;
}

export function stripMarkdown(raw: string): string {
  return String(raw ?? "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/[｜¦│┃∣]/g, "|")
    .replace(/\*\*|__|~~/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-•*]\s+)/gm, "")
    .replace(/^\s*(?:yuki|assistant|ai|bot)\s*:\s*/i, "")
    .trim();
}

function unwrap(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 3; i++) {
    const m = t.match(/^[{[(<"'“‘`]\s*([\s\S]*?)\s*[}\])>"'”’`]$/);
    if (!m) break;
    t = m[1].trim();
  }
  const PAIRS: Record<string, string> = { "{": "}", "[": "]", "(": ")", "<": ">", "“": "”", "‘": "’" };
  const count = (str: string, ch: string) => str.split(ch).length - 1;
  for (let i = 0; i < 4 && t; i++) {
    const f = t[0];
    const l = t[t.length - 1];
    if (PAIRS[f] && count(t, f) > count(t, PAIRS[f])) t = t.slice(1).trim();
    else if (Object.values(PAIRS).includes(l) && count(t, l) > count(t, Object.keys(PAIRS).find((k) => PAIRS[k] === l)!)) t = t.slice(0, -1).trim();
    else if ((f === '"' || f === "'" || f === "`") && count(t, f) === 1) t = t.slice(1).trim();
    else if ((l === '"' || l === "'" || l === "`") && count(t, l) === 1 && l !== "'") t = t.slice(0, -1).trim();
    else break;
  }
  return t.replace(LABEL, "").trim();
}

function sentences(t: string): string[] {
  const m = t.match(/[^.!?。！？…\n]+(?:[.!?。！？…]+|$)\s*/g);
  return (m ?? [t]).map((x) => x.trim()).filter(Boolean);
}
/** Potong di batas kalimat/klausa agar teks tampil == teks yang diucapkan (tidak terpotong di tengah kata). */
export function clampText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let acc = "";
  for (const sent of sentences(t)) {
    if ((acc + " " + sent).trim().length > max) break;
    acc = (acc + " " + sent).trim();
  }
  if (acc.length >= max * 0.4) return acc;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(","));
  return (i > max * 0.5 ? cut.slice(0, i) : cut).replace(/[,;:\s]+$/, "") + "…";
}

export function cleanGesture(g: string): string {
  const t = unwrap(String(g ?? "")).replace(/\s+/g, " ").replace(/[|]/g, " ").trim();
  if (!t || NONE.test(t)) return "-";
  return t.slice(0, 100);
}

function inferMood(text: string): Expression {
  const t = text.toLowerCase();
  if (/b-?bukan berarti|hmph|jangan salah paham|bukan karena aku/.test(t)) return "Tsundere";
  if (/\bmaaf\b|huhu|hiks|sedih|sayang sekali|turut/.test(t)) return "Sedih";
  if (/kesal|marah|menyebalkan|!!+\s*$/.test(t)) return "Marah";
  if (/astaga|hah\?|serius\?!|kaget|waduh|wah!/.test(t)) return "Kaget";
  if (/e-eh|malu|salah tingkah|\.\.\.\s*aku/.test(t)) return "Malu";
  if (/bingung|hmm|\?\s*$/.test(t)) return "Bingung";
  return "Senang";
}

const LOOKS_SENTENCE = /[.!?…~♡♥。！？]\s*["')\]]?$|[.!?]\s+\S/;

export interface ParseOpts {
  maxChars?: number;
  /** apakah teks ini nama gerakan yang dikenal sub-agent? */
  isGesture?: (s: string) => boolean;
}

export function parseReply(raw: string, opts: ParseOpts = {}): Parsed {
  const max = Math.max(40, opts.maxChars ?? 240);
  const known = opts.isGesture ?? (() => false);
  let expression: Expression | null = null;
  let text = "";
  let gesture = "-";
  try {
    const t = stripMarkdown(raw);
    let parts = t.split("|").map((p) => unwrap(p));
    // buang sisa baris-baris aneh: hanya ambil baris pertama yang mengandung "|" bila ada beberapa
    if (t.includes("\n") && t.includes("|")) {
      const line = t.split("\n").map((l) => l.trim()).find((l) => (l.match(/\|/g) ?? []).length >= 1);
      if (line) parts = line.split("|").map((p) => unwrap(p));
    }
    const m0 = parts.length > 1 ? matchMood(parts[0]) : null;
    if (m0) {
      expression = m0;
      const rest = parts.slice(1);
      const lastIsG = (s: string) => NONE.test(s.trim()) || (known(s) && !LOOKS_SENTENCE.test(s) && s.split(/\s+/).length <= 6) || (s.split(/\s+/).length <= 5 && s.length <= 48 && !LOOKS_SENTENCE.test(s) && !/^[A-Z]/.test(s) && s.length > 0);
      if (rest.length === 1) text = rest[0];
      else if (rest.length === 2) {
        if (lastIsG(rest[1]) || rest[1] === "") { text = rest[0]; gesture = rest[1]; }
        else text = rest.join(" ");
      } else {
        const last = rest[rest.length - 1];
        if (lastIsG(last) || last === "") { gesture = last; text = rest.slice(0, -1).join(" "); }
        else text = rest.join(" ");
      }
    } else {
      // tanpa pemisah yang benar: "Senang: halo", "[Senang] halo", "Senang - halo", atau teks polos
      const flat = unwrap(t.replace(/\|/g, " "));
      const m = flat.match(/^[[{(]?\s*([A-Za-zÀ-ÿ]{3,12})\s*[\]})]?\s*[:\-–—]\s+([\s\S]+)$/);
      const mm = m ? matchMood(m[1]) : null;
      if (mm && m) { expression = mm; text = m[2]; }
      else text = flat;
      // gerakan di ujung dengan kurung: "Halo! (melambai)" / "*melambai*"
      const tail = text.match(/\s*[(*[]\s*([^()*[\]]{2,48})\s*[)*\]]\s*$/);
      if (tail && known(tail[1])) { gesture = tail[1]; text = text.slice(0, tail.index).trim(); }
    }
  } catch {
    /* jatuh ke fallback di bawah */
  }
  text = clampText(
    text.replace(/\|/g, " ").replace(/[{}]/g, "").replace(/^\s*(?:mood|pesan|gerakan)\s*[:=]\s*/i, ""),
    max,
  );
  if (!text) {
    return { expression: "Bingung", text1: "Eh... aku lagi blank nih... Coba tanya lagi ya~", text2: "", gesture: "garuk kepala" };
  }
  return { expression: expression ?? inferMood(text), text1: text, text2: "", gesture: cleanGesture(gesture) };
}
