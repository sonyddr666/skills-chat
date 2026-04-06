# Fase 0.1 - Congelar Features Novas

Base tecnica: `codex/test-backend-first-sync`
Branch de execucao desta fase: `codex/refactor-hardening-foundation`
Tempo alvo: `0,5 dia`

## Objetivo

Impedir que o sistema continue mudando enquanto a base e saneada. O foco desta fase nao e adicionar capacidade; e travar o escopo para permitir diagnostico e correcoes estruturais sem ruido paralelo.

## Decisao operacional

Durante a Fase 0.1:

- nenhuma feature nova entra em chat
- nenhuma feature nova entra em plugins
- nenhuma feature nova entra em jobs, tools, TTS, STT ou Live
- so entram mudancas de saneamento, hardening, documentacao de controle e correcoes diretamente ligadas a estabilizacao da base

## O que entra

- documentacao de escopo
- docs de saneamento e roadmap de estabilizacao
- correcoes de risco estrutural
- endurecimento de auth, exec, credenciais e isolamento
- refactors com objetivo explicito de reduzir acoplamento
- ajustes necessarios para manter a branch operavel durante o saneamento

## O que nao entra

- novas tools
- novos plugins
- novo provider
- novas UX flows
- expansao de anexos, TTS, STT ou Live
- feature de conveniencia sem relacao com estabilizacao
- mudanca cosmetica sem impacto direto no saneamento

## Regras de triagem para esta fase

Uma mudanca so entra se responder "sim" a pelo menos uma pergunta:

1. reduz risco tecnico imediato?
2. reduz acoplamento ou ambiguidade operacional?
3. corrige falha estrutural que bloqueia fases seguintes?
4. melhora a capacidade de testar, manter ou auditar a base?

Se a resposta for "nao" para todas, a mudanca deve ser adiada.

## Branch de trabalho

- branch base congelada para referencia: `codex/test-backend-first-sync`
- branch ativa de saneamento: `codex/refactor-hardening-foundation`

## Resultado esperado

- escopo controlado
- menos regressao por mudanca paralela
- diagnostico que nao envelhece em poucos dias
- base pronta para seguir para a fase de contencao e hardening

## Risco se essa fase for ignorada

- retrabalho
- conflitos de merge
- backlog confuso
- saneamento interrompido por feature paralela
- perda de rastreabilidade entre problema, causa e correcao
