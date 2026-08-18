/**
 * 提问诉求（ask_user_question，即"开发建议"类询问）远程应答。
 *
 * 通过 tools/execute waterfall 拦截（{ prepend: true, global: true } 抢在
 * 其他包装器前；未启用时 next() 正常执行工具）。与 lark-bridge 直接替换
 * userQuestions provider 不同，这里不与 api-proxy 的网页提问桥冲突，
 * 网页 UI 与 IM 通道可同时存在。
 *
 * 应答成功后返回与该工具 body 等价的 ToolExecutionResult：
 * value = { answers: [...] }，content = JSON.stringify(value)（与工具的
 * render 一致，见 @deepseek-ai/dsh-tool-ask-user）。
 */

import { parseAnswer, renderQuestionPrompt } from './answers.js'

const TOOL_NAME = 'ask_user_question'

export function attachQuestionRelay(ctx, relay) {
  return ctx.on(
    'tools/execute',
    async (exec, next) => {
      if (exec.name !== TOOL_NAME) return next()
      if (exec.agent === undefined) return next()
      const sessionId = String(exec.agent.session.id)
      if (!relay.hasActiveChannels() || !relay.store.sessionEnabled(sessionId)) return next()

      const args = exec.arguments ?? {}
      if (!Array.isArray(args.questions) || args.questions.length === 0) return next()

      const number = relay.store.allocNumber()
      const prompt = renderQuestionPrompt(
        number,
        args.questions,
        relay.sessionLabel(exec.agent.session),
        relay.cfg.questionTimeoutSecs,
      )
      relay.pushAll(prompt, { number, kind: 'question', sessionId })

      const answer = await relay.requests.register({
        number,
        kind: 'question',
        sessionId,
        timeoutMs: relay.cfg.questionTimeoutSecs * 1000,
        signal: exec.signal,
      })
      if (answer === undefined || answer === null) {
        // 超时/中止 → 转网页 UI。待办已随移交从队列移除；若电脑端已回答，
        // 通知通道该诉求已完成，避免手机上悬挂未答复的诉求。
        const result = await next()
        try {
          const answers = result?.value?.answers
          if (Array.isArray(answers) && answers.length > 0) {
            const summary = answers
              .map((a) => `${a.id}:${Array.isArray(a.selected) && a.selected.length > 0 ? a.selected.join(',') : (a.custom ?? '')}`)
              .join('；')
            relay.pushAll(`#${number} ✅ 已在电脑端回答${summary ? `（${summary}）` : ''}`, { number, kind: 'question', sessionId })
          }
        } catch { /* 通知失败不影响结果 */ }
        return result
      }

      const text = typeof answer === 'string' ? answer : String(answer.text ?? '')
      const value = { answers: parseAnswer(args.questions, text) }
      return {
        isError: false,
        value,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      }
    },
    { prepend: true, global: true },
  )
}
