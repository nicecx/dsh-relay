/**
 * 纯逻辑单元测试（无依赖，直接 node 运行）：
 *   node src/index.test.js
 */
import { strict as assert } from 'node:assert'
import { routeText, routeTextLoose, cnNumber, findNumberToken } from './router.js'
import { parseAnswer, answerFor, normalizeQuestions, renderQuestionPrompt } from './answers.js'
import { RequestRegistry } from './requests.js'
import { RelayStore } from './store.js'
import { splitReply } from './chunk.js'
import { chatControl } from './merge.js'
import { redactSecrets, parseEmailAuth, emailAuthVerdict } from './secure.js'
import { extractFromAttributedBody, buildMarkReadSql } from './channels/imessage.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('✓', name)
}

// ---- router（严格层） ----
t('router: 批准 #N', () => assert.deepEqual(routeText('批准 #7'), { kind: 'approve', number: 7, word: '批准' }))
t('router: #N 批准', () => assert.deepEqual(routeText('#7 批准'), { kind: 'approve', number: 7, word: '批准' }))
t('router: #N 拒绝', () => assert.deepEqual(routeText('#3 拒绝'), { kind: 'reject', number: 3, word: '拒绝' }))
t('router: 拒绝 #12', () => assert.deepEqual(routeText('拒绝 #12'), { kind: 'reject', number: 12, word: '拒绝' }))
t('router: #N 自由回答', () => assert.deepEqual(routeText('#5 1,3'), { kind: 'answer', number: 5, text: '1,3' }))
t('router: 回复 #N 文本', () => assert.deepEqual(routeText('回复 #9 继续跑'), { kind: 'reply', number: 9, text: '继续跑' }))
t('router: 裸批准', () => assert.deepEqual(routeText('批准'), { kind: 'approve', number: undefined, word: '批准' }))
t('router: 开启/关闭', () => assert.equal(routeText('开启').kind, 'enable'))
t('router: 开启 微信', () => assert.deepEqual(routeText('开启 微信'), { kind: 'enableChannel', channel: 'wechat' }))
t('router: 关闭 邮件', () => assert.deepEqual(routeText('关闭 邮件'), { kind: 'disableChannel', channel: 'email' }))
t('router: 全部开启/关闭', () => assert.equal(routeText('全部关闭').kind, 'disableAll'))
t('router: /enable /disable', () => assert.deepEqual(routeText('/enable abc123'), { kind: 'enableSession', sessionId: 'abc123' }))
t('router: /bind /unbind /sessions', () => {
  assert.equal(routeText('/unbind').kind, 'unbind')
  assert.equal(routeText('/sessions').kind, 'sessions')
})
t('router: 普通文本', () => assert.deepEqual(routeText('帮我看下日志'), { kind: 'chat', text: '帮我看下日志' }))
t('router: #N 空内容不误判', () => assert.equal(routeText('#4').kind, 'noop'))

// ---- router（宽容语义层） ----
t('router: 中文数字', () => {
  assert.equal(cnNumber('三'), 3)
  assert.equal(cnNumber('十二'), 12)
  assert.equal(cnNumber('二十三'), 23)
  assert.equal(cnNumber('十'), 10)
})
t('router: 编号令牌提取', () => {
  assert.equal(findNumberToken('把3号批了'), 3)
  assert.equal(findNumberToken('同意第三个'), 3)
  assert.equal(findNumberToken('第12条拒绝'), 12)
  assert.equal(findNumberToken('帮我看下日志'), undefined)
})
t('router: 自然语言批准/拒绝', () => {
  assert.deepEqual(routeText('把3号批了'), { kind: 'approve', number: 3, word: '批了' })
  assert.deepEqual(routeText('同意第三个'), { kind: 'approve', number: 3, word: '同意' })
  assert.deepEqual(routeText('第2条不同意'), { kind: 'reject', number: 2, word: '不同意' })
  assert.equal(routeText('全部批准').kind, 'approveAll')
  assert.equal(routeText('都拒绝了').kind, 'rejectAll')
})
t('router: 自然语言回答/回复', () => {
  assert.deepEqual(routeText('3号选2'), { kind: 'answer', number: 3, text: '选2' })
  assert.deepEqual(routeText('告诉3号继续跑'), { kind: 'reply', number: 3, text: '继续跑' })
})
t('router: 语义状态/开关', () => {
  assert.equal(routeText('还有哪些没处理').kind, 'status')
  assert.equal(routeText('全部关掉').kind, 'disableAll')
  assert.equal(routeText('帮我开启').kind, 'enable')
})

