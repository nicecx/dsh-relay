/**
 * 提问诉求（ask_user_question）的 IM 应答解析：把 `#N <文本>` 的文本
 * 映射成 AskUserQuestionAnswer 的 answers 数组。
 *
 * 规则（对每个问题）：
 * - 「1,3」/「2 4」→ 按 1 起始序号选选项 label（多选可多个）
 * - 「是」等文本恰与某选项 label 匹配 → 选中该 label
 * - 「q1:1 ; q2:自定义」→ 按问题 id 前缀回答多个问题
 * - 其余文本 → custom 自由文本
 * - 单选项收到多个 label 时取第一个
 */

/** 归一化问题列表：接受 {questions:[...]}（工具入参）或直接的问题数组 */
export function normalizeQuestions(args) {
  const list = Array.isArray(args) ? args : (Array.isArray(args?.questions) ? args.questions : [])
  return list.map((q, i) => ({
    id: String(q.id ?? `q${list.indexOf(q) + 1}`),
    question: String(q.question ?? ''),
    header: q.header === undefined ? undefined : String(q.header),
    detail: q.detail === undefined ? undefined : String(q.detail),
    options: Array.isArray(q.options) ? q.options.map((o) => ({
      label: String(o.label ?? ''),
      description: o.description === undefined ? undefined : String(o.description),
    })) : [],
    multiSelect: Boolean(q.multiSelect),
    intent: q.intent === undefined || typeof q.intent !== 'object' ? undefined : {
      kind: String(q.intent.kind ?? ''),
      approve: String(q.intent.approve ?? ''),
    },
  }))
}

/** 单问题应答 → { id, selected, custom? } */
export function answerFor(q, text) {
  const t = String(text ?? '').trim()
  const tokens = t.split(/[,，、\s]+/).filter(Boolean)
  const selected = []
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const idx = Number(token) - 1
      const opt = q.options[idx]
      if (opt !== undefined) selected.push(opt.label)
    } else if (q.options.some((o) => o.label === token)) {
      selected.push(token)
    }
  }
  const unique = [...new Set(selected)]
  const final = q.multiSelect ? unique : unique.slice(0, 1)
  const custom = final.length === 0 && t !== '' ? t : undefined
  const out = { id: q.id, selected: final }
  if (custom !== undefined) out.custom = custom
  return out
}

/**
 * 主入口：questions + 应答文本 → answers 数组。
 * 多问题时按「qid:应答」段解析；无前缀段作用于第一个问题。
 */
export function parseAnswer(questions, text) {
  const qs = normalizeQuestions(questions)
  const t = String(text ?? '').trim()
  if (qs.length === 0) return []
  if (qs.length === 1) return [answerFor(qs[0], t)]

  const answers = []
  const answered = new Set()
  const parts = t.split(/[;\n]+/).map((p) => p.trim()).filter(Boolean)
  for (const part of parts) {
    const m = part.match(/^([^:=：]{1,64})[:=：]\s*([\s\S]+)$/)
    if (m) {
      const q = qs.find((candidate) => candidate.id === m[1].trim())
      if (q !== undefined && !answered.has(q.id)) {
        answers.push(answerFor(q, m[2].trim()))
        answered.add(q.id)
      }
    }
  }
  // 无前缀段 → 第一个未回答问题
  if (answered.size === 0) {
    const first = qs.find((q) => !answered.has(q.id))
    if (first !== undefined) {
      answers.push(answerFor(first, t))
      answered.add(first.id)
    }
  }
  // 未回答的问题补空（保证每个问题都有回执）
  for (const q of qs) {
    if (!answered.has(q.id)) answers.push({ id: q.id, selected: [] })
  }
  return answers
}

/** 渲染编号提问推送文案 */
export function renderQuestionPrompt(number, questions, label, timeoutSecs) {
  const qs = normalizeQuestions(questions)
  const lines = [`❓ #${number} 需要你的意见`, label !== '' ? `会话: ${label}` : undefined]
  qs.forEach((q, i) => {
    lines.push(`Q${i + 1}: ${q.question}`)
    if (q.options.length > 0) {
      lines.push(q.options.map((o, j) => `  ${j + 1}. ${o.label}${o.description ? `（${o.description}）` : ''}`).join('\n'))
    }
    if (q.multiSelect) lines.push('  （可多选，逗号分隔）')
  })
  lines.push(
    qs.length > 1 ? '回复格式：#N q1:1 q2:自定义文本（q 编号见上）' : '回复格式：#N <选项序号或自定义文本>',
    `（${Math.max(1, Math.round(timeoutSecs / 60))} 分钟内未回复将转回网页）`,
  )
  return lines.filter((l) => l !== undefined).join('\n')
}
