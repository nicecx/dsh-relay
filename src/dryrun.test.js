/**
 * dry-run 集成测试：通讯接口已由真实 iMessage 联调验证（用例 0–3），
 * 剩余逻辑（审批流、提问流、/relay 列表命令）在此用模拟环境驱动真实代码，
 * 不需要手机参与。
 *   node src/dryrun.test.js
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachApprovalRelay } from './approval.js'
import { attachQuestionRelay } from './questions.js'
import { RelayStore } from './store.js'
import { RequestRegistry } from './requests.js'
import { apply } from './index.js'

let passed = 0
const tests = []
const t = (name, fn) => tests.push({ name, fn })

/** 捕获 ctx.on 注册的监听器 */
function fakeCtx(extra = {}) {
  const listeners = {}
  const ctx = {
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
      return () => {}
    },
    effect() { return () => {} },
    get(service) {
      if (extra[service] !== undefined) return extra[service]
      return undefined
    },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {}, success() {} }),
    agents: { get: () => undefined },
    sessions: { list: () => [] },
    jobs: { attachController: () => () => {}, start: () => {} },
    __listeners: listeners,
  }
  return ctx
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-relay-dryrun-'))
const storePath = join(tmp, 'state.json')

// ---------- 审批诉求 dry-run ----------

t('approval: 推送→编号→批准 → allowed-once', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { approvalTimeoutSecs: 10 },
  }
  attachApprovalRelay(ctx, relay)
  const listener = ctx.__listeners['approval/request'][0]
  const req = { agent: { session: { id: 's1', events: [] } }, toolName: 'bash', reason: 'rm -rf', signal: undefined }
  const outcomePromise = listener(req, () => new Promise(() => {})) // 双轨：网页侧挂起，等通道
  assert.equal(pushed.length, 1, '应推送一次')
  assert.ok(pushed[0].text.includes('需要批准'))
  assert.ok(pushed[0].text.includes('bash'))
  const n = pushed[0].meta.number
  assert.equal(requests.size, 1, '应登记 1 条 pending')
  assert.equal(requests.answer(n, 'allow'), 'ok')
  assert.equal(await outcomePromise, 'allowed-once', '批准 → allowed-once')
  assert.equal(requests.size, 0, '应答后 pending 清空')
})

t('approval: 拒绝 → rejected', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { approvalTimeoutSecs: 10 },
  }
  attachApprovalRelay(ctx, relay)
  const listener = ctx.__listeners['approval/request'][0]
  const outcomePromise = listener({ agent: { session: { id: 's1', events: [] } }, toolName: 'bash', signal: undefined }, () => new Promise(() => {})) // 双轨：网页侧挂起，等通道
  const n = pushed[0].meta.number
  assert.equal(requests.answer(n, 'reject'), 'ok')
  assert.equal(await outcomePromise, 'rejected')
})

t('approval: 通道超时 → 等网页裁决（next 挂起模拟网页）', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { approvalTimeoutSecs: 0.3 },
  }
  attachApprovalRelay(ctx, relay)
  const listener = ctx.__listeners['approval/request'][0]
  // next 返回可外部 resolve 的 promise：模拟网页审批卡挂起，之后用户批准
  let resolveWeb
  const webPromise = new Promise((r) => { resolveWeb = r })
  const outcomePromise = listener({ agent: { session: { id: 's1', events: [] } }, toolName: 'bash', signal: undefined }, () => webPromise)
  // 等通道超时（0.3s）后，网页批准
  await new Promise((r) => setTimeout(r, 500))
  resolveWeb('allowed-once')
  const outcome = await outcomePromise
  assert.equal(outcome, 'allowed-once', '通道超时后网页批准生效')
  assert.equal(requests.size, 0, '网页批准后 pending 清空')
  assert.ok(pushed.some((p) => p.text.includes('已在电脑端批准')), '通道收到完成通知')
})

