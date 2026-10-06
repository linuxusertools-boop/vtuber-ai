// @ts-nocheck — three.js & three-vrm dimuat dinamis (code-split); tipe diabaikan di file ini.
import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, memo } from "react";
import { askAI, getYukiConfig } from "@/lib/api";
import { audioTime } from "@/lib/audio";
import type { Envelope } from "@/lib/lipsync";
import { Animator } from "@/vrm/animator";
import { Rig } from "@/vrm/rig";
import { buildSubagentPrompt, fallbackForMood, isNoGesture, resolveLocal, validateAgentJson } from "@/vrm/director";
import { createStage, type Quality } from "@/vrm/stage";
import { loadLibs } from "@/vrm/loader";

export interface VRMViewerHandle {
  setExpression: (mood: string) => void;
  startTalking: (env?: Envelope | null) => void;
  stopTalking: () => void;
  /** Jalankan {gerakan} dari AI lewat sub-agent. holdSec = lama bicara. */
  perform: (gesture: string, holdSec?: number) => void;
}
interface Props {
  onLoad?: () => void;
  onError?: (why?: string) => void;
  onProgress?: (pct: number) => void;
}

const BONES = [
  "hips", "spine", "chest", "upperChest", "neck", "head", "leftEye", "rightEye",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand", "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes", "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
  ...["left", "right"].flatMap((s) => [
    ...["Index", "Middle", "Ring", "Little"].flatMap((f) => ["Proximal", "Intermediate", "Distal"].map((p) => s + f + p)),
    s + "ThumbMetacarpal", s + "ThumbProximal", s + "ThumbDistal",
  ]),
];
// posisi kamera sebagai pecahan tinggi badan: c = titik pandang, span = tinggi yang terlihat, w = lebar min
const SHOTS = { close: { c: 0.8, span: 0.5, w: 0.42 }, mid: { c: 0.7, span: 0.8, w: 0.64 }, full: { c: 0.54, span: 1.22, w: 0.95 } };
const FOV = 26;

const cfgNum = (o: any, k: string, d: number) => (o && typeof o[k] === "number" && isFinite(o[k]) ? o[k] : d);

