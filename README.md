# skills-chat

Chat full-stack em Node.js com login local, estado por usuario, workspace isolada, jobs de chat no backend, approvals server-side e frontend parcialmente modularizado.

O projeto saiu do estado de prototipo inseguro, mas ainda esta em transicao arquitetural. A base atual e utilizavel para desenvolvimento serio, porem ainda nao deve ser descrita como backend-first completo.

## Visao Geral

- backend em Node HTTP sem framework
- autenticacao local por cookie `HttpOnly`
- sessao persistida em disco
- estado do usuario persistido e sanitizado
- filesystem isolado por usuario
- chat Gemini e Codex com jobs no backend
- approvals reais para operacoes sensiveis
- `exec` desligado por padrao
- TTS via proxy backend
- frontend modularizado em `public/app/*`, mas `public/index.html` ainda concentra parte da UI

## Estado Atual

O estado atual mais honesto da base e:

- fases 0 a 3: concluidas e validadas
- fase 5 backend: concluida
- fase 5 frontend: muito avancada, mas ainda nao 100% encerrada
- fase 6: ainda nao iniciada
- fase 7: ainda nao iniciada

Em especial:

- o backend ja e autoridade real para credenciais, approvals, filesystem, exec e jobs
- o frontend ja saiu do monolito total, mas ainda nao foi completamente fatiado
- ainda existe execucao dinamica client-side em plugins `code`, atras de flag

## Estrutura

### Backend

Modulos atuais em `server/`:

- [server/http/utils.js](E:\CODEX-testing\chat\skillflow-chat\server\http\utils.js)
- [server/auth/session.js](E:\CODEX-testing\chat\skillflow-chat\server\auth\session.js)
- [server/state/index.js](E:\CODEX-testing\chat\skillflow-chat\server\state\index.js)
- [server/filesystem/index.js](E:\CODEX-testing\chat\skillflow-chat\server\filesystem\index.js)
- [server/system-prompts/index.js](E:\CODEX-testing\chat\skillflow-chat\server\system-prompts\index.js)
- [server/approvals/index.js](E:\CODEX-testing\chat\skillflow-chat\server\approvals\index.js)
- [server/exec/index.js](E:\CODEX-testing\chat\skillflow-chat\server\exec\index.js)
- [server/chat/codex.js](E:\CODEX-testing\chat\skillflow-chat\server\chat\codex.js)
- [server/chat/gemini.js](E:\CODEX-testing\chat\skillflow-chat\server\chat\gemini.js)
- [server/chat/jobs.js](E:\CODEX-testing\chat\skillflow-chat\server\chat\jobs.js)

Entrypoint:

- [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)

### Frontend

Modulos atuais em `public/app/`:

- [public/app/storage-sync.js](E:\CODEX-testing\chat\skillflow-chat\public\app\storage-sync.js)
- [public/app/api-client.js](E:\CODEX-testing\chat\skillflow-chat\public\app\api-client.js)
- [public/app/jobs.js](E:\CODEX-testing\chat\skillflow-chat\public\app\jobs.js)
- [public/app/chat.js](E:\CODEX-testing\chat\skillflow-chat\public\app\chat.js)
- [public/app/live.js](E:\CODEX-testing\chat\skillflow-chat\public\app\live.js)
- [public/app/tts.js](E:\CODEX-testing\chat\skillflow-chat\public\app\tts.js)
- [public/app/ui-render.js](E:\CODEX-testing\chat\skillflow-chat\public\app\ui-render.js)

Arquivos principais:

