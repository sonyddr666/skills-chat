# Fase 2 - Isolamento e Persistencia

## Escopo Fechado

Esta fase cobre:

- `system-prompts` privados por usuario
- prompts compartilhados apenas com `scope=shared`
- sessao persistida fora da memoria do processo
- saneamento final do estado sensivel sincronizado pelo cliente

## Entregas

### 1. `system-prompts` isolados por usuario

- prompt privado agora fica em escopo do usuario autenticado
- prompt compartilhado so e criado quando o payload envia `scope=shared`
- listagem retorna privados do usuario + compartilhados
- backend aplica checagem de permissao por dono ao atualizar ou remover prompt existente
- legado na pasta raiz de prompts continua legivel como compartilhado para nao quebrar a base anterior

### 2. Sessao persistida em disco

- `const sessions = new Map()` saiu do caminho critico
- sessoes agora ficam em `workspace/.system/sessions.json`
- login continua via cookie `HttpOnly`
- cookie recebe `Secure` automaticamente quando a request chega por HTTPS
- expiracao continua respeitada e sessoes expiradas sao limpas ao carregar

### 3. Estado sincronizado fica sanitizado

- `/api/state` remove restos sensiveis de `gc_cfg`
- `pendingRequest` e `resumeState` sao limpos antes de persistir
- `auth`, `api_key` e variantes nao voltam do backend para o storage do navegador
- snapshots de job e resposta direta do Codex nao devolvem mais `auth` ao cliente

## Validacao

Smoke baseline ampliado:

- `16 checks, 0 falhas, 2 skips`

Novos checks validados:

- prompt privado isolado por usuario
- prompt compartilhado visivel apenas por decisao explicita
- sessao persiste apos restart do processo

## Observacoes

- o fluxo Live continua bloqueado por padrao; ele ainda nao foi migrado para backend.
- o backend ainda aceita `api_key` de Gemini em payload de job direto para cenarios de smoke/manual, mas o fluxo principal da UI usa credencial armazenada no servidor.
