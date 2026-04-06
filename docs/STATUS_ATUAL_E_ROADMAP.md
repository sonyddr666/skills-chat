# Status Atual e Roadmap

## Snapshot Atual

Branch de referencia:

- `codex/refactor-hardening-foundation`

Commit usado como base desta documentacao:

- `0b818a6`

## Fases

### Feitas

- fase 0: freeze e baseline
- fase 1: hardening inicial
- fase 2: isolamento e persistencia
- fase 3: approvals reais e governanca sensivel

### Avancadas

- fase 5 backend: concluida
- fase 5 frontend: muito avancada

### Nao iniciadas de verdade

- fase 6
- fase 7
- fase 8

## Fase 5 - leitura honesta

### Backend

Ja modularizado em:

- `auth/session`
- `chat/codex`
- `chat/gemini`
- `chat/jobs`
- `state`
- `filesystem`
- `exec`
- `system-prompts`
- `approvals`
- `http/utils`

### Frontend

Ja extraido em modulos:

- `api-client`
- `storage-sync`
- `tts`
- `jobs`
- `chat`
- `live`
- `ui-render`

### O que ainda falta para declarar a fase 5 encerrada sem ressalva

- reduzir mais UI residual do `index.html`
- limpar sobras de comportamento visual espalhado
- revisar o frontend apos o saneamento de encoding

## Fase 6 - proximo bloco tecnico

### `6.1`

- remover `Function` do fluxo `calculate`

### `6.2`

- redefinir modelo de plugins
- suportar oficialmente `builtin`, `http` e `exec`
- manter `code` fora de producao

## Fase 7 - robustez operacional

### `7.1`

- limites de payload
- limites de leitura
- limites de output

### `7.2`

- padrao de encoding e strings
- correcoes finais de mojibake

### `7.3`

- reduzir dependencia fragil de CDN

### `7.4`

- observabilidade minima

## Fase 8 - fechamento

### `8.1`

- testes automatizados criticos

### `8.2`

- regressao funcional completa

### `8.3`

- documentacao final coerente com o sistema real

## Prioridade real

Se a execucao continuar agora, a ordem recomendada e:

1. encerrar Fase 5 frontend
2. iniciar Fase 6
3. entrar em Fase 7
4. fechar com Fase 8

## Linha honesta

Hoje o projeto esta:

- muito melhor endurecido
- modularizado em boa parte
- operavel com controle

Mas ainda nao esta:

- backend-first completo
- automatizado em testes
- operacionalmente terminado