const VRMViewer = forwardRef<VRMViewerHandle, Props>(({ onLoad, onError, onProgress }, ref) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<Animator | null>(null);
  const moodRef = useRef("Senang");
  const seqRef = useRef(0);
  const cbRef = useRef({ onLoad, onError, onProgress });
  cbRef.current = { onLoad, onError, onProgress };

  const setExpression = useCallback((mood: string) => {
    moodRef.current = mood;
    animRef.current?.setMood(mood);
  }, []);
  const startTalking = useCallback((env?: Envelope | null) => {
    animRef.current?.startSpeech(env ?? null, audioTime);
  }, []);
  const stopTalking = useCallback(() => {
    animRef.current?.stopSpeech();
  }, []);
  const perform = useCallback((gesture: string, holdSec = 0) => {
    const an = animRef.current;
    if (!an) return;
    const seq = ++seqRef.current;
    try {
      if (isNoGesture(gesture)) {
        an.releaseAll(false);
        return;
      }
      const plan = resolveLocal(gesture);
      if (plan.items.length && plan.confidence >= 0.55) {
        an.play(plan, holdSec);
        return;
      }
      // tak dikenali → langsung beri gerakan cadangan sesuai mood, lalu minta sub-agent AI menyusun yang tepat
      const fb = fallbackForMood(moodRef.current, gesture.length);
      if (fb) an.playDef(fb, holdSec);
      getYukiConfig().then(async (cfg) => {
        const m = (cfg as any).motion;
        if (!m || m.subagent === false) return;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), cfgNum(m, "timeoutMs", 7000));
        try {
          const text = await askAI(buildSubagentPrompt(gesture), ctrl.signal);
          const def = validateAgentJson(text, gesture);
          if (def && seq === seqRef.current && animRef.current) animRef.current.playDef(def, holdSec);
        } catch {
          /* sub-agent gagal → gerakan cadangan/idle tetap berjalan */
        } finally {
          clearTimeout(timer);
        }
      });
    } catch {
      /* gerakan tidak boleh menjatuhkan chat */
    }
  }, []);
  useImperativeHandle(ref, () => ({ setExpression, startTalking, stopTalking, perform }), [setExpression, startTalking, stopTalking, perform]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;
    let renderer: any = null;
    let vrm: any = null;
    let stage: any = null;
    let T: any = null;
    let lostTimer = 0;
    const cleanups: (() => void)[] = [];
    let finished = false;
    const fail = (why?: string) => {
      if (disposed || finished) return;
      finished = true;
      const msg = why || "tidak diketahui";
      console.warn("[VRM] gagal:", msg);
      (window as any).__VRM_ERROR__ = msg;
      cbRef.current.onError?.(msg);
    };
    // timeout LUNAK: tampilkan cadangan tapi terus memuat; bila selesai kemudian, VRM menggantikannya
    const watchdog = window.setTimeout(() => { if (!finished && !disposed) cbRef.current.onError?.("memuat model 3D lebih lama dari biasanya… tetap menunggu"); }, 30000);
    cleanups.push(() => clearTimeout(watchdog));

    (async () => {
      try {
        if (!(window as any).__HAS_WEBGL__) return fail("WebGL tidak tersedia");
        const cfg: any = await getYukiConfig();
        const sc = cfg.scene ?? {};
        const base = import.meta.env.BASE_URL || "/";
        let url = String(cfg.model?.url || "/model/lilya/lilya_hat.vrm");
        if (url.startsWith("/") && base !== "/") url = base + url.slice(1);
        const { THREE, GLTFLoader, V } = await loadLibs();
        if (disposed) return;
        T = THREE;

        // ── renderer ──
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none";
        host.appendChild(canvas);
        cleanups.push(() => canvas.remove());
        const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 700;
        const weak = (navigator.hardwareConcurrency || 8) <= 4;
        let quality: Quality = ["high", "mid", "low"].includes(sc.quality) ? sc.quality : mobile ? (weak ? "low" : "mid") : "high";
        renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== "low", alpha: true, powerPreference: "high-performance", premultipliedAlpha: true });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setClearColor(0x000000, 0);
        let pr = Math.min(window.devicePixelRatio || 1, quality === "high" ? 2 : quality === "mid" ? 1.6 : 1.1);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 40);
        const size = { w: 1, h: 1 };
        const resize = () => {
          const w = Math.max(1, host.clientWidth);
          const h = Math.max(1, host.clientHeight);
          size.w = w; size.h = h;
          renderer.setPixelRatio(pr);
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          stage?.setViewportHeight(h * pr);
        };
        const ro = new ResizeObserver(resize);
        ro.observe(host);
        cleanups.push(() => ro.disconnect());

        // ── model ──
        const loader = new GLTFLoader();
        loader.register((p: any) => new V.VRMLoaderPlugin(p));
        // Unduh sendiri (progres akurat) + validasi: host SPA kadang membalas index.html (200) untuk file yang hilang
        const abs = (u: string) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
        const cands = Array.from(new Set([abs(url), abs("model/lilya/lilya_hat.vrm"), abs("/model/lilya/lilya_hat.vrm")]));
        const expected = cfgNum(cfg.model, "bytes", 16545640);
        const fetchModel = async (): Promise<ArrayBuffer> => {
          const errs: string[] = [];
          for (const u of cands) {
            for (let attempt = 0; attempt < 2; attempt++) {
              if (disposed) throw new Error("dibatalkan");
              const ctrl = new AbortController();
              const to = window.setTimeout(() => ctrl.abort(), 150000);
              try {
                const r = await fetch(u, { signal: ctrl.signal, cache: "force-cache" });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const total = Number(r.headers.get("content-length")) || expected;
                const chunks: Uint8Array[] = [];
                let got = 0;
                if (r.body && r.body.getReader) {
                  const rd = r.body.getReader();
                  for (;;) {
                    const { done, value } = await rd.read();
                    if (done) break;
                    chunks.push(value); got += value.length;
                    cbRef.current.onProgress?.(Math.min(95, Math.round((got / total) * 95)));
                  }
                } else {
                  const ab = await r.arrayBuffer(); chunks.push(new Uint8Array(ab)); got = ab.byteLength;
                }
                const buf = new Uint8Array(got);
                let off = 0;
                for (const c of chunks) { buf.set(c, off); off += c.length; }
                const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
                if (magic !== "glTF" || got < 4096) throw new Error(`bukan file VRM/GLB (diterima ${got} byte, awal "${magic.replace(/[^\x20-\x7e]/g, "?")}")`);
                return buf.buffer;
              } catch (e: any) {
                errs.push(`${u.replace(location.origin, "")}: ${e?.message ?? e}`);
              } finally {
                clearTimeout(to);
              }
            }
          }
          throw new Error("file model tidak bisa diunduh → " + errs.join(" | "));
        };
        const parse = (buf: ArrayBuffer) => new Promise<any>((res, rej) => loader.parse(buf, "", res, rej));
        const gltf: any = await parse(await fetchModel());
        if (disposed) { try { V.VRMUtils.deepDispose(gltf.scene); } catch { /* */ } return; }
        vrm = gltf.userData.vrm;
        if (!vrm) throw new Error("bukan file VRM");
        try { V.VRMUtils.removeUnnecessaryVertices?.(gltf.scene); } catch { /* opsional */ }
        try { V.VRMUtils.rotateVRM0?.(vrm); } catch { /* opsional */ }
        vrm.scene.traverse((o: any) => { o.frustumCulled = false; });
        scene.add(vrm.scene);
        if (vrm.lookAt) { try { vrm.lookAt.autoUpdate = false; vrm.lookAt.target = null; } catch { /* */ } }

        // ── kalibrasi rig dari skeleton model ──
        vrm.scene.updateMatrixWorld(true);
        const root = vrm.humanoid.normalizedHumanBonesRoot;
        root.updateWorldMatrix(true, false);
        const nodes: Record<string, any> = {};
        const restWorld: Record<string, [number, number, number]> = {};
        const tmp = new THREE.Vector3();
        for (const b of BONES) {
          const n = vrm.humanoid.getNormalizedBoneNode(b);
          if (!n) continue;
          nodes[b] = n;
          n.getWorldPosition(tmp);
          root.worldToLocal(tmp);
          restWorld[b] = [tmp.x, tmp.y, tmp.z];
        }
        if (!nodes.hips || !nodes.head) throw new Error("humanoid tidak lengkap");
        const restHips = nodes.hips.position.clone();
        // tinggi & lantai dari TULANG (Box3 pada skinned mesh bisa meleset); Box3 hanya cadangan
        const ys = (n: string) => restWorld[n]?.[1];
        const feet = ["leftFoot", "rightFoot", "leftToes", "rightToes"].map(ys).filter((v) => typeof v === "number") as number[];
        let floorY = feet.length ? Math.min(...feet) - 0.03 : 0;
        let H = Math.max(0.5, ((ys("head") ?? 1.4) - floorY) * 1.14);
        const useBox = () => {
          const box = new THREE.Box3().setFromObject(vrm.scene);
          const hh = box.max.y - box.min.y;
          if (isFinite(hh) && hh > 0.3 && hh < 6) { H = hh; floorY = box.min.y; if (stage?.group) stage.group.position.y = floorY; }
        };
        if (!isFinite(H) || H < 0.5 || H > 4) useBox();
        const rig = new Rig(restWorld);
        const anim = new Animator(rig);
        anim.setMood(moodRef.current, true);
        animRef.current = anim;

        const mkStage = (qq: Quality, k = 1) => {
          try {
            return createStage(THREE, scene, {
              quality: qq,
              light: cfgNum(sc, "light", 1),
              mist: cfgNum(sc, "mist", 1) * k,
              rays: cfgNum(sc, "rays", 1) * k,
              particles: cfgNum(sc, "particles", 1) * k,
            });
          } catch (e) {
            // efek gagal → karakter tetap tampil dengan pencahayaan dasar
            console.warn("[VRM] efek panggung dimatikan:", e);
            const grp = new THREE.Group();
            const hemi = new THREE.HemisphereLight(0xdfe6ff, 0x4a3f5e, 1.1);
            const dl = new THREE.DirectionalLight(0xfff1dc, 1.8);
            dl.position.set(-0.8, 2.2, 1.6);
            const rm = new THREE.DirectionalLight(0x9fb8ff, 1.2);
            rm.position.set(1.4, 1.6, -1.8);
            grp.add(hemi, dl, rm);
            scene.add(grp);
            return { group: grp, setViewportHeight() {}, update() {}, dispose() { scene.remove(grp); } };
          }
        };
        stage = mkStage(quality);
        stage.group.position.y = floorY;
        resize();

        // ── input pointer → tatapan ──
        const onMove = (e: PointerEvent) => {
          const r = host.getBoundingClientRect();
          anim.setPointer(((e.clientX - (r.left + r.width / 2)) / (r.width / 2)), -((e.clientY - (r.top + r.height * 0.35)) / (r.height / 2)));
        };
        window.addEventListener("pointermove", onMove, { passive: true });
        cleanups.push(() => window.removeEventListener("pointermove", onMove));

        // ── context loss: jeda & pulih, kalau gagal → fallback avatar CSS ──
        const onLost = (e: Event) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; lostTimer = window.setTimeout(() => fail("konteks WebGL hilang"), 5000); };
        const onRestored = () => { clearTimeout(lostTimer); if (!raf && !disposed) { last = performance.now(); raf = requestAnimationFrame(frame); } };
        canvas.addEventListener("webglcontextlost", onLost);
        canvas.addEventListener("webglcontextrestored", onRestored);
        cleanups.push(() => { canvas.removeEventListener("webglcontextlost", onLost); canvas.removeEventListener("webglcontextrestored", onRestored); clearTimeout(lostTimer); });

        // ── kamera (spring halus + drift kecil seperti kamera dipegang) ──
        const cam = { y: H * SHOTS.mid.c, d: 3, y0: 0 };
        const camSpring = { y: { x: cam.y, v: 0 }, d: { x: 3, v: 0 } };
        const offsetY = cfgNum(sc, "offsetY", 0.05);
        const tanHalf = Math.tan((FOV * Math.PI) / 360);
        const springTo = (s: any, target: number, om: number, dt: number) => {
          const f = 1 + 2 * dt * om; const hoo = dt * om * om; const det = 1 / (f + dt * hoo);
          const nx = (f * s.x + dt * s.v + dt * hoo * target) * det; const nv = (s.v + hoo * (target - s.x)) * det;
          s.x = isFinite(nx) ? nx : target; s.v = isFinite(nv) ? nv : 0;
        };
        let pxs = 0, pys = 0;

        let last = performance.now();
        let slow = 0, frames = 0, tAcc = 0, downgraded = 0;
        const hipsPos = new THREE.Vector3();
        let blankChecks = 0;
        let nFrames = 0;
        let warned = false;
        const probeOpaque = (): boolean => {
          try {
            const gl = renderer.getContext();
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const px = new Uint8Array(4 * h);
            gl.readPixels(Math.floor(w / 2), 0, 1, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            for (let i = 3; i < px.length; i += 4) if (px[i] > 200) return true;
            return false;
          } catch {
            return true; // tidak bisa memeriksa → anggap baik
          }
        };
        const frame = (now: number) => {
          raf = requestAnimationFrame(frame);
          if (disposed) return;
          const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000));
          last = now;
          tAcc += dt;
          let shot = "mid";
          let voice = 0;
          // 1) animasi — kegagalan di sini TIDAK boleh menghentikan render
          try {
            const out = anim.update(dt);
            shot = out.shot;
            voice = out.voice;
            for (const k in out.rig.quats) {
              const n = nodes[k];
              const q = out.rig.quats[k];
              if (n && q) n.quaternion.set(q.x, q.y, q.z, q.w);
            }
            const h = out.rig.hips;
            nodes.hips.position.set(restHips.x + h[0], restHips.y + h[1], restHips.z + h[2]);
            const em = vrm.expressionManager;
            if (em) for (const k in out.expr) { try { em.setValue(k, out.expr[k]); } catch { /* ekspresi tak ada di model */ } }
          } catch (e) {
            if (!warned) { warned = true; console.warn("[VRM] animasi error (karakter tetap dirender):", e); }
          }
          try { vrm.update(Math.min(dt, 1 / 30)); } catch { /* spring bone */ }
          try { stage.update(tAcc, voice); } catch { /* efek */ }
          // 2) kamera
          try {
            const s = SHOTS[shot] ?? SHOTS.mid;
            const aspect = size.w / size.h;
            const dist = Math.max((s.span * H) / 2 / tanHalf, (s.w * H) / aspect / 2 / tanHalf);
            const ty = floorY + H * s.c - s.span * H * (aspect < 0.85 ? offsetY * 1.6 : offsetY);
            springTo(camSpring.y, ty, 3.2, dt);
            springTo(camSpring.d, dist, 3.2, dt);
            pxs += (Math.sin(tAcc * 0.13) * 0.012 - pxs) * 0.02;
            pys += (Math.sin(tAcc * 0.17 + 1) * 0.008 - pys) * 0.02;
            camera.position.set(pxs, camSpring.y.x + pys, camSpring.d.x);
            camera.lookAt(0, camSpring.y.x - 0.01 + pys * 0.5, 0);
          } catch { /* kamera tetap di posisi terakhir */ }
          // 3) render
          try {
            renderer.render(scene, camera);
          } catch (e) {
            if (!warned) { warned = true; console.warn("[VRM] render error:", e); }
            return;
          }
          nFrames++;
          // 4) deteksi canvas kosong: karakter opak harus ada di kolom tengah
          if ((nFrames === 50 || nFrames === 140) && !document.hidden) {
            if (!probeOpaque()) {
              blankChecks++;
              if (blankChecks === 1) {
                useBox(); // coba framing cadangan berbasis bounding box
                camSpring.d.x = H * 2.2; camSpring.y.x = floorY + H * 0.6;
              } else {
                fail("render kosong (karakter tak terlihat)");
              }
            }
          }
          // 5) adaptif: turunkan kualitas bila lambat terus
          frames++;
          if (dt > 0.034) slow++;
          if (frames >= 120) {
            if (slow > 70 && downgraded < 2) {
              downgraded++;
              pr = Math.max(0.85, pr * 0.78);
              if (downgraded === 2 && quality !== "low") {
                quality = "low";
                try { stage.dispose(); } catch { /* */ }
                stage = mkStage(quality, 0.7);
                if (stage.group?.position) stage.group.position.y = floorY;
              }
              resize();
            }
            frames = 0; slow = 0;
          }
        };
        const onVis = () => {
          if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
          else if (!raf && !disposed) { last = performance.now(); raf = requestAnimationFrame(frame); }
        };
        document.addEventListener("visibilitychange", onVis);
        cleanups.push(() => document.removeEventListener("visibilitychange", onVis));

        // render pertama sebelum menandai selesai → tidak ada kedipan kosong
        frame(performance.now());
        clearTimeout(watchdog);
        cbRef.current.onProgress?.(100);
        cbRef.current.onLoad?.();
      } catch (e) {
        fail(String((e as any)?.message ?? e));
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      animRef.current = null;
      for (const c of cleanups) { try { c(); } catch { /* */ } }
      try { stage?.dispose(); } catch { /* */ }
      try { if (vrm) (window as any).__vrmUtils?.deepDispose?.(vrm.scene); } catch { /* */ }
      try {
        vrm?.scene?.traverse((o: any) => {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (const m of mats) { for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose?.(); }
        });
      } catch { /* */ }
      try { renderer?.dispose(); renderer?.forceContextLoss?.(); } catch { /* */ }
    };
  }, []);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
});
VRMViewer.displayName = "VRMViewer";
export default memo(VRMViewer);
