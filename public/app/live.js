(function (global) {
    function init(deps) {
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

        async function startLiveForCurrentModel(options = {}) {
            const model = global.document.getElementById('model-sel')?.value || '';

            if (deps.isLiveModel(model)) {
                if (!deps.getRuntimeConfig()?.live_client_enabled) {
                    if (!options.silent) deps.toast('Live mode desabilitado por politica neste ambiente.');
                    return false;
                }
                const apiKey = global.document.getElementById('api-in')?.value?.trim() || '';
                if (!apiKey) {
                    if (!options.silent) deps.toast('⚠ Insira sua API Key!');
                    return false;
                }

                const isSecure = global.location.protocol === 'https:' || global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1';
                if (!isSecure) {
                    if (!options.silent) deps.toast('⚠ Live Mode requer HTTPS.');
                    return false;
                }
                if (!await deps.ensureMicPermission()) return false;

                if (!deps.getActiveId()) deps.newConversation();

                try {
                    deps.setLiveMode(true);
                    global.document.getElementById('live-btn')?.classList.add('on');
                    await deps.getGeminiLive().connect(apiKey, model);
                    if (!options.silent) deps.toast('✓ Gemini Live conectado!');
                    return true;
                } catch (error) {
                    deps.setLiveMode(false);
                    global.document.getElementById('live-btn')?.classList.remove('on');
                    console.error('[GeminiLive] Connect failed:', error);
                    if (!options.silent) deps.toast('❌ Falha ao conectar: ' + (error.message || 'erro desconhecido'));
                    return false;
                }
            }

            if (!global.window.SpeechRecognition && !global.window.webkitSpeechRecognition) {
                if (!options.silent) deps.toast('⚠ Live Mode precisa de Chrome ou Edge.');
                return false;
            }
            const isSecure = global.location.protocol === 'https:' || global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1';
            if (!isSecure) {
                if (!options.silent) deps.toast('⚠ Live Mode requer HTTPS. Mic nao funciona em HTTP.');
                return false;
            }
            const voice = global.document.getElementById('tts-voice-sel')?.value;
            if (!voice) {
                if (!options.silent) deps.toast('⚠ Selecione uma voz em Configuracoes > TTS antes de ativar o Live Mode.');
                return false;
            }
            if (!await deps.ensureMicPermission()) return false;

            deps.setLiveMode(true);
            global.document.getElementById('live-btn')?.classList.add('on');
            deps.liveInit();
            return true;
        }

        async function toggleLive() {
            if (deps.getGeminiLive().active || deps.isLiveMode() || deps.getLiveRecognitionActive() || deps.getLiveRecognition()) {
                liveStop();
                return;
            }
            await startLiveForCurrentModel();
        }

        async function toggleLiveScreenShare() {
            const model = global.document.getElementById('model-sel')?.value || '';
            if (!deps.isLiveModel(model)) {
                deps.toast('⚠ Compartilhamento de tela esta disponivel so no Gemini Live 3.1.');
                return;
            }
            if (!deps.getGeminiLive().active) {
                deps.toast('⚠ Ative o Gemini Live antes de compartilhar a tela.');
                return;
            }
            if (deps.getGeminiLive().screenShareActive) {
                deps.getGeminiLive().stopScreenShare();
                return;
            }
            try {
                await deps.getGeminiLive().startScreenShare(5000);
            } catch (error) {
                console.error('[GeminiLive] Screen share error:', error);
                deps.toast('⚠ Falha ao compartilhar a tela: ' + (error.message || 'erro desconhecido'));
                deps.getGeminiLive().stopScreenShare({ silent: true });
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
            liveSetHUD('processing', '⏳ Processando…');

            await deps.send();

            if (!deps.isLiveMode()) return;

            const msgs = deps.getConversations()[deps.getActiveId()]?.msgs || [];
            const lastIdx = msgs.length - 1;
            if (msgs[lastIdx]?.role === 'model' && msgs[lastIdx]?.text) {
                liveSetHUD('playing', '🔊 Respondendo…');
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
                liveSetHUD('listening', '🎙 Interrompido, pode falar');
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
            liveSetHUD('listening', '🎙 Ouvindo…');
        }

        function liveStop(options = {}) {
            if (deps.getGeminiLive().active) {
                deps.getGeminiLive().disconnect();
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
            if (!options.silent) deps.toast('⏹ Live Mode encerrado.');
        }

        return {
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
