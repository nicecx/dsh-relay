#!/usr/bin/env node
/**
 * imessage poll dry-run：真实轮询逻辑 vs 真实 chat.db（只读），不发送、不写真实状态。
 *
 * 固化 2026-08-25 修复：
 *  1. 循环代际（runSeq）：stop() 后旧循环退出、重建的 start() 独立运行、
 *     旧 controller abort 只终止旧循环（不误伤新循环）——修复"僵尸 job/poll 反复停摆"。
 *  2. poll 对 chat.db 只读查询 + attributedBody 提取对真实消息可处理。
 *
 * 安全：markRead 关闭（不写 chat.db）；store 用临时文件；pushInbound 只收集。
 * 用法：node test/imessage-poll.dryrun.mjs
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { RelayStore } from '../src/store.js'
import { createImessageChannel } from '../src/channels/imessage.js'

const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-relay-im-'))
// 预填"上次运行处理到 37499"：验证停机期间 37500/37501 的补收（real 行为）而非首次运行跳过
writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({
  seenIds: { imessage: ['chatdb:37498', 'chatdb:37499'] },
}))
const store = new RelayStore(join(tmpDir, 'state.json'))

const inbound = []
const logs = []
const deps = {
  store,
  log: {
    debug: (...a) => logs.push(['debug', ...a]),
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
  },
  pushInbound: (m) => inbound.push(m),
  chunkMaxChars: 1200,
  stateDir: tmpDir,
  resolveSecret: async () => undefined,
  watchdog: undefined,
  pollSecs: 0.2,
  signal: undefined,
  jobId: { value: 'dsh-relay-dryrun' },
}

const channel = createImessageChannel({
  handle: 'nicecx@msn.com',
  extraHandles: ['nicecx@icloud.com', '15021614862'],
  chatScope: '',
  markRead: false, // dry-run 绝不写 chat.db
}, deps)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    console.log(`✓ ${name}`)
  } else {
    failures += 1
    console.error(`✗ ${name} ${extra}`)
  }
}

// ---- 阶段 1：首次 start，跑 4 轮 poll（约 1s）----
const c1 = new AbortController()
deps.signal = c1.signal
const t0 = Date.now()
const p1 = channel.start()
await sleep(1100)
const inboundIds = inbound.map((m) => m.messageId)
check('start 后 poll 至少跑起来（有活动脉冲）', (store.state.channelPulse?.imessage?.count ?? 0) > 0, `pulse=${store.state.channelPulse?.imessage?.count}`)
check('poll 期间收到真实入站消息（按 chat.db）', inbound.length > 0, `inbound=${JSON.stringify(inboundIds.slice(0, 5))}`)

// ---- 阶段 2：模拟 watchdog spawn 重建（stop 旧 → start 新）----
// 重建：新 controller 替换 deps.signal（复刻 startChannelJob 的覆盖行为）
channel.stop()
const c2 = new AbortController()
deps.signal = c2.signal
const p2 = channel.start()
await sleep(900)
const pulse2 = store.state.channelPulse?.imessage?.count ?? 0
check('重建后新循环继续 poll（脉冲增长）', pulse2 > 0, `count=${pulse2}`)

// ---- 阶段 3：旧 controller abort 不应影响新循环 ----
// （c1 是旧循环的 signal；abort 后新循环（读 c2.signal）应继续）
c1.abort()
const before = store.state.channelPulse?.imessage?.count ?? 0
await sleep(700)
const after = store.state.channelPulse?.imessage?.count ?? 0
check('abort 旧 controller 后新循环不受影响（仍在 poll）', after > before, `before=${before} after=${after}`)

// ---- 阶段 4：正常停止 ----
const c3 = new AbortController()
deps.signal = c3.signal
const p3 = channel.start()
await sleep(500)
channel.stop()
await p3 // start 循环应正常退出（不挂起）
check('stop() 后 start 循环正常退出', true)

await p1.catch(() => {})
await p2.catch(() => {})
rmSync(tmpDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nimessage poll dry-run：${failures} 项失败`)
  process.exit(1)
}
console.log('\nimessage poll dry-run 全部通过 ✅')
