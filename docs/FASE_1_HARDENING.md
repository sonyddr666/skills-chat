# Fase 1 - Hardening Inicial

## Escopo Fechado

Esta fase cobre apenas reducao de risco operacional imediato:

- desabilitar `POST /api/exec` por padrao
- remover segredos do frontend
- bloquear plugins `code` em producao
- limpar residuos operacionais e alinhar `.gitignore`

## Entregas

### 1. `exec` desligado por padrao

- flag: `SKILLFLOW_EXEC_ENABLED`
- comportamento padrao: `false`
- `POST /api/exec` agora responde `403`
- log explicito quando a rota e bloqueada por politica

### 2. Segredos removidos do frontend

- `TTS_KEY` saiu do browser
- `Gemini api_key` nao fica mais persistida em `localStorage`
- `Codex auth` nao fica mais persistido em `localStorage`
- `pendingRequest` e `resumeState` nao carregam mais `api_key` ou `auth`

### 3. Backend passou a concentrar credenciais

Novas rotas:

- `GET /api/runtime-config`
- `GET /api/credentials`
- `POST /api/credentials`
- `GET /api/tts/health`
- `GET /api/tts/voices`
- `POST /api/tts/speak`

Uso:

- frontend envia intencao
- backend injeta credencial segura por sessao ou por ambiente

### 4. Plugins `code` bloqueados por padrao

- `new Function(...)` continua existente apenas para dev/local
- producao bloqueia plugins de codigo arbitrario no cliente
- liberacao depende de `SKILLFLOW_ENABLE_CLIENT_CODE_PLUGINS=true`

### 5. Live client travado por padrao

- fluxo Live continua exigindo chave no browser quando explicitamente habilitado
- por padrao ele fica desabilitado por politica com `SKILLFLOW_ENABLE_LIVE_CLIENT=false`

### 6. Repo limpo

- `.gitignore` cobre `.tmp-*` e `*.tmp.js`
- nenhum artefato temporario entrou no fluxo desta fase

## Validacao

Validado nesta fase:

- smoke baseline: `13 checks, 0 falhas, 2 skips`
- `POST /api/exec` desligado por padrao: `403 {"error":"Execucao desabilitada por politica do servidor"}`

## Observacoes

- Live ainda nao foi movido para backend; ele ficou bloqueado por padrao para eliminar exposicao acidental.
- O proximo passo natural e persistencia de sessao e isolamento por usuario de prompts/estado sensivel.
