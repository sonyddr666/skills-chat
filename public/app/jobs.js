(function (global) {
    function init(deps) {
        const chatJobPolls = new Map();

        async function requestChatJob(payload, signal) {
            const res = await global.fetch('/api/chat/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || (`HTTP ${res.status}`));
            return data.job || null;
        }

        async function fetchChatJobSnapshot(jobId, signal) {
            const res = await global.fetch(`/api/chat/jobs/${encodeURIComponent(jobId)}`, {
                cache: 'no-store',
                signal
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || (`HTTP ${res.status}`));
            return data;
        }

        function sleepWithSignal(ms, signal) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve();
                }, ms);
                function onAbort() {
                    clearTimeout(timer);
                    reject(new DOMException('Aborted', 'AbortError'));
                }
                if (signal) {
                    if (signal.aborted) {
                        onAbort();
                        return;
                    }
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            });
        }

        function parseGeminiJobSnapshot(rawSse) {
            let full = '';
            let tok = 0;
            let sig = '';
            const fnCallParts = [];
            const lines = String(rawSse || '').split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (!raw || raw === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(raw);
                    for (const part of (parsed.candidates?.[0]?.content?.parts || [])) {
                        if (part.text) full += part.text;
                        if (part.thoughtSignature && !part.functionCall) sig = part.thoughtSignature;
                        if (part.functionCall) fnCallParts.push({ ...part });
                    }
                    if (parsed.usageMetadata?.totalTokenCount) tok = parsed.usageMetadata.totalTokenCount;
                } catch (_) {}
            }
            return { full, tok, sig, fnCallParts };
        }

        function getConversationMessage(convId, msgIndex) {
            return deps.conversationMessages(deps.getConversations()?.[convId])?.[msgIndex] || null;
        }

        function updateMessageChatJob(convId, msgIndex, patch = {}, saveNow = true) {
            const message = getConversationMessage(convId, msgIndex);
            if (!message || message.role !== 'model') return null;
            message.chatJob = {
                ...(message.chatJob && typeof message.chatJob === 'object' ? message.chatJob : {}),
                ...patch
            };
            if (saveNow) deps.saveConvs();
            return message;
        }

        function findConversationMessageIndex(convId, messageId) {
            if (!messageId) return -1;
            const msgs = deps.conversationMessages(deps.getConversations()?.[convId]);
            return msgs.findIndex((message) => message?.id === messageId);
        }

        async function waitForChatJob(jobId, options = {}) {
            const existing = chatJobPolls.get(jobId);
            if (existing) return existing;

            const runner = (async () => {
                while (true) {
                    const snapshot = await fetchChatJobSnapshot(jobId, options.signal);
                    if (typeof options.onSnapshot === 'function') options.onSnapshot(snapshot);

                    const status = snapshot?.job?.status || '';
                    if (status === 'completed' || status === 'failed') return snapshot;
                    await sleepWithSignal(options.pollMs || 250, options.signal);
                }
            })();

            chatJobPolls.set(jobId, runner);
            try {
                return await runner;
            } finally {
                chatJobPolls.delete(jobId);
            }
        }

        function applyChatJobSnapshotToMessage(convId, msgIndex, snapshot) {
            const message = getConversationMessage(convId, msgIndex);
            if (!message || message.role !== 'model') return;

            const provider = snapshot?.job?.provider || message?.chatJob?.provider || '';
            const status = snapshot?.job?.status || message?.chatJob?.status || 'running';
            const errorMessage = snapshot?.job?.error?.message || '';
            let visibleHtml = '';
            let needsFullRender = false;

            if (provider === 'gemini') {
                const parsed = parseGeminiJobSnapshot(snapshot?.raw_sse || '');
                if (parsed.full) {
                    message.text = parsed.full;
                    visibleHtml = deps.renderMarkdown(parsed.full);
                }
                if (parsed.tok) message.tok = parsed.tok;
                if (parsed.sig) message.sig = parsed.sig;
                if (status === 'failed') {
                    message.text = message.text || `[Falha: ${errorMessage || 'Falha ao executar o job Gemini no backend.'}]`;
                    visibleHtml = `<p style="color:var(--danger);font-style:italic">${deps.esc(errorMessage || 'Falha ao executar o job Gemini no backend.')}</p>`;
                    deps.pushMessageTraceOnce(message, deps.createTraceStep('error', {
                        title: 'Falha',
                        body: errorMessage || 'Falha ao executar o job Gemini no backend.'
                    }));
                    needsFullRender = true;
                } else if (status === 'completed' && !parsed.full) {
                    if (parsed.fnCallParts.length) {
                        message.text = message.text || '[A chamada do modelo foi retomada, mas ainda faltou continuar as tools no cliente.]';
                        visibleHtml = '<p style="color:var(--muted);font-style:italic">A resposta foi retomada, mas ainda ha tools pendentes para continuar no cliente.</p>';
                        deps.pushMessageTraceOnce(message, deps.createTraceStep('pending_tools', {
                            title: 'Tools pendentes',
                            body: `A retomada encontrou ${parsed.fnCallParts.length} function call(s) que ainda dependem do cliente.`
                        }));
                    } else {
                        message.text = message.text || '[Resposta vazia - o modelo nao retornou texto visivel.]';
                        visibleHtml = '<p style="color:var(--muted);font-style:italic">O modelo concluiu sem texto visivel.</p>';
                        deps.pushMessageTraceOnce(message, deps.createTraceStep('final', {
                            title: 'Resposta vazia',
                            body: 'O modelo concluiu a chamada sem texto visivel.'
                        }));
                    }
                    needsFullRender = true;
                }
            } else if (provider === 'codex') {
                const payload = snapshot?.result?.payload || {};
                if (payload.output_text) {
                    message.text = payload.output_text;
                    visibleHtml = deps.renderMarkdown(payload.output_text);
                }
                const totalTokens = payload.usage?.total_tokens ?? payload.usage?.output_tokens ?? 0;
                if (totalTokens) message.tok = totalTokens;
                if (status === 'failed') {
                    message.text = message.text || `[Falha: ${errorMessage || 'Falha ao executar o job Codex no backend.'}]`;
                    visibleHtml = `<p style="color:var(--danger);font-style:italic">${deps.esc(errorMessage || 'Falha ao executar o job Codex no backend.')}</p>`;
                    deps.pushMessageTraceOnce(message, deps.createTraceStep('error', {
                        title: 'Falha',
                        body: errorMessage || 'Falha ao executar o job Codex no backend.'
                    }));
                    needsFullRender = true;
                } else if (status === 'completed' && !payload.output_text) {
                    message.text = message.text || '[Resposta vazia - o Codex nao retornou texto visivel.]';
                    visibleHtml = '<p style="color:var(--muted);font-style:italic">O Codex concluiu sem texto visivel.</p>';
                    deps.pushMessageTraceOnce(message, deps.createTraceStep('final', {
                        title: 'Resposta vazia',
                        body: 'O Codex concluiu a chamada sem texto visivel.'
                    }));
                    needsFullRender = true;
                }
            }

            updateMessageChatJob(convId, msgIndex, {
                id: snapshot?.job?.id || message?.chatJob?.id,
                provider,
                status,
                finishedAt: snapshot?.job?.finished_at || null,
                updatedAt: snapshot?.job?.updated_at || Date.now(),
                error: snapshot?.job?.error || null
            }, false);

            if (deps.getActiveId() === convId) {
                if (status === 'completed' || status === 'failed' || needsFullRender) {
                    deps.renderChat();
                    if (provider === 'gemini' && message.text && status === 'completed') {
                        deps.revealMessageText(convId, msgIndex, message.text, { final: true });
                    }
                } else if (visibleHtml) {
                    deps.updateVisibleJobBubble(convId, msgIndex, visibleHtml);
                }
            }
            deps.saveConvs();
        }

        function rebuildPendingChatRequest(convId, msgIndex) {
            const conversation = deps.getConversations()?.[convId];
            const messages = deps.conversationMessages(conversation);
            const message = messages?.[msgIndex];
            const job = message?.chatJob;
            const resumeState = job?.resumeState;
            if (!conversation || !message || message.role !== 'model' || !resumeState) return null;

            const historyMessages = messages.slice(0, msgIndex);
            if (resumeState.provider === 'codex') {
                return {
                    provider: 'codex',
                    model: resumeState.model,
                    reasoning: resumeState.reasoning,
                    instructions: resumeState.instructions || '',
                    input: deps.buildCodexInputFromMessages(historyMessages),
                    tools: deps.buildCodexTools()
                };
            }

            return {
                provider: 'gemini',
                model: resumeState.model,
                request: deps.buildGeminiRequestFromMessages(historyMessages, {
                    model: resumeState.model,
                    think: resumeState.think,
                    temperature: resumeState.temperature,
                    topP: resumeState.topP,
                    topK: resumeState.topK,
                    maxOutputTokens: resumeState.maxOutputTokens,
                    systemPrompt: resumeState.systemPrompt || ''
                })
            };
        }

        function resumePendingChatJobs() {
            Object.entries(deps.getConversations() || {}).forEach(([convId, conversation]) => {
                const msgs = deps.conversationMessages(conversation);
                msgs.forEach((message, msgIndex) => {
                    const job = message?.chatJob;
                    if (!job) return;
                    if (job.status === 'completed' || job.status === 'failed') return;
                    const rebuiltRequest = !job.id && !job.pendingRequest
                        ? rebuildPendingChatRequest(convId, msgIndex)
                        : null;
                    const ensureJob = job.id
                        ? Promise.resolve(job.id)
                        : (job.pendingRequest
                            ? requestChatJob(job.pendingRequest).then((createdJob) => {
                                updateMessageChatJob(convId, msgIndex, {
                                    id: createdJob?.id || null,
                                    status: createdJob?.status || 'running',
                                    startedAt: createdJob?.created_at || Date.now(),
                                    pendingRequest: null,
                                    error: null
                                });
                                return createdJob?.id || null;
                            })
                            : (rebuiltRequest
                                ? requestChatJob(rebuiltRequest).then((createdJob) => {
                                    updateMessageChatJob(convId, msgIndex, {
                                        id: createdJob?.id || null,
                                        status: createdJob?.status || 'running',
                                        startedAt: createdJob?.created_at || Date.now(),
                                        pendingRequest: null,
                                        error: null
                                    });
                                    return createdJob?.id || null;
                                })
                                : Promise.resolve(null)));
                    ensureJob.then((jobId) => {
                        if (!jobId) {
                            if (message?.role === 'model') {
                                message.text = message.text || '[Falha: nao foi possivel retomar esta resposta automaticamente.]';
                                deps.pushMessageTraceOnce(message, deps.createTraceStep('error', {
                                    title: 'Retomada indisponivel',
                                    body: 'Nao foi possivel reconstruir ou localizar o job de chat salvo.'
                                }));
                            }
                            updateMessageChatJob(convId, msgIndex, {
                                status: 'failed',
                                finishedAt: Date.now(),
                                error: { message: 'Nao foi possivel retomar esta resposta automaticamente.' }
                            });
                            if (deps.getActiveId() === convId) deps.renderChat();
                            return;
                        }
                        return waitForChatJob(jobId, {
                            onSnapshot(snapshot) {
                                applyChatJobSnapshotToMessage(convId, msgIndex, snapshot);
                            }
                        });
                    }).catch((error) => {
                        if (message?.role === 'model') {
                            message.text = message.text || `[Falha: ${error.message || 'Falha ao retomar job de chat.'}]`;
                            deps.pushMessageTraceOnce(message, deps.createTraceStep('error', {
                                title: 'Falha na retomada',
                                body: error.message || 'Falha ao retomar job de chat.'
                            }));
                        }
                        updateMessageChatJob(convId, msgIndex, {
                            status: 'failed',
                            finishedAt: Date.now(),
                            error: { message: error.message || 'Falha ao retomar job de chat.' }
                        });
                        if (deps.getActiveId() === convId) deps.renderChat();
                    });
                });
            });
        }

        return {
            requestChatJob,
            fetchChatJobSnapshot,
            parseGeminiJobSnapshot,
            updateMessageChatJob,
            getConversationMessage,
            findConversationMessageIndex,
            waitForChatJob,
            applyChatJobSnapshotToMessage,
            rebuildPendingChatRequest,
            resumePendingChatJobs
        };
    }

    global.SkillFlowJobs = { init };
})(window);
