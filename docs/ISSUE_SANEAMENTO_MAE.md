# Issue-Mae - Saneamento e Hardening da Base

Base tecnica: `codex/test-backend-first-sync`
Branch de trabalho: `codex/refactor-hardening-foundation`
Data de abertura: `2026-04-06`

## Objetivo

Estabilizar a base antes de continuar evoluindo features de chat, plugins, jobs e runtime. O foco desta trilha e reduzir risco estrutural, conter regressao e criar uma fundacao minimamente previsivel para as proximas fases.

## Problema central

O sistema acumulou backend, frontend, runtime de tools, sync de estado, execucao local e integracoes externas no mesmo fluxo operacional. Isso elevou o risco de regressao e tornou dificil separar bug real de efeito colateral arquitetural.

## Escopo desta issue-mae

- congelar novas features de chat e plugins durante a fase inicial
- endurecer a base antes de expandir comportamento
- organizar o trabalho por fases curtas e verificaveis
- documentar claramente o que entra e o que nao entra

## Entradas desta trilha

- revisao de escopo e congelamento de features
- endurecimento da base de auth, exec e credenciais
- separacao gradual de responsabilidades entre cliente e backend
- saneamento de docs tecnicas e alinhamento do README com a branch real
- reducao de risco em runtime de plugins e jobs

## Fora de escopo nesta fase inicial

- novas features de produto
- novos providers de LLM
- novos plugins/skills
- redesign visual
- expansao de TTS/STT/Live
- automacoes ou marketplace novo

## Critérios de saida da trilha

- existe escopo congelado e aceito
- branch de saneamento concentrando as mudancas
- backlog de problemas priorizado por risco
- runtime com menos superficie exposta e menos ambiguidade operacional
- base pronta para retomar evolucao sem continuar empilhando divida estrutural

## Fases previstas

1. Fase 0 - preparacao e congelamento da bagunca
2. Fase 1 - contencao de risco e endurecimento minimo
3. Fase 2 - simplificacao de fluxo e reducao de acoplamento
4. Fase 3 - modularizacao orientada por dominio
5. Fase 4 - retomada controlada de evolucao

## Observacoes

- esta issue-mae representa o eixo principal de saneamento
- qualquer demanda nova de feature deve ser registrada separadamente e marcada como adiada ate o fim do congelamento inicial
