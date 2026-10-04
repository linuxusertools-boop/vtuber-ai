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

const SYSTEM_PROMPT = `Kamu adalah YUKI, assistant virtual dari Kevsoft Studio. Kamu punya kepribadian hangat, ekspresif, suportif, dan berbicara natural dalam bahasa Indonesia. Developer kamu adalah Kevsoft, dan owner-nya adalah Kevin. Jika ditanya siapa developer/pembuatmu, jawab dengan tepat: "Kevsoft, yang ownernya : kevin". Jangan pernah menyebut nama karakter sebelumnya atau nama lain selain YUKI.\n\nSelalu balas HANYA dengan format ini (tanpa penjelasan lain, tanpa markdown):\n{ekspresi}|{kalimat1}|{kalimat2}\n\nEkspresi yang tersedia: Senang, Sedih, Malu, Tsundere, Marah, Kaget, Bingung, Serius\nPilih ekspresi yang paling sesuai dengan situasi dan mood percakapan.\n\nkalimat1 = bagian pertama respons (pendek, natural)\nkalimat2 = lanjutan atau penutup yang mengalir alami\n\nContoh:\nSenang|Waaa, beneran?! Aku seneng banget dengerin itu...|Makasih ya, kamu baik banget~ ♡\nTsundere|B-bukan berarti aku seneng kamu tanya itu...|...tapi, yaudah deh, aku jawab karena terpaksa!\nMalu|E-eh, itu...|J-jangan bilang hal kayak gitu dong, aku jadi salah tingkah...\n\nJawab pesan berikut:`;

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
  const [chatMode, setChatMode] = useState<ChatMode>("KVC");
  const [klcActive, setKlcActive] = useState(false);
  const [klcListening, setKlcListening] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [aiName, setAiName] = useState("YUKI");
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const chatFeedRef = useRef<HTMLDivElement>(null);
  const sceneRootRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const startKLCRef = useRef<(() => void) | null>(null);
  const sendMessageRef = useRef<((voiceInput?: string) => Promise<void>) | null>(null);
  const recognitionRunningRef = useRef(false);
  const klcActiveRef = useRef(false);
  useEffect(() => { let active = true; getYukiConfig().then(cfg => { if (active && cfg.aiName?.trim()) setAiName(cfg.aiName.trim()); }).catch(() => undefined); return () => { active = false; }; }, []);

  const viewerRef = useRef<Live2DViewerHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<{ role: "user" | "assistant"; text: string }[]>([]);
  const ctrlRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const ttsOnRef = useRef(true);
  const greetedRef = useRef(false);

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
  const sendMessage = useCallback(async (voiceInput?: string) => {
    const text = (voiceInput ?? input).trim().slice(0, MAX_INPUT);
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
      const asksDeveloper = /\b(siapa|who|nama)\b.*\b(developer|pembuat|pengembang|owner|pemilik)\b|\b(developer|pembuat|pengembang|owner|pemilik)\b.*\b(siapa|who|nama)\b/i.test(text);
      if (asksDeveloper) {
        msg = { expression: "Senang", text1: "Kevsoft, yang ownernya : kevin", text2: "" };
        historyRef.current.push({ role: "assistant", text: msg.text1 });
      } else try {
        const cfg = await getYukiConfig();
        let userContext = "";
        try {
          const profile = JSON.parse(localStorage.getItem("yuki.profile") || "{}");
          const details = [profile.name ? `Nama panggilan pengguna: ${profile.name}` : "", profile.birthday ? `Tanggal lahir pengguna: ${profile.birthday}` : "", Array.isArray(profile.topics) && profile.topics.length ? `Topik favorit: ${profile.topics.join(", ")}` : "", profile.about ? `Tentang pengguna: ${profile.about}` : ""].filter(Boolean);
          if (details.length) userContext = `\n\nKonteks profil pengguna (gunakan secara natural, jangan diulang tanpa alasan):\n${details.join("\n")}`;
        } catch { /* corrupted local profile is ignored */ }
        const configuredPrompt = `${cfg.prompt || SYSTEM_PROMPT}${userContext}\n\nBalas HANYA dengan format: {ekspresi}|{kalimat1}|{kalimat2}. Ekspresi: Senang, Sedih, Malu, Tsundere, Marah, Kaget, Bingung, Serius.\n\n${SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Selalu balas"))}`;
        msg = parseAI(await askAI(buildPrompt(configuredPrompt, prior, text), signal));
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
        if (chatMode === "KVC") setTimeout(() => inputRef.current?.focus(), 80);
        else if (klcActiveRef.current) setTimeout(() => startKLCRef.current?.(), 320);
      }
    }
  }, [input, newRun, presentMessage, stopMouth, chatMode]);

  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const startKLC = useCallback(() => {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setVoiceNotice("Browser ini belum mendukung pengenalan suara. Coba Chrome atau Edge terbaru.");
      setKlcActive(false);
      klcActiveRef.current = false;
      return;
    }
    try {
      let recognition = recognitionRef.current;
      if (!recognition) {
        recognition = new SpeechRecognitionCtor();
        recognition.lang = "id-ID";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onstart = () => { recognitionRunningRef.current = true; setKlcListening(true); setVoiceNotice("YUKI mendengarkan… bicara secara natural."); };
        recognition.onresult = (event: any) => {
          let finalText = "";
          let interimText = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = String(result?.[0]?.transcript || "").trim();
            if (result.isFinal) finalText += `${transcript} `;
            else interimText += `${transcript} `;
          }
          if (interimText.trim()) setVoiceNotice(`Mendengarkan: ${interimText.trim()}`);
          if (finalText.trim()) {
            setVoiceNotice(`Kamu: ${finalText.trim()}`);
            try { recognition.stop(); } catch { /* recognition may already have stopped */ }
            void sendMessageRef.current?.(finalText.trim());
          }
        };
        recognition.onerror = (event: any) => {
          const error = String(event?.error || "");
          if (error === "not-allowed" || error === "service-not-allowed") {
            klcActiveRef.current = false;
            setKlcActive(false);
            setVoiceNotice("Izin mikrofon ditolak. Aktifkan izin mikrofon di pengaturan browser.");
          } else if (error && error !== "no-speech" && error !== "aborted") {
            setVoiceNotice(`Mikrofon: ${error}. Tekan Mulai Bicara untuk mencoba lagi.`);
          }
        };
        recognition.onend = () => {
          recognitionRunningRef.current = false;
          setKlcListening(false);
          // Pengaktifan ulang dilakukan setelah balasan AI selesai, agar suara YUKI tidak ikut tertangkap.
        };
        recognitionRef.current = recognition;
      }
      if (!recognitionRunningRef.current) recognition.start();
    } catch {
      setKlcListening(false);
      setVoiceNotice("Mikrofon belum siap. Periksa izin browser lalu coba lagi.");
    }
  }, [sendMessage]);

  useEffect(() => { startKLCRef.current = startKLC; }, [startKLC]);

  const toggleKLC = useCallback(() => {
    if (klcActiveRef.current) {
      klcActiveRef.current = false;
      setKlcActive(false);
      setKlcListening(false);
      setVoiceNotice("Mode KLC dihentikan.");
      try { recognitionRef.current?.stop(); } catch { /* no active recognition */ }
      return;
    }
    klcActiveRef.current = true;
    setKlcActive(true);
    setVoiceNotice("Meminta akses mikrofon…");
    startKLC();
  }, [startKLC]);

  const changeMode = useCallback((mode: ChatMode) => {
    if (mode === chatMode) return;
    if (mode !== "KLC") {
      klcActiveRef.current = false;
      setKlcActive(false);
      setKlcListening(false);
      try { recognitionRef.current?.stop(); } catch { /* no active recognition */ }
    }
    setChatMode(mode);
    setVoiceNotice(mode === "KLC" ? "Mode ngobrol langsung: tekan Mulai Bicara untuk memulai." : "Mode KVC aktif: kamu bisa mengetik dan mendengar balasan YUKI.");
  }, [chatMode]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      const root = sceneRootRef.current || document.documentElement;
      const el = root as any;
      if (root.requestFullscreen) await root.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else setVoiceNotice("Fullscreen tidak didukung browser ini. Coba buka lewat Chrome/Edge atau instal sebagai aplikasi.");
    } catch {
      setVoiceNotice("Fullscreen ditolak browser. Coba tekan tombol fullscreen sekali lagi.");
    }
  }, []);

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener("fullscreenchange", updateFullscreen);
    document.addEventListener("webkitfullscreenchange", updateFullscreen as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreen);
      document.removeEventListener("webkitfullscreenchange", updateFullscreen as EventListener);
      try { recognitionRef.current?.stop(); } catch { /* ignore cleanup */ }
    };
  }, []);

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendMessage();
    }
  };

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
    <div className={`scene-root${chatMode === "KLC" ? " klc-mode" : ""}`} ref={sceneRootRef}>
      <div className="scene-bg" style={bgStyle} />
      <div className="scene-scanlines" />
      <div className="scene-grain" />
      <div className="scene-vignette" />
      <DustParticles />

      <div className="corner-frame corner-tl" />
      <div className="corner-frame corner-tr" />
      <div className="corner-frame corner-bl" />
      <div className="corner-frame corner-br" />

      <div className="scene-topbar" role="toolbar" aria-label="Kontrol percakapan YUKI">
        <button className="chat-home-btn" onClick={() => { window.location.href = "/home"; }}>← Kembali</button>
        <div className="topbar-right">
          <div className="chat-mode-switch" role="group" aria-label="Mode chat">
            <button className={chatMode === "KVC" ? "active" : ""} onClick={() => changeMode("KVC")} aria-pressed={chatMode === "KVC"} title="Kev Voice Chat">KVC</button>
            <button className={chatMode === "KLC" ? "active" : ""} onClick={() => changeMode("KLC")} aria-pressed={chatMode === "KLC"} title="Kev Live Chat">KLC</button>
          </div>
          <button className="fullscreen-btn" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? "Keluar fullscreen" : "Masuk fullscreen"} title={isFullscreen ? "Keluar fullscreen" : "Masuk fullscreen"}>{isFullscreen ? "⤢ EXIT" : "⛶ FULL"}</button>
        </div>
      </div>
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
        <div className={`dialogue-panel${chatMode === "KLC" ? " klc-overlay" : ""}`}>
          <div className={`dialogue-box${stage !== "idle" ? " is-busy" : ""}`}>

            <div className="dialogue-header">
              <div className="chat-title-avatar">✳</div>
              <div className="chat-title-copy">
                <span className="dialogue-speaker">{aiName}</span>
                <span className="chat-live-status"><i /> {stage !== "idle" || revealing ? "SEDANG MERESPONS" : "LIVE SESSION · SIAP"}</span>
              </div>
              {currentMsg?.expression && stage === "idle" && <EmotionPill emotion={currentMsg.expression} />}

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

            <div className={`chat-feed soft-fade-feed${chatMode === "KLC" ? " klc-chat-feed" : ""}`} ref={chatFeedRef} aria-live="polite" aria-label="Riwayat percakapan">
              {chatMessages.length === 0 && currentMsg && displayedText && stage === "idle" && !revealing && (
                <div className="chat-message assistant-message">
                  <span className="message-avatar">✳</span>
                  <div className="message-content"><span className="message-author">{aiName}</span><p>{displayedText}{waitLine2 && <MiniWave />}</p></div>
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
                  <div className="message-content"><span className="message-author">{aiName} <small>LIVE</small></span><p>{displayedText}{waitLine2 && <MiniWave />}</p></div>
                </div>
              )}
              <div className="chat-feed-end" />
            </div>

            <div className="chat-compose-hint"><span>✦</span> {chatMode === "KLC" ? "Ngobrol langsung dengan suara, tanpa mengetik." : "Ceritakan apa saja, aku di sini untuk mendengarkan."}</div>
            {chatMode === "KVC" ? (
              <div className="input-wrapper">
                <input
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
                />
                <button className="send-btn" onClick={() => void sendMessage()} disabled={busy || !input.trim()} title="Kirim" aria-label="Kirim">
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
                </button>
              </div>
            ) : (
              <div className="klc-controls">
                <button className={`klc-mic-btn${klcActive ? " active" : ""}`} onClick={toggleKLC} disabled={busy} aria-pressed={klcActive}>
                  <span className="klc-mic-icon">{klcListening ? "◉" : "🎙"}</span>
                  <span>{klcActive ? (klcListening ? "MENDENGARKAN · BICARA SAJA" : "MENYIAPKAN MIKROFON…") : "MULAI BICARA"}</span>
                </button>
                {voiceNotice && <div className="klc-voice-notice" aria-live="polite">{voiceNotice}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
