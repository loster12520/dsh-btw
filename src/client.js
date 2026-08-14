/**
 * dsh-btw — Client 半区
 *
 * 左侧旁路面板（BTW）：
 * - 会话头部按钮（conversation.session.header.actions，session-scope）开关面板，
 *   直接拿到 sessionId prop（root-scope 的 overlay 无法安全使用 useSessions）。
 * - 面板本体渲染在 shell.overlay（root scope），不调用任何 standard hook。
 * - 问答历史与 Host 统一记录同步：面板打开期间每 1.5s 轮询 btw/state，
 *   按消息 id 增量合并 —— /btw 命令路径的问答也会出现在面板。
 * - 清空：Ctrl+Shift+K 或「清空」按钮（调用 btw/clear 重置分支）。
 *
 * 挂载方式：
 *   - 动态插件：把本文件的 apply 逻辑作为 code.client（见 scripts/to-dynamic.mjs）
 *   - 静态插件：本文件导出 apply，经 dsh.client 声明由 client-modules 加载
 */

export const inject = ['timer']

export function apply(ctx) {
  // ============ 共享面板状态（apply 闭包内，所有组件共享） ============
  // messages 与 Host 历史同步：id 去重追加
  const store = {
    open: false,
    sessionId: null,
    messages: [],
    lastId: 0,
    listeners: new Set(),
    emit() { this.listeners.forEach((fn) => { try { fn() } catch (e) {} }) },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
  }

  const usePanel = () => {
    const [snap, setSnap] = React.useState({ open: store.open, sessionId: store.sessionId, messages: store.messages.slice() })
    React.useEffect(() => store.subscribe(() => setSnap({ open: store.open, sessionId: store.sessionId, messages: store.messages.slice() })), [])
    return snap
  }

  // 从 Host 历史同步（命令路径与面板路径的问答都进入面板）
  const syncFromHost = async () => {
    try {
      const res = await host.call('btw/state')
      if (!res || !res.ok || !Array.isArray(res.messages)) return
      const msgs = res.messages
      if (msgs.length === 0) {
        if (store.messages.length > 0) { store.messages = []; store.lastId = 0; store.emit() }
        return
      }
      const maxId = msgs.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0)
      const fresh = msgs.filter(x => (Number(x.id) || 0) > store.lastId)
      if (fresh.length > 0) {
        store.messages = store.messages.concat(fresh)
        store.lastId = maxId
        store.emit()
      } else if (maxId < store.lastId || store.messages.length === 0) {
        // Host 侧被清空或首次打开：全量替换
        store.messages = msgs.slice()
        store.lastId = maxId
        store.emit()
      }
    } catch (e) { /* ignore */ }
  }

  // 面板打开期间轮询同步（命令路径的问答也能出现在面板）
  ctx.interval(async () => {
    if (store.open) await syncFromHost()
  }, 1500)

  // ============ 样式（Package 私有，主题变量） ============
  styles.insert(`
.btw-toggle-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-primary);
  font-size: 12px; cursor: pointer;
}
.btw-toggle-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.btw-panel {
  position: fixed; left: 0; top: 0; bottom: 0; width: 340px;
  background: var(--dsw-alias-bg-layer-1);
  border-right: 1px solid var(--dsw-alias-border-l1);
  display: flex; flex-direction: column;
  z-index: 1000; pointer-events: auto;
  box-shadow: 2px 0 14px rgba(0,0,0,0.18);
  font-size: 13px; color: var(--dsw-alias-label-primary);
}
.btw-panel-head {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.btw-panel-title { flex: 1; font-weight: 600; }
.btw-panel-btn {
  padding: 3px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.btw-panel-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.btw-panel-body {
  flex: 1; overflow-y: auto; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px;
}
.btw-panel-empty {
  color: var(--dsw-alias-label-secondary); white-space: pre-line;
  text-align: center; margin-top: 32px; line-height: 1.7;
}
.btw-msg { display: flex; flex-direction: column; gap: 2px; max-width: 92%; }
.btw-msg-user { align-self: flex-end; align-items: flex-end; }
.btw-msg-assistant { align-self: flex-start; align-items: flex-start; }
.btw-msg-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.btw-msg-text {
  padding: 6px 10px; border-radius: 8px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.btw-msg-user .btw-msg-text { background: var(--dsw-alias-brand-primary); color: #fff; }
.btw-msg-assistant .btw-msg-text { background: var(--dsw-alias-bg-layer-2); }
.btw-panel-foot {
  display: flex; gap: 6px; padding: 10px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.btw-input {
  flex: 1; padding: 7px 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px; outline: none;
}
.btw-input:focus { border-color: var(--dsw-alias-brand-primary); }
.btw-send {
  padding: 7px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary); color: #fff;
  font-size: 13px;
}
.btw-send:disabled { opacity: 0.5; cursor: default; }
`)

  // ============ 会话头部按钮（session-scope，直接拿到 sessionId prop） ============
  const slots = ctx.get('slots')
  if (!slots) return

  slots.inject('conversation.session.header.actions', () => slots.register(
    { name: 'conversation.session.header.actions', id: 'btw-panel-toggle', order: 30 },
    (props) => {
      const snap = usePanel()
      // 跟随当前会话：session 切换后即使不重新点击按钮，
      // 面板提问也指向当前会话（useEffect 中更新，避免渲染期副作用）
      React.useEffect(() => {
        if (store.sessionId !== props.sessionId) {
          store.sessionId = props.sessionId
          store.emit()
        }
      }, [props.sessionId])
      return React.createElement('button', {
        className: 'btw-toggle-btn',
        title: snap.open ? '关闭 BTW 旁路面板' : '打开 BTW 旁路面板',
        onClick: () => {
          store.sessionId = props.sessionId
          store.open = !snap.open
          store.emit()
          if (store.open) syncFromHost()
        },
      }, snap.open ? 'BTW ✓' : 'BTW')
    },
  ))

  // ============ 左侧面板（overlay，不调用任何 standard hook） ============
  function BtwPanel(props) {
    const [input, setInput] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const sessionId = store.sessionId

    const send = async () => {
      const text = input.trim()
      if (!text || busy) return
      if (!sessionId) {
        store.messages.push({ role: 'assistant', text: '未关联会话：请先点击会话头部的 BTW 按钮打开面板。' })
        store.emit()
        return
      }
      setInput('')
      setBusy(true)
      try {
        const res = await host.call('btw/ask', { sessionId, text })
        // 返回的 history 直接同步（包含刚提交的问题与回答）
        if (res && res.ok && Array.isArray(res.history)) {
          const msgs = res.history
          const maxId = msgs.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0)
          const fresh = msgs.filter(x => (Number(x.id) || 0) > store.lastId)
          if (fresh.length > 0) {
            store.messages = store.messages.concat(fresh)
            store.lastId = maxId
          } else {
            store.messages = msgs.slice()
            store.lastId = maxId
          }
          store.emit()
        }
      } catch (err) {
        store.messages.push({ role: 'assistant', text: '错误: ' + String((err && err.message) || err) })
        store.emit()
      }
      setBusy(false)
    }

    const clearAll = async () => {
      try { if (sessionId) await host.call('btw/clear', { sessionId }) } catch (e) {}
      store.messages = []
      store.lastId = 0
      store.emit()
    }

    // 键盘快捷键：Ctrl+Shift+K 清空对话记录（面板打开时生效）
    React.useEffect(() => {
      const onKey = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
          e.preventDefault()
          clearAll()
        }
      }
      if (typeof window !== 'undefined') window.addEventListener('keydown', onKey)
      return () => { if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey) }
    }, [])

    const msgs = store.messages
    return React.createElement('div', { className: 'btw-panel' },
      React.createElement('div', { className: 'btw-panel-head' },
        React.createElement('span', { className: 'btw-panel-title' }, 'BTW 旁路对话'),
        React.createElement('button', { className: 'btw-panel-btn', onClick: clearAll, title: '清空对话记录（Ctrl+Shift+K）' }, '清空'),
        React.createElement('button', { className: 'btw-panel-btn', onClick: () => { store.open = false; store.emit() }, title: '关闭面板' }, '✕'),
      ),
      React.createElement('div', { className: 'btw-panel-body' },
        msgs.length === 0
          ? React.createElement('div', { className: 'btw-panel-empty' }, '旁路问答（只读分支，可查看主对话历史）\n输入问题开始，或直接在输入框用 /btw <问题>\n\n清空记录：Ctrl+Shift+K 或点击「清空」')
          : msgs.map((m, i) => React.createElement('div', { className: 'btw-msg btw-msg-' + m.role, key: String(m.id || i) },
              React.createElement('div', { className: 'btw-msg-label' }, m.role === 'user' ? '你' : 'BTW'),
              React.createElement('div', { className: 'btw-msg-text' }, m.text))),
        busy && React.createElement('div', { className: 'btw-msg btw-msg-assistant' },
          React.createElement('div', { className: 'btw-msg-label' }, 'BTW'),
          React.createElement('div', { className: 'btw-msg-text' }, '思考中…')),
      ),
      React.createElement('div', { className: 'btw-panel-foot' },
        React.createElement('input', {
          className: 'btw-input',
          value: input,
          placeholder: '向旁路分支提问…',
          onChange: (e) => setInput(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } },
        }),
        React.createElement('button', { className: 'btw-send', onClick: send, disabled: busy || !input.trim() }, '发送'),
      ),
    )
  }

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'btw-panel' },
    () => {
      // 不调用任何 standard hook（root scope 外无法安全使用 useSessions）
      const snap = usePanel()
      if (!snap.open) return null
      return React.createElement(BtwPanel, {})
    },
  ))
}
