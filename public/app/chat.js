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
            stop
        };
    }

    global.SkillFlowChat = { init };
})(window);
