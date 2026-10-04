import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, memo } from "react";

const MODEL_URL = `${import.meta.env.BASE_URL}model/huohuo/huohuo.model3.json`;

export interface Live2DViewerHandle {
  setExpression: (expr: string) => void;
  startTalking: () => void;
  stopTalking: () => void;
}

interface Props {
  onLoad?: () => void;
  onError?: () => void;
  onProgress?: (pct: number) => void;
}

const expressionFileMap: Record<string, string | null> = {
  Senang:   null,
  Sedih:    "cry",
  Malu:     null,
  Tsundere: "angry",
  Marah:    "angry",
  Kaget:    "baozhen",
  Bingung:  null,
  Serius:   null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;

const Live2DViewer = forwardRef<Live2DViewerHandle, Props>(({ onLoad, onError, onProgress }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const appRef       = useRef<unknown>(null);
  const modelRef     = useRef<unknown>(null);
  const destroyedRef = useRef(false);
  const firedRef     = useRef(false);

  // ─── Animation state (all in refs so ticker can read without re-renders) ───
  const timeRef      = useRef(0);

  // Blink
  const blinkTimer   = useRef(0);
  const blinkState   = useRef<"open" | "closing" | "opening">("open");
  const blinkProg    = useRef(0);

  // Lip sync  ← ONLY driven by TTS events, not always-on
  const isTalkingRef = useRef(false);
  const mouthPhase   = useRef(0);       // internal clock for mouth cycles
  const mouthTarget  = useRef(0);       // target value (0 or burst)
  const mouthCurrent = useRef(0);       // smoothed actual value

  // Head / body sway seeds — random per session so it never looks looping
  const seed1 = useRef(Math.random() * Math.PI * 2);
  const seed2 = useRef(Math.random() * Math.PI * 2);
  const seed3 = useRef(Math.random() * Math.PI * 2);

  // ─── Public handle ────────────────────────────────────────────────────────
  const setExpression = useCallback((expr: string) => {
    const model = modelRef.current as any;
    if (!model) return;
    const file = expressionFileMap[expr];
    try { file ? model.expression(file) : model.expression(); } catch {}
  }, []);

  const startTalking = useCallback(() => {
    isTalkingRef.current = true;
    mouthPhase.current   = 0;
  }, []);

  const stopTalking = useCallback(() => {
    isTalkingRef.current = false;
    mouthTarget.current  = 0;
  }, []);

  useImperativeHandle(ref, () => ({ setExpression, startTalking, stopTalking }), [
    setExpression, startTalking, stopTalking,
  ]);

  // ─── Init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    destroyedRef.current = false;
    firedRef.current     = false;

    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const fail = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      onError?.();
    };

    if (!w.__HAS_WEBGL__) { fail(); return; }
    onProgress?.(5);

    let retries = 0;
    const poll = setInterval(() => {
      if (destroyedRef.current) { clearInterval(poll); return; }
      const ready =
        !!w.PIXI &&
        !!(w.PIXI.live2d?.Live2DModel ?? w.Live2DModel) &&
        !!w.Live2DCubismCore;
      if (!ready) {
        if (++retries > 200) { clearInterval(poll); fail(); } // ±20 dtk menunggu script CDN
        return;
      }
      clearInterval(poll);
      onProgress?.(18);
      initPixi();
    }, 100);

    function initPixi() {
      try {
        const PIXI        = w.PIXI;
        const Live2DModel = PIXI.live2d?.Live2DModel ?? w.Live2DModel;

        const W = container!.offsetWidth  || window.innerWidth;
        const H = container!.offsetHeight || window.innerHeight;

        const app = new PIXI.Application({
          view: canvas!,
          width: W, height: H,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          powerPreference: "high-performance",
        });
        appRef.current = app;
        // konteks WebGL hilang (tab lama, GPU reset) → beralih ke avatar CSS, bukan layar kosong
        const onLost = (e: Event) => { e.preventDefault(); fail(); };
        canvas!.addEventListener("webglcontextlost", onLost);
        (container as any).__lostCleanup = () => canvas!.removeEventListener("webglcontextlost", onLost);
        onProgress?.(28);

        // model tak boleh menggantung selamanya: lewat 30 dtk → pakai avatar CSS
        const modelTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("model-timeout")), 30000),
        );
        Promise.race([Live2DModel.from(MODEL_URL, { autoInteract: false }), modelTimeout])
          .then((model: any) => {
            if (destroyedRef.current) { app.destroy(true); return; }

            modelRef.current = model;
            app.stage.addChild(model);

            const rW     = app.renderer.width;
            const rH     = app.renderer.height;
            const origH  = model.internalModel?.originalHeight || 2048;
            const scale  = (rH * 0.92) / origH;

            model.scale.set(scale);
            model.position.set(rW / 2, rH);
            model.anchor.set(0.5, 1.0);

            try { model.motion("idle", 0, 3); } catch {}

            onProgress?.(100);
            setTimeout(() => onLoad?.(), 60);

            startAnimLoop(app, model);

            // Resize
            const onResize = () => {
              const nW = container!.offsetWidth  || window.innerWidth;
              const nH = container!.offsetHeight || window.innerHeight;
              app.renderer.resize(nW, nH);
              const s = (nH * 0.92) / origH;
              model.scale.set(s);
              model.position.set(nW / 2, nH);
            };
            window.addEventListener("resize", onResize, { passive: true });
            (container as any).__resizeCleanup = () =>
              window.removeEventListener("resize", onResize);
          })
          .catch((err: unknown) => { console.warn("Live2D load error:", err); fail(); });
      } catch (err) {
        console.warn("PIXI init error:", err);
        fail();
      }
    }

    return () => {
      destroyedRef.current = true;
      clearInterval(poll);
      try { (containerRef.current as any)?.__resizeCleanup?.(); } catch {}
      try { (containerRef.current as any)?.__lostCleanup?.(); } catch {}
      try { (appRef.current as any)?.destroy(true); } catch {}
      appRef.current  = null;
      modelRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Ticker / animation loop ──────────────────────────────────────────────
  function startAnimLoop(app: any, model: any) {
    app.ticker.add((dt: number) => {
      if (destroyedRef.current) return;

      // dt is in frames (60fps base). Convert to seconds.
      const ds = (dt / 60) * 1.0;
      timeRef.current    += ds;
      blinkTimer.current += dt;
      mouthPhase.current += ds;

      const t  = timeRef.current;
      const s1 = seed1.current;
      const s2 = seed2.current;
      const s3 = seed3.current;

      const core = model?.internalModel?.coreModel;
      if (!core?.setParameterValueById) return;

      const set = (id: string, v: number) => {
        try { core.setParameterValueById(id, v); } catch {}
      };

      // ── Head sway — layered sinusoids for organic feel ──────────────────
      // AngleX: left-right tilt
      const headX =
        Math.sin(t * 0.41 + s1) * 5.0 +
        Math.sin(t * 0.87 + s2) * 1.8 +
        Math.sin(t * 1.73 + s3) * 0.6;
      // AngleY: forward-back nod
      const headY =
        Math.sin(t * 0.27 + s2) * 2.8 +
        Math.cos(t * 0.53 + s1) * 1.1;
      // AngleZ: z-rotation (lean)
      const headZ =
        Math.sin(t * 0.19 + s3) * 2.4 +
        Math.sin(t * 0.61 + s1) * 0.7;

      set("ParamAngleX", headX);
      set("ParamAngleY", headY);
      set("ParamAngleZ", headZ);

      // ── Body sway — follows head but damped + delayed ───────────────────
      const bodyX = Math.sin(t * 0.34 + s1 + 0.4) * 2.2 + Math.sin(t * 0.71 + s3) * 0.6;
      const bodyY = Math.sin(t * 0.22 + s2 + 0.6) * 1.4;
      const bodyZ = Math.sin(t * 0.17 + s1 + 0.8) * 1.8;
      set("ParamBodyAngleX", bodyX);
      set("ParamBodyAngleY", bodyY);
      set("ParamBodyAngleZ", bodyZ);

      // ── Breathing ───────────────────────────────────────────────────────
      const breathe = 0.5 + Math.sin(t * 0.48 + s2) * 0.5;
      set("ParamBreath", breathe);

      // ── Hair physics simulation (layered oscillation) ───────────────────
      const hairSwing = Math.sin(t * 0.52 + s1) * 0.28 + Math.sin(t * 1.1 + s3) * 0.08;
      set("ParamHairFront", hairSwing);
      set("ParamHairSide",  hairSwing * 0.8 + Math.sin(t * 0.67 + s2) * 0.12);
      set("ParamHairBack",  Math.sin(t * 0.44 + s3) * 0.22);

      // ── Eyebrow subtle movement ──────────────────────────────────────────
      const browMicro = Math.sin(t * 0.73 + s2) * 0.08;
      set("ParamBrowLY", browMicro);
      set("ParamBrowRY", browMicro * 0.9);

      // ── Auto blink ───────────────────────────────────────────────────────
      if (blinkState.current === "open") {
        // Random interval 2-6 seconds (in ticks at 60fps = 120-360)
        if (blinkTimer.current > 120 + Math.random() * 240) {
          blinkTimer.current = 0;
          blinkState.current = "closing";
          blinkProg.current  = 0;
        }
        set("ParamEyeLOpen", 1);
        set("ParamEyeROpen", 1);
      } else if (blinkState.current === "closing") {
        blinkProg.current = Math.min(1, blinkProg.current + 0.22);
        const v = 1 - blinkProg.current;
        set("ParamEyeLOpen", v);
        set("ParamEyeROpen", v);
        if (blinkProg.current >= 1) { blinkState.current = "opening"; blinkProg.current = 0; }
      } else {
        blinkProg.current = Math.min(1, blinkProg.current + 0.16);
        set("ParamEyeLOpen", blinkProg.current);
        set("ParamEyeROpen", blinkProg.current);
        if (blinkProg.current >= 1) { blinkState.current = "open"; blinkTimer.current = 0; }
      }

      // ── Lip sync — ONLY when TTS is speaking ────────────────────────────
      if (isTalkingRef.current) {
        // Phoneme-style mouth: bursts at syllable rhythm (~4–6 Hz)
        // We layer two frequencies to avoid mechanical feel
        const syllable =
          Math.abs(Math.sin(mouthPhase.current * 5.2)) * 0.7 +
          Math.abs(Math.sin(mouthPhase.current * 3.7 + 0.9)) * 0.3;

        // Smooth target
        mouthTarget.current  = Math.min(1, syllable * 1.1);
        mouthCurrent.current = mouthCurrent.current + (mouthTarget.current - mouthCurrent.current) * 0.35;
        set("ParamMouthOpenY", Math.max(0, mouthCurrent.current));
      } else {
        // Smoothly close mouth
        mouthCurrent.current = mouthCurrent.current * 0.75;
        set("ParamMouthOpenY", Math.max(0, mouthCurrent.current));
      }
    });
  }

  // ─── Eye tracking via mouse / touch ──────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      const model = modelRef.current as any;
      if (!model) return;
      const cx = "touches" in e ? (e.touches[0]?.clientX ?? 0) : (e as MouseEvent).clientX;
      const cy = "touches" in e ? (e.touches[0]?.clientY ?? 0) : (e as MouseEvent).clientY;
      try {
        const core = model?.internalModel?.coreModel;
        if (!core?.setParameterValueById) return;
        const dx = (cx / window.innerWidth)  * 2 - 1;
        const dy = (cy / window.innerHeight) * 2 - 1;
        core.setParameterValueById("ParamEyeBallX",  dx *  0.85);
        core.setParameterValueById("ParamEyeBallY",  dy * -0.55);
      } catch {}
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
    };
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
});

Live2DViewer.displayName = "Live2DViewer";
export default memo(Live2DViewer);
