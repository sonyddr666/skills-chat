# Fase 3 - Governanca de Operacoes Sensiveis

## Escopo Fechado

Esta fase cobre:

- approvals reais no backend
- enforcement server-side para `exec`, deletes e integracao externa sensivel
- endurecimento adicional da politica de execucao

## Entregas

### 1. API de approvals no backend

Rotas adicionadas:

- `POST /api/approvals`
- `GET /api/approvals`
- `GET /api/approvals/:id`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`

Cada approval guarda:

- usuario dono
- acao
- payload redigido
- status
- criacao, expiracao e atualizacao
- trilha de auditoria

Agora existem dois modos:

- `single_action`: aprova apenas uma operacao
- `conversation_grant`: aprova a conversa por janela longa

Grant de conversa:

- vinculado a `conversation_id`
- aprovado por 24 horas
- pode liberar `*` ou lista de acoes
- nao e consumido no primeiro uso; ele registra uso e continua valido ate expirar
- pode ser revogado manualmente pela UI antes de expirar

### 2. Enforcement real no servidor

Agora exigem `approval_id` valido:

- `POST /api/exec`
- `DELETE /api/fs/delete`
- `DELETE /api/skills/:id`
- `DELETE /api/system-prompts/:scope/:id`
- `POST /api/ghost-search`

Regras validadas:

- approval pertence ao usuario autenticado
- status precisa estar `approved`
- acao precisa corresponder
- approval expirada falha
- approval usada vira `consumed`

Sem isso a resposta e `403`.

### 3. Hardening extra de `exec`

Quando `exec` esta habilitado:

- continua exigindo approval server-side
- allowlist de binarios continua ativa
- `cwd` continua preso a workspace do usuario
- `shell=true` continua bloqueado por politica global quando desabilitado
- perfil de execucao e inferido por comando
- timeout e limite de env variam por perfil
- `stdin` grande demais e `cwd` sensivel sao bloqueados
- metadados de auditoria e approval entram no registro da execucao

## Cliente

Mudancas na UI:

- `request_human_approval` cria approval real no backend
- tools sensiveis aceitam `approval_id`
- deletes de skill pela UI criam, aprovam e consomem approval antes da exclusao
- botao dedicado de approvals no topo
- painel listando approvals, grants, status, expiracao e usos
- banner da conversa atual quando existe grant ativo
- botao de revogar grant manualmente

## Validacao

Smoke baseline principal:

- `21 checks, 0 falhas, 3 skips`

Checks novos:

- lifecycle basico de approval
- delete sem approval bloqueado
- delete com approval aprovado
- grant de conversa reutilizavel por 24h
- integracao externa sem approval bloqueada

Smoke adicional com exec habilitado:

- `SKILLFLOW_EXEC_ENABLED=true`
- `SMOKE_ENABLE_EXEC_APPROVAL=1`
- resultado: `21 checks, 0 falhas, 2 skips`
- `exec com approval server-side` passou
- `exec` com grant de conversa tambem passou

## Observacoes

- approvals agora existem de verdade no backend, mas a experiencia de aprovacao ainda e minima; o servidor ja virou autoridade.
- a UI agora pode oferecer duas decisoes para acao sensivel: aprovar so esta acao ou aprovar todas as acoes sensiveis da conversa por 24h.
- chat/TTS continuam fora do escopo de approval obrigatoria porque nao entram como operacao sensivel desta fase.
