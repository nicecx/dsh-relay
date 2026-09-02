/**
 * 会话间 inbox（session-inbox）测试 —— 20260902-020（评审 022/023/024 设计要求 T1-T9）。
 *
 *   node --test test/inbox.test.mjs
 *
 * 覆盖：T1 send append / T2 活跃投递 / T3 水位不重复 / T4a-b-c 分级校验三档 /
 * T5 审计 / T6 非活跃留存+激活 drain / T7 并发 append / T8 水位原子写 / T9 归档迁移。
 * 测试用临时 home（tmp），注册表目录手工构造（磁盘扫描是校验唯一源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, testHooks } from '../src/index.js'
import { createInboxService, scanSessionRegistry, normalizeSessionId } from '../src/inbox.js'

const SENDER = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TARGET = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** 独立临时 home：dsh-relay 状态目录 + 持久化会话注册表（磁盘扫描唯一源） */
function makeHome({ registrySids = [TARGET] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-inbox-test-'))
  mkdirSync(join(home, 'dsh-relay'), { recursive: true })
  for (const sid of registrySids) {
    // 注册表结构：<cwd编码>/<sessionId>/session.jsonl.zstd
    const dir = join(home, 'sessions', '--tmp-cwd--', sid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'placeholder')
  }
  return home
}

/** 完整 fake ctx（覆盖 relay apply 全量调用面；jobs.start 不执行 run——宿主才同步跑） */
function makeCtx({ agents = new Map() } = {}) {
  const started = []
  const tools = []
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {}, success() {} }),
    get(service) {
      // 假 watchdog：带 monitor（acquireWatchdog 延迟回调会调 registerChannelToWatchdog）
      if (service === 'watchdog') return { monitor: () => () => {} }
      return undefined
    },
    agents: { get: (id) => agents.get(String(id)) },
    sessions: { list: () => [...agents.keys()].map((id) => ({ id })) },
    jobs: {
      attachController: () => () => {},
      start: (def) => { started.push(def); return 'job-inbox-test' },
    },
    tools: { register: (def) => { tools.push(def); return () => {} } },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
  }
  ctx.__started = started
  ctx.__tools = tools
  return ctx
}

function setup({ registrySids, agents, inboxMaxBytes } = {}) {
  const home = makeHome({ registrySids })
  const ctx = makeCtx({ agents })
  apply(ctx, {
    statePath: join(home, 'dsh-relay', 'state.json'),
    inboxHome: home,
    inboxEnabled: true,
    inboxMaxBytes,
    channels: {},
  })
  const hooks = testHooks.get(ctx)
  const tool = ctx.__tools.find((d) => d.name === 'session_send')
  assert.ok(tool, 'session_send 工具应已注册')
  return { home, ctx, hooks, tool, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } } }
}

const exec = (sid) => ({ agent: { id: sid } })
const fakeAgent = (bucket) => ({ followup: (f) => bucket.push(f) })

// ---------- T1：session_send → append（from 服务端取值） ----------

