/**
 * 长回复分段（移植自 dsh-im-bridge/src/chunk.ts，原注 MIT / AMClaw delivery.rs）。
 * - 按 Unicode 码点计数（不是字节、不是 UTF-16 单元）
 * - 分段前缀是全角括号 `（i/n）`，前缀长度参与段数递归收敛（最多 5 次）
 * - 无法收敛时退化为无前缀硬切；硬切点是任意码点边界，不智能断词
 */

/** 按码点切出前 n 个字符 */
function takeChars(s, n) {
  return [...s].slice(0, n).join('')
}

/** 按码点长度切分为若干段，每段正文最多 n 码点 */
function cut(s, n) {
  const chars = [...s]
  const out = []
  for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(''))
  return out.length > 0 ? out : ['']
}

function prefix(i, n) {
  return `（${i}/${n}）`
}

/**
 * 把 text 拆成带 `（i/n）` 前缀的段，每段总长（含前缀）<= maxChars 码点。
 * 单段能放下时不加前缀。
 */
export function splitReply(text, maxChars) {
  if ([...text].length <= maxChars) return [text]
  let n = Math.ceil([...text].length / maxChars)
  for (let iter = 0; iter < 5; iter++) {
    const widest = prefix(n, n).length
    const budget = maxChars - widest
    if (budget <= 0) break
    const next = Math.ceil([...text].length / budget)
    if (next === n) {
      const bodies = cut(text, budget)
      return bodies.map((b, i) => prefix(i + 1, bodies.length) + b)
    }
    n = next
  }
  return cut(text, maxChars)
}
