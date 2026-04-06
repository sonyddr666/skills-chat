(function (global) {
    function init(deps) {
        let geminiLive = null;

        function getGeminiLive() {
            return geminiLive;
        }

        function liveSetHUD(state, label) {
            deps.setLiveState(state);
            const hud = global.document.getElementById('live-hud');
            const dot = global.document.getElementById('live-hud-dot');
            const lbl = global.document.getElementById('live-hud-label');
            const barW = global.document.getElementById('live-silence-bar-wrap');
            const bar = global.document.getElementById('live-silence-bar');

            hud?.classList.toggle('on', state !== 'idle');
            if (dot) {
                dot.className = '';
                if (state !== 'idle') dot.classList.add(state);
            }
            if (lbl) lbl.textContent = label || '';
            global.clearInterval(deps.getLiveBarInterval());
            if (bar) bar.style.width = '100%';
            if (barW) barW.style.display = (state === 'listening' && deps.getLiveSilenceStart()) ? 'block' : 'none';
            if (state === 'listening' && deps.getLiveSilenceStart()) {
                const intervalId = global.setInterval(() => {
                    if (!deps.getLiveSilenceStart()) return;
                    const pct = Math.max(0, 100 - ((Date.now() - deps.getLiveSilenceStart()) / deps.LIVE_SILENCE_MS) * 100);
                    if (bar) bar.style.width = pct + '%';
                    if (pct <= 0) global.clearInterval(intervalId);
                }, 50);
                deps.setLiveBarInterval(intervalId);
            }
        }

        function createGeminiLive() {
            geminiLive = {
                ws: null,
                captureCtx: null,
                playbackCtx: null,
                mediaStream: null,
                scriptNode: null,
                sourceNode: null,
                active: false,
                sessionModel: '',
                playbackScheduledTime: 0,
                pendingTranscript: '',
                pendingUserTranscript: '',
                liveStreamingEl: null,
                liveUserBubble: null,
                previewRecognition: null,
                previewRecognitionActive: false,
                previewText: '',
                previewRenderedText: '',
                previewRestartTimer: null,
                screenShareStream: null,
                screenShareVideo: null,
                screenShareCanvas: null,
                screenShareInterval: null,
                screenShareActive: false,
                pendingTrace: [],
                turnId: 0,

                async connect(apiKey, model) {
                    if (this.active) this.disconnect();
                    this.sessionModel = model;
                    liveSetHUD('processing', 'Conectando ao Gemini Live...');

                    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

                    return new Promise((resolve, reject) => {
                        let settled = false;
                        const ws = new WebSocket(url);
                        this.ws = ws;

                        ws.onopen = () => {
                            const sysp = global.document.getElementById('sysp')?.value?.trim() || '';
                            const liveVoice = global.document.getElementById('live-voice-sel')?.value || 'Puck';
                            const liveTools = [{ googleSearch: {} }];
                            const enabled = deps.buildGeminiToolEntries();
                            if (enabled.length) {
                                liveTools.push({
                                    functionDeclarations: enabled.map(({ plugin, callName }) => ({
                                        name: callName,
                                        description: plugin.description,
                                        parameters: deps.lowercaseTypes(deps.normalizeParams(plugin.parameters))
                                    }))
                                });
                            }

                            const setup = {
                                setup: {
                                    model: `models/${model}`,
                                    generationConfig: {
                                        responseModalities: ['AUDIO'],
                                        speechConfig: {
                                            voiceConfig: {
                                                prebuiltVoiceConfig: { voiceName: liveVoice }
                                            }
                                        }
                                    },
                                    outputAudioTranscription: {},
                                    inputAudioTranscription: {}
                                }
                            };

                            if (sysp) setup.setup.systemInstruction = { parts: [{ text: sysp }] };
                            if (liveTools.length) setup.setup.tools = liveTools;

                            console.log('[GeminiLive] Setup:', JSON.stringify(setup, null, 2));
                            ws.send(JSON.stringify(setup));
                        };

                        ws.onmessage = async (event) => {
                            try {
                                let raw = event.data;
                                if (raw instanceof Blob) raw = await raw.text();
                                const msg = JSON.parse(raw);
                                this.handleMessage(msg, () => {
                                    if (!settled) {
                                        settled = true;
                                        resolve();
                                    }
                                });
                            } catch (error) {
                                console.error('[GeminiLive] Parse error:', error);
                            }
                        };

                        ws.onerror = (error) => {
                            console.error('[GeminiLive] WebSocket error:', error);
                            if (!settled) {
                                settled = true;
                                reject(error);
                            }
                            this.disconnect();
                            deps.toast('Erro na conexao Live');
                        };

                        ws.onclose = (event) => {
                            console.log('[GeminiLive] Closed:', event.code, event.reason);
                            if (this.active) {
                                this.active = false;
                                deps.setLiveMode(false);
                                liveSetHUD('idle', '');
                                global.document.getElementById('live-btn')?.classList.remove('on');
                                deps.toast('Sessao Live encerrada');
                            }
                            if (!settled) {
                                settled = true;
                                reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
                            }
                        };

                        global.setTimeout(() => {
                            if (!settled) {
                                settled = true;
                                reject(new Error('Timeout'));
                                this.disconnect();
                            }
                        }, 15000);
                    });
                },

                handleMessage(msg, onSetup) {
                    if (msg.setupComplete) {
                        this.active = true;
                        liveSetHUD('listening', 'Gemini Live ativo - fale!');
                        this.startAudioCapture();
                        this.startPreviewTranscription();
                        if (onSetup) onSetup();
                        return;
                    }

                    if (msg.serverContent) {
                        const sc = msg.serverContent;

                        if (sc.interrupted) {
                            this.clearPlayback();
                            if ((this.pendingUserTranscript.trim() || this.pendingTranscript.trim() || this.pendingTrace.length) && deps.getActiveId()) {
                                this.onTurnComplete();
                            }
                            this.pendingTranscript = '';
                            this.pendingUserTranscript = '';
                            this.pendingTrace = [];
                            this.liveStreamingEl = null;
                            this.liveUserBubble = null;
                            this.clearInputPreview();
                            this.startPreviewTranscription();
                            liveSetHUD('listening', 'Interrompido - ouvindo...');
                            return;
                        }

                        const parts = sc.modelTurn?.parts || [];
                        for (const part of parts) {
                            if (part.inlineData?.mimeType?.includes('audio/pcm')) {
                                this.stopPreviewTranscription({ preserveDisplay: true });
                                liveSetHUD('playing', 'Respondendo...');
                                this.queueAudio(part.inlineData.data);
                            }
                        }

                        if (sc.inputTranscription?.text) {
                            const userText = sc.inputTranscription.text;
                            console.log('[GeminiLive] InputTranscription:', userText);
                            this.pendingUserTranscript = this.mergeTranscriptText(this.pendingUserTranscript, userText);
                            if (!this.previewRecognitionActive || this.isAndroidDevice()) {
                                this.renderInputPreview(this.pendingUserTranscript);
                            }

                            if (!deps.getActiveId()) deps.newConversation();
                            if (!this.liveUserBubble) {
                                const chatEl = global.document.getElementById('chat');
                                if (chatEl) {
                                    const div = global.document.createElement('div');
                                    div.className = 'row user animate-in';
                                    div.innerHTML = `<div class="av">User</div><div style="flex:1; max-width: calc(100% - 42px);"><div class="bub"><p class="live-user-text"></p></div><div class="meta"><span>${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</span> <span style="background:#ff4757;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700">LIVE</span></div></div>`;
                                    chatEl.appendChild(div);
                                    this.liveUserBubble = div.querySelector('.live-user-text');
                                    chatEl.scrollTop = chatEl.scrollHeight;
                                }
                            }
                            if (this.liveUserBubble) {
                                this.liveUserBubble.textContent = this.pendingUserTranscript;
                                global.document.getElementById('chat').scrollTop = global.document.getElementById('chat').scrollHeight;
                            }
                        }

                        if (sc.outputTranscription?.text) {
                            this.stopPreviewTranscription({ preserveDisplay: true });
                            const modelText = sc.outputTranscription.text;
                            console.log('[GeminiLive] OutputTranscription:', modelText);
                            this.pendingTranscript = this.mergeTranscriptText(this.pendingTranscript, modelText);

                            if (!deps.getActiveId()) deps.newConversation();
                            if (!this.liveStreamingEl) {
                                this.liveUserBubble = null;
                                const chatEl = global.document.getElementById('chat');
                                if (chatEl) {
                                    const div = global.document.createElement('div');
                                    div.className = 'row model animate-in';
                                    div.innerHTML = `<div class="av">SF</div><div style="flex:1; max-width: calc(100% - 42px);"><div class="bub"><p class="live-model-text"></p></div><div class="meta"><span>${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</span> <span style="color:var(--accent2)">${this.sessionModel || 'gemini-3.1-flash-live-preview'}</span> <span style="background:#ff4757;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700">LIVE</span></div></div>`;
                                    chatEl.appendChild(div);
                                    this.liveStreamingEl = div.querySelector('.live-model-text');
                                    chatEl.scrollTop = chatEl.scrollHeight;
                                }
                            }
                            if (this.liveStreamingEl) {
                                this.liveStreamingEl.textContent = this.pendingTranscript;
                                global.document.getElementById('chat').scrollTop = global.document.getElementById('chat').scrollHeight;
                            }
                        }

                        if (sc.turnComplete) {
                            this.onTurnComplete();
                        }
                        return;
                    }

                    if (msg.toolCall) {
                        this.handleToolCall(msg.toolCall);
                    }
                },

                async handleToolCall(toolCall) {
                    const fcs = toolCall.functionCalls || [];
                    if (!fcs.length) return;

                    const names = fcs.map(fc => fc.name).join(', ');
                    liveSetHUD('processing', `Executando ${names}`);

                    fcs.forEach(fc => {
                        this.pendingTrace.push(deps.createTraceStep('tool_call', {
                            title: fc.name || 'tool',
                            meta: deps.summarizeTraceArgs(fc.args || {})
                        }));
                    });

                    const results = await Promise.all(
                        fcs.map(fc => deps.executePlugin(fc.name, fc.args || {}))
                    );
                    results.forEach((result, index) => {
                        const files = deps.extractToolArtifacts(result);
                        this.pendingTrace.push(deps.createTraceStep('tool_result', {
                            title: fcs[index]?.name || 'tool_result',
                            meta: files.length ? `${files.length} artifact${files.length > 1 ? 's' : ''}` : '',
                            body: deps.summarizeToolResult(result)
                        }));
                    });

                    const response = {
                        toolResponse: {
                            functionResponses: fcs.map((fc, index) => ({
                                name: fc.name,
                                id: fc.id,
                                response: results[index]
                            }))
                        }
                    };

                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify(response));
                    }
                },
                sendText(text) {
                    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                    this.ws.send(JSON.stringify({ realtimeInput: { text } }));
                    liveSetHUD('processing', 'Processando...');
                },

                sendTurn({ text = '', images = [], files = [] } = {}) {
                    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                    const supportedImages = (images || []).filter(img =>
                        img?.data && /^(image\/png|image\/jpeg)$/i.test(img.mimeType || '')
                    );
                    const rejectedImages = (images || []).filter(img =>
                        img?.data && !/^(image\/png|image\/jpeg)$/i.test(img.mimeType || '')
                    );

                    supportedImages.forEach(img => {
                        this.ws.send(JSON.stringify({
                            realtimeInput: {
                                video: {
                                    data: img.data,
                                    mimeType: img.mimeType
                                }
                            }
                        }));
                    });

                    if (text) {
                        this.ws.send(JSON.stringify({ realtimeInput: { text } }));
                    }

                    if (!text && supportedImages.length) {
                        this.ws.send(JSON.stringify({
                            realtimeInput: {
                                text: 'Analise as imagens enviadas.'
                            }
                        }));
                    }

                    if (rejectedImages.length) deps.toast('No Gemini 3.1 Live, envie imagens JPG ou PNG.');
                    if (files?.length) deps.toast('Arquivos anexados fora de imagem nao sao suportados no Gemini 3.1 Live.');
                    if (!text && !supportedImages.length) return;
                    liveSetHUD('processing', 'Processando...');
                },

                updateScreenShareUi() {
                    global.document.getElementById('live-screen-btn')?.classList.toggle('on', !!this.screenShareActive);
                },

                async startScreenShare(intervalMs = 5000) {
                    if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                        deps.toast('Ative o Gemini Live antes de compartilhar a tela.');
                        return false;
                    }
                    if (this.screenShareActive) return true;

                    const stream = await navigator.mediaDevices.getDisplayMedia({
                        video: { frameRate: { ideal: 1, max: 1 } },
                        audio: false
                    });

                    const video = global.document.createElement('video');
                    video.autoplay = true;
                    video.muted = true;
                    video.playsInline = true;
                    video.srcObject = stream;
                    await video.play();

                    const canvas = global.document.createElement('canvas');
                    const track = stream.getVideoTracks()[0];
                    if (track) {
                        track.onended = () => this.stopScreenShare({ silent: true });
                    }

                    this.screenShareStream = stream;
                    this.screenShareVideo = video;
                    this.screenShareCanvas = canvas;
                    this.screenShareActive = true;
                    this.updateScreenShareUi();
                    await this.sendScreenFrame();
                    this.screenShareInterval = global.setInterval(() => {
                        this.sendScreenFrame();
                    }, intervalMs);
                    deps.toast('Tela compartilhada com o Gemini Live.');
                    return true;
                },

                async sendScreenFrame() {
                    if (!this.screenShareActive || !this.screenShareVideo || !this.screenShareCanvas) return;
                    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

                    const video = this.screenShareVideo;
                    const width = video.videoWidth || 0;
                    const height = video.videoHeight || 0;
                    if (!width || !height) return;

                    const maxWidth = 1280;
                    const scale = Math.min(1, maxWidth / width);
                    const targetWidth = Math.max(1, Math.round(width * scale));
                    const targetHeight = Math.max(1, Math.round(height * scale));
                    const canvas = this.screenShareCanvas;
                    canvas.width = targetWidth;
                    canvas.height = targetHeight;

                    const ctx = canvas.getContext('2d', { alpha: false });
                    if (!ctx) return;
                    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

                    const frameData = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
                    if (!frameData) return;

                    this.ws.send(JSON.stringify({
                        realtimeInput: {
                            video: {
                                data: frameData,
                                mimeType: 'image/jpeg'
                            }
                        }
                    }));
                },

                stopScreenShare(options = {}) {
                    global.clearInterval(this.screenShareInterval);
                    this.screenShareInterval = null;
                    if (this.screenShareStream) {
                        this.screenShareStream.getTracks().forEach(track => track.stop());
                        this.screenShareStream = null;
                    }
                    if (this.screenShareVideo) {
                        this.screenShareVideo.pause();
                        this.screenShareVideo.srcObject = null;
                        this.screenShareVideo = null;
                    }
                    this.screenShareCanvas = null;
                    this.screenShareActive = false;
                    this.updateScreenShareUi();
                    if (!options.silent) deps.toast('Compartilhamento de tela encerrado.');
                },

                onTurnComplete() {
                    if (!deps.getActiveId()) deps.newConversation();
                    const activeId = deps.getActiveId();
                    const convs = deps.getConversations();
                    if (!activeId || !convs[activeId]) return;

                    if (this.pendingUserTranscript.trim()) {
                        convs[activeId].msgs.push({
                            id: deps.newMessageId('msg'),
                            role: 'user',
                            text: this.pendingUserTranscript.trim(),
                            ts: Date.now(),
                            live: true
                        });
                        const userMsgs = convs[activeId].msgs.filter(m => m.role === 'user');
                        if (userMsgs.length === 1) {
                            const title = this.pendingUserTranscript.trim();
                    convs[activeId].title = title.slice(0, 48) + (title.length > 48 ? '...' : '');
                        }
                    }
                    this.pendingUserTranscript = '';

                    if (this.pendingTranscript.trim() || this.pendingTrace.length) {
                        const modelTrace = this.pendingTrace.slice(0, 30);
                        modelTrace.push(deps.createTraceStep('final', {
                            title: 'Resposta final',
                            meta: 'live',
                            body: this.pendingTranscript.trim() || 'Turno sem texto final visivel.'
                        }));
                        convs[activeId].msgs.push({
                            id: deps.newMessageId('msg'),
                            role: 'model',
                            text: this.pendingTranscript.trim() || '[Trace do live disponivel abaixo.]',
                            ts: Date.now(),
                            model: this.sessionModel,
                            live: true,
                            trace: modelTrace
                        });
                    }
                    this.pendingTranscript = '';
                    this.pendingTrace = [];
                    this.previewText = '';
                    this.liveStreamingEl = null;
                    this.liveUserBubble = null;

                    deps.saveConvs();
                    deps.renderSidebar();
                    deps.renderChat();

                    const remaining = this.playbackCtx
                        ? Math.max(0, this.playbackScheduledTime - this.playbackCtx.currentTime)
                        : 0;
                    global.setTimeout(() => {
                        if (this.active) {
                            this.clearInputPreview();
                            liveSetHUD('listening', 'Ouvindo...');
                            this.startPreviewTranscription();
                        }
                    }, remaining * 1000 + 300);
                },

                renderInputPreview(text) {
                    const msgEl = global.document.getElementById('msg');
                    if (!msgEl || !deps.isLiveMode()) return;
                    msgEl.value = text || '';
                    this.previewRenderedText = msgEl.value;
                    deps.autoH(msgEl);
                },

                clearInputPreview() {
                    const msgEl = global.document.getElementById('msg');
                    if (msgEl && (!msgEl.value.trim() || msgEl.value === this.previewRenderedText)) {
                        msgEl.value = '';
                        deps.autoH(msgEl);
                    }
                    this.previewRenderedText = '';
                },

                isAndroidDevice() {
                    return /Android/i.test(navigator.userAgent || '');
                },

                mergeTranscriptText(base, chunk) {
                    const current = String(base || '').replace(/\s+/g, ' ').trim();
                    const incoming = String(chunk || '').replace(/\s+/g, ' ').trim();
                    if (!incoming) return current;
                    if (!current) return incoming;
                    if (current === incoming || current.endsWith(incoming)) return current;
                    if (incoming.startsWith(current)) return incoming;

                    const maxOverlap = Math.min(current.length, incoming.length);
                    for (let len = maxOverlap; len > 0; len--) {
                        if (current.slice(-len) === incoming.slice(0, len)) {
                            return `${current}${incoming.slice(len)}`.replace(/\s+/g, ' ').trim();
                        }
                    }
                    return `${current} ${incoming}`.replace(/\s+/g, ' ').trim();
                },

                startPreviewTranscription() {
                    if (!this.active || !deps.isLiveMode()) return;
                    if (this.isAndroidDevice()) return;
                    if (this.previewRecognitionActive || this.previewRecognition) return;
                    const SpeechAPI = global.window.SpeechRecognition || global.window.webkitSpeechRecognition;
                    if (!SpeechAPI) return;

                    global.clearTimeout(this.previewRestartTimer);
                    this.previewRestartTimer = null;
                    this.previewText = '';
                    this.clearInputPreview();

                    const recognition = new SpeechAPI();
                    recognition.lang = 'pt-BR';
                    recognition.interimResults = true;
                    recognition.continuous = true;
                    recognition.maxAlternatives = 1;

                    recognition.onstart = () => {
                        this.previewRecognitionActive = true;
                    };

                    recognition.onresult = (event) => {
                        if (!this.active || !deps.isLiveMode()) return;
                        let finalText = this.previewText;
                        let interimText = '';

                        for (let i = event.resultIndex; i < event.results.length; i++) {
                            const transcript = event.results[i][0]?.transcript?.trim();
                            if (!transcript) continue;
                            if (event.results[i].isFinal) {
                                finalText = this.mergeTranscriptText(finalText, transcript);
                            } else {
                                interimText = this.mergeTranscriptText(interimText, transcript);
                            }
                        }

                        this.previewText = finalText.trim();
                        const displayText = [this.previewText, interimText.trim()].filter(Boolean).join(' ').trim();
                        if (displayText) {
                            this.renderInputPreview(displayText);
                        }
                    };

                    recognition.onerror = (event) => {
                        this.previewRecognitionActive = false;
                        if (event.error === 'no-speech' || event.error === 'aborted') return;
                        console.warn('[GeminiLive] Preview STT error:', event.error);
                    };

                    recognition.onend = () => {
                        this.previewRecognitionActive = false;
                        this.previewRecognition = null;
                        if (!this.active || !deps.isLiveMode() || this.pendingTranscript.trim()) return;
                        global.clearTimeout(this.previewRestartTimer);
                        this.previewRestartTimer = global.setTimeout(() => {
                            this.startPreviewTranscription();
                        }, 180);
                    };

                    this.previewRecognition = recognition;
                    try {
                        recognition.start();
                    } catch (error) {
                        this.previewRecognition = null;
                        this.previewRecognitionActive = false;
                        console.warn('[GeminiLive] Preview STT start failed:', error);
                    }
                },

                stopPreviewTranscription(options = {}) {
                    global.clearTimeout(this.previewRestartTimer);
                    this.previewRestartTimer = null;
                    const recognition = this.previewRecognition;
                    this.previewRecognition = null;
                    this.previewRecognitionActive = false;
                    if (recognition) {
                        recognition.onstart = null;
                        recognition.onresult = null;
                        recognition.onerror = null;
                        recognition.onend = null;
                        try { recognition.stop(); } catch (_) {}
                    }
                    if (!options.preserveDisplay) {
                        this.previewText = '';
                        this.clearInputPreview();
                    }
                },

                async startAudioCapture() {
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                                sampleRate: { ideal: 16000 },
                                channelCount: 1,
                                echoCancellation: true,
                                noiseSuppression: true,
                                autoGainControl: true
                            }
                        });

                        this.mediaStream = stream;
                        this.captureCtx = new (global.window.AudioContext || global.window.webkitAudioContext)({
                            sampleRate: 16000
                        });

                        const source = this.captureCtx.createMediaStreamSource(stream);
                        const processor = this.captureCtx.createScriptProcessor(4096, 1, 1);

                        processor.onaudioprocess = (event) => {
                            if (!this.active || this.ws?.readyState !== WebSocket.OPEN) return;
                            const float32 = event.inputBuffer.getChannelData(0);
                            const int16 = new Int16Array(float32.length);
                            for (let i = 0; i < float32.length; i++) {
                                const sample = Math.max(-1, Math.min(1, float32[i]));
                                int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                            }

                            const bytes = new Uint8Array(int16.buffer);
                            let binary = '';
                            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                            const base64 = btoa(binary);

                            this.ws.send(JSON.stringify({
                                realtimeInput: {
                                    audio: {
                                        mimeType: 'audio/pcm;rate=16000',
                                        data: base64
                                    }
                                }
                            }));
                        };

                        source.connect(processor);
                        processor.connect(this.captureCtx.destination);
                        this.scriptNode = processor;
                        this.sourceNode = source;
                    } catch (error) {
                        console.error('[GeminiLive] Audio capture error:', error);
                    deps.toast('Mic: ' + error.message);
                        this.disconnect();
                    }
                },

                queueAudio(base64PCM) {
                    if (!this.playbackCtx) {
                        this.playbackCtx = new (global.window.AudioContext || global.window.webkitAudioContext)({
                            sampleRate: 24000
                        });
                        this.playbackScheduledTime = 0;
                    }

                    const binary = atob(base64PCM);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    const int16 = new Int16Array(bytes.buffer);
                    const float32 = new Float32Array(int16.length);
                    for (let i = 0; i < int16.length; i++) {
                        float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
                    }

                    const buffer = this.playbackCtx.createBuffer(1, float32.length, 24000);
                    buffer.getChannelData(0).set(float32);

                    const src = this.playbackCtx.createBufferSource();
                    src.buffer = buffer;
                    src.connect(this.playbackCtx.destination);

                    const now = this.playbackCtx.currentTime;
                    const startTime = Math.max(now + 0.01, this.playbackScheduledTime);
                    src.start(startTime);
                    this.playbackScheduledTime = startTime + buffer.duration;
                },

                clearPlayback() {
                    this.playbackScheduledTime = 0;
                    if (this.playbackCtx) {
                        this.playbackCtx.close().catch(() => {});
                        this.playbackCtx = null;
                    }
                },

                disconnect() {
                    if ((this.pendingUserTranscript.trim() || this.pendingTranscript.trim() || this.pendingTrace.length) && deps.getActiveId()) {
                        this.onTurnComplete();
                    }
                    this.stopPreviewTranscription();
                    this.stopScreenShare({ silent: true });
                    this.active = false;
                    this.pendingTranscript = '';
                    this.pendingUserTranscript = '';
                    this.pendingTrace = [];
                    this.liveStreamingEl = null;
                    this.liveUserBubble = null;

                    if (this.scriptNode) { this.scriptNode.disconnect(); this.scriptNode = null; }
                    if (this.sourceNode) { this.sourceNode.disconnect(); this.sourceNode = null; }
                    if (this.captureCtx) { this.captureCtx.close().catch(() => {}); this.captureCtx = null; }
                    if (this.mediaStream) {
                        this.mediaStream.getTracks().forEach(track => track.stop());
                        this.mediaStream = null;
                    }
                    this.clearPlayback();
                    if (this.ws) { this.ws.close(); this.ws = null; }

                    deps.setLiveMode(false);
                    liveSetHUD('idle', '');
                    global.document.getElementById('live-btn')?.classList.remove('on');
                }
            };

            return geminiLive;
        }

        async function startLiveForCurrentModel(options = {}) {
            const model = global.document.getElementById('model-sel')?.value || '';

            if (deps.isLiveModel(model)) {
                if (!deps.getRuntimeConfig()?.live_client_enabled) {
                    if (!options.silent) deps.toast('Live mode desabilitado por politica neste ambiente.');
                    return false;
                }
                const apiKey = global.document.getElementById('api-in')?.value?.trim() || '';
                if (!apiKey) {
                    if (!options.silent) deps.toast('Insira sua API Key!');
                    return false;
                }

                const isSecure = global.location.protocol === 'https:' || global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1';
                if (!isSecure) {
                    if (!options.silent) deps.toast('Live Mode requer HTTPS.');
                    return false;
                }
                if (!await deps.ensureMicPermission()) return false;

                if (!deps.getActiveId()) deps.newConversation();

                try {
                    deps.setLiveMode(true);
                    global.document.getElementById('live-btn')?.classList.add('on');
                    if (!getGeminiLive()) createGeminiLive();
                    await getGeminiLive().connect(apiKey, model);
                    if (!options.silent) deps.toast('Gemini Live conectado!');
                    return true;
                } catch (error) {
                    deps.setLiveMode(false);
                    global.document.getElementById('live-btn')?.classList.remove('on');
                    console.error('[GeminiLive] Connect failed:', error);
                    if (!options.silent) deps.toast('Falha ao conectar: ' + (error.message || 'erro desconhecido'));
                    return false;
                }
            }

            if (!global.window.SpeechRecognition && !global.window.webkitSpeechRecognition) {
                if (!options.silent) deps.toast('Live Mode precisa de Chrome ou Edge.');
                return false;
            }
            const isSecure = global.location.protocol === 'https:' || global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1';
            if (!isSecure) {
                if (!options.silent) deps.toast('Live Mode requer HTTPS. Mic nao funciona em HTTP.');
                return false;
            }
            const voice = global.document.getElementById('tts-voice-sel')?.value;
            if (!voice) {
                if (!options.silent) deps.toast('Selecione uma voz em Configuracoes > TTS antes de ativar o Live Mode.');
                return false;
            }
            if (!await deps.ensureMicPermission()) return false;

            deps.setLiveMode(true);
            global.document.getElementById('live-btn')?.classList.add('on');
            deps.liveInit();
            return true;
        }

        async function toggleLive() {
            if (getGeminiLive()?.active || deps.isLiveMode() || deps.getLiveRecognitionActive() || deps.getLiveRecognition()) {
                liveStop();
                return;
            }
            await startLiveForCurrentModel();
        }

        async function toggleLiveScreenShare() {
            const model = global.document.getElementById('model-sel')?.value || '';
            if (!deps.isLiveModel(model)) {
                deps.toast('Compartilhamento de tela esta disponivel so no Gemini Live 3.1.');
                return;
            }
            if (!getGeminiLive()?.active) {
                deps.toast('Ative o Gemini Live antes de compartilhar a tela.');
                return;
            }
            if (getGeminiLive().screenShareActive) {
                getGeminiLive().stopScreenShare();
                return;
            }
            try {
                await getGeminiLive().startScreenShare(5000);
            } catch (error) {
                console.error('[GeminiLive] Screen share error:', error);
                deps.toast('Falha ao compartilhar a tela: ' + (error.message || 'erro desconhecido'));
                getGeminiLive().stopScreenShare({ silent: true });
            }
        }

        function livePauseSTT() {
            deps.setLiveIgnoreSTT(true);
            global.clearTimeout(deps.getLiveSilenceTimer());
            global.clearInterval(deps.getLiveBarInterval());
            global.clearTimeout(deps.getLiveRestartTimer());
            deps.setLiveSilenceStart(null);
            deps.setMicStreamEnabled(false);
            if (deps.getLiveRecognition()) {
                try {
                    deps.getLiveRecognition().stop();
                } catch (_) {}
            }
        }

        async function liveTriggerSend() {
            if (!deps.isLiveMode()) return;
            global.clearTimeout(deps.getLiveSilenceTimer());
            global.clearInterval(deps.getLiveBarInterval());
            deps.setLiveSilenceStart(null);

            livePauseSTT();
            liveSetHUD('processing', 'Processando...');

            await deps.send();

            if (!deps.isLiveMode()) return;

            const msgs = deps.getConversations()[deps.getActiveId()]?.msgs || [];
            const lastIdx = msgs.length - 1;
            if (msgs[lastIdx]?.role === 'model' && msgs[lastIdx]?.text) {
                liveSetHUD('playing', 'Respondendo...');
                await liveSpeak(lastIdx);
            } else {
                liveResumeListening();
            }
        }

        async function liveSpeak(msgIdx) {
            if (!deps.isLiveMode()) return 'inactive';

            const status = await deps.ttsSpeakMsg(msgIdx);
            if (!deps.isLiveMode()) return status;

            if (status === 'completed') {
                global.setTimeout(() => liveResumeListening(), 200);
                return 'ended';
            }

            if (status === 'interrupted') {
                liveSetHUD('listening', 'Interrompido, pode falar');
                global.setTimeout(() => liveResumeListening(), 120);
                return 'interrupted';
            }

            global.setTimeout(() => liveResumeListening(), 200);
            return status;
        }

        function liveResumeListening() {
            if (!deps.isLiveMode()) return;
            deps.setLiveIgnoreSTT(false);
            deps.setLiveSilenceStart(null);
            deps.setLiveAccum('');
            deps.setLiveLastDisplay('');
            deps.setLiveNoSpeechCount(0);
            deps.setLiveRestartAttempts(0);
            deps.setSpeechBase('');
            const msgEl = global.document.getElementById('msg');
            if (msgEl) msgEl.value = '';
            global.setTimeout(() => deps.setMicStreamEnabled(true), 200);
            if (deps.getLiveRecognition() && !deps.getLiveRecognitionActive()) {
                try {
                    deps.getLiveRecognition().start();
                } catch (_) {}
            }
            liveSetHUD('listening', 'Ouvindo...');
        }

        function liveStop(options = {}) {
            if (getGeminiLive()?.active) {
                getGeminiLive().disconnect();
            }
            deps.setLiveMode(false);
            deps.setLiveIgnoreSTT(false);
            global.clearTimeout(deps.getLiveSilenceTimer());
            global.clearInterval(deps.getLiveBarInterval());
            global.clearTimeout(deps.getLiveRestartTimer());
            if (deps.getLiveRecognition()) {
                try {
                    deps.getLiveRecognition().stop();
                } catch (_) {}
                deps.setLiveRecognition(null);
            }
            deps.setLiveRecognitionActive(false);
            deps.setLiveRestartAttempts(0);
            deps.setLiveNoSpeechCount(0);
            deps.ttsStop();
            deps.setMicStreamEnabled(true);
            liveSetHUD('idle', '');
            global.document.getElementById('live-btn')?.classList.remove('on');
            if (!options.silent) deps.toast('Live Mode encerrado.');
        }

        return {
            createGeminiLive,
            getGeminiLive,
            liveSetHUD,
            startLiveForCurrentModel,
            toggleLive,
            toggleLiveScreenShare,
            livePauseSTT,
            liveTriggerSend,
            liveSpeak,
            liveResumeListening,
            liveStop
        };
    }

    global.SkillFlowLive = { init };
})(window);
