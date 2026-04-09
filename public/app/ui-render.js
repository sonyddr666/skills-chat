(function (global) {
    function init(deps) {
        function fileBadgeLabel(file) {
            const mimeType = String(file?.mimeType || file?.type || '').toLowerCase();
            const name = String(file?.name || file?.path || '').toLowerCase();
            if (mimeType.startsWith('image/')) return 'IMG';
            if (mimeType.includes('pdf') || name.endsWith('.pdf')) return 'PDF';
            if (mimeType.includes('json') || name.endsWith('.json')) return 'JSON';
            if (mimeType.includes('zip') || mimeType.includes('gzip') || /\.(zip|gz|tgz|7z|rar)$/.test(name)) return 'ZIP';
            if (mimeType.includes('audio') || /\.(mp3|wav|ogg|m4a)$/.test(name)) return 'AUDIO';
            if (mimeType.includes('video') || /\.(mp4|mov|webm|mkv)$/.test(name)) return 'VIDEO';
            return 'FILE';
        }

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
      <button class="ci-del" onclick="delConv('${id}',event)" title="Deletar">x</button>
    </div>`).join('');
        }

        function toast(msg) {
            const toastEl = global.document.getElementById('toast');
            toastEl.textContent = msg;
            toastEl.classList.add('show');
            global.setTimeout(() => toastEl.classList.remove('show'), 2800);
        }

        function renderImagePreview() {
            const container = global.document.getElementById('img-preview-container');
            const pendingImages = deps.getPendingImages();
            const pendingFiles = deps.getPendingFiles();
            if (!container) return;
            if (!pendingImages.length && !pendingFiles.length) {
                container.style.display = 'none';
                return;
            }

            container.style.display = 'flex';
            let html = pendingImages.map((img, i) => `
    <div class="img-preview">
      <img src="${img.url}">
      <button class="rm-btn" onclick="removeImage(${i})">x</button>
    </div>
  `).join('');
            html += pendingFiles.map((file, i) => `
    <div class="file-preview">
      <span class="file-icon">${fileBadgeLabel(file)}</span>
      <span>${deps.esc(file?.name || 'arquivo')}</span>
      <button class="rm-btn" onclick="removeFile(${i})">x</button>
    </div>
  `).join('');
            container.innerHTML = html;
        }

        function removeImage(index) {
            const nextImages = deps.getPendingImages().slice();
            nextImages.splice(index, 1);
            deps.setPendingImages(nextImages);
            renderImagePreview();
        }

        function removeFile(index) {
            const nextFiles = deps.getPendingFiles().slice();
            nextFiles.splice(index, 1);
            deps.setPendingFiles(nextFiles);
            renderImagePreview();
        }

        // Guarda o ultimo grant id mostrado via toast pra nao notificar toda hora
        let lastNotifiedGrantId = null;
        function renderConversationApprovalBanner() {
            // Banner fixo foi removido (incomodava). Agora dispara um toast UMA VEZ
            // quando um grant novo entra em vigor nesta conversa. O user pode ver
            // detalhes e revogar pelo botao "Approvals" no header.
            const grant = deps.getCurrentConversationGrant();
            if (!grant) {
                lastNotifiedGrantId = null;
                return;
            }
            const grantId = String(grant.id || '');
            if (grantId && grantId !== lastNotifiedGrantId) {
                lastNotifiedGrantId = grantId;
                const allowed = Array.isArray(grant.allowed_actions) ? grant.allowed_actions.join(', ') : '*';
                if (typeof deps.toast === 'function') {
                    deps.toast(`Grant ativo nesta conversa (${allowed}). Veja em Approvals.`);
                }
            }
        }

        function renderApprovalsPanel() {
            const list = global.document.getElementById('approvals-list');
            if (!list) return;
            const currentConversationId = String(deps.getCurrentConversationId() || '').trim();
            const approvalItems = deps.getApprovalItems();
            const globalGrant = deps.getCurrentGlobalGrant ? deps.getCurrentGlobalGrant() : null;
            const globalControls = `<div class="approval-item ${globalGrant ? 'current-conv' : ''}">
  <div class="approval-item-head">
    <div>
      <div class="approval-item-title">Liberacao total</div>
      <div class="approval-item-meta">${globalGrant ? `Valida ate ${deps.esc(deps.formatApprovalExpiry(globalGrant.expires_at))}` : 'Permite todas as acoes sensiveis.'}</div>
    </div>
    <div class="approval-item-meta">${globalGrant ? 'ativa' : 'inativa'}</div>
  </div>
  <div class="approval-item-meta">${globalGrant ? 'Grant global ativo para este usuario.' : 'Use somente se voce quer modo sem travas.'}</div>
  <div class="approval-item-actions">
    ${globalGrant
      ? `<button class="approval-mini-btn" type="button" onclick="revokeGlobalApprovalGrant()">Revogar liberacao total</button>`
      : `<button class="approval-mini-btn" type="button" onclick="activateGlobalApprovalGrant()">Liberar tudo</button>`}
  </div>
</div>`;
            if (!approvalItems.length) {
                list.innerHTML = `${globalControls}<div class="approval-item"><div class="approval-item-title">Nenhum approval registrado</div><div class="approval-item-meta">Quando uma acao sensivel precisar de autorizacao, ela aparecera aqui.</div></div>`;
                return;
            }
            list.innerHTML = globalControls + approvalItems.map(item => {
                const isCurrentConversation = currentConversationId && item?.conversation_id === currentConversationId;
                const canRevoke = ['conversation_grant', 'global_grant'].includes(String(item?.kind || '').toLowerCase()) && ['approved', 'pending'].includes(String(item?.status || '').toLowerCase());
                const allowed = Array.isArray(item?.allowed_actions) ? item.allowed_actions.join(', ') : (item?.action || '');
                return `<div class="approval-item ${isCurrentConversation ? 'current-conv' : ''}">
  <div class="approval-item-head">
    <div>
      <div class="approval-item-title">${deps.esc(item.kind === 'conversation_grant' ? 'Grant da conversa' : (item.kind === 'global_grant' ? 'Grant global' : item.action || 'Approval'))}</div>
      <div class="approval-item-meta">
        <span class="approval-pill ${deps.esc(String(item.status || '').toLowerCase())}">${deps.esc(deps.approvalStatusLabel(item.status))}</span>
        <span>${deps.esc(item.id || '')}</span>
        ${item.conversation_id ? `<span>conversa ${deps.esc(item.conversation_id)}</span>` : ''}
      </div>
    </div>
    <div class="approval-item-meta">${deps.esc(item.risk || 'medio')}</div>
  </div>
  <div class="approval-item-meta">${deps.esc(item.reason || '')}</div>
  <div class="approval-item-meta">Acoes: ${deps.esc(allowed || item.action || '')}</div>
  <div class="approval-item-meta">Expira em: ${deps.esc(deps.formatApprovalExpiry(item.expires_at))}</div>
  <div class="approval-item-meta">Usos: ${deps.esc(String(item.used_count || 0))}</div>
  ${canRevoke ? `<div class="approval-item-actions"><button class="approval-mini-btn" type="button" onclick="revokeApprovalById('${deps.esc(item.id)}')">Revogar</button></div>` : ''}
</div>`;
            }).join('');
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
      <span class="file-icon">${fileBadgeLabel(file)}</span>
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
                        : `<div class="file-preview"><span class="file-icon">IMG</span><span>${deps.esc(img?.name || 'Imagem anexada')}</span></div>`;
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
                        <button class="msg-act-btn" onclick="editMsg(${messageIndex})" title="Editar">Editar</button>
                        <button class="msg-act-btn danger" onclick="deleteMsg(${messageIndex})" title="Excluir">Excluir</button>
                    </div>`;
            }

            if (role === 'model') {
                return `
                    <div class="msg-actions">
                        <button class="msg-act-btn" onclick="regenerateMsg(${messageIndex})" title="Regenerar resposta">Regenerar</button>
                        <button class="msg-act-btn danger" onclick="deleteMsg(${messageIndex})" title="Excluir">Excluir</button>
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
        <button class="cp" onclick="copyMsg(${messageIndex})">Copiar Tudo</button>
        ${message.role === 'model' ? `<button class="tts-btn" onclick="ttsSpeakMsg(${messageIndex})" id="tts-btn-${messageIndex}" title="Ouvir resposta">Ouvir</button>` : ''}
      </div>`;
        }

        function renderMessageShell(message, messageIndex, bodyHtml, metaHtml, actionsHtml) {
            return `<div class="row ${message.role} animate-in">
    <div class="av">${message.role === 'user' ? 'EU' : 'AI'}</div>
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

        function msgCacheKey(convId, idx, msg) {
            return `${convId}:${idx}:${msg.ts || 0}:${(msg.text || '').length}:${Array.isArray(msg.trace) ? msg.trace.length : 0}:${Array.isArray(msg.files) ? msg.files.length : 0}`;
        }

        function cachedMsgHTML(convId, msg, idx) {
            const key = msgCacheKey(convId, idx, msg);
            const cache = deps.getMsgHTMLCache();
            if (cache.has(key)) return cache.get(key);
            const html = renderMessageHtml(msg, idx);
            cache.set(key, html);
            if (cache.size > 500) {
                const first = cache.keys().next().value;
                cache.delete(first);
            }
            return html;
        }

        function cleanupChatObserver() {
            const observer = deps.getChatScrollObserver();
            if (observer) {
                observer.disconnect();
                deps.setChatScrollObserver(null);
            }
        }

        function loadOlderMessages() {
            const activeId = deps.getActiveId();
            if (!activeId) return;
            const messages = deps.getConversationMessages(activeId);
            if (deps.getChatRenderedFrom() <= 0) return;

            const chatEl = global.document.getElementById('chat');
            const prevScrollHeight = chatEl.scrollHeight;
            const newFrom = Math.max(0, deps.getChatRenderedFrom() - deps.getChatPageSize());
            const batchMsgs = messages.slice(newFrom, deps.getChatRenderedFrom());
            const batchHtml = batchMsgs.map((msg, i) => cachedMsgHTML(activeId, msg, newFrom + i)).join('');
            const hasOlder = newFrom > 0;
            const sentinel = hasOlder
                ? `<div id="chat-load-more" style="text-align:center;padding:12px;color:var(--muted);font-size:12px;cursor:pointer" onclick="loadOlderMessages()">Carregar mensagens anteriores (${newFrom} restantes)</div>`
                : '';

            const oldSentinel = global.document.getElementById('chat-load-more');
            if (oldSentinel) oldSentinel.remove();

            chatEl.insertAdjacentHTML('afterbegin', sentinel + batchHtml);
            deps.setChatRenderedFrom(newFrom);
            deps.setChatRenderedCount(deps.getChatRenderedCount() + batchMsgs.length);

            global.requestAnimationFrame(() => {
                const newScrollHeight = chatEl.scrollHeight;
                chatEl.scrollTop += (newScrollHeight - prevScrollHeight);
                updateScrollBottomButton();
                deps.renderMermaidBlocks();
            });

            setupChatObserver();
        }

        function setupChatObserver() {
            cleanupChatObserver();
            const sentinel = global.document.getElementById('chat-load-more');
            if (!sentinel) return;

            const observer = new global.IntersectionObserver((entries) => {
                if (entries[0]?.isIntersecting) {
                    loadOlderMessages();
                }
            }, { root: global.document.getElementById('chat'), rootMargin: '200px 0px 0px 0px' });

            observer.observe(sentinel);
            deps.setChatScrollObserver(observer);
        }

        function renderEmptyChat() {
            return `<div id="empty">
      <div class="logo">AI</div>
      <h3>SkillFlow Chat OS</h3>
      <p>Chat real com LLM, STT, TTS, skills, plugins e function calling. Configure a API Key, escolha o modelo e trabalhe por conversa, projeto ou skill pack.</p>
      <div class="empty-features">
        <span>Function Calling</span>
        <span>Skills por projeto</span>
        <span>TTS + Live Voice</span>
        <span>Logs e approvals</span>
      </div>
    </div>`;
        }

        function renderInitialChatSlice(activeId, messages) {
            const total = messages.length;
            const from = Math.max(0, total - deps.getChatPageSize());
            const slice = messages.slice(from);
            const html = slice.map((msg, i) => cachedMsgHTML(activeId, msg, from + i)).join('');
            const hasOlder = from > 0;
            const sentinel = hasOlder
                ? `<div id="chat-load-more" style="text-align:center;padding:12px;color:var(--muted);font-size:12px;cursor:pointer" onclick="loadOlderMessages()">Carregar mensagens anteriores (${from} restantes)</div>`
                : '';

            return {
                from,
                html: sentinel + html,
                count: slice.length
            };
        }

        function finalizeRenderChat(options) {
            const {
                prevScrollTop,
                prevScrollHeight,
                prevClientHeight,
                shouldStickToBottom
            } = options;

            if (shouldStickToBottom) {
                queueChatScrollToBottom(true);
            } else {
                restoreChatScrollPosition(prevScrollTop, prevScrollHeight, prevClientHeight);
            }

            updateScrollBottomButton();
            deps.renderConversationApprovalBanner();
            global.requestAnimationFrame(async () => {
                await deps.renderMermaidBlocks();
                if (shouldStickToBottom) queueChatScrollToBottom(true);
                else updateScrollBottomButton();
            });

            setupChatObserver();
        }

        function renderChat(forceScrollToBottom = false) {
            const chatEl = global.document.getElementById('chat');
            const activeId = deps.getActiveId();
            const messages = activeId ? deps.getConversationMessages(activeId) : [];
            const prevScrollTop = chatEl?.scrollTop || 0;
            const prevScrollHeight = chatEl?.scrollHeight || 0;
            const prevClientHeight = chatEl?.clientHeight || 0;
            const shouldStickToBottom = !!forceScrollToBottom || deps.getChatStickToBottom() || isChatNearBottom(chatEl);

            if (!activeId || !messages.length) {
                chatEl.innerHTML = renderEmptyChat();
                deps.setChatRenderedFrom(0);
                deps.setChatRenderedCount(0);
                cleanupChatObserver();
                deps.renderConversationApprovalBanner();
                return;
            }

            const initialRender = renderInitialChatSlice(activeId, messages);
            chatEl.innerHTML = initialRender.html;
            deps.setChatRenderedFrom(initialRender.from);
            deps.setChatRenderedCount(initialRender.count);

            finalizeRenderChat({
                prevScrollTop,
                prevScrollHeight,
                prevClientHeight,
                shouldStickToBottom
            });
        }

        function copyMsg(messageIndex) {
            const activeId = deps.getActiveId();
            const conversations = deps.getConversations();
            return global.navigator.clipboard.writeText(conversations[activeId].msgs[messageIndex].text)
                .then(() => toast('Mensagem copiada.'));
        }

        function editMsg(messageIndex) {
            const activeId = deps.getActiveId();
            const conversations = deps.getConversations();
            const message = conversations[activeId]?.msgs[messageIndex];
            if (!message || message.role !== 'user') return;
            const bubble = global.document.getElementById('bub' + messageIndex);
            if (!bubble) return;
            bubble.innerHTML = `<textarea class="edit-textarea" id="edit-ta-${messageIndex}">${deps.esc(message.text || '')}</textarea>
                <div class="edit-actions">
                    <button class="edit-save-btn" onclick="saveEdit(${messageIndex})">Salvar e Reenviar</button>
                    <button class="edit-cancel-btn" onclick="cancelEdit(${messageIndex})">Cancelar</button>
                </div>`;
            global.document.getElementById('edit-ta-' + messageIndex)?.focus();
        }

        function saveEdit(messageIndex) {
            const textarea = global.document.getElementById('edit-ta-' + messageIndex);
            if (!textarea) return;
            const newText = textarea.value.trim();
            if (!newText) {
                toast('Mensagem vazia.');
                return;
            }

            const activeId = deps.getActiveId();
            const conversations = deps.getConversations();
            conversations[activeId].msgs[messageIndex].text = newText;
            conversations[activeId].msgs[messageIndex].ts = Date.now();
            conversations[activeId].msgs = conversations[activeId].msgs.slice(0, messageIndex + 1);
            deps.saveConvs();
            renderChat();
            deps.send();
        }

        function cancelEdit() {
            renderChat();
        }

        function regenerateMsg(messageIndex) {
            const activeId = deps.getActiveId();
            const messages = deps.getConversations()[activeId]?.msgs;
            if (!messages || messageIndex < 1) return;
            deps.getConversations()[activeId].msgs = messages.slice(0, messageIndex);
            deps.saveConvs();
            renderChat();
            deps.send();
        }

        function deleteMsg(messageIndex) {
            const activeId = deps.getActiveId();
            const messages = deps.getConversations()[activeId]?.msgs;
            if (!messages) return;
            if (!global.confirm('Deletar esta mensagem?')) return;
            if (messages[messageIndex].role === 'user' && messages[messageIndex + 1]?.role === 'model') {
                deps.getConversations()[activeId].msgs.splice(messageIndex, 2);
            } else {
                deps.getConversations()[activeId].msgs.splice(messageIndex, 1);
            }
            deps.saveConvs();
            renderChat();
            renderSidebar();
        }

        return {
            autoH,
            cachedMsgHTML,
            cleanupChatObserver,
            copyMsg,
            deleteMsg,
            editMsg,
            finalizeRenderChat,
            isChatNearBottom,
            isRenderableImageFile,
            renderApprovalsPanel,
            renderConversationApprovalBanner,
            cancelEdit,
            removeFile,
            removeImage,
            regenerateMsg,
            renderInlineMessageImage,
            renderImagePreview,
            renderMessageActions,
            renderMessageAttachments,
            renderChat,
            renderMessageHtml,
            renderMessageFile,
            renderMessageMeta,
            renderMessageShell,
            renderEmptyChat,
            renderInitialChatSlice,
            loadOlderMessages,
            msgCacheKey,
            saveEdit,
            setupChatObserver,
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
