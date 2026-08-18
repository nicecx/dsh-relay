/**
 * iMessage 通道（macOS）。
 *
 * - 发送：AppleScript 驱动 Messages.app（send ... to chat id ...；macOS 26 上
 *   已移除 message 类与 buddy key form，chat id 形式仍可用）。目标 chat 通过
 *   参与者句柄匹配；若无既有会话，提示用户先用 iMessage 给本机发一条消息。
 * - 接收：轮询 ~/Library/Messages/chat.db（sqlite3 -readonly）。macOS 26 的
 *   Messages 不再暴露 message 类给 AppleScript，chat.db 是唯一可靠的收信途径。
 *
 * 权限要求（一次授权）：
 *   1) 自动化：允许宿主进程控制 Messages.app（首次发送时系统会弹窗）；
 *   2) 完全磁盘访问：System Settings → Privacy & Security → Full Disk Access，
 *      加入运行 DSH 的终端/进程，否则 chat.db 读取被 TCC 拒绝。
 *
 * 安全：只应答白名单句柄（imessage.handle + extraHandles）。
 *
 * 收信口径（同账号手机/电脑设备）：手机与 Mac 同 Apple ID 时，手机发出的
 * 消息在本机 chat.db 里是 is_from_me=1、文本只存在 attributedBody 列——
 * 因此轮询同时收 is_from_me=0 与 1，用「不可见标记」排除插件自己推送的
 * 消息、用 ignorePrefixes（默认【）排除其他机器人的消息（如 【ops-agent】）。
 *
 * 已读标注（cfg.markRead=true，默认关）：轮询读到并处理白名单消息后，用
 * rw 模式把对应 ROWID 标 is_read=1/date_read（Apple 纪元纳秒），让手机上
 * 显示已读。只标实际处理过的行，不碰其他会话/其他发送者；失败仅记日志，
 * 下一轮 poll 会重试同批 ROWID。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')

/** 本插件出站消息的不可见自标记：轮询据此排除自己的推送（防止回灌成命令） */
export const SELF_MARKER = '\u200bD5HR42'

/** 忽略以这些前缀开头的消息（其他机器人的消息，如 【ops-agent】） */
const DEFAULT_IGNORE_PREFIXES = ['【']

/** 纯 ASCII 命令词表（attributedBody 提取兜底用；首词匹配） */
const COMMAND_WORDS = new Set([
  'sessions', 'status', 'help', 'enable', 'disable', 'bind', 'unbind',
  'on', 'off', 'list', 'approve', 'reject', 'yes', 'no', 'ok', 'y', 'n',
  '状态', '帮助', '开启', '关闭', '待办', '列表',
])

/**
 * 从 attributedBody（NSKeyedArchiver 私有格式）提取消息文本：
 * 无法结构化解码，用可打印 UTF-8 分段 + CJK/数字/指令词评分挑出真实文本。
 */
/** 剥离 attributedBody 解码产生的 U+FFFD 替换符与控制字符（否则命令/正文会被污染成聊天消息） */
const cleanSeg = (s) => s.replace(/[\uFFFD\u0000-\u001f\u007f]/g, '')

