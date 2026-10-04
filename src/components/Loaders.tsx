import { memo, useEffect, useRef, useState, type CSSProperties } from "react";

const reduceMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Teks yang "teracak" lalu menyusun diri huruf demi huruf. */
export function Scramble({ text, speed = 28 }: { text: string; speed?: number }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (reduceMotion()) {
      setOut(text);
      return;
    }
    const glyphs = "▓▒░#%&@01<>/\\+=";
    let frame = 0;
    const id = window.setInterval(() => {
      frame += 1;
      const settled = Math.floor(frame / 2);
      setOut(
        text
          .split("")
          .map((c, i) => (c === " " || i < settled ? c : glyphs[Math.floor(Math.random() * glyphs.length)]))
          .join(""),
      );
      if (settled >= text.length) {
        clearInterval(id);
        setOut(text);
      }
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return <>{out}</>;
}

/** Progres yang mengejar target dan tetap merayap pelan, supaya tidak pernah terlihat macet. */
function useSmoothProgress(target: number): number {
  const [v, setV] = useState(0);
  const tRef = useRef(target);
  tRef.current = target;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let cur = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = tRef.current;
      let next = cur;
      if (t >= 100) next = cur + (100 - cur) * Math.min(1, dt * 8);
      else {
        if (t > cur) next = cur + (t - cur) * Math.min(1, dt * 6);
        next = Math.min(92, next + 3 * dt);
      }
      cur = Math.max(cur, next);
      setV(cur);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return v;
}

const TICKS = Array.from({ length: 60 }, (_, i) => i);

/** Layar muat awal (model Live2D). */
export function BootLoader({ pct }: { pct: number }) {
  const shown = useSmoothProgress(pct);
  const label = shown < 25 ? "initializing" : shown < 80 ? "loading model" : "almost ready";
  return (
    <div className="boot" role="status" aria-live="polite" aria-label="Memuat YUKI">
      <div className="boot-rings" aria-hidden>
        <i /><i /><i />
      </div>
      <svg className="boot-dial" viewBox="0 0 200 200" aria-hidden>
        {TICKS.map((i) => (
          <line
            key={i}
            x1="100" y1="4" x2="100" y2={i % 5 === 0 ? 16 : 10}
            transform={`rotate(${i * 6} 100 100)`}
            stroke="#fff" strokeWidth={i % 5 === 0 ? 1.4 : 0.8}
          />
        ))}
        <circle className="boot-dash" cx="100" cy="100" r="80" fill="none" stroke="#fff" strokeWidth="0.8" strokeDasharray="2 7" />
      </svg>
      <div className="boot-title" aria-hidden>
        {"YUKI".split("").map((c, i) => (
          <span key={i} style={{ "--i": i } as CSSProperties}>{c}</span>
        ))}
      </div>
      <div className="boot-sub"><Scramble text={label} /></div>
      <div className="boot-bar">
        <div className="boot-bar-fill" style={{ transform: `scaleX(${shown / 100})` }} />
        <div className="boot-bar-glint" />
      </div>
      <div className="boot-pct">{String(Math.round(shown)).padStart(3, "0")}%</div>
    </div>
  );
}

const WAVE = Array.from({ length: 26 }, (_, i) => i);
const MSG = {
  ai: ["lagi mikir", "nyusun kata-kata", "ngumpulin ide"],
  tts: ["nyiapin suara", "ngatur nada", "hampir siap"],
} as const;

/** Indikator saat menunggu AI lalu suara (teks baru tampil setelah suara siap). */
export const ThinkingLoader = memo(function ThinkingLoader({ stage }: { stage: "ai" | "tts" }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    const id = window.setInterval(() => setI((n) => (n + 1) % MSG[stage].length), 1700);
    return () => clearInterval(id);
  }, [stage]);
  return (
    <div className="think" role="status" aria-live="polite" aria-label="YUKI sedang menyiapkan jawaban">
      <div className="think-wave" aria-hidden>
        {WAVE.map((k) => (
          <i key={k} style={{ "--k": k } as CSSProperties} />
        ))}
      </div>
      <div className="think-line">
        <span className="think-steps">
          <b className={stage === "ai" ? "on" : "done"}>01 pikir</b>
          <b className={stage === "tts" ? "on" : ""}>02 suara</b>
        </span>
        <span className="think-label"><Scramble text={MSG[stage][i]} /></span>
      </div>
    </div>
  );
});

/** Equalizer mini: menunggu suara kalimat kedua. */
export const MiniWave = memo(function MiniWave() {
  return (
    <span className="mini-wave" aria-hidden>
      {[0, 1, 2, 3].map((k) => (
        <i key={k} style={{ animationDelay: `${k * -0.15}s` }} />
      ))}
    </span>
  );
});
