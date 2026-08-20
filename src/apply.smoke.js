/**
 * apply() 组装冒烟测试：用最小假 ctx 验证插件装载、监听注册（prepend）、
 * 通道创建与清理路径，不需要真实 DSH 运行时。
 *   node src/apply.smoke.js
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-smoke-'))

function fakeCtx() {
  const listeners = []
  const effects = []
  const ctx = {
    on(event, fn, options) {
      listeners.push({ event, fn, options })
      return () => {}
    },
    effect(setup) {
      effects.push(setup)
      return () => {}
    },
    get(service) {
      return undefined
    },
    logger: () => ({
      debug() {}, info() {}, warn() {}, error() {}, success() {},
    }),
    agents: { get: () => undefined },
    sessions: { list: () => [] },
    jobs: {
      attachController: () => () => {},
      start: (spec) => {
        ctx.__jobCount += 1
        return `dsh-relay-${ctx.__jobCount}` // 真实 dsh-jobs 返回 JobId（string）
      },
    },
    __listeners: listeners,
    __effects: effects,
    __jobCount: 0,
  }
  return ctx
}

const config = {
  enabled: false, // 冒烟测试不真连通道
  approvalTimeoutSecs: 600,
  questionTimeoutSecs: 1800,
  chunkMaxChars: 1200,
  mergeTimeoutSecs: 5,
  imessagePollSecs: 5,
  emailPollSecs: 20,
  statePath: join(dir, 'state.json'),
  channels: {
    imessage: { enabled: true, handle: '' }, // 未配置 → 不启动
    email: { enabled: false },
    wechat: { enabled: false },
  },
}

const ctx = fakeCtx()
apply(ctx, config)

// 1. 监听器已注册：approval/request 与 tools/execute 均为 prepend + global
const events = ctx.__listeners.map((l) => l.event)
assert.ok(events.includes('approval/request'), '应注册 approval/request 监听')
assert.ok(events.includes('tools/execute'), '应注册 tools/execute 监听')
assert.ok(events.includes('session/event'), '应注册 session/event 监听')
for (const l of ctx.__listeners) {
  if (l.event === 'approval/request' || l.event === 'tools/execute') {
    assert.equal(l.options.prepend, true, `${l.event} 必须 prepend`)
    assert.equal(l.options.global, true, `${l.event} 必须 global`)
  }
}

// 2. 未启用通道时不启动 job
assert.equal(ctx.__jobCount, 0)

// 3. 审批监听在"无活动通道"时直接 next()
const approvalListener = ctx.__listeners.find((l) => l.event === 'approval/request').fn
const req = {
  agent: { session: { id: 's1', events: [] } },
  toolName: 'bash',
  reason: 'test',
  signal: undefined,
}
approvalListener(req, async () => 'downstream').then((outcome) => {
  assert.equal(outcome, 'downstream', '无通道时应委托下游')
  console.log('✓ 审批监听无通道时委托下游')
})

// 4. 工具监听对非 ask_user_question 直接 next()
const toolListener = ctx.__listeners.find((l) => l.event === 'tools/execute').fn
toolListener({ name: 'bash', agent: { session: { id: 's1' } } }, async () => 'tool-result').then((out) => {
  assert.equal(out, 'tool-result')
  console.log('✓ 工具监听对普通工具直接放行')
})

// 5. 效果清理注册
assert.ok(ctx.__effects.length >= 1, '应注册清理效果')

// 6. 状态文件落盘
import { RelayStore } from './store.js'
const store = new RelayStore(join(dir, 'state.json'))
assert.equal(store.relayEnabled, false, '行配置 enabled:false 应写入默认开关')

rmSync(dir, { recursive: true, force: true })
console.log('\n冒烟测试全部通过')