export function extractFromAttributedBody(buf) {
  if (!buf || buf.length === 0) return ''
  const text = Buffer.from(buf).toString('utf8')
  const segs = (text.match(/[\u0020-\u007e\u00a0-\uffff]{2,}/g) ?? []).map(cleanSeg).filter(Boolean)
  // 真实消息：含 CJK 或数字/编号的连续段（类名如 NSString 全是 ASCII）
  const real = segs.filter((s) =>
    /[\u4e00-\u9fff]/.test(s)          // 中文
    || /[0-9#№]/.test(s)                // 编号/数字
    || /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]/u.test(s) // emoji
    || s.length >= 40)                  // 较长 ASCII 正文（类名通常 < 40）
  if (real.length > 0) return real.join('')
  // 纯 ASCII 命令兜底：/sessions、/enable last、approve、status 等（逐段匹配，避开类名噪音）
  const cmd = segs.find((s) => {
    const m2 = s.trim().match(/^(\/?[a-zA-Z][a-zA-Z0-9]*)([\s\S]*)$/)
    return m2 && COMMAND_WORDS.has(m2[1].toLowerCase().replace(/^\//, ''))
  })
  if (cmd) {
    const m2 = cmd.trim().match(/^(\/?[a-zA-Z][a-zA-Z0-9]*)([\s\S]*)$/)
    const rest = (m2?.[2] ?? '').replace(/[\uFFFD\u0000-\u001f\u007f]/g, ' ').trim()
    return m2[1] + (rest ? ' ' + rest : '')
  }
  return ''
}

/** 执行 osascript（支持 on run argv 传参），返回 stdout 或抛错 */
async function runAppleScript(lines, args = []) {
  const opts = lines.flatMap((line) => ['-e', line])
  const { stdout } = await execFileAsync('osascript', [...opts, ...args], { timeout: 20_000, maxBuffer: 1 << 20 })
  return stdout
}

/** 找到包含任一目标句柄的 chat 列表 → [{chatId, serviceType}] */
async function findChats(handles) {
  const script = [
    'on run argv',
    '  set targets to items 1 thru (count of argv) of argv',
    '  set out to ""',
    '  tell application "Messages"',
    '    repeat with c in chats',
    '      try',
    '        set hit to false',
    '        repeat with p in participants of c',
    '          if targets contains (handle of p as text) then set hit to true',
    '        end repeat',
    '        if hit then',
    '          set svcType to "?"',
    '          try',
    '            set svcType to (service type of (service of c) as text)',
    '          end try',
    '          set out to out & (id of c as text) & tab & svcType & linefeed',
    '        end if',
    '      end try',
    '    end repeat',
    '  end tell',
    '  return out',
    'end run',
  ]
  const out = await runAppleScript(script, handles)
  const rows = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const seen = new Set()
  const chats = []
  for (const row of rows) {
    const [chatId, serviceType = '?'] = row.split('\t')
    if (seen.has(chatId)) continue
    seen.add(chatId)
    chats.push({ chatId, serviceType })
  }
  return chats
}

/** 归一化句柄：纯数字（不带 +）补 +86 形式，匹配 chat.db 与 Messages 的两种记法 */
function expandHandles(raw) {
  const out = []
  for (const h of raw) {
    const s = String(h).trim()
    if (!s) continue
    out.push(s)
    if (/^\d{5,}$/.test(s) && !s.startsWith('+')) out.push(`+86${s}`)
  }
  return [...new Set(out)]
}

/** 通用会话范围判定：chatScope 为空=全部会话；否则按子串匹配会话标识（any;-;xxx / xxx / +86xxx） */
export function chatInScope(chatId, scope) {
  const sc = String(scope ?? '').trim()
  if (!sc) return true
  return String(chatId).includes(sc)
}

/**
 * 构造"标注已读"的 SQL（纯函数，供单测）：
 * 只更新给定 ROWID（poll 实际处理过、来自白名单发送者的消息），
 * 不触碰其他会话/其他发送者的未读状态。
 * date_read 用 Apple 纪元纳秒（(unix秒+978307200)*1e9，与 message.date 同口径）。
 * 空输入返回 ''（调用方应跳过执行）。
 */
export function buildMarkReadSql(rowids) {
  const ids = [...new Set((rowids ?? []).map((r) => String(r).trim()).filter((r) => /^\d+$/.test(r)))]
  if (ids.length === 0) return ''
  return `PRAGMA busy_timeout=5000; UPDATE message SET is_read = 1, date_read = (strftime('%s','now') + 978307200) * 1000000000 WHERE ROWID IN (${ids.join(', ')});`
}

export function createImessageChannel(cfg, deps) {
  const chatScope = String(cfg.chatScope ?? '').trim()
  const handles = expandHandles([
    ...(cfg.handle ? [String(cfg.handle)] : []),
    ...(Array.isArray(cfg.extraHandles) ? cfg.extraHandles.map(String) : []),
  ])
  let chatCache = []
  let running = false
  let lastChatRefresh = 0
  let lastTccWarnAt = 0
  /** 启动时的最大 rowid 水位：只处理启动后的新消息，避免历史消息冲刷 */
  let floorRowid = 0

  const trusted = () => new Set(handles.map((h) => h.toLowerCase()))

  /** 优先 iMessage 服务会话，其次任意可用会话 */
  async function resolveSendTarget(forceRefresh = false) {
    if (!forceRefresh && chatCache.length > 0 && Date.now() - lastChatRefresh < 60_000) return chatCache[0].chatId
    chatCache = (await findChats(handles)).filter((c) => chatInScope(c.chatId, chatScope))
    lastChatRefresh = Date.now()
    if (chatCache.length === 0) return undefined
    const preferred = chatCache.find((c) => c.serviceType === 'iMessage') ?? chatCache[0]
    return preferred.chatId
  }

  return {
    id: 'imessage',
    label: 'iMessage',
    configured() {
      return process.platform === 'darwin' && handles.length > 0
    },
    async start() {
      running = true
      // 水位 = 已处理过的最大 rowid（去重表里的最新一条），而不是启动时 MAX(ROWID)。
      // 这样停机/重启期间到达的消息（rowid 介于"最后处理"与"当前最大"之间）也会被补收，
      // 不会被启动水位误跳过。首次运行（无历史去重记录）才用 MAX(ROWID) 防历史冲刷。
      try {
        const seen = deps.store.seenRowids('imessage')
        if (seen.length > 0) {
          floorRowid = Math.max(...seen)
          deps.log.info('iMessage: 启动水位=最后处理 rowid %s（停机期间新消息将补收）', floorRowid)
        } else {
          const { stdout } = await execFileAsync('sqlite3', [
            '-readonly', `file:${CHAT_DB}?mode=ro`, 'SELECT MAX(ROWID) FROM message;',
          ], { timeout: 10_000 })
          floorRowid = Number(stdout.trim()) || 0
          deps.log.info('iMessage: 首次启动水位 rowid=%s（跳过既有历史）', floorRowid)
        }
      } catch (err) {
        deps.log.debug('iMessage: 读取水位失败（按 0 处理）:', err)
      }
      // 预解析会话（失败不致命：首次消息进来后回填）
      try {
        chatCache = await findChats(handles)
        lastChatRefresh = Date.now()
        if (chatCache.length === 0) {
          deps.log.warn('iMessage: 未找到与 %s 的既有会话；请先用 iMessage 给本机发一条消息', handles.join('/'))
        }
      } catch (err) {
        deps.log.warn('iMessage: 预解析会话失败（稍后重试）:', err)
      }
      while (running && !deps.signal.aborted) {
        await sleep(deps.pollSecs * 1000, deps.signal)
        if (!running || deps.signal.aborted) return
        await poll()
      }
    },
    async stop() {
      running = false
    },
    async send(text) {
      const chatId = await resolveSendTarget()
      if (chatId === undefined) {
        throw new Error('iMessage: 无可用会话（请先给本机发一条 iMessage）')
      }
      const script = [
        'on run argv',
        '  set msg to item 1 of argv',
        '  set cid to item 2 of argv',
        '  tell application "Messages"',
        '    send msg to chat id cid',
        '  end tell',
        'end run',
      ]
      // 附加不可见自标记：轮询据此排除本插件自己的推送
      await runAppleScript(script, [`${text}${SELF_MARKER}`, chatId])
    },
    isTrusted(senderId) {
      return trusted().has(String(senderId).toLowerCase())
    },
    status() {
      return `iMessage(${handles.join('/') || '未配置'})${chatCache.length > 0 ? ' ✓' : '（无会话）'}`
    },
  }

  /** 把本轮实际处理过的消息（白名单发送者、已过过滤）标注为已读（cfg.markRead=true 时启用） */
  async function markRead(rowids) {
    const sql = buildMarkReadSql(rowids)
    if (sql === '') return
    try {
      await execFileAsync('sqlite3', [`file:${CHAT_DB}?mode=rw`, sql], { timeout: 10_000 })
      deps.log.info('iMessage: 已把 %s 条消息标注为已读', rowids.length)
    } catch (err) {
      // 写 chat.db 失败不影响收发（可能 Messages 正忙/被锁）；下一轮 poll 会重试同批 ROWID
      deps.log.warn('iMessage: 标注已读失败（不影响收发）:', String(err?.message ?? err))
    }
  }

  async function poll() {
    if (handles.length === 0) return
    // 本轮实际处理（将交给 pushInbound）的消息 ROWID：cfg.markRead=true 时标注已读
    const processed = []
    // 系统 sqlite3 不支持位置参数绑定，句柄内联为转义后的字符串字面量；
    // 用 -json 输出（正确转义多行/制表符文本，避免按行解析被消息正文打乱）。
    // 同时收 is_from_me=0/1（同 Apple ID 的手机/电脑消息在 Mac 上记作 is_from_me=1），
    // 文本列与 attributedBody 二选一；自标记与 ignorePrefixes 用于排除机器人消息。
    const sqlSafe = handles.map((h) => `'${h.replaceAll("'", "''")}'`).join(',')
    const scopeSql = chatScope
      ? ` AND EXISTS (SELECT 1 FROM chat_message_join cm JOIN chat c ON c.ROWID = cm.chat_id WHERE cm.message_id = m.ROWID AND c.chat_identifier LIKE '%${chatScope.replaceAll("'", "''").replaceAll('%', '\%').replaceAll('_', '\_')}%' ESCAPE '\\')`
      : ''
    const sql = [
      'SELECT m.ROWID AS rowid, m.text AS text, hex(m.attributedBody) AS body, h.id AS sender, m.is_from_me AS me, m.date AS date FROM message m JOIN handle h ON h.ROWID = m.handle_id',
      `WHERE ((m.text IS NOT NULL AND m.text != '') OR (m.attributedBody IS NOT NULL AND length(m.attributedBody) > 0)) AND h.id IN (${sqlSafe})${scopeSql}`,
      'ORDER BY m.ROWID DESC LIMIT 50',
    ].join(' ')
    try {
      const { stdout } = await execFileAsync('sqlite3', [
        '-readonly',
        '-json',
        `file:${CHAT_DB}?mode=ro`,
        sql,
      ], { timeout: 20_000, maxBuffer: 1 << 24 })
      let rows
      try {
        rows = JSON.parse(stdout)
      } catch {
        if (stdout.trim() !== '') deps.log.debug('imessage: chat.db 输出解析失败（跳过本轮）')
        return
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        if (deps.signal.aborted) return
        const rowid = String(row.rowid ?? '')
        const sender = String(row.sender ?? '')
        if (rowid === '' || sender === '') continue
        // 启动后的新消息才处理（避免历史消息冲刷进会话）
        if (floorRowid > 0 && Number(rowid) <= floorRowid) continue
        const body = typeof row.body === 'string' && row.body !== '' ? Buffer.from(row.body, 'hex') : undefined
        const text = String(row.text ?? '').trim() || extractFromAttributedBody(body)
        if (text === '') continue
        // 排除本插件自己的推送（不可见标记）
        if (text.includes('D5HR42')) continue
        // 排除其他机器人的消息（如 【ops-agent】）
        const prefixes = Array.isArray(cfg.ignorePrefixes) && cfg.ignorePrefixes.length > 0 ? cfg.ignorePrefixes : DEFAULT_IGNORE_PREFIXES
        if (prefixes.some((p) => text.startsWith(p))) continue
        const messageId = `chatdb:${rowid}`
        processed.push(rowid)
        deps.pushInbound({
          channelId: 'imessage',
          senderId: sender,
          messageId,
          text,
        })
      }
      // 读信后标注已读（可选，cfg.markRead=true）：只标本轮实际处理过的白名单消息
      if (cfg.markRead === true && processed.length > 0) {
        await markRead(processed)
      }
    } catch (err) {
      if (deps.signal.aborted) return
      const msg = String(err?.message ?? err)
      if (/authorization denied|Operation not permitted|not authorized/i.test(msg)) {
        // TCC 拒绝：节流告警（每 10 分钟最多一次），避免刷屏
        if (Date.now() - (lastTccWarnAt ?? 0) > 600_000) {
          lastTccWarnAt = Date.now()
          deps.log.warn('iMessage: 无法读取 chat.db（TCC 未授权）。请在 系统设置 → 隐私与安全性 → 完全磁盘访问 中加入运行 DSH 的进程（%s）', process.execPath)
        }
      } else {
        deps.log.warn('iMessage: 轮询失败:', msg)
      }
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
