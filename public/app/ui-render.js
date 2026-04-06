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

        return {
            renderSidebar,
            toast
        };
    }

    global.SkillFlowUiRender = { init };
})(window);
