# skills-chat

Chat full-stack em Node com login local, estado por usuario, workspace isolada e runtime de chat integrado ao backend.

## Rodando

```bash
npm start
```

Servidor padrao:

- app: `http://127.0.0.1:9321/`
- login: `http://127.0.0.1:9321/login`
- health: `http://127.0.0.1:9321/health`

## Estado Atual da Base

- auth local por cookie em `/auth/*`
- estado do usuario em `/api/state`
- filesystem por usuario em `/api/fs/*`
- chat Gemini/Codex com jobs em `/api/chat` e `/api/chat/jobs/*`
- prompts em `/api/system-prompts`
- credenciais de provedor salvas no servidor em `/api/credentials`
- runtime config do cliente em `/api/runtime-config`
- TTS via proxy backend em `/api/tts/*`

## Hardening da Fase 1

- `POST /api/exec` fica desligado por padrao
- plugins com `code` ficam bloqueados por padrao no cliente
- Gemini, Codex e TTS nao dependem mais de segredo persistido no navegador
- `localStorage`, `pendingRequest` e `resumeState` nao carregam mais `api_key` ou `auth`
- Live client continua desabilitado por padrao

## Flags de Ambiente

- `SKILLFLOW_EXEC_ENABLED=true`
  Libera `POST /api/exec`. O padrao e desligado.

- `SKILLFLOW_ENABLE_CLIENT_CODE_PLUGINS=true`
  Libera plugins client-side com `new Function(...)`. O padrao e desligado.

- `SKILLFLOW_ENABLE_LIVE_CLIENT=true`
  Libera o fluxo Live direto do navegador. O padrao e desligado.

- `GEMINI_API_KEY`
  API key padrao do Gemini no backend.

- `SKILLFLOW_TTS_API_URL`
  Endpoint do provider TTS.

- `SKILLFLOW_TTS_SECRET`
  Segredo do provider TTS usado apenas no backend.

## Smoke

```bash
npm run smoke:baseline
```

Checks atuais:

- `GET /health`
- `signup/login/logout`
- `GET /auth/me`
- criar e listar arquivo na workspace
- criar prompt
- `POST /api/exec` bloqueado por padrao
- validar sessao entre requests

Smokes externos continuam opt-in:

- chat: `SMOKE_ENABLE_CHAT=1`
- tts: `SMOKE_ENABLE_TTS=1`
