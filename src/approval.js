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

      // 双轨并行：通道裁决（手机回复）与网页裁决（api-proxy next 挂起）**同时等待**，
      // Promise.race 谁先到用谁——手机批立即生效，网页批也立即生效（不再"通道优先"，
      // 修复 2026-08-25：手机收到推送但网页看不到/批不了的感知问题）。
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

      const settled = await Promise.race([
        channelVerdict.then((verdict) => ({ source: 'channel', verdict })),
        webOutcome,
      ])

      const doneOf = (outcome) => ({ 'allowed-once': '✅ 已在电脑端批准', rejected: '❌ 已在电脑端拒绝', cancelled: '⏹ 已在电脑端取消' }[outcome])

      if (settled.source === 'channel') {
        const verdict = settled.verdict
        if (verdict === 'allow') return 'allowed-once'
        if (verdict === 'reject') return 'rejected'
        // 通道超时/中止（undefined）→ 网页裁决兜底（挂起中，用户仍可批）
        const web = await webOutcome
        const outcome = web.outcome
        const done = doneOf(outcome)
        if (done) relay.pushAll(`#${number} ${done}`, { number, kind: 'approval', sessionId })
        return outcome ?? 'unavailable'
      }
      // 网页先裁决：立即生效 + 结算通道侧（手机晚到不会被误报"不存在/过期"）
      const outcome = settled.outcome
      const done = doneOf(outcome)
      if (done) relay.pushAll(`#${number} ${done}`, { number, kind: 'approval', sessionId })
      if (outcome === 'allowed-once') relay.requests.answer(number, 'allow')
      else if (outcome === 'rejected') relay.requests.answer(number, 'reject')
      else relay.requests.answer(number, undefined)
      return outcome ?? 'unavailable'
    },
    { prepend: true, global: true },
  )
}
