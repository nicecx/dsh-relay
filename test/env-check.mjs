#!/usr/bin/env node
/**
 * dsh-relay iMessage 环境依赖自检（2026-08-25 新增）。
 *
 * 背景：dry-run 覆盖"接收/发送路由"的逻辑层，但以下环境依赖无法用纯逻辑测试：
 *   - TCC 权限（chat.db 读取、osascript 控制 Messages）
 *   - Messages 运行状态与 AppleScript 可达性
 *   - buddy 可寻址性（发送目标是否真的存在）
 *   - 发送落点正确性（chat id 形式在 macOS 26 实测会落错会话）
 *   - 运行时装配（watchdog 连接、poll 活性）
 *
 * 本脚本默认只读、无副作用，可随时运行；`--send` 才做一次真实发送路由验证
 * （会往手机号会话发一条带自标记的消息，poll 会跳过它，不产生回执）。
 *
 * 用法：
 *   node test/env-check.mjs
 *   node test/env-check.mjs --handles '+8615021614862,nicecx@msn.com,nicecx@icloud.com'
 *   node test/env-check.mjs --handles '...' --send
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { extractHandleFromChatId } from '../src/channels/imessage.js'

const execFileAsync = promisify(execFile)
const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')
const DEFAULT_STATE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-relay', 'state.json')

const args = process.argv.slice(2)
const handles = (() => {
  const i = args.indexOf('--handles')
  if (i === -1) return []
  return args[i + 1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
})()
const doSend = args.includes('--send')

let failures = 0
const check = (name, ok, extra = '') => {
  if (ok) console.log(`✓ ${name}${extra ? '  ' + extra : ''}`)
  else {
    failures += 1
    console.error(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

const sqlite = async (sql) => {
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', `file:${CHAT_DB}?mode=ro`, sql], { timeout: 20_000, maxBuffer: 1 << 24 })
  return stdout.trim() === '' ? [] : JSON.parse(stdout)
}
const osascript = async (scriptLines, argsList = []) => {
  const opts = scriptLines.flatMap((l) => ['-e', l])
  const { stdout } = await execFileAsync('osascript', [...opts, ...argsList], { timeout: 20_000, maxBuffer: 1 << 20 })
  return stdout
}

const run = async () => {
  // ---- 1. 平台与 chat.db 可读（TCC） ----
  check('平台 macOS', process.platform === 'darwin', process.platform)
  check('chat.db 存在', existsSync(CHAT_DB), CHAT_DB)
  if (existsSync(CHAT_DB)) {
    try {
      const rows = await sqlite('SELECT MAX(ROWID) AS max FROM message')
      check('chat.db 可读（TCC 完整磁盘访问）', rows[0]?.max > 0, `max rowid=${rows[0]?.max}`)
    } catch (err) {
      check('chat.db 可读（TCC 完整磁盘访问）', false, String(err?.message ?? err).slice(0, 120))
    }
  }

  // ---- 2. Messages 进程与 AppleScript 可达 ----
  try {
    const n = Number((await osascript(['tell application "Messages" to count of chats'])).trim())
    check('osascript 可达（Messages 响应）', Number.isFinite(n) && n > 0, `${n} 个会话`)
  } catch (err) {
    check('osascript 可达（Messages 响应）', false, String(err?.message ?? err).slice(0, 120))
  }

  // ---- 3. 白名单 buddy 可寻址（发送目标的真实存在性，无副作用） ----
  if (handles.length > 0) {
    const buddyScript = [
      'on run argv',
      '  set h to item 1 of argv',
      '  tell application "Messages"',
      '    set svc to first service whose service type is iMessage',
      '    return exists buddy h of svc',
      '  end tell',
      'end run',
    ]
    for (const h of handles) {
      try {
        const r = (await osascript(buddyScript, [h])).trim()
        check(`buddy 可寻址: ${h}`, r === 'true', r)
      } catch (err) {
        check(`buddy 可寻址: ${h}`, false, String(err?.message ?? err).slice(0, 100))
      }
    }
  } else {
    console.log('（未传 --handles，跳过 buddy 可寻址与路由健康检查）')
  }

  // ---- 4. 发送偏斜提示（历史数据弱信号）+ 手机号会话活性 ----
  // 注意：message 表无"目标 handle"列，历史数据无法证明发送目标——
  // 路由正确性的权威验证是 --send（实时发送后读落点）。
  if (handles.length > 0) {
    const targetSet = new Set(handles.map((h) => extractHandleFromChatId(h)))
    const phoneHandles = handles.map((h) => extractHandleFromChatId(h)).filter((h) => /^\+\d{5,}$/.test(h))
    if (phoneHandles.length > 0) {
      const phone = phoneHandles[0]
      try {
        const rows = await sqlite(`SELECT m.ROWID, h.id AS handleId, datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS dt, (SELECT c.chat_identifier FROM chat_message_join cm JOIN chat c ON c.ROWID=cm.chat_id WHERE cm.message_id=m.ROWID LIMIT 1) AS chat FROM message m JOIN handle h ON h.ROWID=m.handle_id WHERE m.is_from_me=1 AND ((SELECT c2.chat_identifier FROM chat_message_join cm2 JOIN chat c2 ON c2.ROWID=cm2.chat_id WHERE cm2.message_id=m.ROWID LIMIT 1) = '${phone}' OR h.id = '${phone}') ORDER BY m.ROWID DESC LIMIT 1`)
        if (rows[0]) {
          check('手机号会话最近有出站消息（活性）', true, `rowid ${rows[0].ROWID} ${rows[0].dt}（handle ${rows[0].handleId} / 落 ${rows[0].chat}）`)
        } else {
          check('手机号会话最近有出站消息（活性）', false, `${phone} 会话无 me=1 消息——发送可能偏斜，建议 --send 验证`)
        }
      } catch { /* 弱信号检查失败不致命 */ }
    }
    const rows = await sqlite(`SELECT m.ROWID, h.id AS handleId, (SELECT c.chat_identifier FROM chat_message_join cm JOIN chat c ON c.ROWID=cm.chat_id WHERE cm.message_id=m.ROWID LIMIT 1) AS chat FROM message m JOIN handle h ON h.ROWID=m.handle_id WHERE m.is_from_me=1 ORDER BY m.ROWID DESC LIMIT 30`)
    const mismatches = rows.filter((r) => targetSet.has(r.handleId) && r.chat !== r.handleId)
    check('发送账号与落点一致（弱信号；权威验证见 --send）', mismatches.length === 0,
      mismatches.length > 0 ? `异常 ${mismatches.length} 条，如 rowid ${mismatches[0].ROWID}（账号 ${mismatches[0].handleId} 落 ${mismatches[0].chat}）` : '')
  }

  // ---- 5. 运行时装配（state.json：watchdog 连接 + poll 活性） ----
  try {
    const state = JSON.parse(readFileSync(DEFAULT_STATE, 'utf8'))
    check('watchdog 已连接', state.watchdogConnected === true)
    const pulse = state.channelPulse?.imessage
    if (pulse) {
      const ageSec = Math.round((Date.now() - pulse.lastAt) / 1000)
      check('imessage poll 活跃（channelPulse）', ageSec < 30, `${ageSec}s 前（count=${pulse.count}）`)
    } else {
      check('imessage poll 活跃（channelPulse）', false, '无 pulse（通道未启动？）')
    }
  } catch (err) {
    check('运行时装配（state.json）', false, String(err?.message ?? err).slice(0, 100))
  }

  // ---- 6. [--send] 真实发送路由验证（会打扰手机一次，仅显式启用） ----
  if (doSend) {
    const phone = handles.find((h) => /^\+\d{5,}$/.test(extractHandleFromChatId(h)))
    if (!phone) {
      check('--send: 需要 --handles 含手机号', false)
    } else {
      const target = extractHandleFromChatId(phone)
      try {
        await osascript([
          'on run argv',
          '  set msg to item 1 of argv',
          '  set target to item 2 of argv',
          '  tell application "Messages"',
          '    set svc to first service whose service type is iMessage',
          '    send msg to buddy target of svc',
          '  end tell',
          'end run',
        ], [`\u200bENVCHK${Date.now()}`, target])
        // 等待落库 + poll 读到（带 \u200b 前缀会被 poll 提取为文本但无 D5HR42——
        // 注意：env-check 用 \u200bENVCHK 而非 D5HR42，避免被误当插件消息）
        await new Promise((r) => setTimeout(r, 6000))
        const rows = await sqlite(`SELECT m.ROWID, h.id AS handleId, (SELECT c.chat_identifier FROM chat_message_join cm JOIN chat c ON c.ROWID=cm.chat_id WHERE cm.message_id=m.ROWID LIMIT 1) AS chat FROM message m JOIN handle h ON h.ROWID=m.handle_id WHERE m.is_from_me=1 ORDER BY m.ROWID DESC LIMIT 3`)
        const last = rows[0]
        check('--send 落点正确（buddy 形式 → 手机号会话）', last?.handleId === target && last?.chat === target,
          last ? `rowid ${last.ROWID} 目标=${target} 落=${last.chat}` : '无新消息')
      } catch (err) {
        check('--send 发送', false, String(err?.message ?? err).slice(0, 120))
      }
    }
  }

  if (failures > 0) {
    console.error(`\nenv-check：${failures} 项失败`)
    process.exit(1)
  }
  console.log('\nenv-check 全部通过 ✅')
}

run().catch((err) => {
  console.error('env-check 异常:', err)
  process.exit(1)
})
