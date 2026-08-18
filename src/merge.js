/**
 * 消息合并窗口（移植自 dsh-im-bridge/src/merge.ts，原注 MIT / AMClaw session_router）。
 * - `<text>..` 后缀：还有后续，入缓冲不触发（ChatContinue）
 * - `<text>!!` 后缀：说完了，入缓冲并立即 flush（ChatCommit）
 * - 裸文本：入缓冲，mergeTimeoutMs 超时后整体 flush
 * - 裸 `..` / `!!`（去掉后缀为空）：忽略
 * 缓冲内容用 "\n" join。实现用每用户一个 timer。
 */

/** 剥后缀判定：`..`/`!!` 后缀（在 trim 之后判断） */
export function chatControl(text) {
  const t = text.trim()
  if (t.endsWith('..')) {
    const body = t.slice(0, -2).trim()
    return body ? { kind: 'continue', body } : { kind: 'ignore', body: '' }
  }
  if (t.endsWith('!!')) {
    const body = t.slice(0, -2).trim()
    return body ? { kind: 'commit', body } : { kind: 'ignore', body: '' }
  }
  return { kind: 'pending', body: t }
}

export class SessionMerger {
  constructor(opts) {
    this.opts = opts
    this.buffers = new Map()
    this.timers = new Map()
  }

  ingest(key, text) {
    const ctl = chatControl(text)
    if (ctl.kind === 'ignore') return { kind: 'ignored' }
    const buf = this.buffers.get(key) ?? []
    buf.push(ctl.body)
    this.buffers.set(key, buf)
    this.opts.onSnapshot(key, [...buf])
    if (ctl.kind === 'commit') {
      return { kind: 'flush', text: this.drain(key) }
    }
    this.rearm(key)
    return { kind: 'buffered' }
  }

  restore(key, buffer) {
    if (buffer.length === 0) return
    this.buffers.set(key, [...buffer])
    this.rearm(key)
  }

  rearm(key) {
    const old = this.timers.get(key)
    if (old) clearTimeout(old)
    const t = setTimeout(() => {
      const text = this.drain(key)
      if (text) this.opts.onTimeoutFlush(key, text)
    }, this.opts.mergeTimeoutMs)
    t.unref?.()
    this.timers.set(key, t)
  }

  drain(key) {
    const t = this.timers.get(key)
    if (t) clearTimeout(t)
    this.timers.delete(key)
    const buf = this.buffers.get(key) ?? []
    this.buffers.delete(key)
    if (buf.length > 0) this.opts.onSnapshot(key, [])
    return buf.join('\n')
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.buffers.clear()
  }
}
