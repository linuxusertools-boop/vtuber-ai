import { useState, useRef, useEffect, useCallback, type CSSProperties, type KeyboardEvent } from "react";
import VRMViewer, { type VRMViewerHandle } from "@/components/VRMViewer";
import DustParticles from "@/components/DustParticles";
import CSSAvatar from "@/components/CSSAvatar";
import { BootLoader, MiniWave } from "@/components/Loaders";
import { askAI, buildPrompt, parseAI, loadVoice, isAbort, getYukiConfig, type Parsed } from "@/lib/api";
import { unlockAudio, playUrl, stopAudio, stopSpeech, typeText } from "@/lib/audio";
import { buildFormatPrompt } from "@/lib/prompt";
import { recognizesGesture } from "@/vrm/director";
import type { Envelope } from "@/lib/lipsync";

const BG_URL = "https://cdn.nexray.eu.cc/download/rOyFPH";
const MAX_INPUT = 300;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;
const IS_IFRAME: boolean = w.__IS_IFRAME__ ?? false;
const HAS_WEBGL: boolean = w.__HAS_WEBGL__ ?? false;

const PERSONA = `Kamu adalah YUKI, assistant virtual dari Kevsoft Studio. Kamu punya kepribadian hangat, ekspresif, suportif, dan berbicara natural dalam bahasa Indonesia.`;

const GREETING: Parsed = {
  expression: "Senang",
  text1: "Haii~ Aku Yuki! Seneng banget kamu mau ngobrol sama aku ♡",
  text2: "Mau cerita apa hari ini? Aku dengerin semuanya~",
  gesture: "melambai sambil tersenyum",
};
const ERROR_MSG: Parsed = {
  expression: "Sedih",
  text1: "Eh... koneksiku lagi bermasalah nih...",
  text2: "Coba kirim lagi sebentar ya~",
  gesture: "menggaruk kepala",
};

type Stage = "idle" | "ai" | "tts";
type ChatMode = "KVC" | "KLC";

function EmotionPill({ emotion }: { emotion: string }) {
  return <span className="emotion-pill">{emotion}</span>;
}

