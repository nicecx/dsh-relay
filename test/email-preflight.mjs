#!/usr/bin/env node
/**
 * Email 通道预检（不碰运行中的插件）：验证 IMAP 登录、SMTP 登录、以及可选的真实发送回环。
 * 所有邮箱地址/主机/凭据均从环境变量读取，仓库内不含任何个人数据。
 *
 * 用法（值用你自己的配置替换）：
 *   EMAIL_FROM='you@example.com' EMAIL_TO='you@example.com' \
 *   EMAIL_IMAP_HOST='imap.example.com' EMAIL_IMAP_USER='you@example.com' EMAIL_IMAP_PASS='<授权码>' \
 *   EMAIL_SMTP_HOST='smtp.example.com' EMAIL_SMTP_USER='you@example.com' EMAIL_SMTP_PASS='<授权码>' \
 *   node test/email-preflight.mjs [--send]
 *
 * --send 会从 SMTP 发一封测试邮件到 EMAIL_TO（含 Reply-To: EMAIL_REPLY_TO，默认 EMAIL_TO），
 * 并轮询 IMAP 等待回信（In-Reply-To 匹配），验证回信链路。
 */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'

const env = (name, fallback) => process.env[name] ?? fallback
const requireEnv = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`缺少环境变量 ${name}，请设置后重试`)
  return v
}

const FROM = requireEnv('EMAIL_FROM')
const TO = requireEnv('EMAIL_TO')
// 不设 Reply-To 时回复自动回到发件人邮箱（即脚本轮询的 IMAP），与插件模型一致；
// 如需回信到别处可显式设 EMAIL_REPLY_TO
const REPLY_TO = env('EMAIL_REPLY_TO', FROM)
const IMAP = {
  host: requireEnv('EMAIL_IMAP_HOST'),
  port: Number(env('EMAIL_IMAP_PORT', 993)),
  secure: env('EMAIL_IMAP_SECURE', '1') === '1',
  user: requireEnv('EMAIL_IMAP_USER'),
}
const SMTP = {
  host: requireEnv('EMAIL_SMTP_HOST'),
  port: Number(env('EMAIL_SMTP_PORT', 465)),
  secure: env('EMAIL_SMTP_SECURE', '1') === '1',
  user: requireEnv('EMAIL_SMTP_USER'),
}

let ok = 0, fail = 0
const check = (name, fn) => Promise.resolve().then(fn).then(() => { ok++; console.log('✓', name) }).catch((e) => { fail++; console.log('❌', name, '→', e.message) })

await check('IMAP 连接 + 登录', async () => {
  const c = new ImapFlow({ ...IMAP, auth: { user: IMAP.user, pass: requireEnv('EMAIL_IMAP_PASS') }, logger: false })
  await c.connect()
  const st = await c.status('INBOX', { messages: true })
  console.log('   INBOX 邮件数:', st.messages)
  await c.logout()
})

await check('SMTP 连接 + 登录', async () => {
  const t = nodemailer.createTransport({ host: SMTP.host, port: SMTP.port, secure: SMTP.secure, auth: { user: SMTP.user, pass: requireEnv('EMAIL_SMTP_PASS') } })
  await t.verify()
  t.close()
})

if (process.argv.includes('--send')) {
  await check('真实发送 + 回信链路（Reply-To）', async () => {
    const t = nodemailer.createTransport({ host: SMTP.host, port: SMTP.port, secure: SMTP.secure, auth: { user: SMTP.user, pass: requireEnv('EMAIL_SMTP_PASS') } })
    const info = await t.sendMail({ from: FROM, to: TO, ...(REPLY_TO === FROM ? {} : { replyTo: REPLY_TO }), subject: '[DSH] 邮件预检', text: '这是 dsh-relay 邮件通道预检。请直接回复此邮件（回复会回到发件人邮箱）。' })
    t.close()
    console.log('   已发送 Message-Id:', info.messageId)
    const c = new ImapFlow({ ...IMAP, auth: { user: IMAP.user, pass: requireEnv('EMAIL_IMAP_PASS') }, logger: false })
    await c.connect()
    const lock = await c.getMailboxLock('INBOX')
    try {
      // 信封扫描：1:* 一次取完（211 封量级，快），按 envelope.inReplyTo 匹配，避免范围/取正文问题
      const needle = (info.messageId || '').replace(/[<>]/g, '').toLowerCase()
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        let found = false
        for await (const msg of c.fetch('1:*', { uid: true, envelope: true })) {
          const irt = String(msg.envelope?.inReplyTo ?? '').replace(/[<>]/g, '').toLowerCase()
          if (needle && irt.includes(needle)) { found = true; break }
        }
        if (found) {
          console.log('   ✓ 收到回信（In-Reply-To 匹配）')
          await c.logout()
          return
        }
        await new Promise((r) => setTimeout(r, 5000))
      }
      throw new Error('90 秒内未收到回信')
    } finally {
      await lock.release()
    }
  })
}

console.log(`\n预检结果：${ok} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
