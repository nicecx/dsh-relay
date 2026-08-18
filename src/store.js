/**
 * dsh-relay 持久化状态：单个 JSON 文件，原子写（tmp + rename）。
 * 移植自 dsh-im-bridge (MIT) 的 BridgeStore，扩展：总开关、按通道开关、
 * 按会话启用表、诉求编号游标、按通道去重/游标与绑定会话。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 内存去重上限与裁剪目标（AMClaw MAX_SEEN_IDS / TRIM_SEEN_IDS_TO） */
export const MAX_SEEN_IDS = 1000
export const TRIM_SEEN_IDS_TO = 500

const emptyState = () => ({
  /** 总开关：false 时不再推送/应答任何诉求（通道命令可翻转） */
  relayEnabled: undefined,
  /** 首次启动时总开关的默认值（来自行配置），落盘后不再变化 */
  relayEnabledDefault: true,
  /** 各通道启用开关：{ [channelId]: boolean } */
  channelEnabled: {},
  /** 所有会话开启（未单独列出的会话默认值） */
  allSessions: true,
  /** 按会话覆盖：{ [sessionId]: true|false } */
  sessions: {},
  /** 诉求编号游标（跨重启连续；每天零点重置） */
  nextRequestNumber: 1,
  /** 编号所属日期（YYYY-MM-DD，本地时区），跨天时编号归 1 */
  numberDate: '',
  /** 通道 → 已见消息 id 列表（持久去重，保序） */
  seenIds: {},
  /** iMessage：chatId → 最近已处理消息 id */
  imessageChatCursors: {},
  /** Email：已处理的最大 UID */
  emailLastUid: 0,
  /** 微信：ilink 白名单用户 / context token 缓存 */
  wechatAllowedUserId: '',
  wechatContextTokens: {},
  /** 通道 → 绑定会话（/bind 设置；显式注入目标） */
  boundSessions: {},
  /** 通道 → 最近对话（最近一次诉求推送/注入所属的会话；裸文本续接目标） */
  channelContexts: {},
  /** 合并窗口缓冲快照（崩溃恢复；flush 后删除）：channelId → senderId → parts */
  mergeBuffers: {},
})

