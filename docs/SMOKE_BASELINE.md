# Baseline de Smoke - Fase 0.2

Base tecnica: `codex/test-backend-first-sync`
Branch de saneamento: `codex/refactor-hardening-foundation`

## Objetivo

Criar uma baseline minima e repetivel para detectar quebra de fluxo essencial antes de iniciar refactors e hardening mais agressivos.

## Escopo da baseline

Checklist coberto pelo smoke runner:

- `GET /health`
- `signup`
- `login`
- `logout`
- `GET /auth/me`
- criar arquivo na workspace
- listar arquivos
- criar prompt
- validar que sessao sobrevive entre requests autenticados

Checks opcionais:

- enviar mensagem no chat via `POST /api/chat/jobs`
- rodar TTS contra a API externa atual

## Runner

Script executavel:

`npm run smoke:baseline`

O script sobe `server.js`, espera o `/health`, executa o fluxo core e encerra o processo no fim.

## Variaveis opcionais

Para smoke de chat:

- `SMOKE_ENABLE_CHAT=1`
- `SMOKE_GEMINI_API_KEY`
- ou `GEMINI_API_KEY`

Para smoke de TTS:

- `SMOKE_ENABLE_TTS=1`
- `SMOKE_TTS_API`
- `SMOKE_TTS_SECRET`

Defaults atuais do runner:

- `SMOKE_PORT=9321`
- `SMOKE_TTS_API=https://apitts.ghost1.cloud`
- `SMOKE_TTS_SECRET=abelhadomato`

## Como interpretar

- `PASS`: fluxo validado
- `SKIP`: fluxo dependia de credencial ou rede externa e nao foi executado
- `FAIL`: baseline quebrou e a branch nao deve seguir para refactor sem diagnostico

## Uso recomendado durante saneamento

Rodar obrigatoriamente:

1. antes de iniciar mudanca estrutural
2. depois de cada bloco de refactor sensivel
3. antes de abrir PR

## Limites conhecidos

- o smoke de chat depende de credencial real do Gemini
- o smoke de TTS depende da API externa atual
- o runner valida continuidade de sessao entre requests, nao persistencia de sessao entre reinicios de processo
- o runner cobre backend e contratos HTTP; nao substitui teste manual completo de UI
