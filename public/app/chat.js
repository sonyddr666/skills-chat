(function (global) {
    function init(deps) {
        function sanitizeUploadName(name, fallback = 'arquivo') {
            const cleaned = String(name || fallback)
                .replace(/[\\/:*?"<>|]+/g, '_')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 120);
            return cleaned || fallback;
        }

        async function persistPendingAttachments(items, folder) {
            const now = new Date();
            const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const persisted = [];

            for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                if (!item?.data) {
                    persisted.push(item);
                    continue;
                }

                const prefix = `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
                const fileName = sanitizeUploadName(item.name || `${folder}-${prefix}`);
                const path = `.uploads/${stamp}/${folder}/${prefix}-${fileName}`;
                const res = await global.fetch('/api/fs/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path,
                        content: item.data,
                        encoding: 'base64',
                        create_dirs: true
                    })
                });

                let data = null;
                try {
                    data = await res.json();
                } catch (_) {}

                if (!res.ok || !data?.ok) {
                    throw new Error(data?.error || `Falha ao salvar ${fileName}`);
                }

                persisted.push({
                    name: item.name || fileName,
                    mimeType: item.mimeType || '',
                    path: data.path,
                    downloadUrl: '/api/fs/download?path=' + encodeURIComponent(data.path),
                    data: item.data
                });
            }

            return persisted;
        }

        async function handleLiveSend(context) {
            const { conversationId, input, text, model } = context;
            const runtimeConfig = deps.getRuntimeConfig();
            if (!runtimeConfig?.live_client_enabled) {
                deps.toast('Live mode desabilitado por politica neste ambiente.');
                return { handled: true };
            }

            const apiKey = global.document.getElementById('api-in')?.value?.trim() || '';
            if (!apiKey) {
                deps.toast('⚠ Insira sua API Key!');
                return { handled: true };
            }

            const pendingFiles = deps.getPendingFiles();
            if (pendingFiles.length) {
                deps.toast('⚠ Gemini 3.1 Live aceita imagem nesse fluxo, mas nao arquivo de texto/codigo/PDF anexado.');
                return { handled: true };
            }

            input.value = '';
            deps.autoH(input);

            let imgsToSave = [...deps.getPendingImages()];
            let filesToSave = [...pendingFiles];
            deps.setPendingImages([]);
            deps.setPendingFiles([]);
            deps.renderImagePreview();

            try {
                imgsToSave = await persistPendingAttachments(imgsToSave, 'images');
                filesToSave = await persistPendingAttachments(filesToSave, 'files');
            } catch (error) {
                deps.setPendingImages(imgsToSave);
                deps.setPendingFiles(filesToSave);
                deps.renderImagePreview();
                deps.toast('⚠ Falha ao salvar anexos do usuario: ' + (error.message || 'erro desconhecido'));
                return { handled: true };
            }

            const geminiLive = deps.getGeminiLive();
            if (geminiLive.active && (geminiLive.pendingTranscript.trim() || geminiLive.pendingUserTranscript.trim())) {
                geminiLive.onTurnComplete();
            }

            const convs = deps.getConversations();
            const msgData = { id: deps.newMessageId('msg'), role: 'user', text, ts: Date.now(), live: true };
            if (imgsToSave.length) msgData.imgs = imgsToSave;
            if (filesToSave.length) msgData.files = filesToSave;
            convs[conversationId].msgs.push(msgData);
            convs[conversationId].ts = msgData.ts;
            if (convs[conversationId].msgs.length === 1) {
                convs[conversationId].title = text
                    ? text.slice(0, 48) + (text.length > 48 ? '…' : '')
                    : (imgsToSave.length ? 'Imagem enviada' : filesToSave[0]?.name || 'Arquivo enviado');
            }
            deps.saveConvs();
            deps.renderSidebar();
            deps.renderChat();

            if (!geminiLive.active) {
                try {
                    deps.setLiveMode(true);
                    global.document.getElementById('live-btn')?.classList.add('on');
                    await geminiLive.connect(apiKey, model);
                } catch (error) {
                    deps.setLiveMode(false);
                    global.document.getElementById('live-btn')?.classList.remove('on');
                    deps.toast('❌ Falha ao conectar Live: ' + (error.message || ''));
                    return { handled: true };
                }
            }

            geminiLive.sendTurn({
                text,
                images: imgsToSave,
                files: []
            });
            return { handled: true };
        }

        async function prepareStandardSend(context) {
            const { conversationId, input, text, model } = context;
            const usingCodex = deps.isCodexModel(model);
            const provider = usingCodex ? 'codex' : 'gemini';
            const credentialInput = global.document.getElementById('api-in');
            const rawCredential = credentialInput?.value?.trim() || '';

            try {
                if (rawCredential) await deps.saveProviderCredential(provider, rawCredential);
            } catch (error) {
                deps.toast('Erro ao salvar credencial: ' + (error?.message || error));
                return { blocked: true };
            }

            if (credentialInput && rawCredential) credentialInput.value = '';
            if (!deps.providerConfigured(provider)) {
                deps.toast(usingCodex ? 'Configure a credencial do Codex no servidor.' : 'Configure a API key do Gemini no servidor.');
                return { blocked: true };
            }

            const think = global.document.getElementById('think-lvl')?.value || '';
            const effectiveThink = usingCodex ? deps.normalizeCodexReasoning(think) : think;
            const isThinking = (deps.supportsThinking(model) && !!think) || (usingCodex && !!effectiveThink);
            const temp = parseFloat(global.document.getElementById('temp')?.value || '0');
            const topp = parseFloat(global.document.getElementById('topp')?.value || '0');
            const topk = parseInt(global.document.getElementById('topk')?.value || '0', 10);
            const maxt = parseInt(global.document.getElementById('maxt')?.value || '0', 10);
            const sysp = global.document.getElementById('sysp')?.value?.trim() || '';

            input.value = '';
            deps.autoH(input);

            let imgsToSave = [...deps.getPendingImages()];
            let filesToSave = [...deps.getPendingFiles()];
            deps.setPendingImages([]);
            deps.setPendingFiles([]);
            deps.renderImagePreview();

            const convs = deps.getConversations();
            const msgData = { id: deps.newMessageId('msg'), role: 'user', text, ts: Date.now() };
            if (imgsToSave.length) msgData.imgs = imgsToSave.map((item) => ({ ...item }));
            if (filesToSave.length) msgData.files = filesToSave.map((item) => ({ ...item }));
            convs[conversationId].msgs.push(msgData);
            convs[conversationId].ts = msgData.ts;
            if (convs[conversationId].msgs.length === 1) {
                convs[conversationId].title = text
                    ? text.slice(0, 48) + (text.length > 48 ? '…' : '')
                    : (msgData.imgs?.length ? 'Imagem enviada' : msgData.files?.[0]?.name || 'Arquivo enviado');
            }

            const modelMessageId = deps.newMessageId('msg');
            let mi = convs[conversationId].msgs.length;
            convs[conversationId].msgs.push({
                id: modelMessageId,
                role: 'model',
                text: '',
                ts: Date.now(),
                model,
                think: isThinking ? effectiveThink : undefined,
                trace: isThinking
                    ? [deps.createTraceStep('thinking', { title: 'Thinking', meta: `level=${effectiveThink}` })]
                    : [],
                chatJob: {
                    provider: usingCodex ? 'codex' : 'gemini',
                    status: 'preparing',
                    recoverable: true,
                    resumeState: usingCodex
                        ? {
                            provider: 'codex',
                            model,
                            reasoning: effectiveThink,
                            instructions: sysp
                        }
                        : {
                            provider: 'gemini',
                            model,
                            think,
                            temperature: temp,
                            topP: topp,
                            topK: topk,
                            maxOutputTokens: maxt,
                            systemPrompt: sysp
                        },
                    error: null
                }
            });

            convs[conversationId].ts = Date.now();
            deps.saveConvs();
            deps.renderSidebar();
            deps.renderChat(true);
            deps.scrollEnd(true);

            const refreshModelIndex = () => {
                mi = deps.findConversationMessageIndex(conversationId, modelMessageId);
                return mi;
            };
            const getCurrentModelMsg = () => {
                const currentIndex = refreshModelIndex();
                return currentIndex >= 0 ? deps.getConversationMessage(conversationId, currentIndex) : null;
            };
            const getCurrentModelBubble = () => {
                const currentIndex = refreshModelIndex();
                return currentIndex >= 0 ? global.document.getElementById(`bb${currentIndex}`) : null;
            };
            const getCurrentModelMeta = () => {
                const currentIndex = refreshModelIndex();
                return currentIndex >= 0 ? global.document.getElementById(`mt${currentIndex}`) : null;
            };
            const getCurrentHistoryMessages = () => {
                const currentIndex = refreshModelIndex();
                const msgs = deps.conversationMessages(deps.getConversations()?.[conversationId]);
                return currentIndex >= 0 ? msgs.slice(0, currentIndex) : msgs;
            };
            const updateCurrentModelChatJob = (patch, saveNow = true) => {
                const currentIndex = refreshModelIndex();
                if (currentIndex < 0) return null;
                return deps.updateMessageChatJob(conversationId, currentIndex, patch, saveNow);
            };

            const requestId = deps.nextGenerationSeq();
            const requestCtrl = new AbortController();
            deps.generationControllers.set(requestId, requestCtrl);
            deps.refreshGenerationUi();

            const thinkTimeout = isThinking ? 180000 : 60000;
            const autoAbort = global.setTimeout(() => {
                if (deps.generationControllers.has(requestId)) {
                    requestCtrl._stopReason = 'timeout';
                    requestCtrl.abort();
                }
            }, thinkTimeout);

            return {
                blocked: false,
                conversationId,
                model,
                usingCodex,
                provider,
                think,
                effectiveThink,
                isThinking,
                temp,
                topp,
                topk,
                maxt,
                sysp,
                msgData,
                imgsToSave,
                filesToSave,
                requestId,
                requestCtrl,
                autoAbort,
                refreshModelIndex,
                getCurrentModelMsg,
                getCurrentModelBubble,
                getCurrentModelMeta,
                getCurrentHistoryMessages,
                updateCurrentModelChatJob
            };
        }

        async function runStandardSend(prepared) {
            const {
                conversationId,
                model,
                usingCodex,
                think,
                effectiveThink,
                temp,
                topp,
                topk,
                maxt,
                sysp,
                msgData,
                requestId,
                requestCtrl,
                autoAbort,
                refreshModelIndex,
                getCurrentModelMsg,
                getCurrentModelBubble,
                getCurrentModelMeta,
                getCurrentHistoryMessages,
                updateCurrentModelChatJob
            } = prepared;
            let { imgsToSave, filesToSave } = prepared;

            try {
                imgsToSave = await persistPendingAttachments(imgsToSave, 'images');
                filesToSave = await persistPendingAttachments(filesToSave, 'files');
                if (imgsToSave.length) msgData.imgs = imgsToSave;
                else delete msgData.imgs;
                if (filesToSave.length) msgData.files = filesToSave;
                else delete msgData.files;
                deps.saveConvs();
                deps.renderChat(true);

                const body = deps.buildGeminiRequestFromMessages(getCurrentHistoryMessages(), {
                    model,
                    think,
                    temperature: temp,
                    topP: topp,
                    topK: topk,
                    maxOutputTokens: maxt,
                    systemPrompt: sysp
                });
                const bub = getCurrentModelBubble();

                const callAPI = async (reqBody, bubEl, depth = 0) => {
                    updateCurrentModelChatJob({
                        provider: 'gemini',
                        status: 'starting',
                        pendingRequest: {
                            provider: 'gemini',
                            model,
                            request: reqBody
                        },
                        error: null
                    });
                    const job = await deps.requestChatJob({
                        provider: 'gemini',
                        model,
                        request: reqBody
                    }, requestCtrl.signal);
                    if (!job?.id) throw new Error('Falha ao iniciar o job Gemini no backend.');

                    updateCurrentModelChatJob({
                        id: job.id,
                        provider: 'gemini',
                        status: job.status || 'running',
                        startedAt: job.created_at || Date.now(),
                        pendingRequest: null
                    });

                    let parsedSnapshot = { full: '', tok: 0, sig: '', fnCallParts: [] };
                    const snapshot = await deps.waitForChatJob(job.id, {
                        signal: requestCtrl.signal,
                        pollMs: 250,
                        onSnapshot(data) {
                            parsedSnapshot = deps.parseGeminiJobSnapshot(data?.raw_sse || '');
                            const currentMsg = getCurrentModelMsg();
                            if (!currentMsg) return;

                            updateCurrentModelChatJob({
                                id: job.id,
                                provider: 'gemini',
                                status: data?.job?.status || 'running',
                                updatedAt: data?.job?.updated_at || Date.now(),
                                error: data?.job?.error || null
                            }, false);

                            if (parsedSnapshot.full && currentMsg.text !== parsedSnapshot.full) {
                                currentMsg.text = parsedSnapshot.full;
                                if (parsedSnapshot.tok) currentMsg.tok = parsedSnapshot.tok;
                                if (parsedSnapshot.sig) currentMsg.sig = parsedSnapshot.sig;
                                deps.saveConvs();
                            }

                            if (parsedSnapshot.full && !parsedSnapshot.fnCallParts.length) {
                                const currentIndex = refreshModelIndex();
                                if (currentIndex >= 0) deps.revealMessageText(conversationId, currentIndex, parsedSnapshot.full);
                            }
                        }
                    });

                    updateCurrentModelChatJob({
                        id: job.id,
                        provider: 'gemini',
                        status: snapshot?.job?.status || 'completed',
                        finishedAt: snapshot?.job?.finished_at || Date.now(),
                        error: snapshot?.job?.error || null
                    });

                    if (snapshot?.job?.status === 'failed') {
                        throw new Error(snapshot?.job?.error?.message || 'Falha ao executar o job Gemini no backend.');
                    }

                    const { full, tok, sig: textSig, fnCallParts } = parsedSnapshot;

                    if (fnCallParts.length && depth < 6) {
                        fnCallParts.forEach((part) => {
                            deps.pushToolCallTrace(getCurrentModelMsg(), {
                                name: part?.functionCall?.name,
                                arguments: part?.functionCall?.args || {}
                            });
                        });
                        const callLabels = fnCallParts.map((part) => {
                            const args = part.functionCall.args || {};
                            const argStr = Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
                            return `<code style="background:var(--s2);padding:2px 6px;border-radius:4px">${part.functionCall.name}(${argStr})</code>`;
                        }).join(' <span style="color:var(--muted)">+</span> ');
                        const currentBubble = getCurrentModelBubble() || bubEl;
                        if (currentBubble) currentBubble.innerHTML = `<div style="color:var(--accent2);font-size:13px;display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap">
          <span style="display:inline-block;animation:bop 1s infinite">&#128269;</span>
          <span>Chamando ${callLabels} ...</span>
        </div>`;
                        deps.scrollEnd(true);

                        const results = await Promise.all(
                            fnCallParts.map((part) => deps.executePlugin(part.functionCall.name, part.functionCall.args || {}))
                        );
                        results.forEach((result, index) => {
                            deps.pushToolResultTrace(getCurrentModelMsg(), fnCallParts[index]?.functionCall?.name, result);
                        });
                        const currentFiles = results.flatMap((result) => deps.extractToolArtifacts(result));
                        const modelParts = fnCallParts;
                        const frParts = fnCallParts.map((part, index) => ({
                            functionResponse: { name: part.functionCall.name, response: results[index] }
                        }));
                        const updatedContents = [
                            ...reqBody.contents,
                            { role: 'model', parts: modelParts },
                            { role: 'user', parts: frParts }
                        ];
                        const nested = await callAPI({ ...reqBody, contents: updatedContents }, bubEl, depth + 1);
                        return {
                            ...nested,
                            files: deps.mergeMessageFiles(currentFiles, nested?.files || [])
                        };
                    }

                    return { full, tok, sig: textSig, files: [] };
                };

                let full = '';
                let tok = 0;
                let sig = '';
                let modelFiles = [];
                const codexTools = usingCodex ? deps.buildCodexTools() : [];

                const callCodexAPI = async (inputItems, depth) => {
                    updateCurrentModelChatJob({
                        provider: 'codex',
                        status: 'starting',
                        pendingRequest: {
                            provider: 'codex',
                            model,
                            reasoning: effectiveThink,
                            instructions: sysp,
                            input: inputItems,
                            tools: codexTools
                        },
                        error: null
                    });
                    const job = await deps.requestChatJob({
                        provider: 'codex',
                        model,
                        reasoning: effectiveThink,
                        instructions: sysp,
                        input: inputItems,
                        tools: codexTools
                    }, requestCtrl.signal);
                    if (!job?.id) throw new Error('Falha ao iniciar o job Codex no backend.');

                    updateCurrentModelChatJob({
                        id: job.id,
                        provider: 'codex',
                        status: job.status || 'running',
                        startedAt: job.created_at || Date.now(),
                        pendingRequest: null
                    });

                    const snapshot = await deps.waitForChatJob(job.id, {
                        signal: requestCtrl.signal,
                        pollMs: 400,
                        onSnapshot(data) {
                            updateCurrentModelChatJob({
                                id: job.id,
                                provider: 'codex',
                                status: data?.job?.status || 'running',
                                updatedAt: data?.job?.updated_at || Date.now(),
                                error: data?.job?.error || null
                            }, false);
                        }
                    });

                    updateCurrentModelChatJob({
                        id: job.id,
                        provider: 'codex',
                        status: snapshot?.job?.status || 'completed',
                        finishedAt: snapshot?.job?.finished_at || Date.now(),
                        error: snapshot?.job?.error || null
                    });

                    if (snapshot?.job?.status === 'failed') {
                        throw new Error(snapshot?.job?.error?.message || 'Falha ao executar o job Codex no backend.');
                    }

                    const result = snapshot?.result || {};
                    const payload = result?.payload || {};
                    const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
                    const outputItems = Array.isArray(payload.output_items) ? payload.output_items : [];

                    if (toolCalls.length) {
                        if (depth >= 6) throw new Error('Limite de function calls atingido para o Codex.');
                        toolCalls.forEach((call) => deps.pushToolCallTrace(getCurrentModelMsg(), call));

                        const callLabels = toolCalls.map((call) => {
                            const args = call.arguments || {};
                            const argStr = Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
                            return `<code style="background:var(--s2);padding:2px 6px;border-radius:4px">${call.name}(${argStr})</code>`;
                        }).join(' <span style="color:var(--muted)">+</span> ');

                        const currentBubble = getCurrentModelBubble() || bub;
                        if (currentBubble) currentBubble.innerHTML = `<div style="color:var(--accent2);font-size:13px;display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap">
          <span style="display:inline-block;animation:bop 1s infinite">&#128269;</span>
          <span>Chamando ${callLabels} ...</span>
        </div>`;
                        deps.scrollEnd(true);

                        const results = await Promise.all(
                            toolCalls.map((call) => deps.executePlugin(call.name, call.arguments || {}))
                        );
                        results.forEach((resultItem, index) => {
                            deps.pushToolResultTrace(getCurrentModelMsg(), toolCalls[index]?.name, resultItem);
                        });
                        const currentFiles = results.flatMap((resultItem) => deps.extractToolArtifacts(resultItem));
                        const assistantToolItems = outputItems.length
                            ? outputItems
                            : toolCalls.map((call) => ({
                                type: 'function_call',
                                id: call.id || call.call_id,
                                call_id: call.call_id,
                                name: call.name,
                                arguments: call.arguments_raw || JSON.stringify(call.arguments || {})
                            }));

                        const nextInput = [
                            ...inputItems,
                            ...assistantToolItems,
                            ...toolCalls.map((call, index) => ({
                                type: 'function_call_output',
                                call_id: call.call_id,
                                output: deps.stringifyCodexToolOutput(results[index])
                            }))
                        ];

                        const nested = await callCodexAPI(nextInput, depth + 1);
                        return {
                            ...nested,
                            files: deps.mergeMessageFiles(currentFiles, nested?.files || [])
                        };
                    }

                    return {
                        full: payload.output_text || '',
                        tok: deps.codexUsageTotalTokens(payload.usage),
                        files: []
                    };
                };

                if (usingCodex) {
                    const codexResult = await callCodexAPI(deps.buildCodexInputFromMessages(getCurrentHistoryMessages()), 0);
                    full = codexResult.full || '';
                    tok = codexResult.tok || 0;
                    modelFiles = codexResult.files || [];
                    if (full) {
                        const currentBubble = getCurrentModelBubble();
                        if (currentBubble) currentBubble.innerHTML = deps.renderMarkdown(full);
                        deps.scrollEnd(true);
                    }
                } else {
                    ({ full, tok, sig, files: modelFiles } = await callAPI(body, bub));
                }

                const currentModelIndex = refreshModelIndex();
                const currentModelMessage = deps.getConversationMessage(conversationId, currentModelIndex);
                if (currentModelIndex < 0 || !currentModelMessage) {
                    throw new Error('Resposta em andamento nao encontrada na conversa apos a sincronizacao.');
                }
                currentModelMessage.text = full || (usingCodex
                    ? '[Resposta vazia - o Codex nao retornou texto.]'
                    : '[Resposta vazia - o modelo executou ferramentas sem gerar texto.]');
                if (!full) {
                    const emptyBubble = getCurrentModelBubble();
                    if (emptyBubble) {
                        emptyBubble.innerHTML = usingCodex
                            ? '<p style="color:var(--muted);font-style:italic">O Codex respondeu sem texto visivel.</p>'
                            : '<p style="color:var(--muted);font-style:italic">O modelo executou ferramentas mas nao gerou texto de resposta.</p>';
                    }
                }
                const deliveredFiles = Array.isArray(modelFiles) ? modelFiles.length : 0;
                if (!full && deliveredFiles) {
                    currentModelMessage.text = `[Arquivo${deliveredFiles > 1 ? 's' : ''} entregue${deliveredFiles > 1 ? 's' : ''} - veja ${deliveredFiles > 1 ? 'os anexos abaixo' : 'o anexo abaixo'}.]`;
                    const artifactBubble = getCurrentModelBubble();
                    if (artifactBubble) {
                        artifactBubble.innerHTML = `<p style="color:var(--muted);font-style:italic">${deliveredFiles > 1 ? `${deliveredFiles} arquivos foram gerados` : 'Arquivo gerado'} e anexado${deliveredFiles > 1 ? 's' : ''} na conversa.</p>`;
                    }
                }
                if (tok) currentModelMessage.tok = tok;
                if (sig) currentModelMessage.sig = sig;
                if (Array.isArray(modelFiles) && modelFiles.length) currentModelMessage.files = modelFiles;
                deps.pushMessageTrace(getCurrentModelMsg(), deps.createTraceStep('final', {
                    title: 'Resposta final',
                    meta: [
                        tok ? `${tok.toLocaleString()} tok` : '',
                        deliveredFiles ? `${deliveredFiles} arquivo${deliveredFiles > 1 ? 's' : ''}` : ''
                    ].filter(Boolean).join(' • '),
                    body: full
                        ? deps.trimTraceText(full, 420)
                        : (deliveredFiles
                            ? `Resposta sem texto, mas com ${deliveredFiles} arquivo${deliveredFiles > 1 ? 's' : ''} entregue${deliveredFiles > 1 ? 's' : ''}.`
                            : 'Resposta sem texto visivel.')
                }));

                deps.stopMessageReveal(conversationId, currentModelIndex);
                const mt = getCurrentModelMeta();
                if (mt) {
                    if (tok) mt.insertAdjacentHTML('beforeend', `<span>${tok.toLocaleString()} tok</span>`);
                    mt.insertAdjacentHTML('beforeend', `<button class="cp" onclick="copyMsg(${currentModelIndex})">⎘ Copiar Tudo</button>`);
                    mt.insertAdjacentHTML('beforeend', `<button class="tts-btn" onclick="ttsSpeakMsg(${currentModelIndex})" id="tts-btn-${currentModelIndex}" title="Ouvir resposta">🔊</button>`);
                    if (global.document.getElementById('tts-autoplay')?.checked && !deps.isLiveMode()) deps.ttsSpeakMsg(currentModelIndex);
                }
                deps.saveConvs();
                deps.renderChat(true);
            } catch (err) {
                if (err.name === 'AbortError') {
                    deps.toast('⏹ Geracao interrompida.');
                    const currentIndex = refreshModelIndex();
                    if (currentIndex !== null && currentIndex >= 0) {
                        const abortedMsg = deps.getConversationMessage(conversationId, currentIndex);
                        const shouldDiscardPlaceholder = requestCtrl._stopReason === 'manual';
                        if (abortedMsg?.role === 'model' && !abortedMsg.text && deps.getConversations()?.[conversationId]?.msgs && shouldDiscardPlaceholder) {
                            deps.getConversations()[conversationId].msgs.splice(currentIndex, 1);
                        } else if (abortedMsg?.role === 'model') {
                            updateCurrentModelChatJob({
                                status: shouldDiscardPlaceholder ? 'cancelled' : 'failed',
                                finishedAt: Date.now(),
                                error: shouldDiscardPlaceholder ? null : { message: 'Geracao interrompida.' }
                            }, false);
                        }
                    }
                } else {
                    const friendlyMsg = err.message?.includes('Failed to fetch')
                        ? '🌐 Sem conexao ou o servidor demorou demais. Tente de novo.'
                        : err.message?.includes('timeout') || err.message?.includes('aborted')
                            ? '⏱ O modelo demorou para responder. Tente novamente ou reduza o Thinking Level.'
                            : err.message;
                    if (String(err.message || '').includes('Falha ao salvar')) {
                        deps.setPendingImages(Array.isArray(msgData?.imgs) ? msgData.imgs.map((item) => ({ ...item })) : []);
                        deps.setPendingFiles(Array.isArray(msgData?.files) ? msgData.files.map((item) => ({ ...item })) : []);
                        deps.renderImagePreview();
                    }
                    const currentIndex = refreshModelIndex();
                    if (currentIndex !== null && currentIndex >= 0) {
                        const failedMsg = deps.getConversationMessage(conversationId, currentIndex);
                        if (failedMsg?.role === 'model') {
                            failedMsg.text = failedMsg.text || `[Falha: ${friendlyMsg}]`;
                            deps.pushMessageTrace(failedMsg, deps.createTraceStep('error', {
                                title: 'Falha',
                                body: friendlyMsg
                            }));
                            updateCurrentModelChatJob({
                                status: 'failed',
                                finishedAt: Date.now(),
                                error: { message: friendlyMsg }
                            }, false);
                        }
                    }
                    deps.toast('❌ ' + friendlyMsg.slice(0, 70));
                }
                deps.saveConvs();
                deps.renderChat(true);
            } finally {
                global.clearTimeout(autoAbort);
                deps.generationControllers.delete(requestId);
                deps.refreshGenerationUi();
                deps.renderSidebar();
                if (deps.getActiveId() === conversationId) deps.scrollEnd(true);
            }
        }

        function stop() {
            deps.generationControllers.forEach((controller) => {
                try {
                    controller._stopReason = 'manual';
                    controller.abort();
                } catch (_) {}
            });
        }

        return {
            sanitizeUploadName,
            persistPendingAttachments,
            handleLiveSend,
            prepareStandardSend,
            runStandardSend,
            stop
        };
    }

    global.SkillFlowChat = { init };
})(window);