t('approval: 未启用通道 → 直接 next()', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const relay = {
    store, requests,
    hasActiveChannels: () => false,
    pushAll: () => { throw new Error('不应推送') },
    sessionLabel: () => '会话X',
    cfg: { approvalTimeoutSecs: 10 },
  }
  attachApprovalRelay(ctx, relay)
  const listener = ctx.__listeners['approval/request'][0]
  const outcome = await listener({ agent: { session: { id: 's1', events: [] } }, toolName: 'bash', signal: undefined }, async () => 'downstream')
  assert.equal(outcome, 'downstream')
})

// ---------- 提问诉求 dry-run ----------

t('question: 推送→编号→答选项 → 结构化工具结果', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { questionTimeoutSecs: 10 },
  }
  attachQuestionRelay(ctx, relay)
  const listener = ctx.__listeners['tools/execute'][0]
  const exec = {
    name: 'ask_user_question',
    agent: { session: { id: 's1' } },
    arguments: { questions: [{ id: 'q1', question: '继续？', options: [{ label: '是' }, { label: '否' }] }] },
    signal: undefined,
  }
  const resultPromise = listener(exec, async () => 'tool-default')
  assert.equal(pushed.length, 1)
  assert.ok(pushed[0].text.includes('需要你的意见'))
  const n = pushed[0].meta.number
  assert.ok(pushed[0].text.includes('#'), '推送应含编号')
  assert.equal(requests.answer(n, { text: '1' }), 'ok')
  const result = await resultPromise
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { answers: [{ id: 'q1', selected: ['是'] }] })
  assert.ok(Array.isArray(result.content) && result.content[0].type === 'text')
})

t('question: 超时 → 转回网页（next 执行真实工具）', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { questionTimeoutSecs: 0.3 },
  }
  attachQuestionRelay(ctx, relay)
  const listener = ctx.__listeners['tools/execute'][0]
  const result = await listener({
    name: 'ask_user_question',
    agent: { session: { id: 's1' } },
    arguments: { questions: [{ id: 'q1', question: '继续？', options: [{ label: '是' }] }] },
    signal: undefined,
  }, async () => 'tool-default')
  assert.equal(result, 'tool-default', '超时应放行真实工具（网页 UI）')
})

t('question: 非 ask_user_question 工具 → 直接放行', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: () => { throw new Error('不应推送') },
    sessionLabel: () => '会话X',
    cfg: { questionTimeoutSecs: 10 },
  }
  attachQuestionRelay(ctx, relay)
  const listener = ctx.__listeners['tools/execute'][0]
  const result = await listener({ name: 'bash', agent: { session: { id: 's1' } }, signal: undefined }, async () => 'ok')
  assert.equal(result, 'ok')
})

// ---------- apply() + /relay 命令 dry-run（无活动通道，零真实发送） ----------

const relayConfig = {
  enabled: true,
  approvalTimeoutSecs: 600,
  questionTimeoutSecs: 1800,
  chunkMaxChars: 1200,
  mergeTimeoutSecs: 5,
  imessagePollSecs: 5,
  emailPollSecs: 20,
  statePath: join(tmp, 'state2.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
}

let commandHandler
const commandsCtx = fakeCtx({
  commands: {
    register: (def) => {
      commandHandler = def.handler
      return () => {}
    },
  },
})
commandsCtx.sessions = {
  list: () => [
    { id: 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', events: [] },
    { id: 'session-cb200000-aaaa-4aaa-8aaa-000000000000', events: [] },
  ],
}
apply(commandsCtx, relayConfig)

t('/relay 列表：无待办', async () => {
  const res = await commandHandler({ rawInput: '' })
  assert.equal(res.kind, 'success')
  assert.ok(res.text.includes('待回复诉求'), res.text)
  assert.ok(res.text.includes('无'), res.text)
})

t('/relay status：总览', async () => {
  const res = await commandHandler({ rawInput: 'status' })
  assert.equal(res.kind, 'success')
  assert.ok(res.text.includes('总开关'), res.text)
  assert.ok(res.text.includes('会话策略'), res.text)
})

t('/relay sessions：列表含会话', async () => {
  const res = await commandHandler({ rawInput: 'sessions' })
  assert.equal(res.kind, 'success')
  assert.ok(res.text.includes('session-cb200000'), res.text)
})


// ---------- 电脑端处理 → 通道完成通知 ----------

t('approval: 超时后电脑端批准 → 通道收到完成通知', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { approvalTimeoutSecs: 0.3 },
  }
  attachApprovalRelay(ctx, relay)
  const listener = ctx.__listeners['approval/request'][0]
  const outcome = await listener({ agent: { session: { id: 's1', events: [] } }, toolName: 'bash', signal: undefined }, async () => 'allowed-once')
  assert.equal(outcome, 'allowed-once')
  const n = pushed[0].meta.number
  assert.equal(pushed.length, 2, '应推送诉求 + 完成通知')
  assert.ok(pushed[1].text.includes('#') && pushed[1].text.includes('已在电脑端批准'), pushed[1].text)
  assert.equal(requests.size, 0, '待办已从队列移除')
})