export default function VTuberChat() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [live2dReady, setLive2dReady] = useState(false);
  const [live2dFailed, setLive2dFailed] = useState(false);
  const [vrmWhy, setVrmWhy] = useState("");
  const [showUI, setShowUI] = useState(!HAS_WEBGL);
  const [loadPct, setLoadPct] = useState(0);
  const [currentMsg, setCurrentMsg] = useState<Parsed | null>(null);
  const [shown1, setShown1] = useState("");
  const [shown2, setShown2] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [waitLine2, setWaitLine2] = useState(false);
  const [isTalking, setIsTalking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [aiName, setAiName] = useState("YUKI");
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [chatMode, setChatMode] = useState<ChatMode>("KVC");
  const [isListening, setIsListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const chatFeedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { let active = true; getYukiConfig().then(cfg => { if (!active) return; if (cfg.aiName?.trim()) setAiName(cfg.aiName.trim()); if (!cfg.tts.enabled) { setTtsEnabled(false); ttsOnRef.current = false; } }).catch(() => undefined); return () => { active = false; }; }, []);

  const viewerRef = useRef<VRMViewerHandle>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<{ role: "user" | "assistant"; text: string }[]>([]);
  const ctrlRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const ttsOnRef = useRef(true);
  const greetedRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const listeningRef = useRef(false);
  const modeRef = useRef<ChatMode>("KVC");
  const sendMessageRef = useRef<(voiceText?: string) => Promise<void>>(async () => undefined);

  // ── mulut (lip-sync) ────────────────────────────────────────────────────
  const startMouth = useCallback((env?: Envelope | null) => {
    setIsTalking(true);
    viewerRef.current?.startTalking(env ?? null);
  }, []);
  const stopMouth = useCallback(() => {
    setIsTalking(false);
    viewerRef.current?.stopTalking();
  }, []);

  // ── setiap pesan = satu "run" yang bisa dibatalkan total ─────────────────
  const newRun = useCallback(() => {
    ctrlRef.current?.abort();
    const c = new AbortController();
    ctrlRef.current = c;
    stopAudio();
    stopSpeech();
    stopMouth();
    return c;
  }, [stopMouth]);

  // ── bubble + suara muncul BERSAMAAN ──────────────────────────────────────
  // Urutan: "Menjawab pesan..." → "Menyiapkan suara..." (audio diunduh penuh dulu)
  // → saat audio benar-benar mulai bunyi: bubble muncul & teks diketik mengikuti currentTime audio.
  // Jika suara gagal/diblokir: teks tetap tampil dengan efek ketik biasa (pesan tidak pernah hilang).
  const presentMessage = useCallback(
    async (msg: Parsed, signal: AbortSignal, speak: boolean, commit?: () => void) => {
      const voice = speak && ttsOnRef.current;
      const speechText = [msg.text1, msg.text2].filter(Boolean).join(" ").trim();
      const t1 = msg.text1;
      const t2 = msg.text2;
      const total = t1.length + t2.length;
      const reveal = (n: number) => {
        const c = Math.max(0, Math.min(total, Math.round(n)));
        setShown1(t1.slice(0, c));
        setShown2(t2.slice(0, Math.max(0, c - t1.length)));
      };
      let begun = false;
      const begin = (hold = 0) => {
        if (begun || signal.aborted) return;
        begun = true;
        setCurrentMsg(msg);
        setWaitLine2(false);
        setStage("idle"); // indikator "menyiapkan suara" diganti bubble
        setRevealing(true);
        reveal(1);
        viewerRef.current?.setExpression(msg.expression);
        viewerRef.current?.perform(msg.gesture || "-", hold); // gerakan mulai TEPAT saat suara & teks mulai
      };
      const typeFallback = async () => {
        begin(total * 0.034);
        await typeText(t1 + t2, (x) => reveal(x.length), signal, 34);
      };

      try {
        if (!voice || !speechText) {
          await typeFallback();
        } else {
          setStage("tts");
          setCurrentMsg(null);
          setShown1("");
          setShown2("");
          const clip = await loadVoice(speechText, signal);
          if (signal.aborted) {
            clip?.release();
            return;
          }
          if (!clip) {
            await typeFallback();
          } else {
            let last = 0;
            try {
              await playUrl(
                clip.src,
                signal,
                {
                  onStart: () => {
                    begin(clip.estSec);
                    startMouth(clip.envelope);
                  },
                  onProgress: (ratio: number) => {
                    const n = Math.ceil(Math.min(1, ratio * 1.03) * total);
                    if (n !== last) {
                      last = n;
                      reveal(n);
                    }
                  },
                },
                clip.estSec,
                clip.preloaded ? 6000 : 12000,
              );
            } finally {
              clip.release();
            }
            stopMouth();
            if (signal.aborted) return;
            // suara tidak sempat mulai (diblokir autoplay / API error) → tetap ketik teksnya
            if (!begun) await typeFallback();
          }
        }
        if (signal.aborted) return;
        reveal(total); // pastikan teks selalu tampil penuh di akhir
        begin();
        commit?.(); // masukkan ke riwayat chat & tutup bubble live dalam satu render
        setStage("idle");
        setRevealing(false);
      } catch {
        // TTS gagal tidak boleh menghilangkan pesan atau membuat chat macet.
        if (!signal.aborted) {
          begin();
          reveal(total);
          commit?.();
        }
      } finally {
        if (!signal.aborted) {
          setStage("idle");
          setRevealing(false);
          stopMouth();
        }
      }
    },
    [startMouth, stopMouth],
  );

  // ── kirim pesan ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (voiceText?: string) => {
    const text = (voiceText ?? input).trim().slice(0, MAX_INPUT);
    if (!text || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const ctrl = newRun();
    // Harus sinkron dengan aksi pengguna, sesudah stopAudio() dari newRun().
    unlockAudio();
    const { signal } = ctrl;
    const prior = historyRef.current.slice(-8);
    historyRef.current.push({ role: "user", text });
    setChatMessages((messages) => [...messages, { role: "user", text }]);
    setInput("");
    setCurrentMsg(null);
    setShown1("");
    setShown2("");
    setRevealing(false);
    setWaitLine2(false);
    setStage("ai");

    try {
      let msg: Parsed;
      let spoken = true;
      try {
        const asksDeveloper = /\b(developer|pembuat|pencipta|owner|pemilik|yang bikin|yang buat|dibuat|pembuatnya|pengembang|mengembangkan)\b/i.test(text) && /\b(siapa|nama|yuki|kamu|anda|developer|owner|pembuat|pencipta|pengembang)\b/i.test(text);
        if (asksDeveloper) {
          msg = { expression: "Senang", text1: "Kevsoft, yang ownernya : kevin.", text2: "", gesture: "-" };
        } else {
          const cfg = await getYukiConfig();
          let userContext = "";
          try {
            const profile = JSON.parse(localStorage.getItem("yuki.profile") || "{}");
            const details = [profile.name ? `Nama panggilan pengguna: ${profile.name}` : "", profile.birthday ? `Tanggal lahir pengguna: ${profile.birthday}` : "", Array.isArray(profile.topics) && profile.topics.length ? `Topik favorit: ${profile.topics.join(", ")}` : "", profile.about ? `Tentang pengguna: ${profile.about}` : ""].filter(Boolean);
            if (details.length) userContext = `\n\nKonteks profil pengguna (gunakan secara natural, jangan diulang tanpa alasan):\n${details.join("\n")}`;
          } catch { /* corrupted local profile is ignored */ }
          const configuredPrompt = `${cfg.prompt || PERSONA}${userContext}\n\nJika ditanya siapa developer/pembuat/owner Yuki, bagian pesan harus persis: Kevsoft, yang ownernya : kevin.\n\n${buildFormatPrompt()}`;
          msg = parseAI(await askAI(buildPrompt(configuredPrompt, prior, text, 6400), signal), { maxChars: cfg.tts.maxChars, isGesture: recognizesGesture });
        }
        const assistantText = `${msg.text1} ${msg.text2}`.trim();
        historyRef.current.push({ role: "assistant", text: assistantText });
        try {
          const saved = JSON.parse(localStorage.getItem("yuki.chats") || "[]");
          const userProfile = JSON.parse(localStorage.getItem("yuki.profile") || "{}");
          saved.unshift({ title: text.slice(0, 64) || "Percakapan dengan Yuki", date: new Date().toLocaleString("id-ID"), preview: assistantText.slice(0, 180), user: userProfile.name || "", messages: [{ role: "user", text }, { role: "assistant", text: assistantText }] });
          localStorage.setItem("yuki.chats", JSON.stringify(saved.slice(0, 50)));
        } catch { /* local storage can be unavailable or full; chat still works */ }
      } catch (e) {
        if (isAbort(e) || signal.aborted) return;
        msg = ERROR_MSG; // pesan error tampil instan, tanpa menunggu TTS
        spoken = false;
      }
      const finalMsg = msg;
      await presentMessage(finalMsg, signal, spoken, () =>
        setChatMessages((messages) => [...messages, { role: "assistant", text: `${finalMsg.text1} ${finalMsg.text2}`.trim() }]),
      );
    } catch {
      // jaring pengaman terakhir: apa pun yang lolos, UI tidak boleh macet
      if (!signal.aborted) {
        setStage("idle");
        setCurrentMsg(ERROR_MSG);
        setShown1(ERROR_MSG.text1);
        setShown2(ERROR_MSG.text2);
      }
    } finally {
      if (ctrlRef.current === ctrl) {
        busyRef.current = false;
        setBusy(false);
        setStage("idle");
        setRevealing(false);
        setWaitLine2(false);
        stopMouth();
        setTimeout(() => inputRef.current?.focus(), 80);
      }
    }
  }, [input, newRun, presentMessage, stopMouth]);
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setIsListening(false);
    try { recognitionRef.current?.stop(); } catch { /* recognizer may already be stopped */ }
  }, []);

  const startListening = useCallback((continuous = false) => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      listeningRef.current = continuous;
      recognition.continuous = continuous;
      recognition.interimResults = true;
      recognition.lang = "id-ID";
      setIsListening(true);
      recognition.start();
    } catch {
      // start() can throw if the microphone is already active; onend will recover when possible.
    }
  }, []);

  const toggleListening = useCallback(() => {
    unlockAudio();
    if (listeningRef.current || isListening) {
      stopListening();
      return;
    }
    startListening(modeRef.current === "KLC");
  }, [isListening, startListening, stopListening]);

  const changeChatMode = useCallback((mode: ChatMode) => {
    modeRef.current = mode;
    setChatMode(mode);
    stopListening();
    if (mode === "KLC") {
      // Microphone permission must be triggered by a user gesture; the mic button starts it.
      setInput("");
    }
  }, [stopListening]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
        setIsFullscreen(!!document.fullscreenElement);
      } else {
        await document.exitFullscreen?.();
        setIsFullscreen(false);
      }
    } catch {
      // Some mobile browsers do not expose Fullscreen API; standalone/PWA mode is the fallback.
      setIsFullscreen(!!document.fullscreenElement);
    }
  }, []);

  useEffect(() => {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setVoiceSupported(false);
      return;
    }
    setVoiceSupported(true);
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "id-ID";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      let finalText = "";
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += `${result[0]?.transcript || ""} `;
      }
      const transcript = finalText.trim();
      if (transcript) {
        listeningRef.current = modeRef.current === "KLC";
        if (modeRef.current === "KVC") setIsListening(false);
        try { recognition.stop(); } catch { /* already stopped */ }
        void sendMessageRef.current(transcript);
      }
    };
    recognition.onerror = () => {
      // Permission/network errors stop the loop instead of retrying forever.
      listeningRef.current = false;
      setIsListening(false);
    };
    recognition.onend = () => {
      if (modeRef.current === "KLC" && listeningRef.current) {
        if (!busyRef.current) {
          window.setTimeout(() => {
            if (modeRef.current === "KLC" && listeningRef.current && !busyRef.current) {
              try { recognition.start(); setIsListening(true); } catch { /* browser may still be finalizing audio */ }
            }
          }, 450);
        } else {
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };
    recognitionRef.current = recognition;
    const onFullscreen = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      listeningRef.current = false;
      try { recognition.stop(); } catch { /* ignore teardown */ }
      recognitionRef.current = null;
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, []);

  useEffect(() => {
    if (chatMode === "KLC" && listeningRef.current && !busy && recognitionRef.current) {
      const id = window.setTimeout(() => {
        if (modeRef.current === "KLC" && listeningRef.current && !busyRef.current) {
          try { recognitionRef.current.start(); setIsListening(true); } catch { /* recognizer may already be active */ }
        }
      }, 500);
      return () => clearTimeout(id);
    }
  }, [busy, chatMode]);

  const toggleTTS = () => {
    const next = !ttsEnabled;
    setTtsEnabled(next);
    ttsOnRef.current = next;
    if (!next) {
      stopAudio(); // playUrl menganggap jeda = selesai → teks langsung tampil penuh
      stopSpeech();
      stopMouth();
    }
  };

  // ── kapan UI tampil ──────────────────────────────────────────────────────
  useEffect(() => {
    if (live2dFailed || live2dReady) setShowUI(true);
  }, [live2dFailed, live2dReady]);
  useEffect(() => {
    const t = window.setTimeout(() => setShowUI(true), 12000); // CDN lambat? chat tetap bisa dipakai
    return () => clearTimeout(t);
  }, []);

  // ── sapaan pertama ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!showUI || greetedRef.current) return;
    greetedRef.current = true;
    const ctrl = newRun();
    const t = window.setTimeout(async () => {
      try {
        // browser memblokir suara sebelum ada interaksi → jangan buang waktu menunggu TTS
        const canSound = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
        await presentMessage(GREETING, ctrl.signal, canSound);
      } catch {
        /* abaikan */
      } finally {
        if (ctrlRef.current === ctrl) {
          setStage("idle");
          setRevealing(false);
          setWaitLine2(false);
        }
      }
    }, 200);
    return () => clearTimeout(t);
  }, [showUI, newRun, presentMessage]);

  // ── bersih-bersih saat unmount ───────────────────────────────────────────
  useEffect(
    () => () => {
      ctrlRef.current?.abort();
      stopAudio();
      stopSpeech();
    },
    [],
  );

  const onLoad = useCallback(() => setLive2dReady(true), []);
  const onError = useCallback((why?: string) => { setLive2dFailed(true); if (why) { setVrmWhy(why); window.setTimeout(() => setVrmWhy(""), 12000); } }, []);

  const displayedText = shown2 ? `${shown1}\n${shown2}` : shown1;
  useEffect(() => {
    const feed = chatFeedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [chatMessages, shown1, shown2, stage, revealing, waitLine2]);
  const openFull = () => window.open(window.location.href, "_blank", "noopener,noreferrer");
  const bgStyle = { "--bg-url": `url(${BG_URL})` } as CSSProperties;

  // ── layar "buka full view" (iframe tanpa WebGL) ──────────────────────────
  if (IS_IFRAME && !HAS_WEBGL) {
    return (
      <div className="scene-root">
        <div className="scene-bg" style={bgStyle} />
        <div className="scene-vignette" />
        <div className="scene-grain" />
        <DustParticles />
        <div className="name-plate">
          <div className="name-plate-inner">
            <h1>{aiName}</h1>
            <div className="name-plate-rule" />
            <span className="name-plate-sub">Personal AI Assistant · Kevsoft Studio</span>
          </div>
        </div>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div className="unlock-card">
            <div style={{ fontSize: "2rem", marginBottom: 14 }}>◐</div>
            <div style={{ color: "rgba(255,255,255,0.9)", fontFamily: "'Cormorant Garamond',serif", fontSize: "1.05rem", lineHeight: 1.65, marginBottom: 20 }}>
              Model 3D Yuki membutuhkan WebGL.<br />
              <span style={{ opacity: 0.55, fontSize: "0.85rem" }}>Buka di tab baru untuk melihat karakter penuh.</span>
            </div>
            <button className="unlock-btn" onClick={openFull}>Buka Full View ↗</button>
          </div>
        </div>
      </div>
    );
  }

  // ── adegan utama ─────────────────────────────────────────────────────────
  return (
    <div className="scene-root">
      <div className="scene-bg" style={bgStyle} />
      <div className="scene-atmosphere" aria-hidden="true" />
      <div className="scene-dew" aria-hidden="true" />
      <div className="scene-scanlines" />
      <div className="scene-grain" />
      <div className="scene-vignette" />
      <DustParticles />

      <div className="corner-frame corner-tl" />
      <div className="corner-frame corner-tr" />
      <div className="corner-frame corner-bl" />
      <div className="corner-frame corner-br" />

      <button className="chat-home-btn" onClick={() => { window.location.href = "/home"; }}>⌂ BACK TO HOME</button>
      <button className="fullscreen-btn" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? "Keluar layar penuh" : "Layar penuh"}>{isFullscreen ? "KELUAR FULLSCREEN" : "FULLSCREEN ⛶"}</button>
      <div className="name-plate">
        <div className="name-plate-inner">
          <h1>{aiName}</h1>
          <div className="name-plate-rule" />
          <span className="name-plate-sub">Personal AI Assistant · Kevsoft Studio</span>
        </div>
      </div>

      {HAS_WEBGL && (
        <div className="live2d-wrapper">
          <VRMViewer ref={viewerRef} onLoad={onLoad} onError={onError} onProgress={setLoadPct} />
        </div>
      )}

      {(!HAS_WEBGL || live2dFailed) && (
        <div className="live2d-wrapper" style={{ opacity: showUI ? 1 : 0, transition: "opacity 0.6s" }}>
          <CSSAvatar expression={currentMsg?.expression || "Senang"} talking={isTalking} />
        </div>
      )}

      {vrmWhy && (
        <div style={{ position: "fixed", left: 10, bottom: 10, zIndex: 9999, maxWidth: "min(92vw,420px)", padding: "8px 12px", borderRadius: 10, background: "rgba(20,16,32,.88)", color: "#fff", font: "12px/1.4 system-ui", border: "1px solid rgba(255,255,255,.18)" }}>
          Model 3D tidak bisa dimuat — memakai avatar cadangan.<br /><span style={{ opacity: 0.7 }}>{vrmWhy.slice(0, 220)}</span>
        </div>
      )}
      {!showUI && <BootLoader pct={loadPct} />}

      {showUI && (
        <div className="dialogue-panel">
          <div className={`dialogue-box${stage !== "idle" ? " is-busy" : ""}`}>
            {stage !== "idle" && <div className="busy-line" />}

            <div className="dialogue-header overlay-header">
              <div className="overlay-status">
                <i className={isListening ? "listening" : stage !== "idle" ? "thinking" : isTalking || revealing ? "speaking" : "ready"} />
                <span>{isListening ? "LIVE · LISTENING" : stage === "ai" ? "MENJAWAB PESAN…" : stage === "tts" ? "MENYIAPKAN SUARA…" : isTalking || revealing ? "LIVE · SPEAKING" : "LIVE · READY"}</span>
              </div>
              <div className={`overlay-wave${isTalking || isListening ? " active" : ""}`} aria-label={isListening ? "Mikrofon aktif" : isTalking ? "Yuki sedang berbicara" : "Audio standby"}>
                {Array.from({ length: 6 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 90}ms` }} />)}
              </div>
              <span className="overlay-timer">{String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:{String(elapsedSeconds % 60).padStart(2, "0")}</span>
              <button
                className={`tts-btn${ttsEnabled ? " on" : ""}`}
                onClick={toggleTTS}
                title={ttsEnabled ? "Matikan suara" : "Nyalakan suara"}
                aria-label={ttsEnabled ? "Matikan suara" : "Nyalakan suara"}
                aria-pressed={ttsEnabled}
              >
                {ttsEnabled ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
              {IS_IFRAME && <button className="full-btn" onClick={openFull}>FULL ↗</button>}
            </div>

            <div className="chat-mode-switch" role="group" aria-label="Mode percakapan">
              <button className={chatMode === "KVC" ? "selected" : ""} onClick={() => changeChatMode("KVC")} aria-pressed={chatMode === "KVC"}><b>KVC</b><span>Kev Voice Chat</span></button>
              <button className={chatMode === "KLC" ? "selected" : ""} onClick={() => changeChatMode("KLC")} aria-pressed={chatMode === "KLC"}><b>KLC</b><span>Kev Live Chat · hands-free</span></button>
            </div>
            <div className="chat-feed" ref={chatFeedRef} aria-live="polite" aria-label="Riwayat percakapan">
              {chatMessages.length === 0 && currentMsg && displayedText && stage === "idle" && !revealing && (
                <div className="chat-message assistant-message">
                  <span className="message-avatar">✳</span>
                  <div className="message-content"><span className="message-author">{aiName}</span><p>{displayedText}{revealing && <span className="dialogue-cursor" />}{waitLine2 && <MiniWave />}</p></div>
                </div>
              )}
              {chatMessages.map((message, index) => (
                <div className={`chat-message ${message.role === "user" ? "user-message" : "assistant-message"}`} key={`${index}-${message.role}`}>
                  {message.role === "assistant" && <span className="message-avatar">✳</span>}
                  <div className="message-content">
                    <span className="message-author">{message.role === "user" ? "Kamu" : aiName}</span>
                    <p>{message.text}</p>
                  </div>
                  {message.role === "user" && <span className="message-avatar user-avatar">☺</span>}
                </div>
              ))}
              {stage !== "idle" && !(currentMsg && displayedText) && (
                <div className="chat-message assistant-message typing-message">
                  <span className="message-avatar">✳</span>
                  <div className="message-content"><span className="message-author">{aiName}</span><div className="typing-bubble"><i/><i/><i/><span>{stage === "tts" ? "Menyiapkan suara..." : "Menjawab pesan..."}</span></div></div>
                </div>
              )}
              {currentMsg && displayedText && revealing && (
                <div className="chat-message assistant-message live-response">
                  <span className="message-avatar">✳</span>
                  <div className="message-content"><span className="message-author">{aiName} <small>LIVE</small></span><p>{displayedText}{revealing && !waitLine2 && <span className="dialogue-cursor" />}{waitLine2 && <MiniWave />}</p></div>
                </div>
              )}
              <div className="chat-feed-end" />
            </div>

            <div className="chat-compose-hint"><span>✦</span> {chatMode === "KLC" ? (voiceSupported ? "Ngobrol langsung dengan suara — tekan mikrofon untuk mulai." : "Voice input tidak didukung browser ini; gunakan input teks di bawah.") : "KVC: ngobrol dengan suara atau ketik pesan."}</div>
            <div className={`input-wrapper${chatMode === "KLC" ? " voice-only" : ""}`}>
              <button className={`mic-btn${isListening ? " listening" : ""}`} onClick={toggleListening} disabled={!voiceSupported || busy} aria-label={isListening ? "Hentikan mikrofon" : "Mulai bicara"} title={!voiceSupported ? "Browser ini belum mendukung pengenalan suara" : isListening ? "Hentikan mikrofon" : "Mulai bicara"}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg>
              </button>
              {(chatMode !== "KLC" || !voiceSupported) && <input
                ref={inputRef}
                className="chat-input"
                placeholder={`Ketik pesan untuk ${aiName}...`}
                value={input}
                maxLength={MAX_INPUT}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                disabled={busy}
                autoComplete="off"
                enterKeyHint="send"
                aria-label="Pesan untuk Yuki"
                autoFocus
              />}
              {chatMode === "KLC" && voiceSupported && <span className="voice-mode-hint">{isListening ? "Yuki mendengarkan…" : "Tekan mikrofon untuk mulai bicara"}</span>}
              {(chatMode !== "KLC" || !voiceSupported) && <button className="send-btn" onClick={() => void sendMessage()} disabled={busy || !input.trim()} title="Kirim" aria-label="Kirim">
                {busy ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20">
                      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
                    </circle>
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
                  </svg>
                )}
              </button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
