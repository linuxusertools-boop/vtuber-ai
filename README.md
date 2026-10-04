# Huohuo — AI VTuber (siap Vercel)

Deploy: import ke Vercel → preset **Vite** terdeteksi otomatis (build `npm run build`, output `dist`). Tanpa environment variable.

- **AI**: `https://kev-ai.vercel.app/ai?text={text}` (lewat proxy `/api/chat`, fallback langsung)
- **Suara**: `https://kev-tts.vercel.app/animemoe?text={text}` (lewat proxy `/api/tts`, fallback langsung, lalu suara bawaan browser, lalu tanpa suara)
- Alur: pesan → AI → suara siap → **teks & suara mulai bersamaan**
- Opsional: `AI_API_URL` / `TTS_API_URL` untuk mengganti endpoint di `api/*.js`

`npm install` → `npm run dev` untuk lokal. Tema 100% hitam putih (model Live2D diberi `filter: grayscale(1)` di `.live2d-wrapper`; hapus baris itu bila ingin berwarna).