// ---- answers ----
t('answers: 单题序号选择', () => {
  const qs = normalizeQuestions({ questions: [{ id: 'a', question: '继续？', options: [{ label: '是' }, { label: '否' }] }] })
  assert.deepEqual(parseAnswer(qs, '1'), [{ id: 'a', selected: ['是'] }])
  assert.deepEqual(parseAnswer(qs, '2'), [{ id: 'a', selected: ['否'] }])
})
t('answers: 单题 label 匹配', () => {
  const qs = normalizeQuestions({ questions: [{ id: 'a', question: '继续？', options: [{ label: '继续' }] }] })
  assert.deepEqual(parseAnswer(qs, '继续'), [{ id: 'a', selected: ['继续'] }])
})
t('answers: 自定义文本', () => {
  const qs = normalizeQuestions({ questions: [{ id: 'a', question: '意见？', options: [{ label: '无意见' }] }] })
  assert.deepEqual(parseAnswer(qs, '我觉得应该先做 A'), [{ id: 'a', selected: [], custom: '我觉得应该先做 A' }])
})
t('answers: 多选序号', () => {
  const qs = normalizeQuestions({ questions: [{ id: 'a', question: '选哪些', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] }] })
  assert.deepEqual(parseAnswer(qs, '1,3'), [{ id: 'a', selected: ['X', 'Z'] }])
})
t('answers: 单选收到多个取第一个', () => {
  const qs = normalizeQuestions({ questions: [{ id: 'a', question: '选', options: [{ label: 'X' }, { label: 'Y' }] }] })
  assert.deepEqual(parseAnswer(qs, '2 1'), [{ id: 'a', selected: ['Y'] }])
})
t('answers: 多问题 qid 前缀', () => {
  const qs = normalizeQuestions({ questions: [
    { id: 'q1', question: 'A？', options: [{ label: '甲' }, { label: '乙' }] },
    { id: 'q2', question: 'B？', options: [] },
  ] })
  const out = parseAnswer(qs, 'q1:2 ; q2:随便写点')
  assert.deepEqual(out, [
    { id: 'q1', selected: ['乙'] },
    { id: 'q2', selected: [], custom: '随便写点' },
  ])
})
t('answers: 多问题未答补空', () => {
  const qs = normalizeQuestions({ questions: [
    { id: 'q1', question: 'A？', options: [{ label: '甲' }] },
    { id: 'q2', question: 'B？', options: [] },
  ] })
  assert.deepEqual(parseAnswer(qs, '甲'), [
    { id: 'q1', selected: ['甲'] },
    { id: 'q2', selected: [] },
  ])
})
t('answers: 提问文案渲染', () => {
  const qs = normalizeQuestions({ questions: [{ id: 'a', question: '继续？', options: [{ label: '是' }] }] })
  const text = renderQuestionPrompt(3, qs, '测试会话', 600)
  assert.ok(text.includes('#3'))
  assert.ok(text.includes('1. 是'))
})

