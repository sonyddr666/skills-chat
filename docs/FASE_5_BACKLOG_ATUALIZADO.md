# Fase 5 em diante - Backlog Executavel

Atualizado para refletir o estado real apos a modularizacao de backend e o avanço forte da modularizacao de frontend.

## Estado Atual

- `5.1A` backend infra: concluida
- `5.1B` governanca backend: concluida
- `5.1C` chat backend: concluida
- `5.2A` base frontend + api-client: concluida
- `5.2B` storage-sync: concluida
- `5.2C` tts: concluida
- `5.2D` jobs/chat/live/ui-render: muito avancada, mas ainda nao 100% encerrada
- smoke baseline: verde

## Quadro Atual

| ID | Status | Prioridade | Esforco | Tempo |
|---|---|---|---|---|
| `5.1A-F-01` | concluido | alta | baixo a medio | 0,5 a 1 dia |
| `5.1B-01` | concluido | alta | medio | 1 dia |
| `5.1B-02` | concluido | alta | medio | 1 a 1,5 dia |
| `5.1B-03` | concluido | muito alta | medio | 1,5 a 2 dias |
| `5.1C-01` | concluido | alta | medio | 1 a 1,5 dia |
| `5.1C-02` | concluido | alta | medio | 1 a 1,5 dia |
| `5.1C-03` | concluido | alta | medio | 1,5 a 2 dias |
| `5.1C-04` | concluido | alta | baixo | 0,5 dia |
| `5.2A-01` | concluido | media alta | baixo | 0,5 dia |
| `5.2A-02` | concluido | alta | medio | 1 dia |
| `5.2B-01` | concluido | alta | medio | 1 a 1,5 dia |
| `5.2B-02` | concluido | media | baixo | 0,5 dia |
| `5.2C-01` | concluido | media alta | medio | 1 dia |
| `5.2D-01` | concluido | alta | medio | 1 a 1,5 dia |
| `5.2D-02` | muito avancado | alta | alto | 1,5 a 2,5 dias |
| `5.2D-03` | muito avancado | media | medio | 1 dia |
| `5.2D-04` | muito avancado | media alta | alto | 2 a 3 dias |
| `6.1-01` | todo | alta | baixo a medio | 0,5 a 1 dia |
| `6.2-01` | todo | muito alta | medio a alto | 2 a 3 dias |
| `7.1-01` | todo | alta | medio | 1 dia |
| `7.2-01` | todo | media alta | medio | 1 a 2 dias |
| `7.3-01` | todo | media | medio | 1 a 2 dias |
| `7.4-01` | todo | alta | medio | 1,5 a 2 dias |
| `8.1-01` | todo | muito alta | alto | 2 a 4 dias |
| `8.2-01` | todo | alta | medio | 1 a 2 dias |
| `8.3-01` | todo | media alta | medio | 1 dia |

## Bloco A - Fechar backend modularizado

### `5.1A-F-01` Limpar redundancias remanescentes do `server.js`

- Objetivo: remover codigo duplicado ou wrappers provisórios deixados apos a extracao de `http/utils`, `auth/session`, `state` e `filesystem`
- Arquivos provaveis:
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1A` concluida
- Entregavel:
  - `server.js` menor
  - imports apontando para modulos reais
  - sem helper duplicado sobrando no entrypoint
- Criterio de pronto:
  - servidor sobe
  - smoke baseline passa
  - nenhuma rota muda
  - `server.js` nao mantem implementacao paralela de infra ja extraida

### `5.1B-01` Extrair `system-prompts`

- Objetivo: tirar regras de prompt privado/shared e permissoes do monolito
- Arquivos provaveis:
  - [server/system-prompts/index.js](E:\CODEX-testing\chat\skillflow-chat\server\system-prompts\index.js)
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1A-F-01`
- Entregavel:
  - modulo com CRUD de prompts
  - escopo privado/shared centralizado
  - helpers de permissao centralizados
- Criterio de pronto:
  - prompts privados continuam isolados
  - prompts shared continuam respeitando permissao
  - contratos HTTP nao mudam
  - smoke de prompts passa

### `5.1B-02` Extrair `approvals`

