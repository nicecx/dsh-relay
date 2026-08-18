/**
 * Email 通道：IMAP 轮询收信（imapflow）+ SMTP 发信（nodemailer）。
 *
 * - 推送：主题 [DSH] 前缀 + 诉求正文；记录 Message-Id 供回信匹配。
 * - 收信：轮询 INBOX 未读增量（UID 游标持久化），mailparser 解出纯文本。
 *   用户直接回复邮件即可：正文按「#N 批准」等语法应答；
 *   若邮件 In-Reply-To 命中某条推送，正文可省略编号自动补 #N。
 * - 凭据：优先 deps.resolveSecret(passRef)（DSH credentials 服务），
 *   其次配置里的明文 pass。
 * - 安全：只接受白名单发件人（from/to/allowedFrom）。
 */

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { parseEmailAuth, emailAuthVerdict } from '../secure.js'

/**
 * 单封邮件的处理决策（纯函数，可单测）：
 * - 正文为空 → skip；发件人认证失败/严格模式无认证头 → reject；
 * - In-Reply-To 命中本插件推送且正文未带编号 → 自动补 #N。
 */
export function processEmailMessage({ uid, parsed, cfg, sentIds }) {
  const address = parsed?.from?.value?.[0]?.address ?? ''
  const text = String(parsed?.text ?? '').trim()
  if (!text) return { action: 'skip', uid }
  const verdict = emailAuthVerdict(parseEmailAuth(parsed?.headers))
  if (verdict === 'fail' || (verdict === 'unknown' && cfg?.strictAuth === true)) {
    return { action: 'reject', reason: verdict, address, uid }
  }
  let body = text
  const replyTo = String(parsed?.inReplyTo ?? '').toLowerCase()
  const hinted = sentIds.get(replyTo)
  if (hinted !== undefined && !/^\s*#\d+/.test(body) && !/^(批准|拒绝|回复|开启|关闭)/.test(body)) {
    body = `#${hinted} ${body}`
  }
  return { action: 'push', body, address, uid }
}

export function createEmailChannel(cfg, deps) {
  let client
  let transport
  let running = false
  let connected = false
  /** sentMessageId -> request number */
  const sentIds = new Map()

  const fromAddr = String(cfg.from ?? '')
  const toAddr = String(cfg.to ?? '')
  const allowed = new Set(
    [fromAddr, toAddr, String(cfg.replyTo ?? ''), ...(Array.isArray(cfg.allowedFrom) ? cfg.allowedFrom.map(String) : [])]
      .filter(Boolean)
      .map((a) => a.toLowerCase()),
  )

  async function resolvePass(ref, fallback) {
    if (ref) {
      try {
        const resolved = await deps.resolveSecret(ref)
        if (resolved) return resolved
      } catch (err) {
        deps.log.warn('email: 凭据解析失败（%s）:', ref, err)
      }
    }
    return fallback ?? ''
  }

  /** 创建带 error 监听的 ImapFlow：IMAP 超时/断连会 emit 'error'，无监听会导致进程崩溃 */
  const createImapClient = async () => {
    const imapPass = await resolvePass(cfg.imap?.passRef, cfg.imap?.pass)
    const c = new ImapFlow({
      host: cfg.imap.host,
      port: Number(cfg.imap.port ?? 993),
      secure: cfg.imap.secure !== false,
      auth: { user: cfg.imap.user, pass: imapPass },
      logger: false,
    })
    c.on('error', (err) => {
      connected = false
      deps.log.warn('email: IMAP error 事件（已捕获，避免进程崩溃）:', err?.message ?? err)
    })
    return c
  }

  return {
    id: 'email',
    label: 'Email',
    configured() {
      return Boolean(
        cfg.imap?.host && cfg.imap?.user && cfg.smtp?.host && cfg.smtp?.user && fromAddr && toAddr,
      )
    },
    async start() {
      const smtpPass = await resolvePass(cfg.smtp?.passRef, cfg.smtp?.pass)
      try {
        client = await createImapClient()
        await client.connect()
        connected = true
        transport = nodemailer.createTransport({
          host: cfg.smtp.host,
          port: Number(cfg.smtp.port ?? 465),
          secure: cfg.smtp.secure !== false,
          auth: { user: cfg.smtp.user, pass: smtpPass },
        })
        await transport.verify()
      } catch (err) {
        deps.log.warn('email: 启动连接失败（通道不启动，等待下次重启）:', err?.message ?? err)
        return
      }
      deps.log.info('email: SMTP/IMAP 已连接（%s → %s）', fromAddr, toAddr)
      running = true
      while (running && !deps.signal.aborted) {
        await sleep(deps.pollSecs * 1000, deps.signal)
        if (!running || deps.signal.aborted) return
        await poll()
      }
    },
    async stop() {
      running = false
      try { transport?.close() } catch { /* 忽略 */ }
      try { await client?.logout() } catch { /* 忽略 */ }
      connected = false
    },
    async send(text) {
      if (!transport) throw new Error('email: SMTP 未连接')
      const firstLine = text.split('\n')[0].slice(0, 60)
      const info = await transport.sendMail({
        from: fromAddr,
        to: toAddr,
        // Reply-To 指向接收邮箱：用户回复邮件时自动回到轮询的收件箱
        ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
        subject: `[DSH] ${firstLine}`,
        text,
      })
      // 记住 Message-Id，回信命中时自动补编号
      const numberMatch = text.match(/#(\d+)/)
      if (info.messageId && numberMatch) {
        sentIds.set(info.messageId.toLowerCase(), Number(numberMatch[1]))
        if (sentIds.size > 100) sentIds.delete(sentIds.keys().next().value)
      }
    },
    isTrusted(senderId) {
      return allowed.has(String(senderId).toLowerCase())
    },
    status() {
      return `Email(${fromAddr || '未配置'}${connected ? ' ✓' : ' ✗'})`
    },
  }

  async function poll() {
    if (!client || !connected) return
    let lock
    try {
      lock = await client.getMailboxLock('INBOX')
      const status = await client.status('INBOX', { uidNext: true })
      const last = deps.store.emailCursor
      const from = Math.max(1, last + 1)
      if (status.uidNext <= from) return
      let maxUid = last
      for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true })) {
        if (deps.signal.aborted) return
        try {
          const uid = Number(msg.uid)
          if (uid > maxUid) maxUid = uid
          const parsed = await simpleParser(msg.source)
          const decision = processEmailMessage({ uid, parsed, cfg, sentIds })
          if (decision.action === 'skip') continue
          if (decision.action === 'reject') {
            deps.log.warn('email: 发件人验证 %s（%s），消息被拒绝', decision.reason, decision.address || '未知')
            continue
          }
          deps.pushInbound({
            channelId: 'email',
            senderId: decision.address.toLowerCase(),
            messageId: `uid:${decision.uid}`,
            text: decision.body,
          })
        } catch (err) {
          if (!deps.signal.aborted) deps.log.warn('email: 单封解析失败（跳过）:', err)
        }
      }
      deps.store.setEmailCursor(maxUid)
    } catch (err) {
      if (!deps.signal.aborted) {
        connected = false
        deps.log.warn('email: 轮询失败，5s 后尝试重连:', err)
        try { await client?.logout() } catch { /* 忽略 */ }
        client = undefined
        await sleep(5000, deps.signal)
        if (running && !deps.signal.aborted) {
          try {
            client = await createImapClient()
            await client.connect()
            connected = true
          } catch (err2) {
            if (!deps.signal.aborted) deps.log.warn('email: 重连失败:', err2)
          }
        }
      }
    } finally {
      lock?.release()
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}
