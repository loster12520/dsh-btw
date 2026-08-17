/* dsh-btw 静态 Client 半区 bundle —— 由 scripts/build-static.mjs 生成，请勿手改。
 * 修改 src/client.js 后重新运行：npm run build（或 npm run check）。
 * 格式：window.__ModuleLoader__.load({ id, factory })（client-modules 约定）。 */
window.__ModuleLoader__.load({
  id: "dsh-btw",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // React 来自客户端模块系统的 seed 表（与动态路径的 React 闭包符号等价）
    var React = require("react");
    // host 桥：动态路径由宿主沙箱提供（harness.handle 配对）；静态路径映射到
    // /api/dsh-btw/* HTTP 路由（Host 半区注册，含浏览器信任围栏）。
    var host = {
      call: async (method, args) => {
        const res = await fetch("/api/dsh-btw" + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args === undefined ? null : args),
        });
        if (!res.ok) throw new Error('dsh-btw host call failed: HTTP ' + res.status);
        return res.json();
      }
    };
    // styles 桥：静态路径下直接注入 <style> 标签（data-plugin 标记供 HMR 认领）
    var styles = {
      insert(css) {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin', "dsh-btw");
        tag.textContent = css;
        document.head.append(tag);
        return () => tag.remove();
      }
    };
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

const inject = ['timer']

