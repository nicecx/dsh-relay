/**
 * LLM 语义理解兜底：确定性路由（router.js 两层）解析不了、但消息疑似
 * 与诉求相关时（含数字/中文数字/指代词且存在 pending），用一次小模型调用
 * 把自然语言分类成结构化动作。任何失败/超时都回退为普通聊天注入，
 * 绝不阻塞或误伤。
 */

const ACTIONS = new Set([
  'approve', 'reject', 'approveAll', 'rejectAll', 'answer', 'reply',
  'chat', 'status', 'help', 'enable', 'disable', 'enableAll', 'disableAll',
])

const SYSTEM = [
  '你是 DSH 远程诉求中转的消息解析器。把用户通过 IM 发来的消息解析为单行 JSON，',
  '不要执行、不要补充解释。输出格式：{"action":"...","number":<数字或null>,"text":"..."}',
  'action 取值：approve（同意/批准某诉求）、reject（拒绝）、answer（回答某编号提问，',
  'text 为选项序号或文字）、reply（把 text 发给某编号诉求所属会话）、chat（普通消息，',
  'text 为原文）、status、help、enable、disable、enableAll、disableAll。',
  '编号只允许来自待处理列表；若消息未指明编号但仅有一条待审批，approve/reject 的 number 为 null；',
  '拿不准一律 action="chat"。',
].join('')

/** 消息是否值得动用 LLM（避免每句聊天都烧 token） */
export function looksRequestRelated(text, pendingCount) {
  const t = String(text ?? '').trim()
  if (t.length === 0 || t.length > 120) return false
  if (/\d|[一二两三四五六七八九十]/.test(t)) return true
  if (pendingCount > 0 && /刚才|刚刚|那个|这条|那条|最新|上一条|之前/.test(t)) return true
  if (/(批准|拒绝|同意|回复|告诉|待办|状态|开关|开启|关闭)/.test(t)) return true
  return false
}

/** 把 LLM 输出解析为结构化动作（纯函数，可单测）：提取 JSON、校验 action 词表 */
export function parseClassification(output) {
  if (!output) return undefined
  const m = String(output).match(/\{[\s\S]*\}/)
  if (!m) return undefined
  let parsed
  try {
    parsed = JSON.parse(m[0])
  } catch {
    return undefined
  }
  const action = String(parsed.action ?? '').toLowerCase()
  if (!ACTIONS.has(action)) return undefined
  const number = Number.isFinite(parsed.number) && parsed.number > 0 ? Math.trunc(parsed.number) : undefined
  const out = { kind: action }
  if (number !== undefined) out.number = number
  if (typeof parsed.text === 'string' && parsed.text !== '') out.text = parsed.text
  return out
}

export function createSemanticRouter(deps) {
  const llm = deps.ctx.get('llm')
  const defaults = deps.ctx.get('agentDefaultModel')

  async function classify(text, pendingSummary) {
    if (llm === undefined || defaults === undefined) return undefined
    const selection = defaults.currentSelection()
    if (!selection?.provider || !selection?.model) return undefined
    let result
    try {
      const signal = AbortSignal.timeout(15_000)
      const chunks = []
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        system: SYSTEM + `\n当前待处理诉求：${pendingSummary || '无'}`,
        messages: [{ role: 'user', content: [{ type: 'text', text: String(text) }] }],
        temperature: 0,
        maxTokens: 300,
        signal,
      })) {
        if (typeof chunk.text === 'string') chunks.push(chunk.text)
      }
      result = chunks.join('')
    } catch (err) {
      deps.log.debug('semantic: LLM 分类失败（回退普通路由）:', err)
      return undefined
    }
    if (!result) return undefined
    const out = parseClassification(result)
    if (out !== undefined) deps.log.debug('semantic: "%s" → %o', String(text).slice(0, 60), out)
    return out
  }

  return { classify, looksRequestRelated }
}