t('approval: 超时后电脑端拒绝 → 通道收到完成通知', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { approvalTimeoutSecs: 0.3 },
  }
  attachApprovalRelay(ctx, relay)
  const listener = ctx.__listeners['approval/request'][0]
  await listener({ agent: { session: { id: 's1', events: [] } }, toolName: 'bash', signal: undefined }, async () => 'rejected')
  assert.ok(pushed[1].text.includes('已在电脑端拒绝'))
  assert.equal(requests.size, 0)
})

t('question: 超时后电脑端回答 → 通道收到完成通知', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const requests = new RequestRegistry()
  const pushed = []
  const relay = {
    store, requests,
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    cfg: { questionTimeoutSecs: 0.3 },
  }
  attachQuestionRelay(ctx, relay)
  const listener = ctx.__listeners['tools/execute'][0]
  const webResult = { isError: false, value: { answers: [{ id: 'q1', selected: ['是'] }] }, content: [] }
  const result = await listener({
    name: 'ask_user_question',
    agent: { session: { id: 's1' } },
    arguments: { questions: [{ id: 'q1', question: '继续？', options: [{ label: '是' }] }] },
    signal: undefined,
  }, async () => webResult)
  assert.equal(result, webResult)
  assert.equal(pushed.length, 2)
  assert.ok(pushed[1].text.includes('已在电脑端回答'), pushed[1].text)
  assert.ok(pushed[1].text.includes('q1:是'), pushed[1].text)
  assert.equal(requests.size, 0)
})

rmSync(tmp, { recursive: true, force: true })


// ---------- turnEndPush（默认关闭） ----------
import { attachTurnEndRelay } from './turnpush.js'

t('turnEndPush: 默认关闭 → 不推送', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const pushed = []
  const relay = {
    store,
    cfg: { turnEndPush: undefined },
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    lastAssistantText: () => '长文本'.repeat(300),
    trackActive: () => {},
    redact: (s) => s,
    snippetMaxChars: 120,
  }
  attachTurnEndRelay(ctx, relay)
  const listener = ctx.__listeners['session/event'][0]
  listener({ id: 's1', events: [] }, { type: 'turn/end', data: { reason: { kind: 'completed' }, turn: 3 } })
  assert.equal(pushed.length, 0, '默认不推送')
})

t('turnEndPush: 开启 → 推送且片段 ≤120 字', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const pushed = []
  const relay = {
    store,
    cfg: { turnEndPush: true },
    hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X',
    lastAssistantText: () => '很长的回复文本'.repeat(50),
    trackActive: () => {},
    redact: (s) => s,
    snippetMaxChars: 120,
  }
  attachTurnEndRelay(ctx, relay)
  const listener = ctx.__listeners['session/event'][0]
  listener({ id: 's1', events: [] }, { type: 'turn/end', data: { reason: { kind: 'completed' }, turn: 3 } })
  assert.equal(pushed.length, 1)
  assert.ok(pushed[0].text.includes('[✅ 完成]'))
  const snippet = pushed[0].text.split('\n')[1] ?? ''
  assert.ok([...snippet].length <= 120, '片段应 ≤120 字，实际 ' + [...snippet].length)
})

