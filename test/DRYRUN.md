# dsh-relay dry-run 覆盖矩阵（正向推演）

> dryrun-design skill v2：功能规格 → 测试设计技术 → 规模层 → 风险 → 断言 → 回归实证。

## 1. 功能规格清单

### 主流程（端到端）
- 审批诉求：approval/request 事件 → 拦截（prepend）→ 生成 #N 推送（iMessage/Email）→ 通道内「#N 批准/拒绝」→ 双轨结算（通道优先 vs 网页兜底）→ 回执
- 提问诉求：question → 推送 → 通道回复 → 注入会话（allowInjection）
- 通道接收：poll（iMessage chat.db / Email IMAP）→ 白名单过滤 → 派发 → 回执（回执发回来源会话）
- 命令系统：/enable、/disable、/bind、/sessions、/status、/relay

### 输入域
- 文本路由（routeText）：命令/chat/noop、语义兜底（LLM classify）
- 编号：pending/历史/外来（同通道其他 agent 的），迟到回复策略
- 通道配置：白名单（安全红线：仅显式身份、通配拒绝）、chatScope、ignorePrefixes、markRead

### 状态与生命周期
- 通道轮询：start/stop/重建（watchdog spawn）/旧 controller abort（runSeq 代际）
- 诉求注册表：allocNumber 跨天重置、timeout/restart 失效、pending 持久化恢复
- 合并窗口（.. / !! / 超时合并）按 通道:发送方 隔离

### 输出域与副作用
- 推送/回执发送：目标优先级（原会话 > 手机号 > 兜底）；buddy 形式（macOS 26 chat id 不可靠）
- 脱敏（redactSecrets）、自标记（D5HR42 防回灌）、分片（chunkMaxChars）、turnEndPush

### 安全约束
- **白名单是唯一准入**（涉及审批/敏感信息）；通配/全放行配置被守卫拒绝
- 注入仅显式绑定会话（不跟随最近活跃防跨对话污染）；裸文本注入默认关闭
- 会话列表向外暴露策略（pointer 默认）

### 外部依赖（→ env-check）
- TCC 完整磁盘访问（chat.db）、osascript 可达、buddy 可寻址、Messages 服务、
  watchdog 装配（watchdogConnected/channelPulse）、IMAP/SMTP 连通、iLink 登录

## 2. 测试设计表

| 功能规格 | 技术 | 规模 | 环境 | 影响×概率 | 断言 | 现状 |
|---|---|---|---|---|---|---|
| 文本路由 | 等价类+决策表 | Small | — | 高×高 | 命令/聊天/noop/语义兜底 | ✅ index.test.js |
| 审批双轨 | 决策表+状态 | Medium | — | **高**×高 | 通道优先/网页兜底/超时 | ✅ dryrun.test.js |
| 提问/回执 | 状态转换 | Medium | — | 高×高 | 回执兜底不静默/迟到回复 | ✅ dryrun.test.js |
| 白名单安全 | 等价类 | Small | — | **高**×高 | 通配拒绝/非白名单忽略 | ✅（含守卫）|
| 发送目标选择 | 决策表+状态 | Medium | — | **高**×高 | 原会话>手机号>兜底；buddy 优先 | ✅ dryrun（sendTargetOrder/buildSendAttempts）|
| 通道轮询竞态 | 状态转换+竞态 | Medium | — | **高**×高 | 重建无僵尸；abort 只终止自身 | ✅ imessage-poll.dryrun（回归实证 33db4b5）|
| 水位/去重 | 边界值 | Medium | — | 高×中 | ==floor 跳过/floor+1 补收/裁剪 | ✅ imessage-poll.dryrun |
| chat id 路由 | 决策表+组合 | Medium | — | **高**×高 | any;-;X 落错→buddy 形式 | ✅ normalize/extract 断言 |
| 脱敏 | 等价类 | Small | — | **高**×高 | sk-*/ghp_*/私钥块/普通文本 | ✅ index.test.js `secure: …` |
| 分片/合并 | 边界值 | Small | — | 中×中 | 短文本/分片/合并窗口 | ✅ index.test.js `chunk/merge` |
| 命令系统 | 决策表 | Medium | — | 中×高 | enable/disable/bind/sessions/status | ✅ dryrun.test.js |
| 状态持久化 | 状态转换 | Small | — | 中×中 | 编号跨天/重启恢复/去重表 | ✅ index.test.js + dryrun |
| watchdog 装配 | 运行时 | Large | 服务 | 高×高 | 回填后 beat 生效/注册 | ✅ env-check + 运行时观测 |
| iMessage 发送落点 | E2E | Large | 系统 | **高**×高 | 发送→落点=目标 | ✅ env-check `--send`（37539 实证）|
| TCC/osascript/buddy | env 探测 | Large | 权限 | 高×高 | 只读探测 | ✅ env-check 全过 |
| Email 通道（轮询） | 状态转换 | Large | 网络 | 高×中 | IMAP 收/发（真实） | ⚠️ email-preflight.mjs（预检）为部分覆盖 |
| WeChat 通道 | 状态转换 | Large | 网络 | 低×中 | iLink 登录/收 | ⏭ 未覆盖（默认禁用的通道，低风险）|
| LLM 语义兜底 | — | — | 模型 | 中×中 | classify | ⚠️ 未覆盖（依赖 LLM 服务——调用方契约）|

## 3. 质量检测（2026-08-25）

| 套件 | 结果 | c8 |
|---|---|---|
| 单元（路由/语义/编号/存储/脱敏/通道） | 23+ 项 ✅ | Stmts 60.4% / Branches **82.3%** |
| dry-run 集成（审批/提问//relay 命令） | 28 项 ✅ | Stmts 60.0% / Branches 61.7% |
| imessage poll dry-run（竞态回归） | 20 项 ✅（回归实证）| Stmts 69.0%（channels/**）|
| env-check 环境自检 | 10+ 项 ✅（含 --send 落点）| — |

**判读**：Stmts ~60-69% 中，**核心风险面（安全/审批/竞态/发送路由）已全部覆盖**；
未覆盖主要是 UI 层客户端、LLM 语义兜底（外部依赖）、WeChat（默认禁用）、Email 网络细节（部分预检）。

## 4. 回归实证记录

| 历史 Bug | 断言 | 实证 |
|---|---|---|
| 共享 running 布尔致僵尸循环 | 旧循环已退出（start settle）| 旧逻辑下失败 ✗ → 还原 ✅（33db4b5）|
| `send to chat id` 落错会话 | normalize/extract + `--send` 落点 | 37511/37539 落点实证（b8ee38c/3f5dc3b）|
| watchdog 未回填致 beat 空转 | watchdogConnected + pulse | 运行时观测（9ec0476）|

## 5. 源码清单
src/index.js、store.js、requests.js、router.js、approval.js、questions.js、chunk.js、merge.js、
secure.js、semantic.js、turnpush.js、channels/{imessage,email,wechat}.js