function apply(ctx) {
  // ============ 共享面板状态（apply 闭包内，所有组件共享） ============
  // messages 与 Host 历史同步：id 去重追加
  const store = {
    open: false,
    sessionId: null,
          bySession: new Map(),
          focusRequest: 0,
    listeners: new Set(),
    emit() { this.listeners.forEach((fn) => { try { fn() } catch (e) {} }) },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
  }

    const getBucket = (sessionId) => {
      if (!store.bySession.has(sessionId)) {
        store.bySession.set(sessionId, { messages: [], lastId: 0 })
      }
      return store.bySession.get(sessionId)
    }

  const usePanel = () => {
          const [snap, setSnap] = React.useState({ open: store.open, sessionId: store.sessionId, messages: store.sessionId ? getBucket(store.sessionId).messages.slice() : [], focusRequest: store.focusRequest })
          React.useEffect(() => store.subscribe(() => setSnap({
        open: store.open,
        sessionId: store.sessionId,
        messages: store.sessionId ? getBucket(store.sessionId).messages.slice() : [],
        focusRequest: store.focusRequest,
      })), [])
    return snap
  }

  // 从 Host 历史同步（命令路径与面板路径的问答都进入面板）
  const syncFromHost = async (sessionId) => {
      if (!sessionId) return
    try {
      const res = await host.call('btw/state', { sessionId })
      if (!res || !res.ok || !Array.isArray(res.messages)) return
        const bucket = getBucket(sessionId)
      const msgs = res.messages
      if (msgs.length === 0) {
                  if (bucket.messages.length > 0) { bucket.messages = []; bucket.lastId = 0; store.emit() }
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
          if (store.open) await syncFromHost(store.sessionId)
  }, 1500)

    // 命令触发打开面板/聚焦：Host 写入一次性意图，Client 低频轮询消费。
    // 面板已打开时也轮询，以便无参 /btw 能聚焦输入框。
    ctx.interval(async () => {
      try {
        const res = await host.call('btw/panel-intent')
        if (!res || !res.ok || !res.sessionId) return
        const targetSessionId = res.sessionId
        store.sessionId = targetSessionId
        store.open = true
        store.focusRequest += 1
        store.emit()
        await syncFromHost(targetSessionId)
      } catch (e) { /* ignore */ }
    }, 500)

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

    styles.insert(`
  .btw-overlay {
    position: fixed; top: 0; right: 0; bottom: 0;
    left: var(--dsw-sidebar-width, 240px); /* 排除左侧侧边栏，只遮罩右侧内容区 */
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000; pointer-events: auto;
  }
  .btw-panel {
    position: relative;
    width: 520px; max-width: calc(100% - 32px);
    max-height: 75vh;
    background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l1);
    border-radius: 12px;
    display: flex; flex-direction: column;
    pointer-events: auto;
    box-shadow: 0 6px 30px rgba(0,0,0,0.2);
    font-size: 13px; color: var(--dsw-alias-label-primary);
  }
  `)

  // ============ 会话头部按钮（session-scope，直接拿到 sessionId prop） ============
  const slots = ctx.get('slots')
  if (!slots) return

    /* [old header toggle replaced below]
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
    */

    // ============ 会话切换同步器（session-scope，直接拿到 sessionId prop） ============
    // 不再显示可见的 BTW 开关按钮；只保留一个隐形组件，让面板跟随当前活跃会话。
    slots.inject('conversation.session.header.actions', () => slots.register(
      { name: 'conversation.session.header.actions', id: 'btw-session-sync', order: 30 },
      (props) => {
        React.useEffect(() => {
          if (store.sessionId !== props.sessionId) {
            store.sessionId = props.sessionId
            store.emit()
          }
        }, [props.sessionId])
        return React.createElement('span', { style: { display: 'none' } })
      },
    ))

  // ============ 左侧面板（overlay，不调用任何 standard hook） ============
    /* [old BtwPanel replaced below]
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
    */

    // ============ 居中弹窗面板（overlay，不调用任何 standard hook） ============
    function BtwPanel(props) {
      const [input, setInput] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const inputRef = React.useRef(null)
      const sessionId = store.sessionId
      const bucket = sessionId ? getBucket(sessionId) : null

      // 命令触发打开/聚焦时，自动聚焦输入框
      React.useEffect(() => {
        if (inputRef.current) inputRef.current.focus()
      }, [props.focusRequest])

      const send = async () => {
        const text = input.trim()
        if (!text || busy) return
        if (!sessionId) {
          const b = getBucket(null)
          b.messages.push({ role: 'assistant', text: '未关联会话：请先使用 /btw 打开面板。' })
          store.emit()
          return
        }
        setInput('')
        setBusy(true)
        try {
          const res = await host.call('btw/ask', { sessionId, text })
          // 返回的 history 直接同步（包含刚提交的问题与回答）
          if (res && res.ok && Array.isArray(res.history)) {
            const bucket = getBucket(sessionId)
            const msgs = res.history
            const maxId = msgs.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0)
            const fresh = msgs.filter(x => (Number(x.id) || 0) > bucket.lastId)
            if (fresh.length > 0) {
              bucket.messages = bucket.messages.concat(fresh)
              bucket.lastId = maxId
            } else {
              bucket.messages = msgs.slice()
              bucket.lastId = maxId
            }
            store.emit()
          }
        } catch (err) {
          const b = getBucket(sessionId)
          b.messages.push({ role: 'assistant', text: '错误: ' + String((err && err.message) || err) })
          store.emit()
        }
        setBusy(false)
      }

      const clearAll = async () => {
        try { if (sessionId) await host.call('btw/clear', { sessionId }) } catch (e) {}
        if (sessionId) {
          const b = getBucket(sessionId)
          b.messages = []
          b.lastId = 0
        }
        store.emit()
      }

      const close = () => {
        store.open = false
        store.emit()
      }

      // 键盘快捷键：Ctrl+Shift+K 清空当前会话对话记录（面板打开时生效）
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

      const msgs = bucket ? bucket.messages : []
      return React.createElement('div', { className: 'btw-overlay', onClick: close },
        React.createElement('div', { className: 'btw-panel', onClick: (e) => e.stopPropagation() },
          React.createElement('div', { className: 'btw-panel-head' },
            React.createElement('span', { className: 'btw-panel-title' }, 'BTW 旁路对话'),
            React.createElement('button', { className: 'btw-panel-btn', onClick: clearAll, title: '清空对话记录（Ctrl+Shift+K）' }, '清空'),
            React.createElement('button', { className: 'btw-panel-btn', onClick: close, title: '关闭面板' }, '✕'),
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
              ref: inputRef,
              className: 'btw-input',
              value: input,
              placeholder: '向旁路分支提问…',
              onChange: (e) => setInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } },
            }),
            React.createElement('button', { className: 'btw-send', onClick: send, disabled: busy || !input.trim() }, '发送'),
          ),
        ),
      )
    }

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'btw-panel' },
    () => {
      // 不调用任何 standard hook（root scope 外无法安全使用 useSessions）
      const snap = usePanel()
      if (!snap.open) return null
              return React.createElement(BtwPanel, { focusRequest: snap.focusRequest })
    },
  ))
}

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
