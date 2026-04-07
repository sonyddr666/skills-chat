(function (global) {
    const TTS_API = '/api/tts';
    const TTS_FIRST_CHUNK_MAX_CHARS = 120;
    const TTS_MAX_CHARS_PER_CHUNK = 250;
    const TTS_PREFETCH_AHEAD = 2;

    function createRuntime(deps) {
        let ttsAudio = null;
        let ttsPlaying = false;
        let ttsVoices = [];
        let ttsMsgIndex = null;
        let ttsChunkControllers = new Map();
        let ttsChunkRequests = new Map();
        let ttsChunkUrls = new Map();
        let ttsSessionCounter = 0;
        let ttsActiveSession = 0;
        let ttsCurrentAudioResolver = null;

        function saveTTSCfg() {
            const voice = global.document.getElementById('tts-voice-sel')?.value || '';
            const autoplay = global.document.getElementById('tts-autoplay')?.checked || false;
            deps.storage.set('gc_tts_voice', voice, { silent: true });
            deps.storage.set('gc_tts_autoplay', autoplay ? '1' : '0', { silent: true });
        }

        function loadTTSCfg() {
            const voice = deps.storage.get('gc_tts_voice', '');
            const autoplay = deps.storage.get('gc_tts_autoplay') === '1';
            const sel = global.document.getElementById('tts-voice-sel');
            const ap = global.document.getElementById('tts-autoplay');
            if (sel && voice) {
                sel.value = voice;
                if (sel.value !== voice) {
                    const option = global.document.createElement('option');
                    option.value = voice;
                    option.selected = true;
                    option.textContent = '✏ ' + voice.split('__').pop().replace(/_/g, ' ');
                    sel.insertBefore(option, sel.firstChild);
                }
            }
            if (ap) ap.checked = autoplay;
        }

        async function ttsLoadVoices() {
            const sel = global.document.getElementById('tts-voice-sel');
            if (!sel) return;
            try {
                sel.innerHTML = '<option value="">Carregando…</option>';
                const res = await global.fetch(TTS_API + '/voices');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const raw = await res.text();
                console.log('[TTS] /vozes raw response:', raw.slice(0, 300));
                let data;
                try {
                    data = JSON.parse(raw);
                } catch (_) {
                    throw new Error('Resposta inválida: ' + raw.slice(0, 80));
                }

                const rawList = Array.isArray(data) ? data : (data.voices || data.vozes || Object.values(data)[0] || []);
                console.log('[TTS] raw voices sample:', JSON.stringify(rawList[0]));

                ttsVoices = rawList.map((voice) => {
                    if (typeof voice === 'string') {
                        const id = voice.includes('/') ? voice.split('/').pop() : voice;
                        return { id, label: id.split('__').pop().replace(/_/g, ' ') };
                    }
                    const rawId = voice.voiceId
                        || voice.voice_id
                        || voice.id
                        || (voice.name ? voice.name.split('/').pop() : null)
                        || String(voice);
                    const label = voice.displayName
                        || voice.display_name
                        || voice.label
                        || rawId.split('__').pop().replace(/_/g, ' ');
                    return { id: rawId, label };
                }).filter((voice) => voice.id && voice.id !== '[object Object]');

                console.log('[TTS] parsed voices:', ttsVoices.length, ttsVoices[0]);

                sel.innerHTML = ttsVoices.map((voice) => {
                    const cleanName = voice.id.includes('__') ? voice.id.split('__').pop() : voice.label;
                    return `<option value="${deps.esc(voice.id)}">${deps.esc(cleanName)}</option>`;
                }).join('');

                loadTTSCfg();
                deps.toast('✓ ' + ttsVoices.length + ' vozes carregadas!');
            } catch (error) {
                sel.innerHTML = '<option value="">Erro ao carregar vozes</option>';
                deps.toast('⚠ TTS: ' + error.message);
            }
        }

        function ttsFormatText(rawText) {
            return String(rawText || '')
                .replace(/```[\s\S]*?```/g, ' [bloco de codigo] ')
                .replace(/`[^`]+`/g, (match) => match.slice(1, -1))
                .replace(/#{1,6}\s/g, '')
                .replace(/\*\*(.*?)\*\*/g, '$1')
                .replace(/\*(.*?)\*/g, '$1')
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
                .replace(/^[\s]*[-*+][\s]/gm, '')
                .replace(/\n{2,}/g, '. ')
                .replace(/\n/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function ttsSplitLongSegment(text, maxChars) {
            const parts = [];
            let remaining = String(text || '').trim();
            while (remaining.length > maxChars) {
                let cut = remaining.lastIndexOf(' ', maxChars);
                if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
                parts.push(remaining.slice(0, cut).trim());
                remaining = remaining.slice(cut).trim();
            }
            if (remaining) parts.push(remaining);
            return parts;
        }

        function splitTextIntoChunks(text, firstChunkMaxChars = TTS_FIRST_CHUNK_MAX_CHARS, maxCharsPerChunk = TTS_MAX_CHARS_PER_CHUNK) {
            const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
            if (!cleaned) return [];

            const rawSentences = cleaned.match(/[^.!?\n;:]+[.!?\n;:]*/g) || [cleaned];
            const sentences = rawSentences.map((sentence) => sentence.trim()).filter(Boolean);
            const chunks = [];
            let currentChunk = '';

            const flushCurrent = () => {
                if (!currentChunk.trim()) return;
                chunks.push(currentChunk.trim());
                currentChunk = '';
            };

            for (const sentence of sentences) {
                let pending = [sentence];
                while (pending.length) {
                    const segment = pending.shift();
                    if (!segment) continue;
                    const maxChars = chunks.length === 0 ? firstChunkMaxChars : maxCharsPerChunk;

                    if (!currentChunk && segment.length > maxChars) {
                        const pieces = ttsSplitLongSegment(segment, maxChars);
                        currentChunk = pieces.shift() || '';
                        flushCurrent();
                        if (pieces.length) pending = pieces.concat(pending);
                        continue;
                    }

                    const candidate = currentChunk ? `${currentChunk} ${segment}` : segment;
                    if (candidate.length > maxChars && currentChunk) {
                        flushCurrent();
                        pending.unshift(segment);
                        continue;
                    }

                    currentChunk = candidate;
                }
            }

            flushCurrent();
            return chunks.length ? chunks : [cleaned];
        }

        function ttsIsSessionActive(sessionId) {
            return !!sessionId && ttsPlaying && ttsActiveSession === sessionId;
        }

        function ttsRevokeChunkUrls() {
            for (const url of ttsChunkUrls.values()) {
                try {
                    global.URL.revokeObjectURL(url);
                } catch (_) {}
            }
            ttsChunkUrls.clear();
        }

        function ttsAbortPendingFetches() {
            for (const controller of ttsChunkControllers.values()) {
                try {
                    controller.abort();
                } catch (_) {}
            }
            ttsChunkControllers.clear();
            ttsChunkRequests.clear();
        }

        function ttsSetBarLabel(text, chunkIndex = 0, totalChunks = 1) {
            const label = global.document.getElementById('tts-bar-label');
            if (!label) return;
            const prefix = totalChunks > 1 ? `[${chunkIndex + 1}/${totalChunks}] ` : '';
            label.textContent = prefix + text.slice(0, 60) + (text.length > 60 ? '...' : '');
        }

        function ttsResetUi(idx) {
            const targetIdx = idx ?? ttsMsgIndex;
            if (targetIdx !== null) {
                const btn = global.document.getElementById('tts-btn-' + targetIdx);
                if (btn) btn.classList.remove('playing');
            }
            ttsMsgIndex = null;
            global.document.getElementById('tts-bar')?.classList.remove('on');
            const label = global.document.getElementById('tts-bar-label');
            if (label) label.textContent = '';
        }

        function ttsCleanupPlayback(idx) {
            const activeAudio = ttsAudio;
            const resolveAudio = ttsCurrentAudioResolver;
            ttsCurrentAudioResolver = null;
            ttsSessionCounter += 1;
            if (activeAudio) {
                activeAudio.onended = null;
                activeAudio.onerror = null;
                try {
                    activeAudio.pause();
                    activeAudio.currentTime = 0;
                } catch (_) {}
            }
            ttsAudio = null;
            ttsPlaying = false;
            ttsActiveSession = 0;
            ttsAbortPendingFetches();
            ttsRevokeChunkUrls();
            ttsResetUi(idx);
            if (resolveAudio) resolveAudio('interrupted');
        }

        async function ttsFetchChunkAudio(text, voice, chunkIndex, sessionId) {
            if (!ttsIsSessionActive(sessionId)) return null;
            if (ttsChunkUrls.has(chunkIndex)) return ttsChunkUrls.get(chunkIndex);
            if (ttsChunkRequests.has(chunkIndex)) return ttsChunkRequests.get(chunkIndex);

            const controller = new AbortController();
            ttsChunkControllers.set(chunkIndex, controller);

            let request;
            request = (async () => {
                try {
                    const res = await global.fetch(TTS_API + '/speak', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ voice, text }),
                        signal: controller.signal
                    });
                    if (!res.ok) {
                        let errMsg = 'HTTP ' + res.status;
                        try {
                            const contentType = res.headers.get('content-type') || '';
                            const errBody = contentType.includes('json') ? await res.json() : await res.text();
                            if (typeof errBody === 'object') errMsg += ': ' + (errBody.error || JSON.stringify(errBody));
                            else if (errBody) errMsg += ': ' + String(errBody).slice(0, 120);
                        } catch (_) {}
                        throw new Error(errMsg);
                    }

                    const blob = await res.blob();
                    const url = global.URL.createObjectURL(blob);
                    if (!ttsIsSessionActive(sessionId)) {
                        try {
                            global.URL.revokeObjectURL(url);
                        } catch (_) {}
                        return null;
                    }
                    ttsChunkUrls.set(chunkIndex, url);
                    return url;
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return null;
                    throw error;
                } finally {
                    ttsChunkControllers.delete(chunkIndex);
                    if (ttsChunkRequests.get(chunkIndex) === request) {
                        ttsChunkRequests.delete(chunkIndex);
                    }
                }
            })();

            ttsChunkRequests.set(chunkIndex, request);
            return request;
        }

        function ttsPrefetchNext(chunks, voice, chunkIndex, sessionId) {
            if (!ttsIsSessionActive(sessionId)) return;
            if (chunkIndex >= chunks.length) return;
            if (ttsChunkUrls.has(chunkIndex) || ttsChunkRequests.has(chunkIndex)) return;
            void ttsFetchChunkAudio(chunks[chunkIndex], voice, chunkIndex, sessionId).catch((error) => {
                if (ttsIsSessionActive(sessionId)) console.warn('[TTS] Prefetch falhou:', error);
            });
        }

        function ttsPrimeChunkWindow(chunks, voice, currentChunkIndex, sessionId, prefetchAhead = TTS_PREFETCH_AHEAD) {
            if (!ttsIsSessionActive(sessionId)) return;
            const safeAhead = Math.max(0, Number(prefetchAhead) || 0);
            for (let offset = 0; offset <= safeAhead; offset += 1) {
                ttsPrefetchNext(chunks, voice, currentChunkIndex + offset, sessionId);
            }
        }

        function ttsPlayAudioUrl(audioUrl, sessionId) {
            return new Promise((resolve, reject) => {
                if (!ttsIsSessionActive(sessionId)) {
                    resolve('interrupted');
                    return;
                }

                const audio = new global.Audio(audioUrl);
                let settled = false;
                const finish = (status, error) => {
                    if (settled) return;
                    settled = true;
                    if (ttsCurrentAudioResolver === finish) ttsCurrentAudioResolver = null;
                    if (ttsAudio === audio) ttsAudio = null;
                    audio.onended = null;
                    audio.onerror = null;
                    if (status === 'error') reject(error || new Error('Erro ao reproduzir audio.'));
                    else resolve(status);
                };

                ttsAudio = audio;
                ttsCurrentAudioResolver = finish;
                audio.onended = () => finish('ended');
                audio.onerror = () => finish('error', new Error('Erro ao reproduzir audio.'));
                audio.play().then(() => {
                    if (!ttsIsSessionActive(sessionId)) finish('interrupted');
                }).catch((error) => finish('error', error));
            });
        }

        async function ttsPlayChunkQueue(idx, chunks, voice, sessionId) {
            ttsPrimeChunkWindow(chunks, voice, 0, sessionId);
            for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
                if (!ttsIsSessionActive(sessionId)) return 'interrupted';

                const currentChunk = chunks[chunkIndex];
                ttsSetBarLabel(currentChunk, chunkIndex, chunks.length);

                ttsPrimeChunkWindow(chunks, voice, chunkIndex, sessionId);
                const audioUrl = await ttsFetchChunkAudio(currentChunk, voice, chunkIndex, sessionId);
                if (!ttsIsSessionActive(sessionId)) return 'interrupted';
                if (!audioUrl) return 'interrupted';

                ttsPrimeChunkWindow(chunks, voice, chunkIndex + 1, sessionId);

                const playStatus = await ttsPlayAudioUrl(audioUrl, sessionId);
                if (playStatus !== 'ended') return playStatus;

                const staleUrl = ttsChunkUrls.get(chunkIndex);
                if (staleUrl) {
                    try {
                        global.URL.revokeObjectURL(staleUrl);
                    } catch (_) {}
                    ttsChunkUrls.delete(chunkIndex);
                }
            }

            if (ttsActiveSession === sessionId) {
                ttsCleanupPlayback(idx);
                return 'completed';
            }
            return 'interrupted';
        }

        async function ttsSpeakMsg(idx) {
            const convs = deps.getConversations();
            const activeId = deps.getActiveId();
            const msgs = convs[activeId]?.msgs;
            if (!msgs?.[idx]) return 'missing';
            const text = ttsFormatText(msgs[idx].text || '');

            if (!text) {
                deps.toast('⚠ Mensagem vazia.');
                return 'empty';
            }

            const voice = global.document.getElementById('tts-voice-sel')?.value;
            if (!voice) {
                deps.toast('⚠ Selecione uma voz em Configurações > TTS.');
                return 'missing-voice';
            }

            ttsStop();

            const chunks = splitTextIntoChunks(text);
            if (!chunks.length) {
                deps.toast('⚠ Mensagem vazia.');
                return 'empty';
            }

            const sessionId = ++ttsSessionCounter;
            ttsActiveSession = sessionId;
            ttsMsgIndex = idx;
            ttsPlaying = true;
            const btn = global.document.getElementById('tts-btn-' + idx);
            if (btn) btn.classList.add('playing');
            const bar = global.document.getElementById('tts-bar');
            if (bar) bar.classList.add('on');
            ttsSetBarLabel(text, 0, chunks.length);

            try {
                console.log('[TTS] voice selecionada no select:', voice);
                console.log('[TTS] texto total/chunks:', text.length, chunks.length);
                console.log('[TTS] janela de prefetch:', TTS_PREFETCH_AHEAD);
                return await ttsPlayChunkQueue(idx, chunks, voice, sessionId);
            } catch (error) {
                deps.toast('⚠ TTS: ' + error.message);
                ttsCleanupPlayback(idx);
                return 'error';
            }
        }

        function ttsStop(idx) {
            ttsCleanupPlayback(idx ?? ttsMsgIndex);
        }

        function bindStartup() {
            global.addEventListener('DOMContentLoaded', () => {
                global.fetch(TTS_API + '/health')
                    .then((response) => response.json())
                    .then((data) => {
                        console.log('[TTS] API online:', data);
                        return ttsLoadVoices().then(() => loadTTSCfg());
                    })
                    .catch((error) => {
                        console.warn('[TTS] API offline ou CORS bloqueado:', error.message);
                        const sel = global.document.getElementById('tts-voice-sel');
                        if (sel) sel.innerHTML = '<option value="">API offline - cole Voice ID manualmente</option>';
                    });
            });
        }

        bindStartup();

        return {
            saveTTSCfg,
            loadTTSCfg,
            ttsLoadVoices,
            ttsSpeakMsg,
            ttsStop
        };
    }

    global.SkillFlowTts = {
        init(deps) {
            const runtime = createRuntime(deps);
            global.saveTTSCfg = runtime.saveTTSCfg;
            global.loadTTSCfg = runtime.loadTTSCfg;
            global.ttsLoadVoices = runtime.ttsLoadVoices;
            global.ttsSpeakMsg = runtime.ttsSpeakMsg;
            global.ttsStop = runtime.ttsStop;
            return runtime;
        }
    };
})(window);
