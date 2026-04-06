# Seguranca e Operacao

## Principios Atuais

- seguro por padrao
- opt-in explicito para capacidades perigosas
- approvals server-side para operacoes sensiveis
- credenciais fora do browser sempre que possivel
- isolamento por usuario

## Sessao e Auth

- cookie `HttpOnly`
- sessao persistida em disco
- sessao sobrevive restart
- `/auth/me` usado para validar sessao ativa

## Credenciais

### Hoje

- Gemini pode ser configurado no backend
- TTS e servido por proxy backend
- runtime config do cliente nao expoe segredo bruto
- estado salvo remove restos sensiveis conhecidos

### O que ainda exige cautela

- live client continua feature especial e opt-in
- plugins `code` continuam proibidos por padrao, mas ainda existem atras de flag

## Approvals

### Tipos

- `single_action`
- `conversation_grant`

### Regras

- approval pertence a um usuario
- approval expira
- approval valida acao
- approval pode ser consumido
- grant de conversa pode cobrir acoes da conversa por janela limitada

### Rotas

- `GET /api/approvals`
- `POST /api/approvals`
- `GET /api/approvals/:id`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`
- `POST /api/approvals/:id/revoke`

## Exec

### Situacao atual

- desligado por padrao
- so liga com `SKILLFLOW_EXEC_ENABLED=true`
- usa allowlist de binarios
- shell continua restrito por policy
- approval e obrigatorio para execucao sensivel
- logs e historico existem

### Flags relacionadas

- `SKILLFLOW_EXEC_ENABLED`
- `SKILLFLOW_EXEC_ALLOW_SHELL`
- `SKILLFLOW_EXEC_ALLOWED_BINS`

## Filesystem

- workspace isolada por usuario
- path traversal bloqueado
- delete exige approval
- rotas de leitura e escrita passam pelo backend

## Prompts

- prompt privado isolado por usuario
- prompt compartilhado so com `scope=shared`
- delete de prompt sensivel exige approval

## Estado salvo

O backend sanitiza:

- configuracoes sensiveis em `gc_cfg`
- restos de `pendingRequest`
- restos de `resumeState`

Objetivo:

- impedir persistencia de tokens e chaves no estado salvo

## TTS

- proxy backend em `/api/tts/*`
- provider configurado por `SKILLFLOW_TTS_API_URL` e `SKILLFLOW_TTS_SECRET`

## O que ainda nao deve ser vendido como resolvido

- backend-first completo
- eliminacao total de runtime sensivel no cliente
- suite de testes automatizados
- observabilidade completa
- limites operacionais amplos

## Checklist de operacao minima

Antes de usar em ambiente serio:

- manter `SKILLFLOW_EXEC_ENABLED=false` por padrao
- manter `SKILLFLOW_ENABLE_CLIENT_CODE_PLUGINS=false`
- manter `SKILLFLOW_ENABLE_LIVE_CLIENT=false` se live nao for necessario
- configurar `GEMINI_API_KEY` no backend quando for usar Gemini sem input manual
- configurar `SKILLFLOW_TTS_API_URL` e `SKILLFLOW_TTS_SECRET` se TTS for requerido
- rodar `npm run smoke:baseline`

## Residual risk

Os riscos atuais mais relevantes sao:

- runtime client-side ainda parcial
- plugin `code` ainda existe atras de flag
- ausencia de testes automatizados fortes
- documentacao historica antiga ainda existe em alguns arquivos

## Recomendacao

Use a base atual como:

- ambiente de desenvolvimento serio
- base de endurecimento continuo
- branch de transicao controlada

Nao descreva ainda como:

- backend-first completo
- produto endurecido final