// ---- requests ----
t('requests: 编号注册与应答', async () => {
  const reg = new RequestRegistry()
  const p = reg.register({ number: 1, kind: 'approval', sessionId: 's1', timeoutMs: 5000 })
  assert.equal(reg.size, 1)
  assert.equal(reg.answer(1, 'allow'), 'ok')
  assert.equal(await p, 'allow')
  assert.equal(reg.size, 0)
})
t('requests: 超时返回 undefined', async () => {
  const reg = new RequestRegistry()
  const p = reg.register({ number: 2, kind: 'approval', sessionId: 's1', timeoutMs: 30 })
  assert.equal(await p, undefined)
})
t('requests: 会话提示在诉求结束后仍可查', () => {
  const reg = new RequestRegistry()
  reg.register({ number: 9, kind: 'question', sessionId: 's-xyz', timeoutMs: 5000 })
  assert.equal(reg.sessionOf(9), 's-xyz')
})
t('requests: 按类型列出 pending（不含 stale）', () => {
  const reg = new RequestRegistry()
  reg.register({ number: 3, kind: 'approval', sessionId: 's1', timeoutMs: 5000 })
  reg.register({ number: 4, kind: 'question', sessionId: 's1', timeoutMs: 5000 })
  reg.restore([{ number: 8, kind: 'approval', sessionId: 's1', createdAt: Date.now() - 1000 }])
  assert.deepEqual(reg.list('approval').map((e) => e.number), [3])
  assert.deepEqual(reg.list('question').map((e) => e.number), [4])
  assert.equal(reg.snapshot().length, 3) // 快照含 stale 供展示
})
t('requests: 重启恢复的诉求为 stale 且不可应答', () => {
  const reg = new RequestRegistry()
  reg.restore([{ number: 5, kind: 'approval', sessionId: 's1', createdAt: Date.now() - 5000 }])
  assert.equal(reg.isStale(5), true)
  assert.equal(reg.answer(5, 'allow'), 'stale')
  assert.equal(reg.size, 1)
  reg.dispose()
})
t('requests: 快照持久化回调（debounce 后写盘）', async () => {
  let persisted
  const reg = new RequestRegistry((snap) => { persisted = snap })
  reg.register({ number: 6, kind: 'approval', sessionId: 's1', timeoutMs: 5000 })
  await new Promise((r) => setTimeout(r, 650))
  assert.equal(persisted?.[0]?.number, 6)
  reg.dispose()
})

// ---- store ----
t('store: 会话启用策略（全部开启 + 单会话覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
  const s = new RelayStore(join(dir, 'state.json'))
  assert.equal(s.sessionEnabled('any'), true)
  s.setSessionEnabled('a', false)
  assert.equal(s.sessionEnabled('a'), false)
  assert.equal(s.sessionEnabled('b'), true)
  s.setAllSessions(false)
  s.clearSessionOverrides()
  assert.equal(s.sessionEnabled('b'), false)
  s.setRelayEnabled(false)
  assert.equal(s.sessionEnabled('b'), false)
  s.flush()
  rmSync(dir, { recursive: true, force: true })
})
t('store: 编号游标递增且持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
  const s = new RelayStore(join(dir, 'state.json'))
  assert.equal(s.allocNumber(), 1)
  assert.equal(s.allocNumber(), 2)
  s.flush()
  const s2 = new RelayStore(join(dir, 'state.json'))
  assert.equal(s2.allocNumber(), 3)
  rmSync(dir, { recursive: true, force: true })
})
t('store: 去重跨实例持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
  const path = join(dir, 'state.json')
  const s = new RelayStore(path)
  assert.equal(s.checkAndMark('email', 'uid:1'), false)
  assert.equal(s.checkAndMark('email', 'uid:1'), true)
  s.flush()
  const s2 = new RelayStore(path)
  assert.equal(s2.checkAndMark('email', 'uid:1'), true)
  rmSync(dir, { recursive: true, force: true })
})
t('store: 编号跨天重置（零点语义）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
  const s = new RelayStore(join(dir, 'state.json'))
  assert.equal(s.allocNumber(), 1)
  assert.equal(s.allocNumber(), 2)
  // 模拟昨天：把 numberDate 改写成昨天，编号应重置为 1
  const d = new Date(Date.now() - 24 * 3600 * 1000)
  const pad = (x) => String(x).padStart(2, '0')
  s.state.numberDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  s.state.nextRequestNumber = 42
  assert.equal(s.allocNumber(), 1)
  assert.equal(s.allocNumber(), 2)
  rmSync(dir, { recursive: true, force: true })
})