- Objetivo: centralizar grants, approve/reject/revoke e validacoes de approval
- Arquivos provaveis:
  - [server/approvals/index.js](E:\CODEX-testing\chat\skillflow-chat\server\approvals\index.js)
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1A-F-01`
- Entregavel:
  - modulo de approvals
  - helpers reutilizaveis de enforcement
  - regras de grant fora do entrypoint
- Criterio de pronto:
  - approvals continuam criando, aprovando, rejeitando e revogando
  - grants continuam corretos
  - acoes sensiveis continuam validando approval
  - smoke de approvals passa

### `5.1B-03` Extrair `exec`

- Objetivo: isolar rota, politica, logs e enforcement de execucao
- Arquivos provaveis:
  - [server/exec/index.js](E:\CODEX-testing\chat\skillflow-chat\server\exec\index.js)
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1B-02`
  - filesystem ja extraido
- Entregavel:
  - modulo unico de `exec`
  - policy, allowlist, timeout e cwd encapsulados
  - logs e historico no mesmo lugar
- Criterio de pronto:
  - `exec` segue desligado por padrao
  - quando habilitado, respeita allowlist e approval
  - logs continuam funcionando
  - smoke com `exec` habilitado continua verde

## Bloco B - Fechar runtime de chat no backend

### `5.1C-01` Extrair `chat/codex`

- Objetivo: isolar integracao Codex, parsing e normalizacao
- Arquivos provaveis:
  - [server/chat/codex.js](E:\CODEX-testing\chat\skillflow-chat\server\chat\codex.js)
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1B-03`
- Entregavel:
  - cliente/handler Codex fora do monolito
  - parsing SSE e adaptacao encapsulados
- Criterio de pronto:
  - contrato atual continua igual
  - requests Codex continuam funcionando
  - jobs que dependem de Codex continuam corretos

### `5.1C-02` Extrair `chat/gemini`

- Objetivo: isolar proxy/stream e normalizacao do Gemini
- Arquivos provaveis:
  - [server/chat/gemini.js](E:\CODEX-testing\chat\skillflow-chat\server\chat\gemini.js)
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1B-03`
- Entregavel:
  - modulo Gemini separado
  - stream/proxy e adaptacao fora do entrypoint
- Criterio de pronto:
  - contrato HTTP continua igual
  - stream continua funcional
  - integracao com jobs continua correta

### `5.1C-03` Extrair `chat/jobs`