test('T1: send appends one JSON line with server-side from', async () => {
  const { home, tool, cleanup } = setup()
  try {
    const r = await tool.execute({ to: TARGET, text: '暂停上传，等我触发', kind: 'coordinate' }, exec(SENDER))
    assert.match(r, /已写入会话/)
    const lines = readFileSync(join(home, 'session-inbox', `${TARGET}.jsonl`), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const msg = JSON.parse(lines[0])
    assert.equal(msg.from, SENDER) // from 服务端取 exec.agent.id
    assert.equal(msg.to, TARGET)
    assert.equal(msg.kind, 'coordinate')
    assert.ok(msg.ts)
    assert.ok(msg.id.startsWith('msg-'))
  } finally { cleanup() }
})

// ---------- T2+T3：活跃目标投递 + 水位推进不重复 ----------

test('T2/T3: active target receives messages; watermark prevents re-delivery', async () => {
  const delivered = []
  const agents = new Map([[TARGET, fakeAgent(delivered)]])
  const { hooks, tool, cleanup } = setup({ agents })
  try {
    await tool.execute({ to: TARGET, text: 'm1' }, exec(SENDER))
    await tool.execute({ to: TARGET, text: 'm2', kind: 'request' }, exec(SENDER))
    await hooks.inboxTick()
    assert.equal(delivered.length, 2, '两条都应投递')
    assert.match(delivered[0].content[0].text, /\[会话间消息｜notice｜来自 session-aaaa/)
    assert.match(delivered[0].content[0].text, /m1/)
    assert.equal(delivered[0].role, 'user') // M4：role:user 帧
    await hooks.inboxTick()
    assert.equal(delivered.length, 2, '水位推进后不重复投递')
  } finally { cleanup() }
})

// ---------- T4a：格式非法 → 拒绝 + 审计 ----------

test('T4a: malformed target rejected with send-rejected:format audit', async () => {
  const { home, tool, cleanup } = setup()
  try {
    const r = await tool.execute({ to: 'not-a-session-id', text: 'x' }, exec(SENDER))
    assert.match(r, /格式非法/)
    const audit = readFileSync(join(home, 'session-inbox', 'audit.jsonl'), 'utf8')
    assert.match(audit, /send-rejected:format/)
    assert.equal(existsSync(join(home, 'session-inbox', 'not-a-session-id.jsonl')), false)
  } finally { cleanup() }
})

// ---------- T4b：注册表未命中 → 拒绝 + 审计 ----------

test('T4b: unknown target (not in registry) rejected with send-rejected:unknown', async () => {
  const { home, tool, cleanup } = setup()
  try {
    const ghost = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const r = await tool.execute({ to: ghost, text: 'x' }, exec(SENDER))
    assert.match(r, /不在持久化注册表/)
    const audit = readFileSync(join(home, 'session-inbox', 'audit.jsonl'), 'utf8')
    assert.match(audit, /send-rejected:unknown/)
  } finally { cleanup() }
})

// ---------- T4c+T6：命中但非活跃 → 接受留存；激活后 drain ----------

test('T4c/T6: registry hit but inactive → accepted & retained; drain after activation', async () => {
  const delivered = []
  const agents = new Map() // 目标非活跃
  const { home, hooks, tool, cleanup } = setup({ agents })
  try {
    const r = await tool.execute({ to: TARGET, text: '稍后处理', kind: 'notice' }, exec(SENDER))
    assert.match(r, /已写入会话/, '命中注册表即接受（无论活跃与否）')
    const file = join(home, 'session-inbox', `${TARGET}.jsonl`)
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, '消息留存')

    // 非活跃 → deliver-deferred + 水位不动
    await hooks.inboxTick()
    const audit = readFileSync(join(home, 'session-inbox', 'audit.jsonl'), 'utf8')
    assert.match(audit, /deliver-deferred/)
    assert.equal(delivered.length, 0)

    // 激活 → drain 补投 + 水位推进
    agents.set(TARGET, fakeAgent(delivered))
    await hooks.inboxTick()
    assert.equal(delivered.length, 1, '激活后补投')
    await hooks.inboxTick()
    assert.equal(delivered.length, 1, '不再重复')
  } finally { cleanup() }
})

// ---------- T5：审计 append-only 可回溯 ----------

test('T5: audit trail is append-only and parseable', async () => {
  const { home, tool, cleanup } = setup()
  try {
    await tool.execute({ to: TARGET, text: 'a' }, exec(SENDER))
    await tool.execute({ to: TARGET, text: 'b' }, exec(SENDER))
    await tool.execute({ to: 'bogus', text: 'c' }, exec(SENDER))
    const raw = readFileSync(join(home, 'session-inbox', 'audit.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    assert.ok(lines.length >= 3)
    for (const line of lines) {
      const e = JSON.parse(line)
      assert.ok(e.ts && e.action)
    }
    assert.equal(lines.filter((l) => l.includes('send-ok')).length, 2)
    assert.equal(lines.filter((l) => l.includes('send-rejected:format')).length, 1)
  } finally { cleanup() }
})

// ---------- T7：并发 append 不互踩 ----------

test('T7: concurrent sends produce intact lines', async () => {
  const { home, tool, cleanup } = setup()
  try {
    const jobs = []
    for (let i = 0; i < 20; i++) {
      jobs.push(tool.execute({ to: TARGET, text: `并行消息-${i}` }, exec(SENDER)))
    }
    await Promise.all(jobs)
    const raw = readFileSync(join(home, 'session-inbox', `${TARGET}.jsonl`), 'utf8').trim()
    const lines = raw.split('\n')
    assert.equal(lines.length, 20)
    const texts = lines.map((l) => JSON.parse(l).text)
    for (let i = 0; i < 20; i++) assert.ok(texts.includes(`并行消息-${i}`), `消息 ${i} 完整存在`)
  } finally { cleanup() }
})

// ---------- T8：水位原子写（temp+rename，无半写/残留） ----------

test('T8: watermark atomic write leaves valid JSON and no tmp residue', async () => {
  const { home, tool, cleanup } = setup()
  try {
    await tool.execute({ to: TARGET, text: 'x' }, exec(SENDER))
    const svc = createInboxService({ homeDir: home })
    svc.advanceWater(TARGET, { offset: 999, lastReadId: 'msg-done' })
    const w = JSON.parse(readFileSync(join(home, 'session-inbox', `${TARGET}.lastRead.json`), 'utf8'))
    assert.equal(w.offset, 999)
    assert.equal(w.lastReadId, 'msg-done')
    const leftovers = readdirSync(join(home, 'session-inbox')).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], '无 temp 残留')
  } finally { cleanup() }
})

// ---------- T9：归档迁移（未投递行不丢） + append-vs-archive ----------

test('T9: archive migrates undelivered tail; no line loss', async () => {
  const delivered = []
  const agents = new Map([[TARGET, fakeAgent(delivered)]])
  const { home, tool, hooks, cleanup } = setup({ agents })
  try {
    // m1 先投（水位推进到 m1 尾），m2/m3 抵达但未投
    await tool.execute({ to: TARGET, text: 'm1' }, exec(SENDER))
    await hooks.inboxTick()
    assert.equal(delivered.length, 1)
    await tool.execute({ to: TARGET, text: 'm2' }, exec(SENDER))
    await tool.execute({ to: TARGET, text: 'm3' }, exec(SENDER))
    // 归档（未投递 m2/m3 应迁移到新文件，水位归 0）
    const svc = createInboxService({ homeDir: home })
    const ar = svc.archive(TARGET)
    assert.equal(ar.ok, true)
    const archived = readdirSync(join(home, 'session-inbox')).filter((f) => f.includes('.archived-'))
    assert.equal(archived.length, 1, '归档文件存在')
    // 归档后 append（模拟并发发送窗口：m4 落新文件）
    await tool.execute({ to: TARGET, text: 'm4' }, exec(SENDER))
    // 水位已归 0：迁移行 + 新行全部可读，不丢
    const got = svc.readNew(TARGET)
    assert.equal(got.msgs.length, 3, 'm2/m3 迁移 + m4 新行均不丢')
    assert.deepEqual(got.msgs.map((m) => m.text), ['m2', 'm3', 'm4'])
    // 投递循环正常 drain（m1 已投，不重复）
    await hooks.inboxTick()
    assert.equal(delivered.length, 4, '全部消息最终送达且不重复')
  } finally { cleanup() }
})

// ---------- 025 修复①：audit.jsonl 不被 tick 误扫描/误归档 ----------

test('025: audit.jsonl excluded from tick scan; never archived', async () => {
  const delivered = []
  const agents = new Map([[TARGET, fakeAgent(delivered)]])
  // 极小阈值：消息/审计一旦被误扫必超限触发归档
  const { home, tool, hooks, cleanup } = setup({ agents, inboxMaxBytes: 200 })
  try {
    for (let i = 0; i < 8; i++) {
      await tool.execute({ to: TARGET, text: `msg-${i}` }, exec(SENDER))
    }
    await tool.execute({ to: 'bogus', text: 'x' }, exec(SENDER)) // 产生审计行
    for (let i = 0; i < 3; i++) await hooks.inboxTick()
    const inboxDir = join(home, 'session-inbox')
    const files = readdirSync(inboxDir)
    assert.ok(files.includes('audit.jsonl'), 'audit.jsonl 必须保持原名')
    assert.equal(files.filter((f) => f.includes('.archived-') && f.includes('audit')).length, 0, 'audit 不得被归档改名')
    assert.equal(files.includes('audit.jsonl.lastRead.json'), false, '不得产生 audit 水位杂物')
    // 审计仍完整可回溯
    const audit = readFileSync(join(inboxDir, 'audit.jsonl'), 'utf8')
    assert.ok(audit.trim().split('\n').length >= 9, '审计行完整')
  } finally { cleanup() }
})

// ---------- 025 修复②：tail 空归档（水位已到文件尾）重建不丢后续 append ----------

test('025: archive with empty tail rebuilds without truncation; later sends survive', async () => {
  const delivered = []
  const agents = new Map([[TARGET, fakeAgent(delivered)]])
  const { home, tool, hooks, cleanup } = setup({ agents })
  try {
    // m1 投完（水位到文件尾 → 归档时 tail 空）
    await tool.execute({ to: TARGET, text: 'm1' }, exec(SENDER))
    await hooks.inboxTick()
    assert.equal(delivered.length, 1)
    const svc = createInboxService({ homeDir: home })
    const ar = svc.archive(TARGET)
    assert.equal(ar.ok, true)
    const got1 = svc.readNew(TARGET)
    assert.equal(got1.msgs.length, 0, 'tail 空归档后新文件为空')
    assert.equal(got1.size, 0, '空文件（appendFileSync 重建，无截断语义残留）')
    // 归档后 append 的消息不丢
    await tool.execute({ to: TARGET, text: 'm2' }, exec(SENDER))
    const got2 = svc.readNew(TARGET)
    assert.equal(got2.msgs.length, 1)
    assert.equal(got2.msgs[0].text, 'm2')
    await hooks.inboxTick()
    assert.equal(delivered.length, 2, 'm2 送达且 m1 不重复')
  } finally { cleanup() }
})

// ---------- 注册表扫描（裸 uuid 形态 + 规范化） ----------

test('registry: bare-uuid dirs normalized; scan finds both forms', () => {
  const home = makeHome() // 默认已建 TARGET（session- 形态）
  try {
    const bare = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const dir = join(home, 'sessions', '--cwd--', bare)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'x')
    const reg = scanSessionRegistry(join(home, 'sessions'))
    assert.equal(normalizeSessionId('session-' + bare), 'session-' + bare)
    assert.equal(normalizeSessionId(bare), 'session-' + bare)
    assert.equal(normalizeSessionId('junk'), null)
    assert.ok(reg.has('session-' + bare), '裸 uuid 目录规范化命中')
    assert.ok(reg.has(TARGET), 'session- 形态命中')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
