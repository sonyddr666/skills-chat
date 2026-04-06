# Arquitetura Atual

## Resumo

O sistema hoje e um chat full-stack em Node com:

- autenticacao local
- sessao persistida
- estado por usuario
- workspace por usuario
- runtime de chat misto entre backend e frontend
- approvals server-side

O backend ja responde pela autoridade de dados, credenciais e operacoes sensiveis. O frontend ainda carrega parte da orquestracao e parte da UI monolitica.

## Backend

### Fluxo principal

1. usuario autentica em `/auth/*`
2. browser recebe cookie `HttpOnly`
3. frontend conversa com `/api/*`
4. backend persiste estado, approvals, jobs e filesystem
5. frontend acompanha jobs e renderiza o estado

### Modulos

- `server/http/utils.js`
  helpers HTTP, cookies, JSON, respostas e utilitarios de request

- `server/auth/session.js`
  login, logout, sessao, cookie e guarda de autenticacao

- `server/state/index.js`
  leitura, escrita e sanitizacao do estado do usuario

- `server/filesystem/index.js`
  workspace isolada, validacao de paths e rotas `/api/fs/*`

- `server/system-prompts/index.js`
  CRUD de prompts privados e compartilhados

- `server/approvals/index.js`
  approvals pontuais, grants por conversa, approve/reject/revoke e enforcement

- `server/exec/index.js`
  policy de exec, historico, validacao de approval e allowlist

- `server/chat/codex.js`
  integracao Codex

- `server/chat/gemini.js`
  integracao Gemini

- `server/chat/jobs.js`
  persistencia e leitura de jobs de chat

### Entrypoint

[server.js](E:\CODEX-testing\chat\skillflow-chat\server.js) hoje esta mais fino do que na base original, mas ainda nao e um bootstrap minimo. Ele ainda concentra roteamento e parte da montagem de dependencias.

## Frontend

### Modulos atuais

- `public/app/storage-sync.js`
  camada central de `localStorage`

- `public/app/api-client.js`
  chamadas HTTP centralizadas

- `public/app/jobs.js`
  polling, retomada e sincronizacao de jobs

- `public/app/chat.js`
  envio de mensagem, preflight, anexos e runtime principal do chat

- `public/app/live.js`
  runtime de live mode

- `public/app/tts.js`
  runtime de TTS

- `public/app/ui-render.js`
  render do chat, sidebar, approvals, scroll e acoes de mensagem

### O que ainda nao saiu do HTML

[public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html) ainda concentra:

- parte da configuracao visual
- handlers de UI residual
- parte do editor de skills/plugins
- parte do fluxo de arquivos
- alguns toggles de layout

Entao a modularizacao do frontend avancou muito, mas ainda nao terminou.

## Modelo atual de responsabilidade

### O backend ja controla

- auth e sessao
- approvals e grants
- exec e filesystem
- prompts privados/shared
- credenciais de provider
- jobs de chat
- TTS proxy

### O frontend ainda controla

- parte da UX e do render
- parte da orquestracao visual do chat
- parte do fluxo live
- runtime de plugin no cliente

## Onde o sistema ainda esta em transicao

### Backend-first incompleto

O sistema ainda nao moveu todo o loop de tool calling para o backend.

Hoje:

- backend executa jobs e integracoes reais
- frontend ainda participa da orquestracao final de alguns fluxos

Alvo futuro:

- backend roda modelo
- backend chama tool
- backend valida resultado
- frontend apenas acompanha

## Persistencia

### Sessao

- persistida em disco
- sobrevive restart
- baseada em cookie `HttpOnly`

### Estado do usuario

- salvo por usuario
- sanitizado antes de persistir

### Jobs

- snapshots de jobs persistidos no backend

### Workspace

- isolamento por usuario

## Principais limites da arquitetura atual

- `server.js` ainda e grande
- `public/index.html` ainda e grande
- frontend ainda nao foi totalmente fatiado
- plugins `code` ainda existem atras de flag
- sem suite automatizada robusta

## Leitura honesta

A arquitetura atual e suficientemente forte para continuar evoluindo com seguranca e controle. O sistema ja nao esta no estado de prototipo bruto.

Mas ainda esta numa fase intermediaria:

- backend bem mais maduro
- frontend ainda em desmonte controlado
- backend-first ainda incompleto
