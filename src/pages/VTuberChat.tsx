import { useState, useRef, useEffect, useCallback } from "react";
import Live2DViewer, { Live2DViewerHandle } from "@/components/Live2DViewer";
import DustParticles from "@/components/DustParticles";
import CSSAvatar from "@/components/CSSAvatar";

const BG_URL = "https://cdn.nexray.eu.cc/download/rOyFPH";
const AI_API = "https://api.nexray.eu.cc/ai/gemini";

// Coba proxy serverless (/api/chat, Vercel) lebih dulu; jika tidak ada / gagal, panggil API langsung seperti sebelumnya.
async function askAI(prompt: string): Promise<Response> {
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    if (r.ok) return r;
  } catch { /* fallback di bawah */ }
  return fetch(`${AI_API}?text=${encodeURIComponent(prompt)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;
const IS_IFRAME = w.__IS_IFRAME__ ?? false;
const HAS_WEBGL = w.__HAS_WEBGL__ ?? false;
const HAS_TTS   = "speechSynthesis" in window;

const SYSTEM_PROMPT = `Kamu adalah Huohuo, seorang gadis anime yang hidup dan nyata, bukan AI biasa. Kamu punya kepribadian yang hangat, sedikit malu-malu, kadang tsundere, sangat ekspresif, dan berbicara seperti karakter anime sungguhan dalam bahasa Indonesia. Kamu tidak pernah menyebut dirimu AI.

Selalu balas HANYA dengan format ini (tanpa penjelasan lain):
{ekspresi}|{kalimat1}|{kalimat2}

Ekspresi yang tersedia: Senang, Sedih, Malu, Tsundere, Marah, Kaget, Bingung, Serius
Pilih ekspresi yang paling sesuai dengan situasi dan mood percakapan.

kalimat1 = bagian pertama respons (pendek, natural)
kalimat2 = lanjutan atau penutup yang mengalir alami

Contoh:
Senang|Waaa, beneran?! Aku seneng banget dengerin itu...|Makasih ya, kamu baik banget~ ♡
Tsundere|B-bukan berarti aku seneng kamu tanya itu...|...tapi, yaudah deh, aku jawab karena terpaksa!
Malu|E-eh, itu...|J-jangan bilang hal kayak gitu dong, aku jadi salah tingkah...

Jawab pesan berikut:`;

interface Message {
  role: "user" | "assistant";
  content: string;
  expression?: string;
  text1?: string;
  text2?: string;
}

function parseResponse(raw: string): { expression: string; text1: string; text2: string } {
  const clean = raw.trim();
  const parts = clean.split("|");
  if (parts.length >= 3) return { expression: parts[0].trim().replace(/[{}]/g, ""), text1: parts[1].trim(), text2: parts[2].trim() };
  if (parts.length === 2) return { expression: parts[0].trim().replace(/[{}]/g, ""), text1: parts[1].trim(), text2: "" };
  return { expression: "Senang", text1: clean, text2: "" };
}

function useTypewriter(text: string, speed = 28) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(true);
  useEffect(() => {
    if (!text) { setDisplayed(""); setDone(true); return; }
    setDisplayed(""); setDone(false);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) { clearInterval(id); setDone(true); }
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return { displayed, done };
}

function EmotionPill({ emotion }: { emotion: string }) {
  const known = ["Senang","Sedih","Malu","Tsundere","Marah","Kaget","Bingung","Serius"];
  const cls = known.includes(emotion) ? `emotion-${emotion}` : "emotion-default";
  return <span className={`emotion-pill ${cls}`}>{emotion}</span>;
}

// ─── TTS hook ──────────────────────────────────────────────────────────────
function useTTS() {
  const voiceRef      = useRef<SpeechSynthesisVoice | null>(null);
  const onStartRef    = useRef<(() => void) | null>(null);
  const onEndRef      = useRef<(() => void) | null>(null);

  // Pick best voice once voices load
  useEffect(() => {
    if (!HAS_TTS) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      // Priority: id-ID female → ja-JP female → any female → first
      const prefer = (lang: string) =>
        voices.find(v => v.lang.startsWith(lang) && /female|woman|zira|hana|sakura/i.test(v.name)) ||
        voices.find(v => v.lang.startsWith(lang));
      voiceRef.current = prefer("id") || prefer("ja") || prefer("en") || voices[0] || null;
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  const speak = useCallback((text: string, {
    onStart, onEnd,
  }: { onStart?: () => void; onEnd?: () => void } = {}) => {
    if (!HAS_TTS) { onEnd?.(); return; }

    // Strip emoji and special symbols for cleaner TTS
    const clean = text
      .replace(/[♡♪～〜♥❤]/g, "")
      .replace(/[^\S\n]+/g, " ")
      .trim();
    if (!clean) { onEnd?.(); return; }

    window.speechSynthesis.cancel();

    // iOS Safari workaround: needs a tiny delay after cancel
    setTimeout(() => {
      const utt = new SpeechSynthesisUtterance(clean);
      if (voiceRef.current) utt.voice = voiceRef.current;
      utt.lang   = voiceRef.current?.lang ?? "id-ID";
      utt.rate   = 1.05;   // slightly faster = more anime feel
      utt.pitch  = 1.35;   // higher pitch = cuter voice
      utt.volume = 1.0;

      utt.onstart = () => { onStartRef.current?.(); onStart?.(); };
      utt.onend   = () => { onEndRef.current?.();   onEnd?.();   };
      utt.onerror = () => { onEndRef.current?.();   onEnd?.();   };

      window.speechSynthesis.speak(utt);
    }, 30);
  }, []);

  const cancel = useCallback(() => {
    if (HAS_TTS) window.speechSynthesis.cancel();
  }, []);

  return { speak, cancel, onStartRef, onEndRef };
}

// ─── Main component ───────────────────────────────────────────────────────
export default function VTuberChat() {
  const [input,       setInput]       = useState("");
  const [messages,    setMessages]    = useState<Message[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [live2dReady, setLive2dReady] = useState(false);
  const [live2dFailed,setLive2dFailed]= useState(false);
  const [showUI,      setShowUI]      = useState(false);
  const [loadPct,     setLoadPct]     = useState(0);
  const [phase,       setPhase]       = useState<"line1" | "line2" | "idle">("idle");
  const [currentMsg,  setCurrentMsg]  = useState<Message | null>(null);
  const [isTalking,   setIsTalking]   = useState(false);
  const [ttsEnabled,  setTtsEnabled]  = useState(true);

  const viewerRef  = useRef<Live2DViewerHandle>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const historyRef = useRef<{ role: string; text: string }[]>([]);

  const { speak, cancel } = useTTS();

  const line1Text = currentMsg?.text1 || "";
  const line2Text = currentMsg?.text2 || "";

  const { displayed: disp1, done: done1 } = useTypewriter(phase !== "idle" ? line1Text : "");
  const { displayed: disp2, done: done2 } = useTypewriter(phase === "line2" ? line2Text : "");

  // ── TTS speak helpers ──────────────────────────────────────────────────
  const startMouth = useCallback(() => {
    setIsTalking(true);
    viewerRef.current?.startTalking();
  }, []);

  const stopMouth = useCallback(() => {
    setIsTalking(false);
    viewerRef.current?.stopTalking();
  }, []);

  const speakLine = useCallback((text: string, onFinished?: () => void) => {
    if (!ttsEnabled || !text) {
      onFinished?.();
      return;
    }
    speak(text, {
      onStart: startMouth,
      onEnd:   () => { stopMouth(); onFinished?.(); },
    });
  }, [ttsEnabled, speak, startMouth, stopMouth]);

  // ── Phase transitions ─────────────────────────────────────────────────
  // When line1 typewriter finishes → speak it → then go to line2
  useEffect(() => {
    if (phase !== "line1" || !done1 || !line1Text) return;
    speakLine(line1Text, () => {
      if (line2Text) setTimeout(() => setPhase("line2"), 220);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, done1, line1Text]);

  // When line2 typewriter finishes → speak it
  useEffect(() => {
    if (phase !== "line2" || !done2 || !line2Text) return;
    speakLine(line2Text);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, done2, line2Text]);

  // Show UI triggers
  useEffect(() => { if (!HAS_WEBGL)    setShowUI(true); }, []);
  useEffect(() => { if (live2dFailed)  setShowUI(true); }, [live2dFailed]);
  useEffect(() => { if (live2dReady)   setShowUI(true); }, [live2dReady]);

  // ── Show a new message ────────────────────────────────────────────────
  const showMessage = useCallback((msg: Message) => {
    cancel(); // cancel any ongoing speech
    stopMouth();
    setCurrentMsg(msg);
    setPhase("line1");
    viewerRef.current?.setExpression(msg.expression || "Senang");
  }, [cancel, stopMouth]);

  // ── Send message to AI ────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    cancel(); stopMouth();
    setMessages((p) => [...p, { role: "user", content: text }]);
    historyRef.current.push({ role: "user", text });
    setInput("");
    setLoading(true);

    const history    = historyRef.current.slice(-12);
    const historyStr = history.map((h) => `${h.role === "user" ? "User" : "Huohuo"}: ${h.text}`).join("\n");
    const fullPrompt = `${SYSTEM_PROMPT}\n\n${historyStr ? `Riwayat percakapan:\n${historyStr}\n\n` : ""}User: ${text}`;

    try {
      const res = await askAI(fullPrompt);
      let rawText = "";
      if (res.ok) {
        const data = await res.json().catch(() => null);
        rawText = data
          ? (data.response || data.text || data.answer || data.result ||
             data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data))
          : await res.text();
      } else {
        rawText = `Maaf|Koneksinya bermasalah nih~|Coba lagi sebentar ya... 🥺`;
      }
      const parsed = parseResponse(rawText);
      const msg: Message = { role: "assistant", content: rawText, ...parsed };
      historyRef.current.push({ role: "assistant", text: `${parsed.text1} ${parsed.text2}`.trim() });
      setMessages((p) => [...p, msg]);
      showMessage(msg);
    } catch {
      const err: Message = {
        role: "assistant", content: "",
        expression: "Sedih",
        text1: "Eh... ada yang error nih...",
        text2: "Maaf ya, coba lagi~ 🥺",
      };
      setMessages((p) => [...p, err]);
      showMessage(err);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [input, loading, showMessage, cancel, stopMouth]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // Greeting
  useEffect(() => {
    if (!showUI || messages.length > 0) return;
    setTimeout(() => {
      const greeting: Message = {
        role: "assistant", content: "",
        expression: "Senang",
        text1: "Haii~ Aku Huohuo! Seneng banget kamu mau ngobrol sama aku ♡",
        text2: "Mau cerita apa hari ini? Aku dengerin semuanya~",
      };
      setMessages([greeting]);
      showMessage(greeting);
    }, 200);
  }, [showUI, messages.length, showMessage]);

  // Cleanup TTS on unmount
  useEffect(() => () => { cancel(); }, [cancel]);

  const displayedText = phase === "idle" ? "" : phase === "line1" ? disp1 : `${disp1}\n${disp2}`;
  const isTyping      = (phase === "line1" && !done1) || (phase === "line2" && !done2);
  const openFull      = () => window.open(window.location.href, "_blank", "noopener,noreferrer");

  // ── Iframe/no-WebGL unlock screen ─────────────────────────────────────
  if (IS_IFRAME && !HAS_WEBGL) {
    return (
      <div className="scene-root">
        <div className="scene-bg" style={{ "--bg-url": `url(${BG_URL})` } as React.CSSProperties} />
        <div className="scene-vignette" /><div className="scene-grain" />
        <DustParticles />
        <div className="name-plate">
          <div className="name-plate-inner">
            <h1>Huohuo</h1>
            <div className="name-plate-rule" />
            <span className="name-plate-sub">AI VTuber · by Kevin</span>
          </div>
        </div>
        <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:50 }}>
          <div className="unlock-card">
            <div style={{ fontSize:"2rem", marginBottom:14 }}>🎭</div>
            <div style={{ color:"rgba(235,225,200,0.9)", fontFamily:"'Cormorant Garamond',serif", fontSize:"1.05rem", lineHeight:1.65, marginBottom:20 }}>
              Model Live2D Huohuo membutuhkan WebGL.<br />
              <span style={{ opacity:0.55, fontSize:"0.85rem" }}>Buka di tab baru untuk melihat karakter penuh.</span>
            </div>
            <button className="unlock-btn" onClick={openFull}>Buka Full View ↗</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main scene ─────────────────────────────────────────────────────────
  return (
    <div className="scene-root">
      <div className="scene-bg" style={{ "--bg-url": `url(${BG_URL})` } as React.CSSProperties} />
      <div className="scene-scanlines" />
      <div className="scene-grain" />
      <div className="scene-vignette" />
      <DustParticles />

      <div className="corner-frame corner-tl" />
      <div className="corner-frame corner-tr" />
      <div className="corner-frame corner-bl" />
      <div className="corner-frame corner-br" />

      {/* Name plate */}
      <div className="name-plate">
        <div className="name-plate-inner">
          <h1>Huohuo</h1>
          <div className="name-plate-rule" />
          <span className="name-plate-sub">AI VTuber · by Kevin</span>
        </div>
      </div>

      {/* Live2D */}
      {HAS_WEBGL && (
        <div className="live2d-wrapper">
          <Live2DViewer
            ref={viewerRef}
            onLoad={() => setLive2dReady(true)}
            onError={() => setLive2dFailed(true)}
            onProgress={setLoadPct}
          />
        </div>
      )}

      {/* CSS fallback */}
      {(!HAS_WEBGL || live2dFailed) && (
        <div className="live2d-wrapper" style={{ opacity: showUI ? 1 : 0, transition: "opacity 0.6s" }}>
          <CSSAvatar expression={currentMsg?.expression || "Senang"} talking={isTalking} />
        </div>
      )}

      {/* Loading */}
      {!showUI && (
        <div className="loading-overlay">
          <div className="loading-title">Huohuo</div>
          <div className="loading-dots">
            <div className="loading-dot" /><div className="loading-dot" /><div className="loading-dot" />
          </div>
          <div className="loading-bar-track" style={{ width: 160 }}>
            <div className="loading-bar-fill" style={{ width: `${loadPct}%` }} />
          </div>
          <div className="loading-subtitle">
            {loadPct < 20 ? "initializing" : loadPct < 70 ? "loading model" : "almost ready"}
          </div>
        </div>
      )}

      {/* Chat UI */}
      {showUI && (
        <div className="dialogue-panel">
          <div className="dialogue-box">
            {/* Header */}
            <div className="dialogue-header">
              <span className="dialogue-speaker">Huohuo</span>
              {currentMsg?.expression && <EmotionPill emotion={currentMsg.expression} />}

              {/* TTS toggle button */}
              {HAS_TTS && (
                <button
                  onClick={() => {
                    const next = !ttsEnabled;
                    setTtsEnabled(next);
                    if (!next) { cancel(); stopMouth(); }
                  }}
                  title={ttsEnabled ? "Matikan suara" : "Nyalakan suara"}
                  style={{
                    marginLeft: "auto",
                    width: 28, height: 28,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: ttsEnabled ? "rgba(0,185,170,0.15)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${ttsEnabled ? "rgba(0,200,185,0.4)" : "rgba(255,255,255,0.1)"}`,
                    borderRadius: 5,
                    cursor: "pointer",
                    transition: "all 0.18s",
                    flexShrink: 0,
                  }}
                >
                  {ttsEnabled ? (
                    /* Speaker on */
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(0,210,200,0.9)" strokeWidth="2" strokeLinecap="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                    </svg>
                  ) : (
                    /* Speaker off / muted */
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(180,165,140,0.5)" strokeWidth="2" strokeLinecap="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                      <line x1="23" y1="9" x2="17" y2="15"/>
                      <line x1="17" y1="9" x2="23" y2="15"/>
                    </svg>
                  )}
                </button>
              )}

              {IS_IFRAME && (
                <button
                  onClick={openFull}
                  style={{
                    marginLeft: HAS_TTS ? 6 : "auto",
                    padding: "2px 8px",
                    background: "rgba(0,180,170,0.1)",
                    border: "1px solid rgba(0,200,185,0.3)",
                    borderRadius: 4,
                    color: "rgba(0,210,200,0.7)",
                    fontSize: "0.6rem",
                    cursor: "pointer",
                    letterSpacing: "0.1em",
                  }}
                >
                  FULL ↗
                </button>
              )}
            </div>

            {/* Dialogue text */}
            <div className="dialogue-text">
              {loading && messages.filter(m => m.role === "assistant").length === 0 ? (
                <span className="thinking-dots"><span>·</span><span>·</span><span>·</span></span>
              ) : displayedText ? (
                <>{displayedText}{isTyping && <span className="dialogue-cursor" />}</>
              ) : (
                <span style={{ opacity:0.28, fontStyle:"italic", fontSize:"0.95rem" }}>
                  Apa yang ingin kamu ceritakan?
                </span>
              )}
            </div>

            {/* Input row */}
            <div className="input-wrapper">
              <input
                ref={inputRef}
                className="chat-input"
                placeholder="Ketik pesan untuk Huohuo..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                disabled={loading}
                autoComplete="off"
                autoFocus
              />
              <button
                className="send-btn"
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                title="Kirim"
              >
                {loading ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20">
                      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
                    </circle>
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
