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
            stop
        };
    }

    global.SkillFlowChat = { init };
})(window);
