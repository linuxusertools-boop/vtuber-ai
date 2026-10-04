import { useState, useRef, useEffect, useCallback, type CSSProperties, type KeyboardEvent } from "react";
import Live2DViewer, { type Live2DViewerHandle } from "@/components/Live2DViewer";
import DustParticles from "@/components/DustParticles";
import CSSAvatar from "@/components/CSSAvatar";
import { BootLoader, MiniWave } from "@/components/Loaders";
import { askAI, buildPrompt, parseAI, prepareTTS, sleep, isAbort, getYukiConfig, type Parsed, type TTSResult } from "@/lib/api";
import { unlockAudio, playUrl, speakBrowser, typeText, stopAudio, stopSpeech, HAS_SPEECH, type PlayResult } from "@/lib/audio";

const BG_URL = "https://cdn.nexray.eu.cc/download/rOyFPH";
const MAX_INPUT = 300;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;
const IS_IFRAME: boolean = w.__IS_IFRAME__ ?? false;
const HAS_WEBGL: boolean = w.__HAS_WEBGL__ ?? false;

const SYSTEM_PROMPT = `Kamu adalah YUKI, assistant virtual dari Kevsoft Studio. Kamu punya kepribadian hangat, ekspresif, suportif, dan berbicara natural dalam bahasa Indonesia.\n\nSelalu balas HANYA dengan format ini (tanpa penjelasan lain, tanpa markdown):\n{ekspresi}|{kalimat1}|{kalimat2}\n\nEkspresi yang tersedia: Senang, Sedih, Malu, Tsundere, Marah, Kaget, Bingung, Serius\nPilih ekspresi yang paling sesuai dengan situasi dan mood percakapan.\n\nkalimat1 = bagian pertama respons (pendek, natural)\nkalimat2 = lanjutan atau penutup yang mengalir alami\n\nContoh:\nSenang|Waaa, beneran?! Aku seneng banget dengerin itu...|Makasih ya, kamu baik banget~ ♡\nTsundere|B-bukan berarti aku seneng kamu tanya itu...|...tapi, yaudah deh, aku jawab karena terpaksa!\nMalu|E-eh, itu...|J-jangan bilang hal kayak gitu dong, aku jadi salah tingkah...\n\nJawab pesan berikut:`;

