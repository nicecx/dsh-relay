/**
 * 微信通道（iLink 协议）。协议客户端移植自 dsh-im-bridge/src/ilink.ts（MIT），
 * 通道逻辑适配本插件的 Channel 契约。默认禁用（个人微信自动化有风控风险），
 * 用户把 channels.wechat.enabled 置 true 并扫码登录后启用。
 *
 * 安全：只应答白名单 ilink_user_id；首个扫码确认用户自动成为白名单。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { splitReply } from '../chunk.js'

const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function pickStr(obj, ...keys) {
  const v = pick(obj, ...keys)
  return typeof v === 'string' ? v : v === undefined ? undefined : String(v)
}

/** message_id 可能是 string/number/float/object，宽松归一化 */
export function normalizeId(v) {
  if (typeof v === 'string') return v || undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v))
  if (v && typeof v === 'object') {
    const inner = pick(v, 'id', 'value', 'str')
    if (inner !== undefined) return normalizeId(inner)
  }
  return undefined
}

/** 单条消息宽松解析；不是文本消息或无法解析返回 null */
export function parseInbound(raw) {
  if (!raw || typeof raw !== 'object') return null
  let m = raw
  if (m.message && typeof m.message === 'object') m = { ...m, ...m.message }
  if (m.message_type !== undefined && Number(m.message_type) !== 1) return null
  const fromUserId = pickStr(m, 'from_user_id', 'from_user')
  if (!fromUserId) return null
  const parts = []
  if (typeof m.text === 'string') parts.push(m.text)
  if (Array.isArray(m.item_list)) {
    for (const item of m.item_list) {
      const t = item?.text_item
      if (t && typeof t.text === 'string') parts.push(t.text)
    }
  }
  const text = parts.join('').trim()
  if (!text) return null
  const messageId = normalizeId(m.message_id) ?? normalizeId(m.msg_id) ?? normalizeId(m.client_id)
    ?? `${fromUserId}:${Number(m.create_time_ms ?? m.create_time ?? 0)}`
  const contextToken = pickStr(m, 'context_token')
  return { messageId, fromUserId, contextToken, text }
}

class ILinkClient {
  constructor(randomUin) {
    this.baseUrl = ILINK_DEFAULT_BASE_URL
    this.botToken = ''
    const u32 = randomUin ?? String(Math.floor(Math.random() * 0xffffffff))
    this.uin = Buffer.from(u32, 'utf8').toString('base64')
  }

  headers() {
    const h = {
      'Content-Type': 'application/json',
      'iLink-App-ClientVersion': '1',
      'X-WECHAT-UIN': this.uin,
    }
    if (this.botToken) {
      h.Authorization = `Bearer ${this.botToken}`
      h.AuthorizationType = 'ilink_bot_token'
    }
    return h
  }