// ---- secure ----
t('secure: 令牌/私钥/凭据脱敏', () => {
  const out = redactSecrets('密钥 sk-abc1234567890123456789012 在这\ngithub: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')
  assert.ok(!out.includes('sk-abc'))
  assert.ok(!out.includes('ghp_ABCDEF'))
  assert.ok(out.includes('[已隐藏令牌]'))
})
t('secure: 私钥块脱敏', () => {
  const out = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAxyz\n-----END RSA PRIVATE KEY-----')
  assert.ok(out.includes('[已隐藏私钥]'))
})
t('secure: 普通文本不受影响', () => {
  assert.equal(redactSecrets('帮我看看这个函数的逻辑'), '帮我看看这个函数的逻辑')
})
t('secure: 邮件认证头解析', () => {
  const headers = { get: () => 'mx.example.com; spf=pass smtp.mailfrom=a.com; dkim=fail reason="bad"; dmarc=pass' }
  const auth = parseEmailAuth(headers)
  assert.equal(auth.spf, 'pass')
  assert.equal(auth.dkim, 'fail')
  assert.equal(emailAuthVerdict(auth), 'fail')
  assert.equal(emailAuthVerdict({ spf: 'pass' }), 'pass')
  assert.equal(emailAuthVerdict({}), 'unknown')
})

// ---- chunk / merge ----
t('chunk: 短文本不分段', () => assert.deepEqual(splitReply('hi', 100), ['hi']))
t('chunk: 长文本分段且前缀收敛', () => {
  const parts = splitReply('长'.repeat(3000), 1200)
  assert.ok(parts.length >= 3)
  assert.ok(parts[0].startsWith('（1/'))
  for (const p of parts) assert.ok([...p].length <= 1200)
})
t('merge: 续段/提交/忽略', () => {
  assert.deepEqual(chatControl('第一部分..'), { kind: 'continue', body: '第一部分' })
  assert.deepEqual(chatControl('说完了!!'), { kind: 'commit', body: '说完了' })
  assert.deepEqual(chatControl('..'), { kind: 'ignore', body: '' })
  assert.deepEqual(chatControl('普通'), { kind: 'pending', body: '普通' })
})


// ---- wechat：iLink 入站解析（移植自 dsh-im-bridge tests/ilink.spec.ts 的用例） ----
import { parseInbound, normalizeId } from './channels/wechat.js'

t('wechat: 宽松 id 归一化', () => {
  assert.equal(normalizeId(12345), '12345')
  assert.equal(normalizeId('abc'), 'abc')
  assert.equal(normalizeId({ id: 7 }), '7')
  assert.equal(normalizeId(undefined), undefined)
})
t('wechat: 文本消息解析', () => {
  const msg = parseInbound({ message_type: 1, from_user_id: 'u1', text: '状态', message_id: 'm1', context_token: 'tk' })
  assert.equal(msg.text, '状态')
  assert.equal(msg.fromUserId, 'u1')
  assert.equal(msg.contextToken, 'tk')
})
t('wechat: 非文本消息忽略', () => {
  assert.equal(parseInbound({ message_type: 2, from_user_id: 'u1', text: 'x' }), null)
  assert.equal(parseInbound({}), null)
})
t('wechat: item_list 拼接文本', () => {
  const msg = parseInbound({ message_type: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '批' } }, { type: 1, text_item: { text: '准' } }] })
  assert.equal(msg.text, '批准')
})

// ---- imessage：attributedBody 文本提取 ----
t('imessage: 提取 CJK 命令（测试123）', () => {
  const blob = Buffer.from('\u0004\u000bstreamtyped\u0001NSAttributedString\u0001测试123\u0001NSDictionary\u0001NSNumber', 'utf8')
  assert.equal(extractFromAttributedBody(blob), '测试123')
})
t('imessage: 提取「状态」', () => {
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001NSString\u0001状态\u0001NSNumber', 'utf8')), '状态')
})
t('imessage: 提取多段文本并拼接', () => {
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001还有哪些没处理\u0001', 'utf8')), '还有哪些没处理')
})
t('imessage: 纯英文指令兜底', () => {
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001approve\u0001', 'utf8')), 'approve')
})
t('imessage: 空 blob 返回空', () => {
  assert.equal(extractFromAttributedBody(undefined), '')
  assert.equal(extractFromAttributedBody(Buffer.alloc(0)), '')
})

