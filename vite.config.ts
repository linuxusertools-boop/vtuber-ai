import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { existsSync } from "node:fs";

// Vercel: base "/" dan output ke "dist" (default preset Vite).
// GitHub Pages / hosting subfolder: jalankan `npm run build:gh-pages` (BASE_PATH='./').
// Rute npm untuk three/three-vrm. Bila belum terpasang → alias ke stub (build tetap sukses, runtime pakai CDN).
const npmOk =
  existsSync(fileURLToPath(new URL("./node_modules/three/build/three.module.js", import.meta.url))) &&
  existsSync(fileURLToPath(new URL("./node_modules/@pixiv/three-vrm/package.json", import.meta.url)));
const stub = fileURLToPath(new URL("./src/vrm/libs.stub.ts", import.meta.url));
if (!npmOk) console.warn("[yuki] three/@pixiv/three-vrm belum terpasang → jalankan `npm install`. Sementara memakai CDN.");
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      ...(npmOk ? [] : [{ find: /^three(\/.*)?$/, replacement: stub }, { find: /^@pixiv\/three-vrm$/, replacement: stub }]),
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
  server: { port, strictPort: !!process.env.PORT, host: "0.0.0.0", allowedHosts: true },
  preview: { port, host: "0.0.0.0", allowedHosts: true },
});
