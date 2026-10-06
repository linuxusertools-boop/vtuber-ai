# YUKI — Personal AI Assistant

Made by Kevsoft Studio. React + Vite, designed for Vercel deployment.

## Pages
- `/onboarding` — setup name, birthday, interests, and personal context
- `/home` — dashboard and quick actions
- `/chat` — animated assistant chat with optional voice and Live2D/CSS fallback
- `/history` — locally saved recent exchanges
- `/memory` — edit profile and preferences
- `/settings` — view runtime configuration and clear local chat history
- `/about` — Kevsoft Studio links

## Configuration
Edit `public/config.json` before deployment. The frontend fetches it at runtime.
- `aiName`: assistant display name
- `api.text` / `api.textFallback`: text AI endpoints
- `api.voice`: URL API suara, `{text}` diganti teks (default `https://kev-tts.vercel.app/animemoe?text={text}`)
- `api.voiceProxy`: proxy `/api/tts` untuk mengatasi CORS (kosongkan `""` untuk mematikan)
- `tts`: `enabled`, `timeoutMs`, `attemptTimeoutMs`, `retries`, `maxChars`
- `prompt`: assistant personality and behavior
- `appearance`, `limits`, `features`: presentation and request defaults

The text proxy can be configured with Vercel environment variable `AI_API_URL`; voice proxy with `TTS_API_URL`. Never put private API keys in `public/config.json`, because it is shipped to every visitor.

## Local development
Requires Node.js 20.19+.

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

## Privacy and limits
Onboarding/profile and chat history are stored in this browser's localStorage. The selected profile context (name, birthday, topics, about text) is included in chat prompts and sent to the configured AI endpoint when chatting. Avoid entering sensitive details. A public AI endpoint can be rate-limited or unavailable; no client can guarantee zero errors or uninterrupted upstream service.

---

## Avatar 3D VRM (lilya_hat.vrm)

- Model: `public/model/lilya/lilya_hat.vrm` (VRM 1.0, ganti lewat `model.url` di `public/config.json`).
  Lisensi model: kredit wajib "kevsoft@2026 lilya.inc", hanya untuk penulis/non-komersial pribadi — sesuai metadata VRM.
- Format balasan AI: `{mood}|{pesan}|{gerakan}` (gerakan `-` = tanpa gerakan khusus). Parser (`src/lib/parse.ts`) menerima format rusak apa pun.
- Sub-agent gerakan: `src/vrm/director.ts` (lokal, fuzzy ID/EN) + opsional LLM (`motion.subagent`) dengan validasi ketat.
- Pustaka gerakan: `src/vrm/motions.ts` (±60 gerakan + beat bicara + gerakan spontan). Tambah gerakan = tambah satu objek.
- Efek panggung dapat distel di `config.json → scene` (`quality`: auto/high/mid/low, `light`, `mist`, `rays`, `particles`, `offsetY`).
- three.js & three-vrm dimuat dari CDN saat runtime (`src/vrm/loader.ts`: esm.sh lalu jsdelivr) — tidak perlu paket npm tambahan. Perlu internet saat pertama membuka.
- Jika model gagal dimuat/render kosong, avatar CSS tampil otomatis dan alasan gagal muncul di pojok kiri bawah (juga `window.__VRM_ERROR__` di console).