t('turnEndPush: 非 turn/end 事件不推送', async () => {
  const ctx = fakeCtx()
  const store = new RelayStore(storePath)
  const pushed = []
  const relay = {
    store, cfg: { turnEndPush: true }, hasActiveChannels: () => true,
    pushAll: (text, meta) => pushed.push({ text, meta }),
    sessionLabel: () => '会话X', lastAssistantText: () => '', trackActive: () => {},
    redact: (s) => s, snippetMaxChars: 120,
  }
  attachTurnEndRelay(ctx, relay)
  ctx.__listeners['session/event'][0]({ id: 's1', events: [] }, { type: 'assistant/message', data: {} })
  assert.equal(pushed.length, 0)
})

// ---------- 调度器测试钩子（dispatch 直接驱动） ----------
import { apply as applyReal, testHooks } from './index.js'

const hookCtx = fakeCtx({
  commands: { register: () => () => {} },
})
hookCtx.sessions = {
  list: () => [
    { id: 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', events: [] },
    { id: 'session-cb200000-aaaa-4aaa-8aaa-000000000000', events: [] },
  ],
}
const followed = []
hookCtx.agents = {
  get: (id) => ({ id, followup: (m) => followed.push({ id, m }) }),
}
const hookConfig = {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state3.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
  // 该组测试显式开启注入，验证"无绑定会话提示/迟到回复不注入"等注入相关行为
  security: { allowInjection: true, redactSecrets: true },
}
applyReal(hookCtx, hookConfig)
const hook = testHooks.get(hookCtx)

t('dispatch: 外来编号（其他 bot 的诉求）静默', async () => {
  assert.equal(await hook.dispatch('把99号批了', 'imessage', 'sender'), undefined)
  assert.equal(await hook.dispatch('#99 批准', 'imessage', 'sender'), undefined)
  assert.equal(await hook.dispatch('回复 99 继续', 'imessage', 'sender'), undefined)
})

t('dispatch: 模糊启用会话（短前缀/最近）', async () => {
  const r1 = await hook.dispatch('打开cb200', 'imessage', 'sender')
  assert.ok(r1.includes('已开启'), r1)
  assert.equal(hook.store.sessionEnabled('session-cb200000-aaaa-4aaa-8aaa-000000000000'), true)
  // 先触发一次会话事件，让"最近活跃"指向 1111 会话，再验证「关掉最近会话」
  hookCtx.__listeners['session/event'][0]({ id: 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', events: [] }, { type: 'user/message', data: {} })
  const r2 = await hook.dispatch('关掉最近会话', 'imessage', 'sender')
  assert.ok(r2.includes('已关闭'), r2)
  assert.equal(hook.store.sessionEnabled('session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false)
})

t('dispatch: 无绑定会话时裸文本不注入', async () => {
  const r = await hook.dispatch('随便说点什么!!', 'imessage', 'sender')
  assert.ok(typeof r === 'string' && r.includes('绑定'), r)
  assert.equal(followed.length, 0, '不得注入到任何会话')
})

rmSync(tmp, { recursive: true, force: true })


// ---------- 迟到回复：已结束诉求不再注入（防污染） ----------

t('dispatch: 已结束诉求的迟到回复 → 不注入、给提示', async () => {
  // 构造一个"已注册并已结算"的历史诉求（编号留痕，非外来）
  const n = hook.store.allocNumber()
  hook.requests.register({ number: n, kind: 'approval', sessionId: 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timeoutMs: 5000 }) // 不 await：返回的是结算 promise
  assert.equal(hook.requests.answer(n, 'allow'), 'ok')
  const r = await hook.dispatch(`#${n} 批准`, 'imessage', 'sender')
  assert.ok(typeof r === 'string' && r.includes('已结束'), r)
  assert.equal(followed.length, 0, '不得注入任何会话（防污染）')
  const r2 = await hook.dispatch(`#${n} 我的意见是选A`, 'imessage', 'sender')
  assert.ok(r2.includes('已结束'), r2)
  assert.equal(followed.length, 0, '迟到的回答也不得注入')
})

// 保活计时器：requests 的超时定时器 unref，需一个引用计时器保持事件循环，超时用例才能结算

// ---------- 裸文本注入默认关闭：静默放过（共享通道共存） ----------

const quietCtx = fakeCtx({})
quietCtx.sessions = { list: () => [] }
const quietFollowed = []
quietCtx.agents = { get: () => ({ id: 'x', followup: (m) => quietFollowed.push(m) }) }
const quietConfig = {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state4.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
  boundSessions: { imessage: 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
}
applyReal(quietCtx, quietConfig)
const qh = testHooks.get(quietCtx)

t('dispatch: 裸文本在 allowInjection=false 时静默（不注入不回复）', async () => {
  const r = await qh.dispatch('具体的评论内容!!', 'imessage', 'sender')
  assert.equal(r, undefined, '不回复')
  assert.equal(quietFollowed.length, 0, '不注入')
})
t('dispatch: 命令不受影响（allowInjection=false 仍执行）', async () => {
  const r = await qh.dispatch('状态', 'imessage', 'sender')
  assert.ok(typeof r === 'string' && r.includes('总开关'), r)
})
// ---------- 通道内 /sessions 隔离策略（默认 pointer，不暴露 id/标题） ----------

const ptrCtx = fakeCtx({
  sessionQuery: {
    listSessions: async () => [
      { header: { id: 'session-aaaaaaaa-0000-4000-8000-000000000001' }, live: true, persisted: true },
      { header: { id: 'session-aaaaaaaa-0000-4000-8000-000000000002' }, live: false, persisted: true },
    ],
  },
})
ptrCtx.sessions = { list: () => [] }
applyReal(ptrCtx, {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state7.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
})
const ph = testHooks.get(ptrCtx)

t('/sessions 通道内默认 pointer：只给数量+指引，不暴露 id/标题', async () => {
  const r = await ph.dispatch('/sessions', 'imessage', 'sender')
  assert.ok(r.includes('共 2 个会话'), r)
  assert.ok(r.includes('/relay sessions'), r)
  assert.ok(!r.includes('session-aaaaaaaa'), '不得暴露会话 id')
  assert.ok(!r.includes('●'), '不得暴露标题/状态细节')
})

const silentCtx = fakeCtx({})
silentCtx.sessions = { list: () => [] }
applyReal(silentCtx, {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state8.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
  sessionsInChannel: 'silent',
})
const sh = testHooks.get(silentCtx)

t('/sessions 通道内 silent：不回复', async () => {
  const r = await sh.dispatch('/sessions', 'imessage', 'sender')
  assert.equal(r, undefined)
})


// ---------- /sessions 全量列表（活跃 + 持久化） ----------

const listCtx = fakeCtx({
  sessionQuery: {
    listSessions: async () => [
      { header: { id: 'session-aaaaaaaa-0000-4000-8000-000000000001' }, live: true, persisted: true },
      { header: { id: 'session-aaaaaaaa-0000-4000-8000-000000000002' }, live: false, persisted: true },
    ],
    readTitleSnapshots: async () => [
      { sessionId: 'session-aaaaaaaa-0000-4000-8000-000000000001', title: { title: '活跃对话' } },
    ],
  },
})
listCtx.sessions = {
  list: () => [{ id: 'session-aaaaaaaa-0000-4000-8000-000000000001', events: [] }],
}
const listConfig = {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state6.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
  sessionsInChannel: 'full',
}
applyReal(listCtx, listConfig)
const lh = testHooks.get(listCtx)

t('/sessions：列出全部会话（含非活跃），标题与活跃标记', async () => {
  const r = await lh.dispatch('/sessions', 'imessage', 'sender')
  assert.ok(r.includes('session-aaaaaaaa-0000-4000-8000-000000000002'), '应包含非活跃会话')
  assert.ok(r.includes('活跃对话'), '应包含标题')
  assert.ok(r.includes('●活跃'), '应标注活跃')
})

// ---------- 重启后遗留诉求：应答必须有回执（不沉默） ----------

const staleCtx = fakeCtx({})
staleCtx.sessions = { list: () => [] }
staleCtx.agents = { get: () => ({ id: 'session-A', followup: () => {} }) }
applyReal(staleCtx, {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state9.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
  security: { allowInjection: true, redactSecrets: true },
})
const sth = testHooks.get(staleCtx)

t('重启恢复的诉求被应答 → 必有明确回执（非沉默）', async () => {
  // 模拟：注册→落盘→新注册表恢复（stale）
  const n = sth.store.allocNumber()
  sth.requests.register({ number: n, kind: 'question', sessionId: 'session-A', timeoutMs: 5000 })
  sth.requests.flushPersist()
  const snapshot = sth.requests.snapshot()
  // 新注册表恢复（模拟重启）
  const fresh = new (await import('./requests.js')).RequestRegistry()
  fresh.restore(snapshot)
  assert.equal(fresh.isStale(n), true)
  // 用恢复后的注册表驱动应答
  sth.requests.restore(snapshot) // 重新恢复（清掉 live 的，模拟只剩 stale）
  const r = await sth.dispatch(`#${n} 1`, 'imessage', 'sender')
  assert.ok(typeof r === 'string' && r.length > 0, '必须有回执')
  assert.ok(r.includes('失效') || r.includes('已结束') || r.includes('回答'), r)
})

// ---------- 通道最近对话：无编号回复续接该通道的最近对话（非全局绑定） ----------

const contCtx = fakeCtx({})
contCtx.sessions = { list: () => [] }
const contFollowed = []
contCtx.agents = {
  get: (id) => ({ id, followup: (m) => contFollowed.push({ id, m }) }),
}
const contConfig = {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state5.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
  security: { allowInjection: true, redactSecrets: true },
}
applyReal(contCtx, contConfig)
const cth = testHooks.get(contCtx)

t('dispatch: 无编号裸文本续接通道最近对话（优先于显式绑定）', async () => {
  cth.store.setChannelContext('imessage', 'session-A')     // 最近推送/对话所属会话
  cth.store.setBoundSession('imessage', 'session-BOUND')   // 显式绑定的是另一个会话
  const r = await cth.dispatch('还有一个补充说明!!', 'imessage', 'sender')
  assert.ok(typeof r === 'string')
  assert.equal(contFollowed.length, 1, '应注入一次')
  assert.equal(contFollowed[0].id, 'session-A', '应续接通道最近对话，而非全局绑定会话')
})

// ---------- 回执兜底（2026-08-20）：可信发送者的消息绝不静默 ----------

const ackCtx = fakeCtx({})
ackCtx.sessions = { list: () => [] }
ackCtx.agents = { get: (id) => ({ id, followup: () => {} }) }
const ackSent = []
const ackConfig = {
  enabled: true, approvalTimeoutSecs: 600, questionTimeoutSecs: 1800,
  chunkMaxChars: 1200, mergeTimeoutSecs: 5, imessagePollSecs: 5, emailPollSecs: 20,
  statePath: join(tmp, 'state6.json'),
  channels: { imessage: { enabled: false }, email: { enabled: false }, wechat: { enabled: false } },
  security: { allowInjection: false, redactSecrets: true },  // 裸文本注入关闭 → dispatch 返回空 → 兜底回执
  boundSessions: { imessage: 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
}
applyReal(ackCtx, ackConfig)
const ackHook = testHooks.get(ackCtx)

// 构造一个已注册的审批诉求（非外来编号），回复后应有明确回执
const ackN = ackHook.store.allocNumber()
void ackHook.requests.register({ number: ackN, kind: 'approval', sessionId: 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timeoutMs: 5000 })

t('回执兜底: dispatch 返回空时 pushInbound 也发送确认（不静默）', async () => {
  // 有诉求在队列时，回复任意编号都有明确回执（#99 不在队列 → "已结束"提示，非静默）
  const ackedForeign = await ackHook.dispatch('把99号批了', 'imessage', 'sender')
  assert.ok(typeof ackedForeign === 'string' && ackedForeign.includes('#99'), ackedForeign)
  const acked = await ackHook.dispatch(`#${ackN} 批准`, 'imessage', 'sender')
  assert.ok(typeof acked === 'string' && acked.includes('已批准'), acked)
})

// 保活计时器：requests 的超时定时器 unref，需一个引用计时器保持事件循环，超时用例才能结算
const alive = setInterval(() => {}, 1000)
for (const { name, fn } of tests) {
  await fn()
  passed++
  console.log('✓', name)
}
clearInterval(alive)

console.log(`\ndry-run 全部通过：${passed} 项`)
