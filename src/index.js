/**
 * dsh-relay：DSH 宿主级"远程诉求中转"插件（跨会话共享）。
 *
 * 基于 dsh-im-bridge (MIT) 的桥接模式扩展：
 * - 通道层：iMessage（AppleScript 发送 + chat.db 轮询）/ Email（IMAP+SMTP）/
 *   微信（iLink，默认禁用），Channel 契约见 channels/types.js，可继续接入
 *   Telegram / 钉钉 / 飞书 等。
 * - 编号诉求：#N 贯穿推送与应答（批准/拒绝/回答/回复），跨会话并发。
 * - 开关与会话配置：全部通过 IM 命令完成（开启/关闭、全部开启/全部关闭、
 *   /enable <sid>、/disable <sid>）。
 * - 关键修正：approval/request 与 tools/execute 监听均 { prepend: true }，
 *   排在本机答案器（api-proxy）之前；超时/未启用 → next() 转回网页 UI。
 *   上游 im-bridge 缺 prepend，在 web profile 中拿不到审批，这里修正。
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { RelayStore } from './store.js'
import { RequestRegistry } from './requests.js'
import { routeText, HELP } from './router.js'
import { attachApprovalRelay } from './approval.js'
import { attachQuestionRelay } from './questions.js'
import { splitReply } from './chunk.js'
import { SessionMerger } from './merge.js'
import { redactSecrets, GUARDRAIL_PREFIX } from './secure.js'
import { createSemanticRouter } from './semantic.js'
import { createImessageChannel } from './channels/imessage.js'
import { createEmailChannel } from './channels/email.js'
import { createWechatChannel } from './channels/wechat.js'
import { attachTurnEndRelay } from './turnpush.js'

export const name = 'dsh-relay'

/** 测试钩子：apply 后可用 testHooks.get(ctx) 取到 { dispatch, store, requests }（仅测试用） */
export const testHooks = new WeakMap()
export const inject = ['agents', 'jobs', 'sessions']

const LAST_TEXT_SNIPPET_CHARS = 600
const LONG_INPUT_ACK_CHARS = 180

