/**
 * 审批诉求（approval/request）远程应答。
 *
 * 关键：以 { prepend: true, global: true } 注册，抢在 api-proxy（网页答案器）
 * 之前拿到每次审批；未启用 / 无通道 / 超时 / 中止 → next() 委托下游，
 * 网页 UI 照常接管。上游 dsh-im-bridge 缺 prepend，在 web profile 中
 * 实际上拿不到审批，此处修正。
 */

export function attachApprovalRelay(ctx, relay) {
  return ctx.on(
    'approval/request',
    async (req, next) => {
      const sessionId = String(req.agent.session.id)
      if (!relay.hasActiveChannels() || !relay.store.sessionEnabled(sessionId)) return next()
      const number = relay.store.allocNumber()
      const prompt = [
        `🔐 #${number} 需要批准`,
        `会话: ${relay.sessionLabel(req.agent.session)}`,
        `工具: ${req.toolName}`,
        `原因: ${req.reason ?? '（未给出）'}`,
        `回复「#${number} 批准」或「#${number} 拒绝」`,
        `（${Math.max(1, Math.round(relay.cfg.approvalTimeoutSecs / 60))} 分钟内未回复将转回网页）`,
      ].join('\n')
      relay.pushAll(prompt, { number, kind: 'approval', sessionId })

      const verdict = await relay.requests.register({
        number,
        kind: 'approval',
        sessionId,
        timeoutMs: relay.cfg.approvalTimeoutSecs * 1000,
        signal: req.signal,
      })
      if (verdict === 'allow') return 'allowed-once'
      if (verdict === 'reject') return 'rejected'
      // 超时/中止/并发：委托下游 answerer（网页 UI）。待办已随移交从队列移除，
      // 若电脑端给出了结果，通知通道该诉求已完成，避免手机上悬挂未答复的诉求。
      const outcome = await next()
      const done = { 'allowed-once': '✅ 已在电脑端批准', rejected: '❌ 已在电脑端拒绝', cancelled: '⏹ 已在电脑端取消' }[outcome]
      if (done) relay.pushAll(`#${number} ${done}`, { number, kind: 'approval', sessionId })
      return outcome
    },
    { prepend: true, global: true },
  )
}