export class RelayStore {
  constructor(path) {
    this.path = path
    this.state = this.load()
    this.seenSets = new Map()
    for (const [channel, ids] of Object.entries(this.state.seenIds)) {
      this.seenSets.set(channel, new Set(ids))
    }
    this.flushTimer = undefined
    this.dirty = false
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      const base = emptyState()
      if (typeof raw.relayEnabled === 'boolean') base.relayEnabled = raw.relayEnabled
      if (typeof raw.relayEnabledDefault === 'boolean') base.relayEnabledDefault = raw.relayEnabledDefault
      if (raw.channelEnabled && typeof raw.channelEnabled === 'object') base.channelEnabled = raw.channelEnabled
      if (typeof raw.allSessions === 'boolean') base.allSessions = raw.allSessions
      if (raw.sessions && typeof raw.sessions === 'object') base.sessions = raw.sessions
      if (Number.isFinite(raw.nextRequestNumber) && raw.nextRequestNumber > 0) base.nextRequestNumber = raw.nextRequestNumber
      if (typeof raw.numberDate === 'string') base.numberDate = raw.numberDate
      if (raw.seenIds && typeof raw.seenIds === 'object') base.seenIds = raw.seenIds
      if (raw.imessageChatCursors && typeof raw.imessageChatCursors === 'object') base.imessageChatCursors = raw.imessageChatCursors
      if (Number.isFinite(raw.emailLastUid)) base.emailLastUid = raw.emailLastUid
      if (typeof raw.wechatAllowedUserId === 'string') base.wechatAllowedUserId = raw.wechatAllowedUserId
      if (raw.wechatContextTokens && typeof raw.wechatContextTokens === 'object') base.wechatContextTokens = raw.wechatContextTokens
      if (raw.boundSessions && typeof raw.boundSessions === 'object') base.boundSessions = raw.boundSessions
      if (raw.channelContexts && typeof raw.channelContexts === 'object') base.channelContexts = raw.channelContexts
      if (raw.mergeBuffers && typeof raw.mergeBuffers === 'object') base.mergeBuffers = raw.mergeBuffers
      return base
    } catch {
      // 文件不存在或损坏：从空状态开始（损坏时宁可重来也不崩）
      return emptyState()
    }
  }

  // ---- 总开关 / 通道开关 ----

  /** 总开关（未显式设置过时用默认值） */
  get relayEnabled() {
    return this.state.relayEnabled ?? this.state.relayEnabledDefault
  }

  setRelayEnabled(value) {
    this.state.relayEnabled = Boolean(value)
    this.saveSoon()
  }

  channelEnabled(channelId, fallback = true) {
    const v = this.state.channelEnabled[channelId]
    return v === undefined ? fallback : Boolean(v)
  }

  setChannelEnabled(channelId, value) {
    this.state.channelEnabled[channelId] = Boolean(value)
    this.saveSoon()
  }

  // ---- 会话启用策略 ----

  /** 该会话是否启用诉求推送（总开关 && 会话策略） */
  sessionEnabled(sessionId) {
    const id = String(sessionId)
    if (!this.relayEnabled) return false
    const override = this.state.sessions[id]
    if (override !== undefined) return Boolean(override)
    return Boolean(this.state.allSessions)
  }

  setSessionEnabled(sessionId, value) {
    this.state.sessions[String(sessionId)] = Boolean(value)
    this.saveSoon()
  }

  clearSessionOverrides() {
    this.state.sessions = {}
    this.saveSoon()
  }

  setAllSessions(value) {
    this.state.allSessions = Boolean(value)
    this.saveSoon()
  }

  sessionOverrides() {
    return { ...this.state.sessions }
  }

  // ---- 诉求编号（每天零点重置） ----

  /** 本地时区日期 YYYY-MM-DD */
  static localDate() {
    const d = new Date()
    const pad = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  allocNumber() {
    const today = RelayStore.localDate()
    if (this.state.numberDate !== today) {
      this.state.numberDate = today
      this.state.nextRequestNumber = 1
    }
    const n = this.state.nextRequestNumber
    this.state.nextRequestNumber += 1
    this.saveSoon()
    return n
  }

  // ---- 去重 ----

  /** 去重判定 + 记录。已见过返回 true。 */
  checkAndMark(channelId, messageId) {
    let set = this.seenSets.get(channelId)
    if (set === undefined) {
      set = new Set(this.state.seenIds[channelId] ?? [])
      this.seenSets.set(channelId, set)
    }
    if (set.has(messageId)) return true
    set.add(messageId)
    const list = this.state.seenIds[channelId] ??= []
    list.push(messageId)
    if (list.length > MAX_SEEN_IDS) {
      const drop = list.splice(0, list.length - TRIM_SEEN_IDS_TO)
      for (const id of drop) set.delete(id)
    }
    this.saveSoon()
    return false
  }

  // ---- iMessage 游标 ----

  /** 某通道已见的纯 rowid 列表（iMessage 去重键形如 chatdb:123，用于启动水位） */
  seenRowids(channelId) {
    const list = this.state.seenIds[channelId] ?? []
    const out = []
    for (const key of list) {
      const m = /^chatdb:(\d+)$/.exec(key)
      if (m) out.push(Number(m[1]))
    }
    return out
  }

  imessageCursor(chatId) {
    return this.state.imessageChatCursors[chatId]
  }

  setImessageCursor(chatId, messageId) {
    this.state.imessageChatCursors[chatId] = String(messageId)
    this.saveSoon()
  }

  // ---- Email 游标 ----

  get emailCursor() {
    return this.state.emailLastUid
  }

  setEmailCursor(uid) {
    this.state.emailLastUid = uid
    this.saveSoon()
  }

  // ---- 微信 ----

  get wechatAllowedUser() {
    return this.state.wechatAllowedUserId
  }

  setWechatAllowedUser(userId) {
    this.state.wechatAllowedUserId = userId
    this.saveSoon()
  }

  wechatContextToken(userId) {
    return this.state.wechatContextTokens[userId]?.token
  }

  setWechatContextToken(userId, token) {
    this.state.wechatContextTokens[userId] = { token, updatedAt: Date.now() }
    this.saveSoon()
  }

  // ---- 绑定会话 ----

  boundSession(channelId) {
    return this.state.boundSessions[channelId] ?? ''
  }

  setBoundSession(channelId, sessionId) {
    this.state.boundSessions[channelId] = String(sessionId)
    this.saveSoon()
  }

  // ---- 通道最近对话（裸文本续接目标） ----

  channelContext(channelId) {
    return this.state.channelContexts[channelId] ?? ''
  }

  setChannelContext(channelId, sessionId) {
    if (!sessionId) return
    this.state.channelContexts[channelId] = String(sessionId)
    this.saveSoon()
  }

  // ---- 合并缓冲 ----

  setMergeBuffer(channelId, senderId, buffer) {
    this.state.mergeBuffers[channelId] ??= {}
    if (buffer.length === 0) {
      delete this.state.mergeBuffers[channelId][senderId]
      if (Object.keys(this.state.mergeBuffers[channelId]).length === 0) delete this.state.mergeBuffers[channelId]
    } else {
      this.state.mergeBuffers[channelId][senderId] = buffer
    }
    this.saveSoon()
  }

  mergeBuffers() {
    return structuredClone(this.state.mergeBuffers)
  }

  // ---- 落盘 ----

  /** 防抖落盘（去重表高频写，500ms 合并一次） */
  saveSoon() {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), 500)
    this.flushTimer.unref?.()
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (!this.dirty) return
    this.dirty = false
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state))
    renameSync(tmp, this.path)
  }
}