t('imessage: 提取纯 ASCII 命令 /sessions', () => {
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001NSString\u0001/sessions\u0001NSNumber', 'utf8')), '/sessions')
})
t('imessage: 提取 /enable last', () => {
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001/enable last\u0001', 'utf8')), '/enable last')
})
t('imessage: 未知 ASCII 文本不提取（防类名误判）', () => {
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001NSAttributedString\u0001NSObject\u0001', 'utf8')), '')
})


t('router: 模糊语意-指定会话开关/绑定', () => {
  assert.deepEqual(routeText('打开cb200'), { kind: 'enableSession', sessionId: 'cb200' })
  assert.deepEqual(routeText('开启会话cb200'), { kind: 'enableSession', sessionId: 'cb200' })
  assert.deepEqual(routeText('把cb200对话打开'), { kind: 'enableSession', sessionId: 'cb200' })
  assert.deepEqual(routeText('关闭cb200对话'), { kind: 'disableSession', sessionId: 'cb200' })
  assert.deepEqual(routeText('关掉最近会话'), { kind: 'disableSession', sessionId: 'last' })
  assert.deepEqual(routeText('启用最近'), { kind: 'enableSession', sessionId: 'last' })
  assert.deepEqual(routeText('把那个对话关掉'), { kind: 'disableSession', sessionId: 'last' })
  assert.deepEqual(routeText('绑定当前对话'), { kind: 'bind', sessionId: 'last' })
  assert.equal(routeText('解绑').kind, 'unbind')
  assert.equal(routeText('取消绑定').kind, 'unbind')
})
t('router: 模糊语意-会话列表/通道不误判', () => {
  assert.equal(routeText('有哪些会话').kind, 'sessions')
  assert.equal(routeText('会话列表').kind, 'sessions')
  assert.deepEqual(routeText('打开 微信'), { kind: 'enableChannel', channel: 'wechat' })
  assert.deepEqual(routeText('开启 imessage'), { kind: 'enableChannel', channel: 'imessage' })
  assert.equal(routeText('打开').kind, 'enable')
  assert.deepEqual(routeText('帮我开启'), { kind: 'enable' })
})

// ---- 新增：水位/邮件处理/语义解析/提取增强 ----
import { processEmailMessage } from './channels/email.js'
import { parseClassification, looksRequestRelated } from './semantic.js'

t('store: seenRowids 解析（水位用）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
  const s = new RelayStore(join(dir, 'state.json'))
  s.checkAndMark('imessage', 'chatdb:100')
  s.checkAndMark('imessage', 'chatdb:101')
  s.checkAndMark('imessage', 'chatdb:Forks') // 历史垃圾键应被忽略
  assert.deepEqual(s.seenRowids('imessage'), [100, 101])
  rmSync(dir, { recursive: true, force: true })
})

t('email: 认证失败/严格模式拒绝、In-Reply-To 补编号', () => {
  const sentIds = new Map([['<msg-1@x>', 7]])
  // dkim fail → reject
  const fail = processEmailMessage({ uid: 1, parsed: { from: { value: [{ address: 'a@b.com' }] }, text: 'hi', headers: { get: () => 'spf=pass; dkim=fail' } }, cfg: {}, sentIds })
  assert.equal(fail.action, 'reject')
  // 无认证头 + strictAuth → reject
  const strict = processEmailMessage({ uid: 2, parsed: { from: { value: [{ address: 'a@b.com' }] }, text: 'hi', headers: { get: () => undefined } }, cfg: { strictAuth: true }, sentIds })
  assert.equal(strict.action, 'reject')
  // In-Reply-To 命中 → 自动补 #7
  const hit = processEmailMessage({ uid: 3, parsed: { from: { value: [{ address: 'a@b.com' }] }, text: '同意', headers: { get: () => undefined }, inReplyTo: '<MSG-1@x>' }, cfg: {}, sentIds })
  assert.equal(hit.action, 'push')
  assert.equal(hit.body, '#7 同意')
  // 正文已有编号 → 不重复补
  const dup = processEmailMessage({ uid: 4, parsed: { from: { value: [{ address: 'a@b.com' }] }, text: '#9 同意', headers: { get: () => undefined }, inReplyTo: '<msg-1@x>' }, cfg: {}, sentIds })
  assert.equal(dup.body, '#9 同意')
  // 空正文 → skip
  const empty = processEmailMessage({ uid: 5, parsed: { from: { value: [{ address: 'a@b.com' }] }, text: '  ' }, cfg: {}, sentIds })
  assert.equal(empty.action, 'skip')
})

