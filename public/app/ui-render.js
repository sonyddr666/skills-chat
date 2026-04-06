(function (global) {
    function init(deps) {
        function renderSidebar() {
            const list = global.document.getElementById('conv-list');
            const q = global.document.getElementById('search-box').value.toLowerCase();
            const convs = deps.getConversations();
            const activeId = deps.getActiveId();
            const ids = Object.keys(convs)
                .filter(id => deps.conversationTitle(convs[id]).toLowerCase().includes(q))
                .sort((a, b) => deps.conversationTs(convs[b]) - deps.conversationTs(convs[a]));

            if (ids.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding: 20px 10px; color:var(--muted); font-size: 13px;">Nenhuma conversa encontrada.</div>';
                return;
            }

            list.innerHTML = ids.map(id => `
    <div class="ci ${id === activeId ? 'active' : ''}" data-cid="${id}" onclick="setActive('${id}')" ondblclick="event.stopPropagation();renameConv('${id}')">
      <span class="ci-title">${deps.esc(deps.conversationTitle(convs[id]))}</span>
      <button class="ci-del" onclick="delConv('${id}',event)" title="Deletar">✕</button>
    </div>`).join('');
        }

        function toast(msg) {
            const toastEl = global.document.getElementById('toast');
            toastEl.textContent = msg;
            toastEl.classList.add('show');
            global.setTimeout(() => toastEl.classList.remove('show'), 2800);
        }

        function isChatNearBottom(chatEl, threshold = 180) {
            if (!chatEl) return true;
            return (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) <= threshold;
        }

        function updateScrollBottomButton() {
            const chatEl = global.document.getElementById('chat');
            const buttonEl = global.document.getElementById('scroll-bottom-btn');
            if (!chatEl || !buttonEl) return;
            const distance = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
            buttonEl.classList.toggle('show', distance > 220);
            deps.setChatStickToBottom(distance <= 180);
        }

        function queueChatScrollToBottom(force = false) {
            const chatEl = global.document.getElementById('chat');
            if (!chatEl) return;
            if (force) deps.setChatStickToBottom(true);
            if (!force && !deps.getChatStickToBottom()) return;
            if (deps.getChatScrollRaf()) global.cancelAnimationFrame(deps.getChatScrollRaf());
            const rafId = global.requestAnimationFrame(() => {
                global.requestAnimationFrame(() => {
                    const current = global.document.getElementById('chat');
                    if (!current) return;
                    current.scrollTop = current.scrollHeight;
                    updateScrollBottomButton();
                    deps.setChatScrollRaf(0);
                });
            });
            deps.setChatScrollRaf(rafId);
        }

        function restoreChatScrollPosition(prevTop, prevScrollHeight, prevClientHeight) {
            global.requestAnimationFrame(() => {
                const chatEl = global.document.getElementById('chat');
                if (!chatEl) return;
                const previousGap = Math.max(0, prevScrollHeight - prevTop - prevClientHeight);
                const nextTop = Math.max(0, chatEl.scrollHeight - chatEl.clientHeight - previousGap);
                chatEl.scrollTop = nextTop;
                updateScrollBottomButton();
            });
        }

        function scrollEnd(force = false) {
            queueChatScrollToBottom(force);
        }

        function autoH(el) {
            el.style.height = '0';
            el.style.height = Math.min(el.scrollHeight, 200) + 'px';
        }

        function renderMessageFile(file) {
            const href = deps.buildMessageFileDownloadUrl(file);
            const action = href
                ? `<a class="cp" href="${href}" download onclick="event.stopPropagation()">Baixar</a>`
                : '';
            const subtitle = file?.path
                ? `<span style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${deps.esc(file.path)}</span>`
                : '';

            return `<div class="file-preview">
      <span class="file-icon">${deps.fileIconForMessage(file)}</span>
      <span style="display:flex;flex-direction:column;min-width:0;flex:1">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${deps.esc(file?.name || 'arquivo')}</span>
        ${subtitle}
      </span>
      ${action}
    </div>`;
        }

        function isRenderableImageFile(file) {
            const mimeType = String(file?.mimeType || file?.type || '').toLowerCase();
            const name = String(file?.name || file?.path || '').toLowerCase();
            return mimeType.startsWith('image/')
                || /\.(png|jpe?g|webp|gif|svg)$/.test(name);
        }

        function renderInlineMessageImage(file) {
            const src = file?.data
                ? `data:${file.mimeType};base64,${file.data}`
                : deps.buildMessageFileDownloadUrl(file);
            if (!src) return renderMessageFile(file);
            return `<img src="${src}" alt="${deps.esc(file?.name || 'Imagem gerada')}" loading="lazy">`;
        }

        function renderMessageAttachments(message) {
            let body = '';
            const allFiles = Array.isArray(message.files) ? message.files : [];
            const imageFiles = allFiles.filter(isRenderableImageFile);
            const regularFiles = allFiles.filter(file => !isRenderableImageFile(file));

            if (message.imgs && message.imgs.length > 0) {
                body += `<div class="attached-imgs">${message.imgs.map(img => {
                    const src = img?.data
                        ? `data:${img.mimeType};base64,${img.data}`
                        : (img?.downloadUrl || (img?.path ? '/api/fs/download?path=' + encodeURIComponent(img.path) : ''));
                    return src
                        ? `<img src="${src}">`
                        : `<div class="file-preview"><span class="file-icon">🖼️</span><span>${deps.esc(img?.name || 'Imagem anexada')}</span></div>`;
                }).join('')}</div>`;
            }

            if (imageFiles.length > 0) {
                body += `<div class="attached-imgs">${imageFiles.map(renderInlineMessageImage).join('')}</div>`;
            }

            if (regularFiles.length > 0) {
                body += `<div class="attached-imgs">${regularFiles.map(renderMessageFile).join('')}</div>`;
            }

            return body;
        }

        function renderMessageActions(messageIndex, role) {
            if (role === 'user') {
                return `
                    <div class="msg-actions">
                        <button class="msg-act-btn" onclick="editMsg(${messageIndex})" title="Editar">✏ Editar</button>
                        <button class="msg-act-btn danger" onclick="deleteMsg(${messageIndex})" title="Deletar">🗑</button>
                    </div>`;
            }

            if (role === 'model') {
                return `
                    <div class="msg-actions">
                        <button class="msg-act-btn" onclick="regenerateMsg(${messageIndex})" title="Regenerar resposta">🔄 Regenerar</button>
                        <button class="msg-act-btn danger" onclick="deleteMsg(${messageIndex})" title="Deletar">🗑</button>
                    </div>`;
            }

            return '';
        }

        function renderMessageMeta(message, messageIndex, formattedTime) {
            return `<div class="meta" id="mt${messageIndex}">
        <span>${formattedTime}</span>
        ${message.model ? `<span style="color:var(--accent2)">${message.model}</span>` : ''}
        ${message.think ? `<span class="tbadge">thinking:${message.think}</span>` : ''}
        ${message.live ? `<span style="background:#ff4757;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700">LIVE</span>` : ''}
        ${message.tok ? `<span>${message.tok.toLocaleString()} tok</span>` : ''}
        <button class="cp" onclick="copyMsg(${messageIndex})">⎘ Copiar Tudo</button>
        ${message.role === 'model' ? `<button class="tts-btn" onclick="ttsSpeakMsg(${messageIndex})" id="tts-btn-${messageIndex}" title="Ouvir resposta">🔊</button>` : ''}
      </div>`;
        }

        function renderMessageShell(message, messageIndex, bodyHtml, metaHtml, actionsHtml) {
            return `<div class="row ${message.role} animate-in">
    <div class="av">${message.role === 'user' ? '👤' : '✦'}</div>
    <div style="flex:1; max-width: calc(100% - 42px);">
      <div class="bub" id="bub${messageIndex}">${bodyHtml}</div>
      ${metaHtml}
      ${actionsHtml}
    </div>
  </div>`;
        }

        function renderMessageHtml(message, messageIndex) {
            const formattedTime = new Date(message.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            let body = renderMessageAttachments(message);
            const traceHtml = message.role === 'model' ? deps.renderMessageTrace(message.trace) : '';

            if (message.role === 'model') {
                body += `<div class="msg-render-text" id="bb${messageIndex}">${deps.renderMarkdown(message.text || '')}</div>`;
                body += traceHtml;
            } else {
                body += `<p>${deps.esc(message.text || '').replace(/\n/g, '<br>')}</p>`;
            }

            const actionsHtml = renderMessageActions(messageIndex, message.role);
            const metaHtml = renderMessageMeta(message, messageIndex, formattedTime);
            return renderMessageShell(message, messageIndex, body, metaHtml, actionsHtml);
        }

        return {
            autoH,
            isChatNearBottom,
            isRenderableImageFile,
            renderInlineMessageImage,
            renderMessageActions,
            renderMessageAttachments,
            renderMessageHtml,
            renderMessageFile,
            renderMessageMeta,
            renderMessageShell,
            updateScrollBottomButton,
            queueChatScrollToBottom,
            restoreChatScrollPosition,
            scrollEnd,
            renderSidebar,
            toast
        };
    }

    global.SkillFlowUiRender = { init };
})(window);
