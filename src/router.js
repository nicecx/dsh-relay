/**
 * 入站文本命令路由。两层：
 * 1) 严格层：精确/前缀模式（原有语法，绝对不误判正文）；
 * 2) 宽容语义层：自然语言变体——中文数字、「第N个/条」、「把N批了」、
 *    「全部批准/都同意」等。宽容层要求消息中必须出现编号令牌或强意图词，
 *    否则一律判为普通聊天文本，避免误执行。
 *
 * 编号诉求回复语法（严格层）：
 *   #N 批准 | 批准 #N | #N 同意 | #N approve | #N y/yes     —— 批准审批诉求 #N
 *   #N 拒绝 | 拒绝 #N | #N reject | #N n/no                 —— 拒绝审批诉求 #N
 *   #N <选项编号|选项文本|自定义文本>                        —— 回答提问诉求 #N
 *   回复 #N <文本>                                          —— 文本注入 #N 所属会话
 *   裸 批准/拒绝：仅当恰有 1 条待审批诉求时作用于它
 *
 * 开关 / 会话配置：
 *   开启 / 关闭 / 开启 <通道> / 关闭 <通道> / 全部开启 / 全部关闭
 *   /enable <sid> | /disable <sid> | /sessions | /bind | /unbind | /status | /help
 *   裸文本 → 注入当前通道绑定会话（.. 续段 / !! 立即提交）
 */

const APPROVE_WORDS = new Set(['批准', '同意', '允许', '通过', '批了', '准了', '放行', '可以', '赞成', 'approve', 'yes', 'y', '/yes', 'ok'])
const REJECT_WORDS = new Set(['拒绝', '驳回', '不同意', '不准', '不行', '否决', 'reject', 'no', 'n', '/no'])
const ALL_WORDS = new Set(['全部', '所有', '都', '一律'])
const CHANNEL_ALIASES = {
  imessage: ['imessage', 'im', '信息'],
  email: ['email', '邮件', 'mail'],
  wechat: ['wechat', '微信', 'ilink'],
}
const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

export const KNOWN_CHANNELS = ['imessage', 'email', 'wechat']

export function normalizeChannel(word) {
  const w = String(word).toLowerCase()
  for (const [id, aliases] of Object.entries(CHANNEL_ALIASES)) {
    if (id === w || aliases.includes(w)) return id
  }
  return undefined
}

/** 中文数字（1–99）→ number */
export function cnNumber(s) {
  const t = String(s).trim()
  if (/^\d+$/.test(t)) return Number(t)
  if (t === '十') return 10
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0)
  if (t in CN_DIGIT) return CN_DIGIT[t]
  return undefined
}

