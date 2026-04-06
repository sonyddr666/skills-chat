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
            stop
        };
    }

    global.SkillFlowChat = { init };
})(window);
