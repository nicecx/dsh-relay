/**
 * 轮次结束推送（turn/end → 通道）。
 *
 * 默认关闭（cfg.turnEndPush !== true 不推送）：轮次结束通知会把整段回复文本
 * 推到通道，易造成打扰/污染（历史教训）。开启时片段强制截断（snippetMaxChars）。
 * 只推**绑定会话**的轮次结束（连续对话模式：绑定哪个会话就只跟哪个会话来回）；
 * 未绑定任何会话时不推任何轮次结束（静默，避免交易/后台任务等会话打扰通道）。
 * 与 approval.js / questions.js 相同的 relay 注入模式，便于 dry-run 测试。
 */

const TURN_END_LABEL = {
  completed: '✅ 完成',
  error: '❌ 出错',
  aborted: '⏹ 已中止',
  blocked: '🚫 被阻塞',
  'max-tokens': '↯ 达到 token 上限',
  interrupted: '⏸ 被打断',
}

export function attachTurnEndRelay(ctx, relay) {
  return ctx.on('session/event', (session, event) => {
    relay.trackActive?.(session) // 维护"最近活跃"（仅用于展示/引用，不用于注入）
    if (event.type !== 'turn/end') return
    if (relay.cfg.turnEndPush !== true) return // 默认关闭
    if (!relay.store.sessionEnabled(session.id)) return
    if (!relay.hasActiveChannels()) return
    // 只推绑定会话（连续对话模式）：绑定哪个会话，就只推哪个会话的轮次结束。
    // 未绑定任何会话时不推任何轮次结束（静默），交易/后台任务等会话不打扰通道。
    const boundIds = new Set(
      Object.values(relay.store.state.boundSessions ?? {})
        .map(String).filter(Boolean),
    )
    if (!boundIds.has(String(session.id))) return
    const label = TURN_END_LABEL[event.data.reason.kind] ?? event.data.reason.kind
    let snippet = relay.lastAssistantText?.(session) ?? ''
    if (snippet && relay.redact) snippet = relay.redact(snippet)
    const max = relay.snippetMaxChars ?? 120
    if (snippet) snippet = [...snippet].slice(0, max).join('')
    relay.pushAll(
      `[${label}] ${relay.sessionLabel(session)} 第 ${event.data.turn} 轮结束` + (snippet ? `\n${snippet}` : ''),
      { number: 'turn', kind: 'turn', sessionId: String(session.id) },
    )
  }, { global: true })
}
