# Huohuo — AI VTuber (siap Vercel)

Deploy: import repo/folder ke Vercel → preset **Vite** terdeteksi otomatis (build `npm run build`, output `dist`).
Tidak perlu environment variable. Opsional: `AI_API_URL` untuk mengganti endpoint AI di `api/chat.js`.

- `npm install` → `npm run dev` untuk lokal.
- `/api/chat` = proxy serverless ke API AI. Jika tidak tersedia (hosting statis), klien otomatis memanggil API langsung.
- Tekstur model: WebP lossless (piksel + alpha identik dengan PNG asli).