const DEFAULTS = {
  enabled: true,
  approvalTimeoutSecs: 600,
  questionTimeoutSecs: 1800,
  chunkMaxChars: 1200,
  mergeTimeoutSecs: 5,
  imessagePollSecs: 5,
  emailPollSecs: 20,
  statePath: '',
  channels: {},
  /** 通道内 /sessions 回复策略：pointer=只给数量+指引（默认，防暴露）；full=完整列表；silent=不回复 */
  sessionsInChannel: 'pointer',
  /** 安全开关：允许文本注入 / 外发脱敏 */
  security: { allowInjection: false, redactSecrets: true },  // 裸文本注入默认关闭（共享通道共存安全）
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const statePath = cfg.statePath || join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-relay', 'state.json')
  const stateDir = dirname(statePath)
  const store = new RelayStore(statePath)
  if (store.state.relayEnabled === undefined) {
    store.setRelayEnabled(cfg.enabled)
    store.flush() // 首次默认值立即落盘
  }
  // 会话范围：配置可显式限定（如"仅当前对话"），未提供时保持持久化状态（默认全部开启）
  if (typeof cfg.allSessions === 'boolean') {
    store.setAllSessions(cfg.allSessions)
    store.clearSessionOverrides()
  }
  for (const [sid, on] of Object.entries(cfg.sessionOverrides ?? {})) {
    store.setSessionEnabled(sid, on)
  }

  const security = { ...(DEFAULTS.security), ...(cfg.security ?? {}) }

  const logger = ctx.logger(name)
  const log = {
    debug: (...a) => logger.debug(...a),
    info: (...a) => logger.info(...a),
    warn: (...a) => logger.warn(...a),
  }

  // ---- 待办快照持久化（命令行罗列/重启恢复共用） ----
  const pendingPath = join(stateDir, 'pending.json')
  const persistPending = (snapshot) => {
    try {
      mkdirSync(stateDir, { recursive: true })
      const tmp = `${pendingPath}.tmp`
      writeFileSync(tmp, JSON.stringify({ updatedAt: Date.now(), pending: snapshot }))
      renameSync(tmp, pendingPath)
    } catch (err) {
      log.warn('pending 快照写盘失败:', err)
    }
  }
  let restored = []
  try {
    const raw = JSON.parse(readFileSync(pendingPath, 'utf8'))
    if (Array.isArray(raw.pending)) restored = raw.pending
  } catch { /* 无快照或损坏：忽略 */ }

  const requests = new RequestRegistry(persistPending)
  requests.restore(restored)

  // ---- 会话工具 ----

  let lastActiveSessionId = ''
  let lastChannelId = ''

  const sessionTitle = (session) => {
    try {
      const t = ctx.get('sessionTitle')?.get(session)?.title
      if (t) return t
    } catch { /* 忽略 */ }
    return String(session.id)
  }

  const sessionLabel = (session) => `${sessionTitle(session)}（${session.id}）`

  const lastAssistantText = (session) => {
    for (const ev of [...session.events].reverse()) {
      if (ev.type !== 'assistant/message') continue
      const text = ev.data.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim()
      if (text) return [...text].slice(0, LAST_TEXT_SNIPPET_CHARS).join('')
    }
    return ''
  }

  // ---- 消息注入 ----

  const injectToSession = async (sid, text) => {
    if (!security.allowInjection) return '文本注入已禁用（security.allowInjection=false，仅可批准/拒绝/回答诉求）。'
    const id = String(sid)
    if (!id) return '还没有活跃会话。请先开始一个任务，或用 /bind <会话id> 绑定。'
    const agent = ctx.agents.get(id)
    if (!agent) return `会话 ${id} 当前没有运行中的 agent，无法注入。`
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `${GUARDRAIL_PREFIX}\n${text}` }],
      source: { kind: 'plugin', plugin: name, form: 'relay' },
    })
    log.info(`通道消息已注入会话 ${id}`)
    return text.length >= LONG_INPUT_ACK_CHARS ? '收到，处理中，稍后给你完整回复。' : ''
  }

  /**
   * 注入目标：只返回**显式绑定**的会话（/bind 或配置 boundSessions）。
   * 不再跟随"最近活跃会话"——否则通道消息会注入到用户正在使用的任何对话
   * （如科幻小说对话），造成跨对话污染。
   */
  const boundSessionFor = (channelId) => store.boundSession(channelId)

  // 配置可预设绑定（如 boundSessions: { imessage: 'session-xxx' }）
  for (const [ch, sid] of Object.entries(cfg.boundSessions ?? {})) {
    store.setBoundSession(ch, sid)
  }

  // ---- 通道注册 ----

  const channels = []

  const pushInbound = ({ channelId, senderId, messageId, text, alreadySeen = false }) => {
    // 去重：已 mark 过则跳过。iMessage 通道在 poll 里已先 mark（含自身推送/前缀排除的消息，
    // 保证水位推进），因此 imessage 传 alreadySeen=true 跳过这里的二次查重；
    // 其他通道（email/wechat）仍在此处统一去重。
    if (!alreadySeen && store.checkAndMark(channelId, messageId)) return
    const channel = channels.find((c) => c.id === channelId)
    if (channel === undefined) return
    if (!channel.isTrusted(senderId)) {
      log.warn('%s: 忽略未授权发送方消息: %s', channelId, senderId)
      return
    }
    void dispatch(text, channelId, senderId).then((reply) => {
      // 回执兜底（2026-08-20）：可信发送者的消息绝不静默——dispatch 返回空时
      // 也给一条轻量确认，让用户知道已收到（纯聊天文本/无操作命令均覆盖）。
      if (reply === undefined || reply === '') {
        reply = '✅ 已收到'
      }
      channel.send(reply).catch((err) => log.warn('%s: 回执发送失败:', channelId, err))
    })
  }

  const resolveSecret = async (ref) => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined || !ref) return undefined
    try {
      const resolved = await credentials.resolve(ref)
      return resolved?.value
    } catch { /* 无效引用或不可用：返回未配置 */ }
    return undefined
  }

  /** 每个通道一个可变 deps（signal 在启动时注入；watchdog 服务由 dsh-task-watchdog 提供） */
  const channelDeps = Object.fromEntries(['imessage', 'email', 'wechat'].map((id) => [id, {
    store,
    log,
    pushInbound,
    chunkMaxChars: cfg.chunkMaxChars,
    stateDir,
    resolveSecret,
    watchdog: ctx.get('watchdog'),
    pollSecs: id === 'imessage' ? cfg.imessagePollSecs : cfg.emailPollSecs,
    signal: undefined,
  }]))

  channels.push(
    createImessageChannel(cfg.channels?.imessage ?? {}, channelDeps.imessage),
    createEmailChannel(cfg.channels?.email ?? {}, channelDeps.email),
    createWechatChannel(cfg.channels?.wechat ?? {}, channelDeps.wechat),
  )

  // 启动条件：行配置 enabled && 状态开关 && 配置完备
  const channelActive = (ch) => {
    const rowEnabled = cfg.channels?.[ch.id]?.enabled !== false
    return rowEnabled && store.channelEnabled(ch.id, true) && ch.configured()
  }

  /** 当前可用的通道（用于诉求推送与应答） */
  const activeChannels = () => channels.filter(channelActive)

  const hasActiveChannels = () => activeChannels().length > 0

  /** 把一条文本推送到所有活动通道（失败仅记日志） */
  const pushAll = (text, meta) => {
    for (const channel of activeChannels()) {
      // 记录该通道的最近对话：无编号回复默认续接这个会话（iMessage 语义）
      if (meta.sessionId) store.setChannelContext(channel.id, meta.sessionId)
      channel.send(text).catch((err) => log.warn('%s: 推送失败（诉求 #%s）:', channel.id, meta.number, err))
    }
  }

  /** LLM 语义理解兜底（llm/agentDefaultModel 服务可用时） */
  const semantic = createSemanticRouter({ ctx, log })

  // ---- 命令调度 ----

  const staleReply = (number, kind) => `已收到你对 #${number} 的回答，但该诉求已因服务重启失效（原${kind === 'question' ? '提问' : '审批'}任务已中断），回答未能投递。如需继续，请重新发起或在本机处理。当前待办：${pendingListText()}`

  /**
   * 外来编号判定：编号既不在 pending 也不是本插件历史诉求、且当前没有任何待办时，
   * 消息大概率是发给同通道其他 agent（如 ops-agent）的，应静默忽略，
   * 避免在别人的对话里插嘴。
   */
  const foreignNumber = (number) => !requests.has(number) && !requests.hasHint(number) && requests.size === 0

  /** 诉求已结束（已应答/超时/电脑端处理）后的迟到回复提示（不注入，避免污染会话） */
  const closedRequestReply = (number) => `诉求 #${number} 已结束（已在电脑端处理或超时），无需再应答。如需继续，请发普通文本或「回复 #${number} <文本>」。`

  const pendingListText = () => {
    if (requests.size === 0) return '无'
    const lines = []
    for (const entry of requests.list('approval')) lines.push(`  #${entry.number} 审批（会话 ${entry.sessionId}）`)
    for (const entry of requests.list('question')) lines.push(`  #${entry.number} 提问（会话 ${entry.sessionId}）`)
    for (const entry of requests.snapshot().filter((e) => e.stale)) {
      lines.push(`  #${entry.number} ${entry.kind === 'approval' ? '审批' : '提问'}（会话 ${entry.sessionId}，已随重启失效）`)
    }
    return '\n' + lines.join('\n')
  }

  /** 给语义理解用的待办摘要（短文本） */
  const pendingSummary = () => {
    const items = requests.snapshot().filter((e) => !e.stale)
    if (items.length === 0) return '无'
    return items.map((e) => `#${e.number}=${e.kind === 'approval' ? '审批' : '提问'}`).join(' ')
  }

  const settleApprovalEntry = (entry, verdict, label) => {
    const result = requests.answer(entry.number, verdict)
    if (result === 'stale') return staleReply(entry.number)
    if (result === 'missing') return `编号 #${entry.number} 不存在或已过期。当前待办：${pendingListText()}`
    return `${label} #${entry.number}`
  }

  const handleApprove = (number, word) => {
    if (number !== undefined) {
      const entry = requests.get(number)
      if (entry === undefined) {
        if (foreignNumber(number)) return undefined
        return closedRequestReply(number)
      }
      if (entry.kind === 'question') return settleApprovalEntry(entry, { text: word ?? '批准' }, '✅ 已回答')
      return settleApprovalEntry(entry, 'allow', '✅ 已批准')
    }
    const approvals = requests.list('approval')
    if (approvals.length === 0) return '当前没有待批准的诉求。'
    if (approvals.length === 1) return settleApprovalEntry(approvals[0], 'allow', '✅ 已批准')
    return `有多条待审批诉求，请指明编号：${pendingListText()}`
  }

  const handleReject = (number, word) => {
    if (number !== undefined) {
      const entry = requests.get(number)
      if (entry === undefined) {
        if (foreignNumber(number)) return undefined
        return closedRequestReply(number)
      }
      if (entry.kind === 'question') return settleApprovalEntry(entry, { text: word ?? '拒绝' }, '✅ 已回答')
      return settleApprovalEntry(entry, 'reject', '❌ 已拒绝')
    }
    const approvals = requests.list('approval')
    if (approvals.length === 0) return '当前没有待批准的诉求。'
    if (approvals.length === 1) return settleApprovalEntry(approvals[0], 'reject', '❌ 已拒绝')
    return `有多条待审批诉求，请指明编号：${pendingListText()}`
  }

  const handleApproveAll = () => {
    const approvals = requests.list('approval')
    if (approvals.length === 0) return '当前没有待批准的诉求。'
    const numbers = approvals.map((e) => e.number)
    for (const entry of approvals) requests.answer(entry.number, 'allow')
    return `✅ 已全部批准：${numbers.map((n) => `#${n}`).join(' ')}`
  }

  const handleRejectAll = () => {
    const approvals = requests.list('approval')
    if (approvals.length === 0) return '当前没有待批准的诉求。'
    const numbers = approvals.map((e) => e.number)
    for (const entry of approvals) requests.answer(entry.number, 'reject')
    return `❌ 已全部拒绝：${numbers.map((n) => `#${n}`).join(' ')}`
  }

  const handleAnswer = async (number, text) => {
    const entry = requests.get(number)
    if (entry === undefined) {
      // 外来编号（发给同通道其他 agent 的）静默忽略
      if (foreignNumber(number)) return undefined
      // 诉求已结束（已应答/超时/电脑端处理）：**不再自动注入**——迟到回复若注入
      // 会污染该诉求所属会话（历史教训：回复「#N 批准」被塞进别的对话）。
      // 明确提示用户；如需继续，可用普通文本或「回复 #N <文本>」显式注入。
      return closedRequestReply(number)
    }
    if (entry.stale) return staleReply(number, entry.kind)
    if (entry.kind === 'approval') {
      // 审批诉求收到自由文本 → 视为"回复"注入会话
      const ack = await injectToSession(entry.sessionId, text)
      return ack || `✅ 已把回复注入会话 ${entry.sessionId}（审批 #${number} 仍待批准/拒绝）`
    }
    const result = requests.answer(number, { text })
    if (result === 'stale') return staleReply(number)
    return `✅ 已回答 #${number}`
  }

  const handleReply = async (number, text) => {
    const sid = requests.sessionOf(number)
    if (sid === undefined) return foreignNumber(number) ? undefined : `找不到编号 #${number} 对应的会话。`
    if (requests.isStale(number)) return staleReply(number)
    // 显式注入后，通道"最近对话"跟随该会话（续接一致性）
    if (lastChannelId) store.setChannelContext(lastChannelId, sid)
    const ack = await injectToSession(sid, text)
    return ack || `✅ 已注入会话 ${sid}`
  }

  const statusText = () => {
    const lines = [
      `总开关：${store.relayEnabled ? '开启' : '关闭'}`,
      `会话策略：${store.allSessions ? '全部开启' : '按白名单'}`,
    ]
    const overrides = store.sessionOverrides()
    if (Object.keys(overrides).length > 0) {
      lines.push(`单会话覆盖：${Object.entries(overrides).map(([k, v]) => `${k}=${v ? '开' : '关'}`).join(' ')}`)
    }
    for (const ch of channels) {
      lines.push(`${channelActive(ch) ? '🟢' : '⚪'} ${ch.status()}`)
    }
    lines.push(`最近活跃：${lastActiveSessionId || '（无）'}`)
    lines.push(`待办诉求：${pendingListText()}`)
    return lines.join('\n')
  }

  /**
   * 全量会话列表（活跃 + 持久化，含标题/开关/状态）。
   * 通过 sessionQuery.listSessions 取全部（不只活跃），批量读标题；
   * 无 sessionQuery 时退回活跃列表。
   */
  /** 收集全量会话（活跃+持久化），返回 [{id, live}] */
  /** 收集全量会话（活跃+持久化），返回 [{id, live}] */
  const collectSessions = async () => {
    const live = new Map(ctx.sessions.list().map((s) => [String(s.id), s]))
    const rows = []
    const seen = new Set()
    const query = ctx.get('sessionQuery')
    const persistence = ctx.get('sessionPersistence')
    try {
      if (query !== undefined && typeof query.listSessions === 'function') {
        for (const r of await query.listSessions()) {
          const id = String(r.header?.id ?? r.sessionId ?? r.id)
          if (!seen.has(id)) { seen.add(id); rows.push({ id, live: Boolean(r.live) }) }
        }
      } else if (persistence !== undefined && typeof persistence.list === 'function') {
        for (const h of await persistence.list()) {
          const id = String(h.id)
          if (!seen.has(id)) { seen.add(id); rows.push({ id, live: live.has(id) }) }
        }
      }
    } catch (err) {
      log.warn('sessions 全量列表获取失败，退回活跃列表:', err)
    }
    for (const s of live.values()) {
      const id = String(s.id)
      if (!seen.has(id)) { seen.add(id); rows.push({ id, live: true }) }
    }
    return rows
  }

  /** 完整会话列表文本（供网页 /relay sessions 与 full 策略；含标题/开关/活跃） */
  const sessionsText = async () => {
    const rows = await collectSessions()
    const live = new Map(ctx.sessions.list().map((s) => [String(s.id), s]))
    const titles = new Map()
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.readTitleSnapshots === 'function' && rows.length > 0) {
        for (const o of await query.readTitleSnapshots(rows.map((r) => r.id))) {
          if (o?.title?.title) titles.set(String(o.sessionId), o.title.title)
        }
      }
    } catch { /* 标题可缺省 */ }
    const lines = rows
      .sort((a, b) => Number(b.live) - Number(a.live))
      .slice(0, 40)
      .map((r) => {
        const title = titles.get(r.id) || (live.get(r.id) ? sessionTitle(live.get(r.id)) : '')
        return `${r.id}\t${title || '（无标题）'}\t${store.sessionEnabled(r.id) ? '开' : '关'}${r.live ? '\t●活跃' : ''}`
      })
    if (lines.length === 0) lines.push('（无会话）')
    return ['会话列表（id\t标题\t开关\t状态）：', ...lines, rows.length > 40 ? `…共 ${rows.length} 个会话，仅显示前 40` : ''].filter(Boolean).join('\n')
  }

  /** 通道内 /sessions 回复：按策略隔离（默认只给数量+指引，不暴露 id/标题） */
  const channelSessionsReply = async () => {
    const policy = cfg.sessionsInChannel ?? 'pointer'
    if (policy === 'silent') return undefined
    if (policy === 'full') return sessionsText()
    const rows = await collectSessions()
    const enabled = rows.filter((r) => store.sessionEnabled(r.id)).length
    return `共 ${rows.length} 个会话，其中启用 ${enabled} 个。为避免在共享通道暴露会话 id/标题，请在网页输入框执行 /relay sessions 查看完整列表。`
  }

  /**
   * 会话引用解析：last/latest = 最近活跃；完整 id；或 ≥4 位前缀（唯一匹配）。
   * 返回 undefined 表示无法唯一确定。
   */
  const resolveSessionRef = (ref) => {
    const input = String(ref ?? '').trim()
    if (input === '') return undefined
    if (input === 'last' || input === 'latest' || input === '最近') {
      if (lastActiveSessionId) return lastActiveSessionId
      return undefined
    }
    if (input.startsWith('session-') || input.length >= 12) {
      // 完整 id 或接近完整：直接按给定值处理（可能是新会话尚未进 live 列表）
      return input
    }
    const live = ctx.sessions.list().map((s) => String(s.id))
    const matches = live.filter((id) => id.startsWith(input) || id.replace(/^session-/, '').startsWith(input))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      log.info('会话前缀 %s 命中多个：%s', input, matches.join(','))
      return undefined
    }
    return undefined
  }

  const dispatch = async (rawText, channelId, senderId) => {
    lastChannelId = channelId
    let r = routeText(rawText)
    // LLM 语义兜底：确定性路由判为普通文本、但疑似与诉求相关时，用小模型再解析一次
    if ((r.kind === 'chat' || r.kind === 'noop') && semantic !== undefined) {
      if (semantic.looksRequestRelated(rawText, requests.size)) {
        const classified = await semantic.classify(rawText, pendingSummary())
        if (classified !== undefined && classified.kind !== 'chat') {
          r = { ...classified, text: classified.text ?? (r.kind === 'chat' ? r.text : undefined) }
        }
      }
    }
    switch (r.kind) {
      case 'noop': return undefined
      case 'approve': return handleApprove(r.number, r.word)
      case 'reject': return handleReject(r.number, r.word)
      case 'approveAll': return handleApproveAll()
      case 'rejectAll': return handleRejectAll()
      case 'answer': return handleAnswer(r.number, r.text)
      case 'reply': return handleReply(r.number, r.text)

      case 'enable':
        store.setRelayEnabled(true)
        return '✅ 已开启 dsh-relay 诉求中转'
      case 'disable':
        store.setRelayEnabled(false)
        return '🛑 已关闭 dsh-relay（不再推送/应答诉求，命令仍可用）'
      case 'enableChannel': {
        const ch = channels.find((c) => c.id === r.channel)
        if (ch === undefined) return `未知通道 ${r.channel}（可用：imessage/email/wechat）。`
        if (!ch.configured()) return `通道 ${ch.label} 尚未配置完整，请先填写 profile 配置。`
        if (cfg.channels?.[r.channel]?.enabled === false) return `通道 ${ch.label} 未在 profile 配置中启用（需修改 cordis.patch.yml 后重启）。`
        store.setChannelEnabled(r.channel, true)
        // 重新开启：若通道曾主动停止，恢复轮询并重新注册到 watchdog
        const runner = channelRunners.get(r.channel)
        if (!runner) {
          startChannelJob(ch)
          registerChannelToWatchdog(ch)
        }
        return `✅ 已开启 ${ch.label} 通道`
      }
      case 'disableChannel': {
        const ch = channels.find((c) => c.id === r.channel)
        if (ch === undefined) return `未知通道 ${r.channel}。`
        store.setChannelEnabled(r.channel, false)
        // 主动关闭：停止通道轮询 + 通知 watchdog 停止监控（避免心跳停滞误判重启）
        const runner = channelRunners.get(r.channel)
        try { runner?.controller.abort() } catch { /* 忽略 */ }
        try { ch.stop?.() } catch { /* 忽略 */ }
        const wdOff = ctx.get('watchdog')
        if (wdOff !== undefined) {
          const jobId = channelRunners.get(r.channel)?.jobId
          if (jobId) wdOff.stop(jobId) // 用真实 jobId 通知 watchdog 主动停止
        }
        return `⏸ 已关闭 ${ch.label} 通道`
      }
      case 'enableAll':
        store.setAllSessions(true)
        store.clearSessionOverrides()
        return '✅ 全部会话开启（清空单会话覆盖）'
      case 'disableAll':
        store.setAllSessions(false)
        store.clearSessionOverrides()
        return '🛑 全部会话关闭（清空单会话覆盖）'
      case 'enableSession':
      case 'disableSession': {
        const sid = resolveSessionRef(r.sessionId)
        if (sid === undefined) return '找不到匹配的会话。用 /sessions 看列表，或用 /enable last（最近活跃）或 /enable <前缀>'
        store.setSessionEnabled(sid, r.kind === 'enableSession')
        return r.kind === 'enableSession' ? `✅ 会话 ${sid} 已开启` : `🛑 会话 ${sid} 已关闭`
      }
      case 'bind': {
        const sid = resolveSessionRef(r.sessionId)
        if (sid === undefined) return '找不到匹配的会话。用 /sessions 看列表，或用 /bind last（最近活跃）或 /bind <前缀>'
        const exists = ctx.sessions.get(sid) !== undefined
        store.setBoundSession(channelId, sid)
        store.setChannelContext(channelId, sid) // 绑定即成为该通道的续接目标
        return `✅ 已绑定会话 ${sid}${exists ? '' : '（当前非活跃会话，注入时需其 agent 在运行）'}。`
      }
      case 'unbind':
        store.setBoundSession(channelId, '')
        return '✅ 已解绑，将跟随最近活跃会话。'
      case 'sessions': return channelSessionsReply()
      case 'status': return statusText()
      case 'help': return HELP
      case 'chat': {
        // 裸文本注入默认关闭（allowInjection=false）：共享通道上其他机器人的
        // 会话里，用户发给别的 bot 的普通文本不应被本插件截胡/注入/回复——静默放过。
        if (!security.allowInjection) return undefined
        const action = merger.ingest(`${channelId}:${senderId}`, r.text)
        if (action.kind !== 'flush') return undefined
        // 无编号回复默认续接该通道的"最近对话"（诉求推送记录），其次显式绑定会话
        const target = store.channelContext(channelId) || boundSessionFor(channelId)
        return injectToSession(target, action.text)
      }
      default: return undefined
    }
  }

  // ---- 合并窗口（.. / !! / 超时合并），按 通道:发送方 隔离 ----

  const merger = new SessionMerger({
    mergeTimeoutMs: cfg.mergeTimeoutSecs * 1000,
    onSnapshot: (key, buffer) => {
      const [channelId, ...rest] = key.split(':')
      store.setMergeBuffer(channelId, rest.join(':'), buffer)
    },
    onTimeoutFlush: (key, text) => {
      const [channelId] = key.split(':')
      if (!security.allowInjection) return
      const target = store.channelContext(channelId) || boundSessionFor(channelId)
      void injectToSession(target, text)
    },
  })
  for (const [channelId, senders] of Object.entries(store.mergeBuffers())) {
    for (const [senderId, buffer] of Object.entries(senders)) {
      merger.restore(`${channelId}:${senderId}`, buffer)
    }
  }

  // ---- 诉求监听（prepend：排在本机答案器之前） ----

  const disposers = [
    attachApprovalRelay(ctx, {
      store,
      requests,
      hasActiveChannels,
      pushAll,
      sessionLabel,
      cfg,
    }),
    attachQuestionRelay(ctx, {
      store,
      requests,
      hasActiveChannels,
      pushAll,
      sessionLabel,
      cfg,
    }),
  ]

  // ---- turn/end 推送（默认关闭：轮次结束通知会把整段回复文本推到通道，易造成打扰/污染；需要时配置 turnEndPush: true） ----

  disposers.push(attachTurnEndRelay(ctx, {
    store,
    cfg,
    hasActiveChannels,
    pushAll,
    sessionLabel,
    lastAssistantText,
    trackActive: (session) => { lastActiveSessionId = String(session.id) },
    redact: (s) => (security.redactSecrets ? redactSecrets(s) : s),
    snippetMaxChars: 120,
  }))

  // ---- 通道启动（每个通道一个 jobs 任务，便于在 UI 中查看） ----

  try {
    ctx.effect(() => ctx.jobs.attachController(name))
  } catch (err) {
    log.warn('jobs.attachController 失败（忽略）:', err)
  }

  const recent = []
  const pushLine = (line) => {
    recent.push(`${new Date().toISOString()} ${line}`)
    if (recent.length > 200) recent.splice(0, recent.length - 200)
  }
  const rawInfo = log.info
  log.info = (m, ...a) => {
    pushLine(`INFO ${m} ${a.map(String).join(' ')}`)
    rawInfo(m, ...a)
  }
  const rawWarn = log.warn
  log.warn = (m, ...a) => {
    pushLine(`WARN ${m} ${a.map(String).join(' ')}`)
    rawWarn(m, ...a)
  }

  const jobs = ctx.jobs

  /** 每个通道的运行句柄（watchdog 重启用） */
  const channelRunners = new Map()

  /** 启动单个通道的轮询 job；返回该通道的停止函数 */
  const startChannelJob = (channel) => {
    const controller = new AbortController()
    channelDeps[channel.id].signal = controller.signal
    // ctx.jobs.start 返回真实 jobId（dsh-relay-N），watchdog 用它对接任务生命周期
    const jobId = jobs.start({
      kind: 'dsh-relay',
      label: `${channel.label} 通道轮询`,
      run: () => {
        const done = channel.start().then(
          () => ({ status: 'completed' }),
          (err) => ({ status: 'failed', detail: String(err) }),
        )
        return {
          cancel: () => controller.abort(),
          done,
          readOutput: () => recent.splice(0).join('\n'),
        }
      },
    })
    channelDeps[channel.id].jobId = jobId // 通道 poll 里 watchdog.beat 用真实 jobId
    channelRunners.set(channel.id, { controller, channel, jobId })
    return () => {
      try { controller.abort() } catch { /* 忽略 */ }
      channelRunners.delete(channel.id)
    }
  }

  for (const channel of channels) {
    if (!channelActive(channel)) {
      log.info('通道 %s 未启用或未配置，跳过启动', channel.id)
      continue
    }
    startChannelJob(channel)
  }

  // ---- 通道健康监控（2026-08-20）：委托给 dsh-task-watchdog 插件 ----
  // 每个通道在 poll 循环里调用 deps.watchdog.beat(channel.id) 上报心跳；
  // 停滞/启动失败由 watchdog 插件统一诊断、自动重启、失败告警。
  // 本插件不再内置 watchdog 逻辑（单一职责，见 README 推荐）。
  const watchdogSvc = ctx.get('watchdog')

  /** 把单个通道注册到 watchdog（启动循环与「开启通道」命令共用） */
  const registerChannelToWatchdog = (channel) => {
    if (watchdogSvc === undefined) return
    const runner = channelRunners.get(channel.id)
    const jobId = runner?.jobId
    if (!jobId) {
      log.warn('watchdog: 通道 %s 尚无 jobId（jobs.start 未返回？），跳过监控注册', channel.id)
      return
    }
    const unreg = watchdogSvc.monitor({
      jobId, // 对接 ctx.jobs 的真实任务 id：任务终结/被 kill → watchdog 自动移除监控
      label: `${channel.label} 通道轮询`,
      restart: () => {
        // 若通道已被用户主动关闭（channelEnabled=false 或 relay 总开关关闭），
        // 不重启——改为通知 watchdog 主动停止（区分"主动停止"与"意外停滞"）
        if (!channelActive(channel) || !store.relayEnabled) {
          log.info('watchdog: 通道 %s 已被主动关闭，通知 watchdog 停止监控（不重启）', channel.id)
          watchdogSvc.stop(jobId)
          return
        }
        log.warn('watchdog: 重启通道 %s…', channel.id)
        const runner2 = channelRunners.get(channel.id)
        try { runner2?.controller.abort() } catch { /* 忽略 */ }
        void Promise.resolve()
          .then(() => { try { return channel.stop() } catch { /* 忽略 */ } })
          .then(() => startChannelJob(channel))
          .catch((err) => log.warn('watchdog: 通道 %s 重启异常:', channel.id, err))
      },
      persist: (diag) => {
        // 诊断快照落盘到 store（跨重启保留，供根因分析）
        try {
          const prev = Array.isArray(store.state.channelDiag) ? store.state.channelDiag : []
          store.state.channelDiag = [...prev.slice(-9), { ...diag, channelId: channel.id }]
          store.saveSoon()
        } catch (err) {
          log.warn('watchdog: 诊断落盘失败（%s）:', channel.id, err)
        }
      },
      alertSink: (msg) => {
        const alive = activeChannels().filter((c) => c.id !== channel.id)
        for (const ch of alive) {
          ch.send(msg).catch((err) => log.warn('watchdog: 告警推送失败（%s）:', ch.id, err))
        }
      },
    })
    disposers.push(unreg)
  }

  if (watchdogSvc !== undefined) {
    for (const channel of channels) {
      if (channelActive(channel)) registerChannelToWatchdog(channel)
    }
    log.info('dsh-relay: 已注册 %s 个通道到 watchdog 服务', channels.filter(channelActive).length)
  } else {
    log.warn('dsh-relay: 未找到 watchdog 服务（dsh-task-watchdog 未安装？），通道健康监控不可用')
  }

  // ---- /relay 命令（网页命令输入行：罗列未回复诉求/状态） ----

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    try {
      const dispose = commands.register({
        name: 'relay',
        description: 'dsh-relay 远程诉求中转：罗列待回复诉求与状态（/relay、/relay status、/relay sessions）',
        handler: async ({ rawInput }) => {
          const arg = String(rawInput ?? '').trim()
          if (arg === '' || arg === 'list' || arg === '列表') return { kind: 'success', text: `待回复诉求：${pendingListText()}` }
          if (arg === 'status' || arg === '状态') return { kind: 'success', text: statusText() }
          if (arg === 'sessions') return { kind: 'success', text: await sessionsText() }
          if (arg === 'help') return { kind: 'success', text: HELP }
          return { kind: 'error', text: '用法：/relay | /relay status | /relay sessions' }
        },
      })
      disposers.push(dispose)
    } catch (err) {
      log.warn('commands 注册失败（忽略）:', err)
    }
  }

  // 清理：停通道、关合并器、清理 pending、落盘
  ctx.effect(() => () => {
    for (const d of disposers) d()
    merger.dispose()
    requests.dispose()
    store.flush()
  })
  try { testHooks.set(ctx, { dispatch, store, requests, boundSessionFor, pushInbound }) } catch { /* 测试钩子失败不影响运行 */ }
  log.info('dsh-relay loaded（状态文件 %s）', statePath)
}
