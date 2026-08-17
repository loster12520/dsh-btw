/**
 * dsh-btw — Host 半区
 *
 * 旁路问答分支（btw）：在独立会话中回答用户问题，分支可查看主对话历史
 * （创建时以主对话已完成 turn 为 seed + 每次提问注入增量），但只有只读 +
 * web 搜索权限（write/edit/bash/pwsh/ssh_* 等写类工具全部下掉）。
 *
 * 关键设计：
 * - 分支用 `agents.create` 创建「裸 agent」：不注册进 subagent registry，
 *   因此 GUI 不会把它显示为子代理；生命周期绑定插件 fiber（停止/更新时
 *   自动 dispose）。
 * - 复用同一分支：state.handle 持有分支，只要不清空，所有 /btw 命令与
 *   面板提问都走 followup 重定向到同一个分支。
 * - 并发安全：ask 经串行队列执行，命令与面板并发提问时排队，不会丢失回答。
 * - 问答历史（state.history）是命令路径与面板路径的统一记录，面板经
 *   btw/state RPC 轮询同步显示。
 *
 * 挂载方式：
 *   - 一键安装（推荐）：`dsh plugin --profile web add <本仓库路径>`。本文件作为
 *     cordis 插件行（cordis.patch.yml insert）加载，经 webServer 注册
 *     /api/dsh-btw/* HTTP 路由（带浏览器信任围栏）供静态 Client 半区 fetch 调用。
 *   - 动态插件：把本文件的 apply 逻辑作为 code.host（见 scripts/to-dynamic.mjs）。
 *     动态宿主沙箱会提供 `harness` 全局，此处用 typeof 守卫同时兼容两种路径。
 *   - 静态插件：本文件导出 apply，作为 cordis 插件行加载。
 */

export const inject = ['timer', 'webServer']