  async request(path, init) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: this.headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    })
    if (!res.ok) throw new Error(`${path} http ${res.status}`)
    const data = await res.json()
    const ret = Number(data.ret ?? 0)
    const errcode = Number(data.errcode ?? 0)
    if (init.tolerateRet1 && ret === 1 && errcode === 0) return data
    if (ret !== 0 || errcode !== 0) {
      throw new Error(`${path} ret=${ret} errcode=${errcode} errmsg=${String(data.errmsg ?? data.err_msg ?? '')}`)
    }
    return data
  }

  async getQRCode(timeoutMs = 15_000) {
    const data = await this.request('/ilink/bot/get_bot_qrcode?bot_type=3', { timeoutMs })
    const qrcodeId = pickStr(data, 'qrcode', 'qrcode_id')
    const qrUrl = pickStr(data, 'qrcode_img_content', 'qrcode_url', 'url')
    if (!qrcodeId || !qrUrl) throw new Error('get_bot_qrcode: missing qrcode/url fields')
    return { qrcodeId, qrUrl }
  }

  async checkQRStatus(qrcodeId, timeoutMs = 40_000) {
    const data = await this.request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`, {
      timeoutMs,
      tolerateRet1: true,
    })
    const status = String(data.status ?? '')
    if (Number(data.ret ?? 0) === 0 && status === 'confirmed') {
      const botToken = pickStr(data, 'bot_token')
      const userId = pickStr(data, 'ilink_user_id')
      if (!botToken || !userId) throw new Error('get_qrcode_status confirmed but missing token/user')
      const baseUrl = pickStr(data, 'baseurl', 'base_url')
      return { kind: 'confirmed', credentials: { botToken, userId }, baseUrl }
    }
    if (status === 'expired') return { kind: 'expired' }
    return { kind: 'wait' }
  }

  async getUpdates(cursor, timeoutSecs) {
    const data = await this.request('/ilink/bot/getupdates', {
      body: { get_updates_buf: cursor, base_info: { channel_version: '1.0.0' } },
      timeoutMs: timeoutSecs * 1000 + 5000,
    })
    const rawList = pick(data, 'msgs', 'messages', 'updates')
    const messages = []
    if (Array.isArray(rawList)) {
      for (const raw of rawList) {
        try {
          const msg = parseInbound(raw)
          if (msg) messages.push(msg)
        } catch { /* 单条跳过 */ }
      }
    }
    const next = pickStr(data, 'get_updates_buf', 'cursor', 'sync_buf') ?? cursor
    return { cursor: next, messages }
  }

  async sendMessage(toUserId, text, contextToken, clientId) {
    await this.request('/ilink/bot/sendmessage', {
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: '1.0.0' },
      },
      timeoutMs: 15_000,
    })
  }
}

function isTimeout(err) {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

export function createWechatChannel(cfg, deps) {
  const client = new ILinkClient()
  let running = false
  let loggedIn = false
  let cursor = ''

  async function login() {
    while (!deps.signal.aborted) {
      let qr
      try {
        qr = await client.getQRCode()
      } catch (err) {
        deps.log.warn('wechat: 获取二维码失败，5s 后重试:', err)
        await sleep(5000, deps.signal)
        continue
      }
      deps.log.warn('wechat: 请用微信扫码登录（iLink）: %s', qr.qrUrl)
      try {
        mkdirSync(dirname(deps.stateDir), { recursive: true })
        writeFileSync(join(deps.stateDir, 'wechat-login-url.txt'), `${qr.qrUrl}\n`)
      } catch (err) {
        deps.log.warn('wechat: 登录链接落盘失败:', err)
      }
      while (!deps.signal.aborted) {
        // 等待扫码期间也上报心跳：通道活着（只是等用户扫码），不应被判为 start-hang
        deps.watchdog?.beat(deps.jobId ?? 'dsh-relay:wechat')
        let st
        try {
          st = await client.checkQRStatus(qr.qrcodeId)
        } catch (err) {
          if (!isTimeout(err)) deps.log.warn('wechat: 查询扫码状态失败，2s 后重试:', err)
          await sleep(2000, deps.signal)
          continue
        }
        if (st.kind === 'wait') {
          await sleep(2000, deps.signal)
          continue
        }
        if (st.kind === 'expired') break
        client.botToken = st.credentials.botToken
        if (st.baseUrl) client.baseUrl = st.baseUrl
        if (!deps.store.wechatAllowedUser) {
          deps.store.setWechatAllowedUser(st.credentials.userId)
          deps.log.warn('wechat: 已绑定白名单用户 %s（仅该用户可驱动）', st.credentials.userId)
        } else if (deps.store.wechatAllowedUser !== st.credentials.userId) {
          deps.log.warn('wechat: 扫码用户 %s 不在白名单，消息将被忽略', st.credentials.userId)
        }
        return true
      }
    }
    return false
  }

  return {
    id: 'wechat',
    label: '微信',
    configured() {
      return true // iLink 无需预配置，扫码登录即可
    },
    async start() {
      running = true
      if (!(await login())) return
      loggedIn = true
      deps.log.info('wechat: 登录完成，开始长轮询')
      while (running && !deps.signal.aborted) {
        // 心跳：watchdog 据此检测轮询停滞
        deps.watchdog?.beat(deps.jobId ?? 'dsh-relay:wechat')
        let page
        try {
          page = await client.getUpdates(cursor, Number(cfg.pollTimeoutSecs ?? 70))
        } catch (err) {
          if (deps.signal.aborted) return
          if (isTimeout(err)) continue
          deps.log.warn('wechat: 长轮询失败，5s 后重试:', err)
          await sleep(5000, deps.signal)
          continue
        }
        cursor = page.cursor
        for (const msg of page.messages) {
          if (deps.signal.aborted) return
          if (msg.contextToken) deps.store.setWechatContextToken(msg.fromUserId, msg.contextToken)
          if (msg.fromUserId !== deps.store.wechatAllowedUser) continue
          deps.pushInbound({
            channelId: 'wechat',
            senderId: msg.fromUserId,
            messageId: msg.messageId,
            text: msg.text,
          })
        }
      }
    },
    async stop() {
      running = false
      loggedIn = false
    },
    async send(text) {
      const userId = deps.store.wechatAllowedUser
      if (!userId) throw new Error('wechat: 尚未绑定白名单用户')
      const token = deps.store.wechatContextToken(userId)
      if (!token) throw new Error('wechat: 缺少 context_token（等一条入站消息）')
      const parts = splitReply(text, deps.chunkMaxChars ?? 1200)
      for (const part of parts) {
        await client.sendMessage(userId, part, token, `dsh-relay:${randomUUID()}`)
      }
    },
    isTrusted(senderId) {
      return String(senderId) === deps.store.wechatAllowedUser
    },
    status() {
      return `微信(${deps.store.wechatAllowedUser || '未绑定'}${loggedIn ? ' ✓' : ' ✗'})`
    },
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