- [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- [public/account.js](E:\CODEX-testing\chat\skillflow-chat\public\account.js)
- [public/mobile.css](E:\CODEX-testing\chat\skillflow-chat\public\mobile.css)

## Rotas Principais

### Auth

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`

### Estado e runtime

- `GET /health`
- `GET /api/state`
- `POST /api/state`
- `GET /api/runtime-config`
- `GET /api/credentials`
- `POST /api/credentials`

### Chat

- `POST /api/chat`
- `POST /api/chat/jobs`
- `GET /api/chat/jobs/:id`

### Filesystem

- `GET /api/fs/list`
- `GET /api/fs/read`
- `GET /api/fs/download`
- `POST /api/fs/write`
- `POST /api/fs/mkdir`
- `POST /api/fs/rename`
- `DELETE /api/fs/delete`

### Prompts

- `GET /api/system-prompts`
- `POST /api/system-prompts`
- `DELETE /api/system-prompts/:scope/:id`

### Approvals

- `GET /api/approvals`
- `POST /api/approvals`
- `GET /api/approvals/:id`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`
- `POST /api/approvals/:id/revoke`

### Exec e TTS

- `GET /api/exec`
- `GET /api/exec/history`
- `POST /api/exec`
- `GET /api/tts/health`
- `GET /api/tts/voices`
- `POST /api/tts/speak`

## Seguranca Atual

### Feito

- `exec` desligado por padrao
- approvals reais no backend
- deletes sensiveis e integracoes externas exigem approval
- grants por conversa com expiracao
- prompts privados isolados por usuario
- sessao persistida em disco
- estado salvo sanitiza restos sensiveis
- credenciais Gemini/Codex/TTS nao ficam mais persistidas no navegador como antes
- path traversal bloqueado nas rotas de filesystem

### Ainda pendente

- plugins `code` ainda existem atras de flag
- o loop completo de tool calling ainda nao vive 100% no backend
- ainda faltam testes automatizados de verdade
- ainda faltam limites operacionais e observabilidade da fase 7

## Flags de Ambiente

- `SKILLFLOW_EXEC_ENABLED=true`
  Libera `POST /api/exec`. O padrao e desligado.

- `SKILLFLOW_EXEC_ALLOW_SHELL=true`
  Permite shell em exec. Nao recomendado fora de ambiente controlado.

- `SKILLFLOW_EXEC_ALLOWED_BINS=node,npm,python,python3,bash,sh`
  Allowlist de binarios para `exec`.

- `SKILLFLOW_ENABLE_CLIENT_CODE_PLUGINS=true`
  Libera plugins client-side com execucao dinamica. O padrao e desligado.

- `SKILLFLOW_ENABLE_LIVE_CLIENT=true`
  Libera o fluxo Live direto do navegador. O padrao e desligado.

- `SKILLFLOW_TTS_API_URL`
  Endpoint do provider TTS.

- `SKILLFLOW_TTS_SECRET`
  Segredo do provider TTS usado apenas no backend.

- `SKILLFLOW_CODEX_DEFAULT_INSTRUCTIONS`
  Instrucoes padrao do Codex no backend.

- `GEMINI_API_KEY`
  Chave default do Gemini no backend.

## Rodando

```bash
npm start
```

Servidor padrao:

- app: `http://127.0.0.1:9321/`
- login: `http://127.0.0.1:9321/login`
- health: `http://127.0.0.1:9321/health`

## Smoke

```bash
npm run smoke:baseline
```

O baseline atual valida:

- `GET /health`
- `signup/login/logout`
- `GET /auth/me`
- escrita e listagem em workspace
- criacao de prompt
- isolamento entre prompt privado e compartilhado
- sessao persistente entre requests e apos restart
- `POST /api/exec` bloqueado por padrao
- lifecycle basico de approvals
- delete sem approval bloqueado
- delete com approval aprovado
- grant de conversa reutilizavel por 24h
- integracao externa sem approval bloqueada

Smokes opt-in:

- chat: `SMOKE_ENABLE_CHAT=1`
- tts: `SMOKE_ENABLE_TTS=1`
- exec com approval: `SMOKE_ENABLE_EXEC_APPROVAL=1` junto com `SKILLFLOW_EXEC_ENABLED=true`

## Documentacao

- arquitetura atual: [docs/ARQUITETURA_ATUAL.md](E:\CODEX-testing\chat\skillflow-chat\docs\ARQUITETURA_ATUAL.md)
- seguranca e operacao: [docs/SEGURANCA_E_OPERACAO.md](E:\CODEX-testing\chat\skillflow-chat\docs\SEGURANCA_E_OPERACAO.md)
- status e roadmap: [docs/STATUS_ATUAL_E_ROADMAP.md](E:\CODEX-testing\chat\skillflow-chat\docs\STATUS_ATUAL_E_ROADMAP.md)
- baseline de smoke: [docs/SMOKE_BASELINE.md](E:\CODEX-testing\chat\skillflow-chat\docs\SMOKE_BASELINE.md)
- roadmap backend-first: [docs/BACKEND_FIRST_ROADMAP.md](E:\CODEX-testing\chat\skillflow-chat\docs\BACKEND_FIRST_ROADMAP.md)

## Linha Honesta

Esta branch esta muito mais segura e organizada do que a base original, mas a descricao correta hoje e:

- base saneada
- backend forte
- frontend em transicao controlada
- ainda nao backend-first completo
- ainda nao fase 6/7 concluida