export function apply(ctx) {
  // ================= 状态 =================
          const sessions = new Map() // sessionId -> SessionState
    let openPanelIntent = null // Client 待消费的“打开面板”意图（单值，UI 为单一弹窗）

    const getSession = (sessionId) => {
      let s = sessions.get(sessionId)
      if (!s) {
        s = {
    handle: null,           // AgentHandle（裸 agent 分支）
    childId: null,          // 分支 session id
    lastSyncedSeq: -1,      // 主对话同步水位
    msgSeq: 0,              // 生成 UserMessage id 用
    history: [],            // [{ id, role, text }] 问答历史
    histSeq: 0,             // 历史消息自增 id
          askQueue: Promise.resolve(), // 串行化 ask：命令与面板并发提问时排队
        }
        sessions.set(sessionId, s)
      }
      return s
  }
  const waiters = new Map() // childId -> { resolve, reject, timer, turn, texts }

  const READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'read_image', 'web_search']
  const BTW_PERSONA = '你是主对话的旁路问答助手（btw）。你有权查看主对话的历史与最新进展（每次提问时注入），可以读取工作区文件并使用 web 搜索。你没有任何写权限：不能修改/创建文件、不能执行命令、不能进行任何写操作。回答要简洁、准确、直接针对问题。'

  // ================= 工具函数 =================
  const textOf = (blocks) => {
    if (!Array.isArray(blocks)) return ''
    return blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  }

  const lastCompletedTurnSeq = (parent) => {
    const events = parent.session.events || []
    let last = -1
    for (const ev of events) if (ev.type === 'turn/end' && ev.seq > last) last = ev.seq
    return last
  }

  // 读取主对话自 sinceSeq 之后的新消息；返回文本与读到的最后一条消息 seq
  // （水位推进到实际读到的最新消息，而非仅到最后一个 turn/end ——
  //   否则主对话有进行中 turn 时增量会重复注入）
  const readMainDelta = (parent, sinceSeq) => {
    const parts = []
    let last = sinceSeq
    const events = parent.session.events || []
    for (const ev of events) {
      if (ev.seq <= sinceSeq) continue
      if (ev.type === 'user/message') {
        parts.push('用户: ' + textOf(ev.data && ev.data.content))
        last = ev.seq
      } else if (ev.type === 'assistant/message') {
        parts.push('助手: ' + textOf(ev.data && ev.data.message && ev.data.message.content))
        last = ev.seq
      }
    }
    return { text: parts.join('\n'), lastSeq: last }
  }

  const pushHistory = (sessionId, role, text) => {
      const s = getSession(sessionId)
          s.history.push({ id: ++s.histSeq, role, text })
          if (s.history.length > 200) s.history = s.history.slice(-200)
  }

  // ================= 分支回答监听 =================
  ctx.on('session/event', (session, event) => {
    const waiter = waiters.get(session.id)
    if (!waiter) return
    if (event.type === 'turn/start') {
      waiter.turn = event.data.turn
    } else if (event.type === 'assistant/message' && event.data.turn === waiter.turn) {
      waiter.texts.push(textOf(event.data.message && event.data.message.content))
    } else if (event.type === 'turn/end' && event.data.turn === waiter.turn) {
      waiters.delete(session.id)
      waiter.timer()
      waiter.resolve(waiter.texts.join('\n').trim())
    }
  })

  const waitAnswer = (childId, timeoutMs) => new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null, turn: null, texts: [] }
    waiters.set(childId, waiter)
    waiter.timer = ctx.timeout(() => {
      waiters.delete(childId)
      reject(new Error('btw 分支回答超时'))
    }, timeoutMs)
  })

  // ================= 创建裸 agent 分支（不进 subagent registry → UI 不显示为子代理） =================
  const createBranch = async (parent, signal) => {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents 服务不可用')

    // seed：主对话已完成 turn 前缀（分支可查看主对话历史）
    const events = parent.session.events || []
    let lastEnd = -1
    for (const ev of events) if (ev.type === 'turn/end' && ev.seq > lastEnd) lastEnd = ev.seq
    const seed = lastEnd >= 0 ? events.slice(0, lastEnd + 1) : []

    const childId = 'btw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    const parentHeader = parent.session.header || {}
    const agentPresets = ctx.get('agentPresets')
    const preset = agentPresets ? agentPresets.composedPreset(parent.ctx) : undefined

    const handle = await agents.create({
      sessionId: childId,
      meta: {
        ...(parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}),
        ...(preset !== undefined ? { agentPreset: preset } : {}),
        parentSession: parent.session.id,
        origin: 'subagent',
        delegationDepth: 1,
        ...(seed.length > 0 ? { seedLength: seed.length } : {}),
      },
      ...(seed.length > 0 ? { seed } : {}),
      agentOptions: {
        ...(parent.options.provider !== undefined ? { provider: parent.options.provider } : {}),
        ...(parent.options.model !== undefined ? { model: parent.options.model } : {}),
        ...(parent.options.maxTokens !== undefined ? { maxTokens: parent.options.maxTokens } : {}),
      },
      signal,
      setup: (childCtx) => {
        // 继承父 preset（工具/提示配置）
        childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
        // 只读权限：白名单之外的全部移除（write/edit/bash/pwsh/ssh_* 等不可见）
        childCtx.tools.restrict({ allow: READ_ONLY_TOOLS })
        // 分支人格
        childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: BTW_PERSONA })
      },
    })
    return { handle, childId }
  }

  // ================= 核心 ask =================
  const askInner = async (parent, sessionId, text, signal) => {
      const s = getSession(sessionId)
    const question = String(text || '').trim()
    if (!question) throw new Error('问题不能为空')

    if (!s.handle || !s.childId) {
      // 新建分支（复用同一分支：只有清空或插件重启后才会重建）
      s.lastSyncedSeq = lastCompletedTurnSeq(parent)
      const created = await createBranch(parent, signal)
              s.handle = created.handle
              s.childId = created.childId
    }

          const childId = s.childId
    const content = []
    // 注入主对话增量（自上次同步水位之后的新消息），随后推进水位到实际读到的最后一条消息
          const delta = readMainDelta(parent, s.lastSyncedSeq)
          s.lastSyncedSeq = delta.lastSeq
    if (delta.text) content.push({ type: 'text', text: '【主对话最新进展，供你参考】\n' + delta.text })
    content.push({ type: 'text', text: question })

    const waiter = waitAnswer(childId, 120000)
          const agent = s.handle.agent
    try {
      agent.followup({
                  id: 'btw-' + (++s.msgSeq),
        role: 'user',
        content,
        source: { kind: 'user' },
      })
    } catch (err) {
      // followup 抛错时立即清理 waiter，避免悬挂到超时
      waiters.delete(childId)
      waiter.timer()
      throw err
    }
    const answer = await waiter

    // 记录到统一历史（面板同步显示）
          pushHistory(sessionId, 'user', question)
          pushHistory(sessionId, 'assistant', answer || '（分支未产生回答）')
    return answer
  }

  // 串行化入口：命令路径与面板路径可能并发提问，排队执行避免
  // waiters（单槽位）被覆盖导致回答丢失或悬挂。
  const ask = (parent, sessionId, text, signal) => {
      const s = getSession(sessionId)
          const run = s.askQueue.then(() => askInner(parent, sessionId, text, signal))
    // 队列自身吞掉错误，保证后续任务继续执行；调用方从 run 拿到真实结果
          s.askQueue = run.catch(() => {})
    return run
  }

    /* [old clearBtw replaced below]
  const clearBtw = async (sessionId) => {
      const s = sessions.get(sessionId)
      if (!s) return
      if (s.handle) {
    if (state.handle) {
      try { await s.handle.dispose() } catch (e) { // ignore }
    }
    for (const [id, waiter] of waiters) {
      waiters.delete(id)
      waiter.timer()
      waiter.reject(new Error('btw 对话已清空'))
    }
    state.handle = null
    state.childId = null
    state.lastSyncedSeq = -1
    state.history = []
    state.histSeq = 0
  }
    */

    const clearBtw = async (sessionId) => {
      const s = sessions.get(sessionId)
      if (!s) return
      if (s.handle) {
        try { await s.handle.dispose() } catch (e) { /* ignore */ }
      }
      if (s.childId) {
        const waiter = waiters.get(s.childId)
        if (waiter) {
          waiters.delete(s.childId)
          waiter.timer()
          waiter.reject(new Error('btw 对话已清空'))
        }
      }
      sessions.delete(sessionId)
    }

    /* [old ctx.effect replaced below]
  // 插件停止/更新时释放分支
  ctx.effect(() => () => {
    if (state.handle) {
      state.handle.dispose().catch(() => {})
      state.handle = null
      state.childId = null
    }
  })
    */

    // 插件停止/更新时释放所有会话分支
    ctx.effect(() => () => {
      for (const s of sessions.values()) {
        if (s.handle) {
          s.handle.dispose().catch(() => {})
        }
      }
      sessions.clear()
    })

  // ================= 命令：/btw <问题> =================
  const commands = ctx.get('commands')
  if (commands) {
    commands.register({
      name: 'btw',
      description: '开启或继续旁路问答（只读分支：可查看主对话历史 + 只读/搜索权限，回答不进入主对话上下文）',
      input: { hint: '输入你的问题' },
      // 不把用户的 /btw 输入写进主对话事件（command/run 不记录 args），
      // 且 Client 半区注册了 keyed commandview 渲染 null，主对话完全不留痕迹。
      recordInput: false,
              handler: async (invocation) => {
          const sessionId = invocation.agent?.session?.id
          if (!sessionId) return { kind: 'error', text: '无法获取当前会话' }
        const text = (invocation.rawInput || '').trim()
                  if (!text) {
            openPanelIntent = sessionId
            return { kind: 'success', text: '' }
          }
        try {
                      openPanelIntent = sessionId
            await ask(invocation.agent, sessionId, text, invocation.signal)
          // 答案不显示在主对话命令卡片，而是进入 btw 面板（经轮询同步）
                      return { kind: 'success', text: 'BTW 分支已回答，详见 BTW 面板。' }
        } catch (err) {
          return { kind: 'error', text: String(err && err.message || err) }
        }
      },
    })
  }

  // ================= Host RPC 方法（动态 harness 与静态 HTTP 路由共用） =================
  const rpcHandlers = {
    'btw/ask': async (args) => {
      const input = (args && typeof args === 'object') ? args : {}
      const agents = ctx.get('agents')
      let agent = agents && agents.get(input.sessionId)
      // 兜底：无 sessionId 或找不到时，取当前根 agent（面板可能未关联会话）
      if (!agent && agents) {
        const roots = agents.roots()
        agent = roots && roots.length > 0 ? roots[0] : undefined
      }
      if (!agent) return { ok: false, error: '找不到会话' }
      const sessionId = agent.session?.id || input.sessionId
      if (!sessionId) return { ok: false, error: '找不到会话' }
      try {
        const answer = await agent.runMaintenance(async (signal) => ask(agent, sessionId, input.text, signal))
        const s = getSession(sessionId)
        return { ok: true, answer, history: s.history.slice() }
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) }
      }
    },
    'btw/state': async (args) => {
      const sessionId = args && args.sessionId
      if (!sessionId || !sessions.has(sessionId)) return { ok: true, messages: [] }
      return { ok: true, messages: sessions.get(sessionId).history.slice() }
    },
    'btw/clear': async (args) => {
      const sessionId = args && args.sessionId
      if (sessionId) await clearBtw(sessionId)
      return { ok: true }
    },
    'btw/panel-intent': async () => {
      const sessionId = openPanelIntent
      openPanelIntent = null
      return { ok: true, sessionId }
    },
  }

  // 动态插件路径：`harness` 全局只存在于 cordis_define 的动态宿主沙箱中
  // （dsh-cordis-host-runner）；静态插件路径下它是未定义标识符，需用 typeof 守卫。
  if (typeof harness !== 'undefined') {
    for (const [method, handler] of Object.entries(rpcHandlers)) {
      harness.handle(method, handler)
    }
  }

  // ================= 静态插件路径：/api/dsh-btw HTTP 路由（带浏览器信任围栏） =================
  // `dsh plugin --profile web add <本仓库路径>` 安装后，Client 半区（dist/client.js）
  // 经普通 fetch 调用这里，语义与动态路径的 host.call 完全一致（同参数、同返回）。
  const trustedHostsOf = () => {
    try {
      const loader = ctx.get('loader')
      for (const entry of loader ? loader.entries() : []) {
        if (entry.options && entry.options.name === 'connection') {
          return (entry.options.config && entry.options.config.trustedHosts) || []
        }
      }
    } catch (e) { /* ignore */ }
    return []
  }
  const parseAuthority = (authority) => {
    try { return new URL('http://' + authority) } catch (e) { return undefined }
  }
  const isLoopbackHostname = (hostname) => {
    if (hostname === 'localhost' || hostname === '[::1]') return true
    const parts = hostname.split('.')
    return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  }
  const canonicalAuthority = (entry, entryUrl) => {
    const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
    return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
  }
  const isTrustedAuthority = (hostUrl, trustedHosts) => trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
  const isTrustedApiRequest = (req) => {
    const host = req.headers && req.headers.host
    if (typeof host !== 'string') return false
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return false
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHostsOf())) return false
    if (req.headers && req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers && req.headers.origin
    if (origin === undefined) return true
    try { return new URL(origin).host === hostUrl.host } catch (e) { return false }
  }
  const readJsonBody = async (req) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buffer.length
      if (total > 1 << 20) throw new Error('request body too large')
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return {}
    try { return JSON.parse(text) } catch (e) { throw new Error('request body is not valid JSON') }
  }
  const writeJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-btw',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
      // RPC 方法名带 btw/ 前缀（如 btw/panel-intent），URL 路径天然含斜杠，
      // 不能在这里用 includes('/') 拒绝；未知方法由下方 rpcHandlers 查找兜底 404。
      const method = pathname.startsWith('/api/dsh-btw/') ? pathname.slice('/api/dsh-btw/'.length) : undefined
      const handler = method === undefined ? undefined : rpcHandlers[method]
      if (!handler) {
        writeJson(res, 404, { ok: false, error: 'unknown dsh-btw API method' })
        return
      }
      try {
        const payload = await readJsonBody(req)
        writeJson(res, 200, await handler(payload))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        writeJson(res, 500, { ok: false, error: message })
      }
    },
  }), 'dsh-btw: /api/dsh-btw routes')
}