const GREETING: Parsed = {
  expression: "Senang",
  text1: "Haii~ Aku Yuki! Seneng banget kamu mau ngobrol sama aku ♡",
  text2: "Mau cerita apa hari ini? Aku dengerin semuanya~",
};
const ERROR_MSG: Parsed = {
  expression: "Sedih",
  text1: "Eh... koneksiku lagi bermasalah nih...",
  text2: "Coba kirim lagi sebentar ya~",
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
  useEffect(() => { let active = true; getYukiConfig().then(cfg => { if (active && cfg.aiName?.trim()) setAiName(cfg.aiName.trim()); }).catch(() => undefined); return () => { active = false; }; }, []);

  const viewerRef = useRef<Live2DViewerHandle>(null);
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
  const startMouth = useCallback(() => {
    setIsTalking(true);
    viewerRef.current?.startTalking();
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

  // ── satu kalimat: suara + teks berjalan serempak ─────────────────────────
  const presentLine = useCallback(
    async (text: string, tts: TTSResult | null, setShown: (s: string) => void, signal: AbortSignal, voice: boolean) => {
      let last = -1;
      const reveal = (r: number) => {
        const n = Math.min(text.length, Math.ceil(text.length * Math.min(1, r / 0.92)));
        if (n !== last) {
          last = n;
          setShown(text.slice(0, n));
        }
      };
      const hooks = { onStart: startMouth, onProgress: reveal };

      let outcome: PlayResult = "failed";
      if (voice && tts) {
        outcome = await playUrl(tts.url, signal, hooks); // teks mulai mengalir saat onStart → bersamaan
        stopMouth();
      }
      if (signal.aborted || outcome === "aborted") return;
      if (outcome === "done") {
        setShown(text);
        return;
      }
      // suara kev-tts gagal → suara bawaan browser (hanya jika memang gagal, bukan diblokir autoplay)
      if (voice && outcome === "failed" && HAS_SPEECH) {
        const r = await speakBrowser(text, signal, hooks);
        stopMouth();
        if (signal.aborted || r === "aborted") return;
        if (r === "done") {
          setShown(text);
          return;
        }
      }
      // terakhir: tanpa suara, teks diketik biasa
      await typeText(text, setShown, signal);
      if (!signal.aborted) setShown(text);
    },
    [startMouth, stopMouth],
  );

  // ── satu pesan: tunggu suara siap → teks & suara mulai bersamaan ─────────
  const presentMessage = useCallback(
    async (msg: Parsed, signal: AbortSignal, speak: boolean) => {
      const voice = speak && ttsOnRef.current;
      if (voice) setStage("tts");
      const p1 = voice ? prepareTTS(msg.text1, signal).catch(() => null) : Promise.resolve(null);
      const p2 = voice && msg.text2 ? prepareTTS(msg.text2, signal).catch(() => null) : Promise.resolve(null);
      let ready2 = false;
      void p2.then(() => {
        ready2 = true;
      });

      const r1 = await p1; // ← teks sengaja belum muncul sampai suara kalimat 1 siap
      if (signal.aborted) return;

      setStage("idle");
      setShown1("");
      setShown2("");
      setWaitLine2(false);
      setCurrentMsg(msg);
      setRevealing(true);
      viewerRef.current?.setExpression(msg.expression);
      await presentLine(msg.text1, r1, setShown1, signal, voice);
      if (signal.aborted) return;

      if (msg.text2) {
        await sleep(160, signal).catch(() => undefined);
        if (signal.aborted) return;
        if (voice && !ready2) setWaitLine2(true); // suara kalimat 2 belum siap → equalizer mini
        const r2 = await p2;
        if (signal.aborted) return;
        setWaitLine2(false);
        await presentLine(msg.text2, r2, setShown2, signal, voice);
      }
      if (!signal.aborted) setRevealing(false);
    },
    [presentLine],
  );

  // ── kirim pesan ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (voiceText?: string) => {
    const text = (voiceText ?? input).trim().slice(0, MAX_INPUT);
    if (!text || busyRef.current) return;
    unlockAudio(); // harus sinkron di dalam gestur pengguna (syarat iOS/Safari)

    busyRef.current = true;
    setBusy(true);
    const ctrl = newRun();
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
          msg = { expression: "Senang", text1: "Kevsoft, yang ownernya : kevin.", text2: "" };
        } else {
          const cfg = await getYukiConfig();
          let userContext = "";
          try {
            const profile = JSON.parse(localStorage.getItem("yuki.profile") || "{}");
            const details = [profile.name ? `Nama panggilan pengguna: ${profile.name}` : "", profile.birthday ? `Tanggal lahir pengguna: ${profile.birthday}` : "", Array.isArray(profile.topics) && profile.topics.length ? `Topik favorit: ${profile.topics.join(", ")}` : "", profile.about ? `Tentang pengguna: ${profile.about}` : ""].filter(Boolean);
            if (details.length) userContext = `\n\nKonteks profil pengguna (gunakan secara natural, jangan diulang tanpa alasan):\n${details.join("\n")}`;
          } catch { /* corrupted local profile is ignored */ }
          const configuredPrompt = `${cfg.prompt || SYSTEM_PROMPT}${userContext}\n\nJika ditanya siapa developer/pembuat/owner Yuki, jawab persis: Kevsoft, yang ownernya : kevin. Balas HANYA dengan format: {ekspresi}|{kalimat1}|{kalimat2}. Ekspresi: Senang, Sedih, Malu, Tsundere, Marah, Kaget, Bingung, Serius.\n\n${SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Selalu balas"))}`;
          msg = parseAI(await askAI(buildPrompt(configuredPrompt, prior, text), signal));
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
      await presentMessage(msg, signal, spoken);
      if (!signal.aborted) setChatMessages((messages) => [...messages, { role: "assistant", text: `${msg.text1} ${msg.text2}`.trim() }]);
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
  const onError = useCallback(() => setLive2dFailed(true), []);

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
              Model Live2D Yuki membutuhkan WebGL.<br />
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
          <Live2DViewer ref={viewerRef} onLoad={onLoad} onError={onError} onProgress={setLoadPct} />
        </div>
      )}

      {(!HAS_WEBGL || live2dFailed) && (
        <div className="live2d-wrapper" style={{ opacity: showUI ? 1 : 0, transition: "opacity 0.6s" }}>
          <CSSAvatar expression={currentMsg?.expression || "Senang"} talking={isTalking} />
        </div>
      )}

      {!showUI && <BootLoader pct={loadPct} />}

      {showUI && (
        <div className="dialogue-panel">
          <div className={`dialogue-box${stage !== "idle" ? " is-busy" : ""}`}>
            {stage !== "idle" && <div className="busy-line" />}

            <div className="dialogue-header overlay-header">
              <div className="overlay-status">
                <i className={isListening ? "listening" : stage !== "idle" || revealing ? "thinking" : isTalking ? "speaking" : "ready"} />
                <span>{isListening ? "LIVE · LISTENING" : stage === "ai" ? "LIVE · THINKING" : isTalking ? "LIVE · SPEAKING" : stage === "tts" ? "LIVE · VOICE" : "LIVE · READY"}</span>
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
              {stage !== "idle" && (
                <div className="chat-message assistant-message typing-message">
                  <span className="message-avatar">✳</span>
                  <div className="message-content"><span className="message-author">{aiName}</span><div className="typing-bubble"><i/><i/><i/><span>{stage === "tts" ? "Menyiapkan suara..." : "Sedang berpikir..."}</span></div></div>
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