- Objetivo: isolar snapshots, polling, retomada e status de job
- Arquivos provaveis:
  - [server/chat/jobs.js](E:\CODEX-testing\chat\skillflow-chat\server\chat\jobs.js)
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1C-01`
  - `5.1C-02`
- Entregavel:
  - modulo central de jobs
  - persistencia e retomada encapsuladas
- Criterio de pronto:
  - `/api/chat/jobs*` segue com mesmo contrato
  - criar, consultar e retomar jobs continua funcionando
  - smoke de jobs passa

### `5.1C-04` Afinar `server.js`

- Objetivo: deixar `server.js` como bootstrap e roteamento fino
- Arquivos provaveis:
  - [server.js](E:\CODEX-testing\chat\skillflow-chat\server.js)
- Dependencias:
  - `5.1B-*`
  - `5.1C-*`
- Entregavel:
  - entrypoint fino
  - imports claros
  - menos regra de negocio no topo
- Criterio de pronto:
  - `server.js` vira wiring
  - modulos novos sao fonte oficial
  - smoke completo passa

## Bloco C - Modularizacao segura do frontend

### `5.2A-01` Criar `public/app/`

- Objetivo: preparar a estrutura modular do frontend
- Arquivos provaveis:
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
  - [public/app](E:\CODEX-testing\chat\skillflow-chat\public\app)
- Dependencias:
  - backend modularizado ate `5.1C-04`
- Entregavel:
  - estrutura `public/app/`
  - carregamento inicial configurado
- Criterio de pronto:
  - app abre igual
  - sem mudanca visual
  - sem erro de carga

### `5.2A-02` Extrair `api-client`

- Objetivo: centralizar chamadas HTTP do frontend
- Arquivos provaveis:
  - [public/app/api-client.js](E:\CODEX-testing\chat\skillflow-chat\public\app\api-client.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- Dependencias:
  - `5.2A-01`
- Entregavel:
  - wrapper central para fetch
  - erros e headers padronizados
- Criterio de pronto:
  - chamadas principais passam pelo modulo
  - contratos nao mudam
  - app continua operando igual

### `5.2B-01` Extrair `storage-sync`

- Objetivo: centralizar `localStorage`, schema e migracao
- Arquivos provaveis:
  - [public/app/storage-sync.js](E:\CODEX-testing\chat\skillflow-chat\public\app\storage-sync.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
  - [public/account.js](E:\CODEX-testing\chat\skillflow-chat\public\account.js)
- Dependencias:
  - `5.2A-02`
- Entregavel:
  - leitura/escrita concentradas
  - chaves permitidas definidas
  - migracao encapsulada
- Criterio de pronto:
  - sync continua funcionando
  - nenhuma credencial sensivel reaparece
  - `localStorage` nao fica mais espalhado

### `5.2B-02` Limpar chaves antigas

- Objetivo: reduzir legado e remover lixo de estado
- Arquivos provaveis:
  - [public/app/storage-sync.js](E:\CODEX-testing\chat\skillflow-chat\public\app\storage-sync.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- Dependencias:
  - `5.2B-01`
- Entregavel:
  - schema atual limpo
  - migracao documentada
- Criterio de pronto:
  - chaves antigas tratadas
  - nao ha regressao na UX
  - documentacao curta do storage atual existe

### `5.2C-01` Consolidar `tts`

- Objetivo: unificar implementacao de TTS
- Arquivos provaveis:
  - [public/app/tts.js](E:\CODEX-testing\chat\skillflow-chat\public\app\tts.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- Dependencias:
  - `5.2A-02`
- Entregavel:
  - fonte oficial de TTS
  - fim da duplicacao de `ttsSpeakMsg` e `ttsStop`
- Criterio de pronto:
  - play/stop/erro seguem funcionando
  - so existe uma implementacao oficial
  - smoke funcional de TTS passa

### `5.2D-01` Extrair `jobs`

- Objetivo: tirar polling, snapshot e retomada do script principal
- Arquivos provaveis:
  - [public/app/jobs.js](E:\CODEX-testing\chat\skillflow-chat\public\app\jobs.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- Dependencias:
  - `5.2B-01`
- Entregavel:
  - modulo de jobs no cliente
  - logica operacional de retomada isolada
- Criterio de pronto:
  - polling continua correto
  - retomada continua funcionando
  - sem regressao de status visual

### `5.2D-02` Extrair `chat`

- Objetivo: tirar fluxo principal de conversa do script gigante
- Arquivos provaveis:
  - [public/app/chat.js](E:\CODEX-testing\chat\skillflow-chat\public\app\chat.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- Dependencias:
  - `5.2D-01`
- Entregavel:
  - modulo central de envio e estado de conversa
  - integracao com `api-client` e `jobs` organizada
- Criterio de pronto:
  - enviar mensagem continua funcionando
  - mensagens continuam renderizando corretamente
  - sem regressao na UX principal

### `5.2D-03` Isolar `live`

- Objetivo: separar fluxo especial de live do script principal
- Arquivos provaveis:
  - [public/app/live.js](E:\CODEX-testing\chat\skillflow-chat\public\app\live.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- Dependencias:
  - `5.2D-02`
- Entregavel:
  - modulo `live`
  - fluxo principal desacoplado do caminho especial
- Criterio de pronto:
  - live continua funcional ou corretamente bloqueado
  - chat normal nao depende mais dele

### `5.2D-04` Extrair `ui/render`

- Objetivo: separar renderizacao de regra de fluxo
- Arquivos provaveis:
  - [public/app/ui-render.js](E:\CODEX-testing\chat\skillflow-chat\public\app\ui-render.js)
  - [public/index.html](E:\CODEX-testing\chat\skillflow-chat\public\index.html)
- Dependencias:
  - `5.2D-02`
- Entregavel:
  - renderizacao encapsulada
  - menos manipulacao direta espalhada no script principal
- Criterio de pronto:
  - UX visual permanece equivalente
  - render fica separada do fluxo de dados
  - side effects mais explicitos

## Bloco D - Remover mecanismos inseguros restantes

### `6.1-01` Substituir `calculate` sem `Function`

- Objetivo: trocar execucao dinamica por parser seguro
- Dependencias:
  - frontend estabilizado ate `5.2D-02`
- Entregavel:
  - calculo seguro e restrito
- Criterio de pronto:
  - expressoes validas funcionam
  - invalidas falham corretamente
  - nao existe `Function` nesse fluxo

### `6.2-01` Redefinir modelo de plugins

- Objetivo: suportar so `builtin`, `http`, `exec` com politica oficial
- Dependencias:
  - `6.1-01`
  - backend e frontend estabilizados
- Entregavel:
  - schema oficial de plugin
  - `code` fora de producao
  - politica clara por tipo
- Criterio de pronto:
  - plugins suportados tem contrato definido
  - `code` nao roda em producao
  - docs atualizadas

## Bloco E - Robustez operacional

### `7.1-01` Limites de payload e leitura

- Objetivo: consolidar limites operacionais em payload, arquivo, exec e listagens
- Criterio de pronto:
  - limites implementados
  - erros coerentes
  - paginacao funcional

### `7.2-01` Higiene de encoding e strings

- Objetivo: padronizar UTF-8 e corrigir mojibake conhecido
- Criterio de pronto:
  - textos quebrados conhecidos deixam de ocorrer
  - padrao documentado

### `7.3-01` Reduzir dependencia fragil de CDN

- Objetivo: mapear libs criticas, fixar versoes e prever fallback
- Criterio de pronto:
  - dependencias criticas nao ficam soltas em CDN sem politica

### `7.4-01` Observabilidade minima

- Objetivo: adicionar request id, logs por rota e duracao basica
- Criterio de pronto:
  - request e rastreavel
  - falha tem categoria
  - duracao fica visivel

## Bloco F - Fechamento e protecao contra regressao

### `8.1-01` Automatizar testes criticos

- Cobertura minima:
  - auth
  - sessao persistente
  - prompts privados
  - path traversal
  - exec desligado por padrao
  - exec com approval
  - chat jobs
  - TTS via backend
- Criterio de pronto:
  - suite critica roda e pega regressao real

### `8.2-01` Rodar regressao funcional completa

- Checklist:
  - chat
  - anexos
  - filesystem
  - Ghost Search
  - skills
  - prompts
  - login
  - sync
  - TTS
- Criterio de pronto:
  - checklist fechado
  - UX principal preservada

### `8.3-01` Atualizar documentacao real

- Entregavel:
  - README atualizado
  - arquitetura modular
  - politica de exec
  - approvals
  - storage de sessao
  - plugins suportados
  - limites operacionais
- Criterio de pronto:
  - documentacao reflete o sistema real

## Ordem de Execucao Recomendada

### Sprint 1

- `5.1A-F-01`
- `5.1B-01`
- `5.1B-02`
- `5.1B-03`

### Sprint 2

- `5.1C-01`
- `5.1C-02`
- `5.1C-03`
- `5.1C-04`

### Sprint 3

- `5.2A-01`
- `5.2A-02`
- `5.2B-01`
- `5.2B-02`
- `5.2C-01`

### Sprint 4

- `5.2D-01`
- `5.2D-02`
- `5.2D-03`
- `5.2D-04`

### Sprint 5

- `6.1-01`
- `6.2-01`
- `7.1-01`
- `7.4-01`

### Sprint 6

- `7.2-01`
- `7.3-01`
- `8.1-01`
- `8.2-01`
- `8.3-01`

## Estimativa Restante

- 1 dev principal: `14 a 26 dias uteis`
- 2 devs bons: `10 a 18 dias uteis`

## Criterio Global de Execucao

- codigo implementado
- smoke validado
- contrato preservado
- logs e erros coerentes
- documentacao curta da mudanca
- codigo velho marcado para remocao ou ja removido
