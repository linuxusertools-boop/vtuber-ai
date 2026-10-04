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
