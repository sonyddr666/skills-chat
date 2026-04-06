# Fase 5 - Backlog Atualizado

## Estado Atual

- `5.1A` backend infra: concluida
- `server/http/utils.js`: concluido
- `server/auth/session.js`: concluido
- `server/state/index.js`: concluido
- `server/filesystem/index.js`: concluido
- smoke baseline: verde

## Proximo Bloco

### 5.1A-finish

- limpar redundancia restante em `server.js`
- remover ou aposentar handlers legados ainda presentes no arquivo
- garantir que os modulos novos sejam a unica fonte oficial para auth, state e filesystem
- manter smoke baseline verde

### 5.1B governanca

#### 5.1B-01 system-prompts

- extrair rotas e storage de system prompts
- isolar escopo privado/shared e checagem de permissao

#### 5.1B-02 approvals

- extrair CRUD, grants por conversa e validacao server-side
- manter auditoria e revoke

#### 5.1B-03 exec

- extrair policy, historico, auditoria e runtime de exec
- manter enforcement por approval

### 5.1C chat runtime

#### 5.1C-01 chat/codex

- extrair auth/refresh/parsing/resposta Codex

#### 5.1C-02 chat/gemini

- extrair proxy/stream Gemini

#### 5.1C-03 chat/jobs

- extrair criacao, snapshot e polling de jobs

#### 5.1C-04 afinar server.js

- deixar `server.js` como bootstrap e roteamento fino

### 5.2 frontend

#### 5.2A base

- criar `public/app/`
- extrair `api-client`

#### 5.2B persistencia

- extrair `storage-sync`
- centralizar `localStorage`
- limpar chaves antigas e migracoes

#### 5.2C midia

- consolidar `tts`
- remover redefinicoes duplicadas

#### 5.2D runtime de interface

- extrair `jobs`
- extrair `chat`
- isolar `live`
- extrair `ui/render`

## Criterio de Pronto por Subetapa

- servidor sobe
- smoke baseline passa
- nenhum contrato HTTP muda sem intencao explicita
- modulo novo vira fonte oficial da responsabilidade
- segredo nao volta para o cliente
- shim legado, se existir, fica curto e com remocao planejada
