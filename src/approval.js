/**
 * 审批诉求（approval/request）双轨应答。
 *
 * 双轨（2026-08-20 修复 regression）：网页与通道**同时**都能批准——
 * - 拦截后：推送通道 + 调 next() 让网页 UI 也显示并挂起等待；
 * - 用 Promise.race 等「通道裁决」或「网页裁决」，谁先到用谁；
 * - 通道先答 → 返回通道裁决（waterfall 结束；网页侧 pending 的迟到点击
 *   只是清理+广播，无害，见 dsh-host-apiproxy settle 逻辑）；
 * - 网页先答 → next() 返回 outcome，插件结算通道侧（通道收到"已在电脑端处理"）。
 *
 * 关键：以 { prepend: true, global: true } 注册，抢在 api-proxy 之前；
 * 未启用 / 无通道 / 会话未启用 → next() 全权委托网页。
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

      // 双轨：通道裁决（register 挂起等通道回复） vs 网页裁决（next 挂起等网页用户）
      const channelVerdict = relay.requests.register({
        number,
        kind: 'approval',
        sessionId,
        timeoutMs: relay.cfg.approvalTimeoutSecs * 1000,
        signal: req.signal,
      })
      const webOutcome = Promise.resolve()
        .then(() => next())
        .then((outcome) => ({ source: 'web', outcome }))
        .catch(() => ({ source: 'web', outcome: undefined }))

      const channelResult = channelVerdict.then((v) => ({ source: 'channel', outcome: v }))

      const first = await Promise.race([channelResult, webOutcome])

      if (first.source === 'channel') {
        const verdict = first.outcome
        if (verdict === 'allow') return 'allowed-once'
        if (verdict === 'reject') return 'rejected'
        // 通道超时/中止：网页侧仍在显示挂起（next 已调用），用户随时可点。
        // 返回 unavailable 结束本监听器（网页 pending 的迟到结算安全），
        // 不阻塞等网页——网页用户操作后由 api-proxy 自行 settle。
        return 'unavailable'
      }

      // 网页先答：结算通道侧（通道收到"已在电脑端处理"，避免手机悬挂）
      const outcome = first.outcome
      if (outcome === 'allowed-once') relay.requests.answer(number, 'allow')
      else if (outcome === 'rejected') relay.requests.answer(number, 'reject')
      const done = { 'allowed-once': '✅ 已在电脑端批准', rejected: '❌ 已在电脑端拒绝', cancelled: '⏹ 已在电脑端取消' }[outcome]
      if (done) relay.pushAll(`#${number} ${done}`, { number, kind: 'approval', sessionId })
      return outcome
    },
    { prepend: true, global: true },
  )
}