/** 从文本中提取第一个编号令牌：#N / №N / N号 / 第N个|条|项|号（支持中文数字） */
export function findNumberToken(text) {
  const patterns = [
    /(?:#|№)\s*(\d+)/,
    /第\s*(\d+|[一二两三四五六七八九十]+)\s*(?:个|条|项|号)/,
    /(\d+|[一二两三四五六七八九十]+)\s*号/,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (!m) continue
    const n = cnNumber(m[1])
    if (n !== undefined && n > 0 && n <= 99999) return n
  }
  return undefined
}

function approveWordOf(text) {
  for (const w of APPROVE_WORDS) if (text.includes(w)) return w
  return undefined
}

function rejectWordOf(text) {
  for (const w of REJECT_WORDS) if (text.includes(w)) return w
  return undefined
}

/** 宽容语义层：自然语言诉求应答/命令。无法识别返回 { kind: 'chat' }。 */
export function routeTextLoose(raw) {
  const text = raw.trim()

  // ---- 全部批准 / 全部拒绝 ----
  const hasAll = [...ALL_WORDS].some((w) => text.includes(w))
  if (hasAll && approveWordOf(text)) return { kind: 'approveAll' }
  if (hasAll && rejectWordOf(text)) return { kind: 'rejectAll' }

  const number = findNumberToken(text)

  // ---- 回复/告诉它 + 编号 + 文本 ----
  const reply = text.match(/^(?:回复|告诉|转告|跟它说|给它说|回它)[:：]?\s*(?:[#№]\s*(\d+))?\s*(.*)$/)
  if (reply && (reply[1] !== undefined || number !== undefined) && reply[2]?.trim()) {
    const body = reply[2]
      .replace(/^(?:\d+|[一二两三四五六七八九十]+)\s*号\s*[:：，,]?\s*/, '')
      .replace(/^第\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:个|条|项|号)\s*[:：，,]?\s*/, '')
      .trim()
    return { kind: 'reply', number: reply[1] !== undefined ? Number(reply[1]) : number, text: body || reply[2].trim() }
  }

  // ---- 批准 / 拒绝（含编号令牌或恰一条时裸词） ----
  if (number !== undefined) {
    const appr = approveWordOf(text)
    const rej = rejectWordOf(text)
    if (appr && (!rej || text.indexOf(appr) < text.indexOf(rej))) return { kind: 'approve', number, word: appr }
    if (rej) return { kind: 'reject', number, word: rej }
    // 「3号选2」「#3 是」「第三个 1,2」等 → 回答提问诉求
    const body = text
      .replace(/[#№]\s*\d+/, '')
      .replace(/第\s*(\d+|[一二两三四五六七八九十]+)\s*(?:个|条|项|号)/, '')
      .replace(/(\d+|[一二两三四五六七八九十]+)\s*号/, '')
      .replace(/^[:：，,。\s]+/, '')
      .trim()
    if (body) return { kind: 'answer', number, text: body }
  }

  // ---- 会话列表（模糊语意：会话/对话 均可） ----
  if (/会话列表|有哪些会话|有哪些对话|列出会话|列出当前|列出所有|列出.*(会话|对话)|看看.*(会话|对话)|查看.*(会话|对话)|所有对话|全部对话|当前所有/.test(text) && text.length <= 18) return { kind: 'sessions' }

  // ---- 指定会话的开关 / 绑定（模糊语意：打开cb200、开启会话cb200、把cb200对话打开、启用最近等） ----
  const SESS_TARGET = ['最近', '当前', '最新', '那个', '这个']
  const SESS_VERB = '(打开|开启|启用|启动|关闭|关掉|停用|禁用)'
  const sessTarget = (t) => (SESS_TARGET.includes(t) ? 'last' : t)
  const sessVerb = text.match(new RegExp(
    [
      `^${SESS_VERB}\\s*(?:会话|对话|房间)\\s*([a-zA-Z0-9-]{4,}|${SESS_TARGET.join('|')})\\s*$`, // 开启会话cb200 / 关掉最近会话
      `^${SESS_VERB}\\s*([a-zA-Z0-9-]{4,})\\s*(?:会话|对话|房间)?\\s*$`,                      // 打开cb200 / 关闭cb200对话
      `^${SESS_VERB}\\s*(${SESS_TARGET.join('|')})\\s*(?:会话|对话|房间)?\\s*$`,                // 启用最近（会话）
    ].join('|'),
  ))
  if (sessVerb) {
    const verb = (sessVerb[1] ?? sessVerb[3] ?? sessVerb[5]).toLowerCase()
    const target = (sessVerb[2] ?? sessVerb[4] ?? sessVerb[6]).toLowerCase()
    if (normalizeChannel(target) !== undefined) return { kind: 'chat', text } // 通道名交给通道开关处理
    const ref = sessTarget(target)
    if (/^(打开|开启|启用|启动)$/.test(verb)) return { kind: 'enableSession', sessionId: ref }
    return { kind: 'disableSession', sessionId: ref }
  }
  // 把 X 打开/关掉（动词在后）
  const ba = text.match(/^把\s*(?:会话|对话|房间)?\s*([a-zA-Z0-9-]{4,}|最近|当前|最新|那个|这个)\s*(?:会话|对话|房间)?\s*(打开|开启|启用|启动|关闭|关掉|停用|禁用)$/)
  if (ba) {
    const ref = sessTarget(ba[1].toLowerCase())
    if (normalizeChannel(ref) !== undefined) return { kind: 'chat', text }
    return /^(打开|开启|启用|启动)$/.test(ba[2])
      ? { kind: 'enableSession', sessionId: ref }
      : { kind: 'disableSession', sessionId: ref }
  }
  // 绑定 / 解绑
  const bm = text.match(/^(?:把|请)?\s*(?:绑定|绑到)\s*(?:会话|对话|房间)?\s*([a-zA-Z0-9-]{4,}|最近|当前|最新|那个|这个)\s*(?:会话|对话|房间)?\s*$/)
  if (bm) return { kind: 'bind', sessionId: sessTarget(bm[1].toLowerCase()) }
  if (/^(解绑|取消绑定|不再绑定)/.test(text)) return { kind: 'unbind' }

  // ---- 状态 / 待办罗列 ----
  if (/待办|未回复|没处理|还有哪些|有哪些.*处理|pending|list/i.test(text) && text.length <= 20) {
    return { kind: 'status' }
  }

  // ---- 开关（宽容） ----
  if (/^(?:帮我)?\s*开启|启动|打开/.test(text) && /全部|所有/.test(text)) return { kind: 'enableAll' }
  if (/^(?:帮我)?\s*关闭|停用|关掉|禁用/.test(text) && /全部|所有/.test(text)) return { kind: 'disableAll' }
  if (/^(?:帮我)?\s*开启|启动|打开|启用/.test(text) && text.length <= 10) {
    const m = text.match(/^(?:帮我)?\s*(?:开启|启动|打开|启用)\s*([\u4e00-\u9fa5a-z]+)/i)
    const channel = m ? normalizeChannel(m[1]) : undefined
    if (channel !== undefined) return { kind: 'enableChannel', channel }
    return { kind: 'enable' }
  }
  if (/^(?:帮我)?\s*关闭|停用|关掉|禁用/.test(text) && text.length <= 10) {
    const m = text.match(/^(?:帮我)?\s*(?:关闭|停用|关掉|禁用)\s*([\u4e00-\u9fa5a-z]+)/i)
    const channel = m ? normalizeChannel(m[1]) : undefined
    if (channel !== undefined) return { kind: 'disableChannel', channel }
    return { kind: 'disable' }
  }
  if (/帮助|怎么用|有哪些命令|help/i.test(text) && text.length <= 12) return { kind: 'help' }

  return { kind: 'chat', text }
}

export function routeText(raw) {
  const text = raw.trim()
  const lower = text.toLowerCase()

  // ---- 编号诉求应答（严格层） ----
  const numMatch = text.match(/^(?:#|№)\s*(\d+)\s*([\s\S]*)$/)
  if (numMatch) {
    const number = Number(numMatch[1])
    const rest = numMatch[2].trim()
    const restLower = rest.toLowerCase()
    if (rest === '') return { kind: 'noop' }
    if (APPROVE_WORDS.has(restLower)) return { kind: 'approve', number, word: rest }
    if (REJECT_WORDS.has(restLower)) return { kind: 'reject', number, word: rest }
    return { kind: 'answer', number, text: rest }
  }
  // 「批准 #N」倒序
  const tail = text.match(/^(批准|同意|允许|通过|approve|yes|y|\/yes|ok|拒绝|驳回|不同意|reject|no|n|\/no)\s*[#№]?\s*(\d+)$/i)
  if (tail) {
    const number = Number(tail[2])
    const word = tail[1]
    const approve = APPROVE_WORDS.has(word.toLowerCase())
    return approve ? { kind: 'approve', number, word } : { kind: 'reject', number, word }
  }
  const reply = text.match(/^回复\s*[#№]?\s*(\d+)\s+([\s\S]+)$/i)
  if (reply) return { kind: 'reply', number: Number(reply[1]), text: reply[2].trim() }

  // ---- 裸批准/拒绝（恰 1 条 pending 时生效） ----
  if (APPROVE_WORDS.has(lower)) return { kind: 'approve', number: undefined, word: text }
  if (REJECT_WORDS.has(lower)) return { kind: 'reject', number: undefined, word: text }

  // ---- 开关（严格层） ----
  if (text === '开启' || text === '/on') return { kind: 'enable' }
  if (text === '关闭' || text === '/off') return { kind: 'disable' }
  if (text === '全部开启' || text === '/enable all') return { kind: 'enableAll' }
  if (text === '全部关闭' || text === '/disable all') return { kind: 'disableAll' }
  const channelSwitch = text.match(/^(开启|关闭)\s+(.+)$/)
  if (channelSwitch) {
    const channel = normalizeChannel(channelSwitch[2])
    if (channel !== undefined) {
      return channelSwitch[1] === '开启'
        ? { kind: 'enableChannel', channel }
        : { kind: 'disableChannel', channel }
    }
  }

  // ---- 会话配置 ----
  if (text === '/enable' || text === '/disable' || text === '/bind') return { kind: 'status' }
  const enableOne = text.match(/^\/enable\s+(\S+)$/)
  if (enableOne) return { kind: 'enableSession', sessionId: enableOne[1] }
  const disableOne = text.match(/^\/disable\s+(\S+)$/)
  if (disableOne) return { kind: 'disableSession', sessionId: disableOne[1] }
  const bind = text.match(/^\/bind\s+(\S+)$/)
  if (bind) return { kind: 'bind', sessionId: bind[1] }
  if (text === '/unbind') return { kind: 'unbind' }
  if (text === '/sessions') return { kind: 'sessions' }

  // ---- 状态 / 帮助 ----
  if (text === '/status' || text === '状态') return { kind: 'status' }
  if (text === '/help' || text === '帮助' || text === 'help') return { kind: 'help' }

  // ---- 宽容语义层 ----
  const loose = routeTextLoose(text)
  if (loose.kind !== 'chat') return loose

  return { kind: 'chat', text }
}

/** 帮助文本 */
export const HELP = [
  'dsh-relay 远程诉求中转。命令（支持自然语言）：',
  '· 应答诉求：#N 批准 / 拒绝；也可「把3号批了」「同意第三个」「全部批准」「都拒绝」',
  '· 回答提问：#N 1,3（选项序号）；也可「3号选2」「第三个：是」',
  '· 回复诉求：回复 #N <文本> / 告诉3号 <文本>',
  '· 总开关：开启 / 关闭；通道：开启 微信 / 关闭 邮件',
  '· 全部会话：全部开启 / 全部关闭；也可「全部关掉」',
  '· 指定会话（模糊）：打开cb200 / 开启会话cb200 / 把cb200对话打开 / 关闭cb200对话',
  '  / 关掉最近会话 / 启用最近 / 把那个对话关掉；/enable last / /enable <短前缀>',
  '· 绑定：绑定当前对话 / 绑到最近会话 / 解绑 / 取消绑定；/bind <id>',
  '· 列表：/sessions / 有哪些会话 / 会话列表 / 列出当前所有对话 / 所有对话；状态：/status / 还有哪些没处理',
  '· 普通文本注入绑定会话（结尾 .. 续段，!! 立即提交）',
].join('\n')
