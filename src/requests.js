/**
 * 编号诉求注册表：跨会话、跨通道共用的多并发 pending 表。
 * 每个诉求：编号 #N、类型（approval/question）、发起会话、通道、超时与回执。
 *
 * 编号回复语法（router.js 解析）：
 *   #N 批准 / 批准 #N   —— 批准审批诉求
 *   #N 拒绝 / 拒绝 #N   —— 拒绝审批诉求
 *   #N <选项或文本>     —— 回答提问诉求
 *   回复 #N <文本>      —— 把文本注入该诉求所属会话
 *
 * 参考 dsh-chatnode-wechat 的编号审批（Map<number, entry>）设计，
 * 并补上：并发多诉求、诉求级超时定时器、按编号应答与中止联动、
 * 快照持久化（供命令行/重启后罗列）与重启后的 stale 标记。
 */

const STALE_TTL_MS = 60 * 60 * 1000

export class RequestRegistry {
  constructor(persist) {
    /** number -> entry */
    this.pending = new Map()
    /** number -> sessionId 的最近记录（LRU 200；诉求结束后仍可「回复 #N」注入其会话） */
    this.sessionHints = new Map()
    /** 快照写盘回调（debounce 由调用方负责），重启恢复/命令行罗列共用 */
    this.persist = persist
    this.persistTimer = undefined
    this.dirty = false
    this.staleCleanTimer = undefined
  }

  get size() {
    return this.pending.size
  }

  /** 纯数据快照（不含运行态对象，可安全写盘） */
  snapshot() {
    const out = []
    for (const entry of this.pending.values()) {
      out.push({
        number: entry.number,
        kind: entry.kind,
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
        stale: Boolean(entry.stale),
      })
    }
    out.sort((a, b) => a.number - b.number)
    return out
  }

  /** 重启恢复：原等待方已随进程消失，全部标 stale（过期自动清理） */
  restore(list) {
    const now = Date.now()
    for (const item of list ?? []) {
      if (!Number.isFinite(item.number) || item.createdAt === undefined) continue
      const entry = {
        number: item.number,
        kind: item.kind === 'question' ? 'question' : 'approval',
        sessionId: String(item.sessionId ?? ''),
        createdAt: item.createdAt,
        settled: false,
        stale: true,
        expiresAt: now + STALE_TTL_MS,
        settle: () => {},
        timer: undefined,
      }
      this.pending.set(entry.number, entry)
      this.sessionHints.set(entry.number, entry.sessionId)
    }
    this.scheduleStaleCleanup()
    // 恢复后立即落盘（自我修复：即使上次快照损坏/缺失，也把恢复结果固化）
    this.flushPersist()
  }

  scheduleStaleCleanup() {
    if (this.staleCleanTimer) return
    this.staleCleanTimer = setInterval(() => {
      const now = Date.now()
      for (const entry of [...this.pending.values()]) {
        if (entry.stale && entry.expiresAt !== undefined && now >= entry.expiresAt) {
          this.pending.delete(entry.number)
          this.markDirty()
        }
      }
      if (![...this.pending.values()].some((e) => e.stale)) {
        clearInterval(this.staleCleanTimer)
        this.staleCleanTimer = undefined
      }
    }, 60_000)
    this.staleCleanTimer.unref?.()
  }

  markDirty() {
    this.dirty = true
    if (this.persistTimer || !this.persist) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      if (!this.dirty) return
      this.dirty = false
      this.persist(this.snapshot())
    }, 500)
    this.persistTimer.unref?.()
  }

  /**
   * 挂起一个诉求，等待任意通道按编号应答。
   * @param {object} spec { number, kind, sessionId, timeoutMs, signal }
   *   resolve 收到 'allow' | 'reject' | {text} | undefined
   */
  register(spec) {
    const entry = {
      number: spec.number,
      kind: spec.kind,
      sessionId: spec.sessionId,
      createdAt: Date.now(),
      settled: false,
      stale: false,
      resolve: undefined,
      timer: undefined,
    }
    this.sessionHints.set(spec.number, spec.sessionId)
    if (this.sessionHints.size > 200) {
      const first = this.sessionHints.keys().next().value
      this.sessionHints.delete(first)
    }
    const promise = new Promise((resolve) => {
      const settle = (value) => {
        if (entry.settled) return
        entry.settled = true
        clearTimeout(entry.timer)
        entry.timer = undefined
        this.pending.delete(entry.number)
        this.markDirty()
        resolve(value)
      }
      entry.settle = settle
      entry.timer = setTimeout(() => settle(undefined), spec.timeoutMs)
      entry.timer.unref?.()
      spec.signal?.addEventListener('abort', () => settle(undefined), { once: true })
    })
    this.pending.set(spec.number, entry)
    // 注册立即落盘（快照必须跟注册同步，否则重启可能丢失 pending 诉求）
    this.markDirty()
    this.flushPersist()
    return promise
  }

  /** 通道侧应答。返回 'ok' | 'stale' | 'missing'。 */
  answer(number, value) {
    const entry = this.pending.get(number)
    if (entry === undefined) return 'missing'
    if (entry.stale) return 'stale'
    entry.settle(value)
    return 'ok'
  }

  isStale(number) {
    return this.pending.get(number)?.stale === true
  }

  /** 该编号是否曾是本插件的诉求（含已结束的；用于"外来编号静默忽略"判定） */
  hasHint(number) {
    return this.sessionHints.has(number)
  }

  has(number) {
    return this.pending.has(number)
  }

  /** 诉求所属会话（pending 优先，其次最近记录） */
  sessionOf(number) {
    return this.pending.get(number)?.sessionId ?? this.sessionHints.get(number)
  }

  get(number) {
    return this.pending.get(number)
  }

  /** 按类型取当前 pending 列表（供"裸批准/拒绝"就近匹配；不含 stale） */
  list(kind) {
    const out = []
    for (const entry of this.pending.values()) {
      if (entry.kind === kind && !entry.stale) out.push(entry)
    }
    return out.sort((a, b) => a.number - b.number)
  }

  /** 立即落盘（dispose 前调用，避免丢失最后快照） */
  flushPersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    if (this.dirty && this.persist) {
      this.dirty = false
      this.persist(this.snapshot())
    }
  }

  /** 关闭时清理：全部按未答复处理 */
  dispose() {
    if (this.staleCleanTimer) clearInterval(this.staleCleanTimer)
    this.staleCleanTimer = undefined
    this.flushPersist()
    for (const entry of [...this.pending.values()]) {
      clearTimeout(entry.timer)
      this.pending.delete(entry.number)
      if (!entry.stale) entry.settle?.(undefined)
    }
  }
}
