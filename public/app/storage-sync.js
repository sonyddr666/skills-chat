(function (global) {
    const JSON_KEYS = new Set([
        'gc_cfg',
        'gc_plugins',
        'gc_convs',
        'gc_user_memory',
        'gc_pending_approvals',
        'gc_skill_packs'
    ]);

    const STATE_KEYS = [
        'gc_cfg',
        'gc_theme',
        'gc_plugins',
        'gc_convs',
        'gc_activeId',
        'gc_user_memory',
        'gc_pending_approvals',
        'gc_skill_packs',
        'gc_tts_voice',
        'gc_tts_autoplay',
        'gc_sb_collapsed'
    ];

    const LEGACY_KEYS = [
        'gc_key',
        'gc_api_key',
        'gc_codex_auth',
        'gc_codex_auth_raw',
        'gc_pendingRequest',
        'gc_resumeState'
    ];

    function isQuotaExceededError(error) {
        return error?.name === 'QuotaExceededError'
            || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
            || error?.code === 22
            || error?.code === 1014;
    }

    function get(key, fallback = null) {
        const value = global.localStorage.getItem(key);
        return value === null ? fallback : value;
    }

    function set(key, value, options = {}) {
        try {
            global.localStorage.setItem(key, String(value));
            return true;
        } catch (error) {
            if (!isQuotaExceededError(error)) {
                console.warn(`[Storage] Falha ao salvar ${key}:`, error);
                return false;
            }
            if (typeof options.onQuota === 'function') {
                return options.onQuota(error) === true;
            }
            if (!options.silent && typeof global.toast === 'function') {
                global.toast('Armazenamento local cheio.');
            }
            return false;
        }
    }

    function remove(key) {
        global.localStorage.removeItem(key);
    }

    function getJson(key, fallback = null) {
        const raw = get(key);
        if (raw === null) return fallback;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return fallback;
        }
    }

    function setJson(key, value, options = {}) {
        return set(key, JSON.stringify(value), options);
    }

    function stateValueFromStorage(key) {
        const raw = get(key);
        if (raw === null) return undefined;
        if (!JSON_KEYS.has(key)) return raw;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return raw;
        }
    }

    function writeStateValue(key, value, options = {}) {
        if (value === undefined) {
            remove(key);
            return;
        }
        if (JSON_KEYS.has(key)) {
            setJson(key, value, options);
            return;
        }
        set(key, value, options);
    }

    function clearTrackedState(keys = STATE_KEYS) {
        keys.forEach(remove);
    }

    function migrateLegacyState() {
        LEGACY_KEYS.forEach(remove);

        const cfg = getJson('gc_cfg', null);
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;

        let changed = false;
        ['key', 'apiKey', 'api_key', 'codexAuth', 'codexAuthRaw'].forEach((field) => {
            if (!Object.prototype.hasOwnProperty.call(cfg, field)) return;
            delete cfg[field];
            changed = true;
        });

        if (changed) {
            setJson('gc_cfg', cfg, { silent: true });
        }
        return changed;
    }

    global.SkillFlowStorage = {
        JSON_KEYS,
        STATE_KEYS,
        LEGACY_KEYS,
        isQuotaExceededError,
        get,
        set,
        remove,
        getJson,
        setJson,
        stateValueFromStorage,
        writeStateValue,
        clearTrackedState,
        migrateLegacyState
    };

    migrateLegacyState();
})(window);
