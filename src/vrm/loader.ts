// Pemuat three.js + three-vrm dari CDN saat runtime (tanpa `npm install`, tanpa bundling).
// Mengapa: tidak ada lagi kegagalan build/dependensi hilang yang membuat karakter tak muncul.
// Dicoba berurutan; satu set CDN harus konsisten (satu instance three untuk semua modul).
const THREE_VER = "0.170.0";
const SETS = [
  {
    name: "esm.sh",
    three: `https://esm.sh/three@${THREE_VER}`,
    gltf: `https://esm.sh/three@${THREE_VER}/examples/jsm/loaders/GLTFLoader.js`,
    vrm: `https://esm.sh/@pixiv/three-vrm@3?deps=three@${THREE_VER}`,
  },
  {
    name: "jsdelivr",
    three: `https://cdn.jsdelivr.net/npm/three@${THREE_VER}/+esm`,
    gltf: `https://cdn.jsdelivr.net/npm/three@${THREE_VER}/examples/jsm/loaders/GLTFLoader.js/+esm`,
    vrm: `https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3/+esm`,
  },
];

export interface Libs {
  THREE: any;
  GLTFLoader: any;
  V: any;
  from: string;
}

const dyn = (u: string): Promise<any> => import(/* @vite-ignore */ u);
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${what}`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });

let cached: Promise<Libs> | null = null;
export function loadLibs(): Promise<Libs> {
  if (cached) return cached;
  cached = (async () => {
    const errors: string[] = [];
    // Rute 1: paket npm yang di-bundle (paling andal, tanpa CDN)
    try {
      const m: any = await withTimeout(import("./libs.npm"), 30000, "npm");
      if (m?.THREE?.WebGLRenderer && m?.GLTFLoader && m?.V?.VRMLoaderPlugin) return { THREE: m.THREE, GLTFLoader: m.GLTFLoader, V: m.V, from: "npm" };
      errors.push("npm: modul tidak lengkap");
    } catch (e: any) {
      errors.push(`npm: ${e?.message ?? e}`);
    }
    for (const s of SETS) {
      try {
        const [THREE, gl, V] = await withTimeout(Promise.all([dyn(s.three), dyn(s.gltf), dyn(s.vrm)]), 25000, s.name);
        if (!THREE?.WebGLRenderer || !gl?.GLTFLoader || !V?.VRMLoaderPlugin) throw new Error("modul tidak lengkap");
        return { THREE, GLTFLoader: gl.GLTFLoader, V, from: s.name };
      } catch (e: any) {
        errors.push(`${s.name}: ${e?.message ?? e}`);
      }
    }
    cached = null; // izinkan coba ulang pada mount berikutnya
    throw new Error("pustaka 3D gagal dimuat (" + errors.join(" | ") + ")");
  })();
  return cached;
}