t('imessage: emoji 与长 ASCII 正文提取', () => {
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001👍\u0001', 'utf8')), '👍')
  const longAscii = 'this is a fairly long plain english message body without any digits'
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001' + longAscii + '\u0001', 'utf8')), longAscii)
})

t('semantic: 分类输出解析（LLM 兜底可测）', () => {
  assert.deepEqual(parseClassification('{"action":"approve","number":3}'), { kind: 'approve', number: 3 })
  assert.deepEqual(parseClassification('{"action":"answer","number":2,"text":"1,3"}'), { kind: 'answer', number: 2, text: '1,3' })
  assert.equal(parseClassification('{"action":"hack"}'), undefined)      // 未知动作
  assert.equal(parseClassification('不是 JSON'), undefined)               // 垃圾输出
  assert.equal(parseClassification(undefined), undefined)
  assert.equal(looksRequestRelated('把那个批了', 1), true)
  assert.equal(looksRequestRelated('今天天气不错', 0), false)
})

t('store: 取消/结算不重置编号（已消耗，不重用）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-'))
  const s = new RelayStore(join(dir, 'state.json'))
  assert.equal(s.allocNumber(), 1) // #1 分配（即使之后被取消，游标也已前进）
  assert.equal(s.allocNumber(), 2) // 下一个诉求必然是 #2，绝不重用 #1
  rmSync(dir, { recursive: true, force: true })
})

t('imessage: 提取剥离 U+FFFD 污染（/sessions 不被注入）', () => {
  // 模拟真实 attributedBody：命令段尾带替换符/控制符
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001/sessions\ufffd\u0001', 'utf8')), '/sessions')
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001状态\ufffd\u0001', 'utf8')), '状态')
  assert.equal(extractFromAttributedBody(Buffer.from('\u0001/enable last\ufffd\u0001', 'utf8')), '/enable last')
})

t('router: 模糊语意-列出对话（会话/对话通用）', () => {
  assert.equal(routeText('列出当前所有对话').kind, 'sessions')
  assert.equal(routeText('所有对话').kind, 'sessions')
  assert.equal(routeText('有哪些对话').kind, 'sessions')
  assert.equal(routeText('列出全部对话').kind, 'sessions')
  assert.equal(routeText('当前对话').kind, 'chat') // 有歧义，不误判为列表
})

import { chatInScope } from './channels/imessage.js'

t('imessage: 通用会话范围 chatScope（空=全部，子串匹配）', () => {
  assert.equal(chatInScope('any;-;you@msn.com', ''), true)          // 空 scope = 全部
  assert.equal(chatInScope('any;-;you@msn.com', 'you@icloud.com'), false)
  assert.equal(chatInScope('any;-;you@icloud.com', 'you@icloud.com'), true)
  assert.equal(chatInScope('any;-;+8613800000000', '+8613800000000'), true)
  assert.equal(chatInScope('any;-;+8613800000000', '+86'), true)        // 前缀/子串
})

t('imessage: buildMarkReadSql 只含数字 ROWID 且去重', () => {
  const sql = buildMarkReadSql([12, '13', 12, 'abc', '', null, '14'])
  assert.ok(sql.startsWith('PRAGMA busy_timeout=5000;'), '带 busy_timeout')
  assert.ok(sql.includes('is_read = 1'), '置已读')
  assert.ok(sql.includes("(strftime('%s','now') + 978307200) * 1000000000"), 'Apple 纪元纳秒')
  assert.ok(sql.includes('WHERE ROWID IN (12, 13, 14)'), '只含合法且去重的 ROWID')
  assert.ok(!sql.includes('abc'), '非法值被过滤')
})

t('imessage: buildMarkReadSql 空输入返回空串（跳过执行）', () => {
  assert.equal(buildMarkReadSql([]), '')
  assert.equal(buildMarkReadSql(undefined), '')
  assert.equal(buildMarkReadSql(['x']), '')
})

console.log(`\n全部通过：${passed} 项`)
