# dsh-relay

> 🚀 **欢迎贡献！** 本项目把"诉求中转"做成通用框架：**iMessage / Email / 微信 三个通道已端到端验收**，**Telegram / 飞书 / 钉钉 等待你来实现**——按 `src/channels/types.js` 的通道契约接入即可，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。所有贡献需通过测试套件（见 [TESTING.md](TESTING.md)）。

DSH（DeepSeek Harness）宿主级插件：**把需要你授权或提供开发建议的诉求，按编号推送到 iMessage / Email / 微信等可配置通道，在通道里直接批准、拒绝或回答；功能开关与启用范围也全部通过通道消息配置。** 跨会话共享（装在 profile 层，所有对话通用）。

架构基于成熟的 [dsh-im-bridge](https://github.com/BiBoyang/dsh-im-bridge)（MIT）扩展：通道层与桥接层分离、持久去重、长回复分段、`..`/`!!` 合并窗口均沿用其实现；编号审批应答参考 [dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)。并修正了上游在 web profile 中的两个关键问题：

- `approval/request` 监听以 `{ prepend: true }` 注册，排在网页答案器（api-proxy）之前——上游缺 prepend，在有浏览器的 web profile 里实际上拿不到审批；
- 提问（ask_user_question）走 `tools/execute` 拦截而非替换 `userQuestions` provider——与网页 UI 共存，超时/未启用时 `next()` 转回网页，两不冲突。

## 能力

| 方向 | 内容 |
|---|---|
| DSH → 通道 | ① 审批诉求（工具名 + 原因 + 会话）② 提问诉求（选项列表，可多选）③ 会话轮次结束（完成/出错/被阻塞 + 片段，自动脱敏） |
| 通道 → DSH | `#N 批准` / `#N 拒绝` 应答审批；`#N <选项序号或文本>` 回答提问；`回复 #N <文本>` 注入诉求所属会话；裸文本注入绑定会话。**支持自然语言**（见下） |
| 开关（通道内） | `开启` / `关闭`（总开关）、`开启 邮件` / `关闭 微信`（单通道）、`全部开启` / `全部关闭`（所有对话）、`/enable <会话id>` / `/disable <会话id>`（单会话）、`/sessions` 列出会话 |
| 编号 | 每个诉求分配全局递增编号 `#N`，**每天零点自动重置**；诉求并发不冲突，回复必须带编号（仅 1 条待审批时允许裸「批准」） |
| 罗列待办 | ① 通道内发「还有哪些没处理」② 网页输入 `/relay` ③ 命令行 `node cli.js`（见下） |

## 语义理解回复

除了严格语法，普通自然语言也能执行（确定性规则 + LLM 兜底双保险，拿不准的文本一律按普通消息注入，绝不误执行）：

- 「把 3 号批了」「同意第三个」「第2条不同意」→ 批准/拒绝对应诉求
- 「全部批准」「都拒绝」→ 批量应答所有待审批
- 「3号选2」「第三个：是」→ 回答对应提问
- 「告诉 3 号 继续跑测试」→ 文本注入该诉求所属会话
- 「还有哪些没处理」→ 罗列待办；「全部关掉」→ 全部会话停用
- 中文数字（三/十二/二十三…）与「第N个/条/项」均识别
- 规则层解析不了的疑似指令（含数字或指代词「刚才那个」），会调用默认模型做一次结构化分类；LLM 不可用/超时自动回退为普通消息

## 命令行罗列未回复诉求

```bash
node ~/.dsh/plugins/dsh-relay/cli.js          # 罗列待回复诉求
node ~/.dsh/plugins/dsh-relay/cli.js status   # 状态总览
node ~/.dsh/plugins/dsh-relay/cli.js --json   # JSON 输出（脚本友好）
```

数据来自 `~/.dsh/dsh-relay/pending.json`（插件实时落盘），只读、不连接运行时。
网页内等价命令：`/relay`、`/relay status`、`/relay sessions`。

## 安装

**方式 A：从 git 安装（推荐，可获取更新）**

```bash
dsh plugin --profile web add https://github.com/<owner>/dsh-relay
# 或把 "dsh-relay": "github:<owner>/dsh-relay" 加入 profile package.json 的
# dependencies，并把 "dsh-relay" 加进 dsh.profile.bundles，然后 pnpm install
```

**方式 B：本地目录链接（开发/试用）**

```bash
dsh plugin --profile web add link:$HOME/.dsh/plugins/dsh-relay
# 或等价地：编辑 profile package.json 的 dependencies 加
#   "dsh-relay": "link:/Users/<you>/.dsh/plugins/dsh-relay"
# 并把 "dsh-relay" 加进 dsh.profile.bundles，然后 pnpm install
```

重启 DSH 生效。运行测试：`npm test`（详见 [TESTING.md](TESTING.md)）。

## 配置（个人信息只放机器本地，绝不进 git）

> **行 config 是整体替换语义**：profile patch 里同 id 的 `config` 会完全替换
> 插件自带占位配置（插件的 `cordis.patch.yml` 里 handle 等一律留空占位）。

把个人配置写进 **profile 的本地补丁文件**
`~/.dsh/profiles/<name>/cordis.patch.yml`（机器本地文件，不属于本插件仓库）：

```yaml
- id: dsh-relay
  name: 'dsh-relay'
  config:
    enabled: true            # 初始总开关（之后用通道命令切换，状态落盘）
    approvalTimeoutSecs: 600 # 审批等待通道答复，超时转回网页 UI
    questionTimeoutSecs: 1800
    channels:
      imessage:
        enabled: true
        handle: '<你的手机号或 Apple ID 邮箱>'   # 仅该地址可驱动
        extraHandles: []                        # 其他可信回复地址（手机号+邮箱同时用）
      email:
        enabled: false
        from: 'you@example.com'
        to: 'you@example.com'
        imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'you@example.com', passRef: 'DSH_RELAY_EMAIL_PASS' }
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'you@example.com', passRef: 'DSH_RELAY_EMAIL_PASS' }
        # passRef 指向 ~/.dsh/.credentials.yaml 中的键（或同名环境变量），不落明文；
        # 也可不用 passRef，直接写 pass: '授权码'
      wechat:
        enabled: false        # iLink 扫码登录；个人微信自动化有风控风险，默认关闭
```

改完重启 DSH 生效（profile patch 文件被 watch，config 修改会自动热更新，
但首次安装本插件必须先重启一次）。

### 隐私 / Git 安全

- 个人配置：**只**写 profile 本地 `cordis.patch.yml`（机器本地，见上）；
- 本仓库（插件目录）不含任何个人信息：`handle` 一律空占位、README 全部用示例值；
- 运行状态 `~/.dsh/dsh-relay/state.json`、凭据 `~/.dsh/.credentials.yaml`、
  profile 补丁 `~/.dsh/profiles/` 都在仓库之外；
- 上传 git 前检查：`grep -rn "<你的手机号>|<你的邮箱>" . --exclude-dir=node_modules`
  应为空；`.gitignore` 已排除 `node_modules/`、`*.log`、`.DS_Store`。

### iMessage 通道权限（macOS，一次授权）

1. **自动化**：首次发送时系统弹窗，允许宿主进程控制 Messages.app；
2. **完全磁盘访问**：macOS 26 已移除 Messages 的 message 类 AppleScript，收信走
   `~/Library/Messages/chat.db` 轮询（`sqlite3 -readonly`）。请在
   *系统设置 → 隐私与安全性 → 完全磁盘访问* 中加入运行 DSH 的进程。
   若 DSH 由 launchd 托管，加它的 node 可执行文件（日志会打印
   `process.execPath` 的实际路径，例如 `/Users/<you>/.hermes/node/bin/node`；
   添加时用 `Cmd+Shift+G` 粘贴路径）。授权后无需重启，轮询会自动恢复。

> 若 chat.db 不可读，插件日志会提示；此时 iMessage 通道只能发不能收。

## 使用

1. 先给 DSH 跑任务（本机可先不发消息；首次使用建议从手机给本机发一条 iMessage，便于自动定位会话）。
2. 有诉求时手机会收到：

   ```
   🔐 #3 需要批准
   会话: 修复登录页（sess-abc123）
   工具: bash
   原因: 执行 rm -rf 需要你的确认
   回复「#3 批准」或「#3 拒绝」
   （10 分钟内未回复将转回网页）
   ```

3. 回复 `#3 批准` → 本机放行；回复 `关闭` → 插件整体停用；`全部关闭` → 不再推送任何会话。

## 安全

**防篡改 / 防内网信息外泄（纵深防御）**：

- 每个通道独立**发送方白名单**：iMessage 仅 `handle`/`extraHandles`，Email 仅 `from`/`to`/`allowedFrom`，微信仅扫码白名单用户；非白名单消息一律忽略并告警；
- **Email 身份认证强制**：解析 `Authentication-Results`（SPF/DKIM/DMARC），任一 `fail` 直接拒绝；`email.strictAuth: true` 时连无认证头的邮件也拒绝（防伪造发件人）；
- 通道命令是**固定白名单**（批准/拒绝/回答/开关/罗列），没有任何"执行 shell / 读文件 / 改配置"类命令；
- 通道文本只能注入会话流（`source.kind = 'plugin'`），且注入时附带**安全护栏提示**（不得外发密钥/令牌/凭据，不得改仓库配置，高危操作照常走审批）——模型的危险动作仍受 DSH 审批栈约束；
- 审批应答必须对应真实 pending 编号，超时/撤销/重启后失效（stale 不可应答）；
- **外发脱敏**：推送的轮次片段自动抹除常见密钥/令牌/私钥/凭据赋值（`security.redactSecrets`）；
- 一键收紧：`security.allowInjection: false` 时通道**只能批准/拒绝/回答**，完全禁止文本注入；
- iMessage 收信强制 `is_from_me = 0`，不会把插件自己的推送当命令回灌。

## 会话列表的通道隔离

`/sessions`（及模糊说法）在**通道内**默认只回复数量与指引，**不暴露会话 id/标题**
（共享通道上其他机器人可见，属轻度信息泄露；`sessionsInChannel` 可配 `full`/`silent`）。
完整列表只在两处：
- **网页**：输入框执行 `/relay sessions`（命令面板输出，不进通道）；
- **命令行**：`node cli.js status` / `node cli.js list`。

## 环境假设与已知限制

- **iMessage 通道仅 macOS**（依赖 Messages.app 与 `~/Library/Messages/chat.db`；macOS 26 需"完全磁盘访问"授权收信）；
- **Email 通道需真实 IMAP/SMTP 凭据**验收（代码完成，未在真实邮箱联调过）；发件人认证强制 SPF/DKIM/DMARC；
- **同通道多机器人共存**：本插件用 `ignorePrefixes`（默认 `【`）排除其他机器人消息，换环境请按需配置；
- **停机期间到达的消息会在重启后补收**（水位=最后处理 rowid），首次安装跳过既有历史；
- 微信通道默认禁用（iLink 个人微信自动化有风控风险）；Telegram/飞书为预留接口。

## 接入新通道

实现 `src/channels/types.js` 描述的契约（`configured/start/stop/send/isTrusted/status`），
在 `src/index.js` 的 `channels` 列表注册即可。**优先移植成熟实现**：
Telegram → [LoserFox/telegram](https://github.com/LoserFox/telegram)（Bot API 长轮询）、
飞书 → [imetn/dsh-lark-bridge](https://github.com/imetn/dsh-lark-bridge)、
微信 → [dsh-im-bridge](https://github.com/BiBoyang/dsh-im-bridge) 的 iLink 客户端（本项目已移植）。
通道成熟度与实现来源矩阵见 [TESTING.md](TESTING.md)。

## 通道健康监控（推荐搭配）

dsh-relay 的通道轮询已委托给 **[dsh-task-watchdog](https://github.com/nicecx/dsh-task-watchdog)**（通用任务健康监控插件）：
- 每个通道登记为 `ctx.jobs` 任务并接入 watchdog，轮询循环上报心跳；
- 心跳停滞/启动卡死 → watchdog 自动抓**根因诊断快照**（进程状态/心跳/最近日志）→ 自动重启通道；
- 区分**主动停止**（你通过命令关闭通道 → 不重启不告警）与**意外停滞**（崩溃 → 诊断+重启）；
- 提供**事件流**（`watchdog.onEvent`），可对接任意通讯方式查看/审计 watchdog 的处理过程。

> **推荐**：任何 DSH 插件有长轮询/后台任务的，都建议接入 dsh-task-watchdog（`ctx.jobs.start` 建任务 → `watchdog.monitor` + 循环里 `beat`），获得同样的监控/诊断/自愈能力。dsh-relay 本身不再内置 watchdog 逻辑（单一职责）。

安装 watchdog：见 [dsh-task-watchdog README](https://github.com/nicecx/dsh-task-watchdog)。

## 测试与贡献

```bash
npm test    # 统一运行器：69 单元 + 27 dry-run + 冒烟，全部通过 ✅ 才算过
```

测试用例全集、手动验收清单（M1–M16）、通道成熟度矩阵、贡献流程见 **[TESTING.md](TESTING.md)**。

**贡献者必读（提交代码前）：**
1. 运行 `npm test`，**输出必须以 `全部测试套件通过 ✅` 结尾**；
2. 把完整测试输出**贴进 PR 描述**（这是通过评审的凭证，缺失会被打回）；
3. 若新增/改动通道，附上对应的**手动验收记录**（真实通道 E2E，见 TESTING.md 清单），或至少给出 dry-run 测试；
4. 改动/新增通道必须附带通过输出，否则不予合并。

## 开发

```bash
cd ~/.dsh/plugins/dsh-relay
pnpm install
npm test
node cli.js list    # 命令行罗列待回复诉求
```

## 致谢

- [dsh-im-bridge](https://github.com/BiBoyang/dsh-im-bridge)（MIT）：iLink 协议客户端、桥接循环、去重/分段/合并、状态存储
- [dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)：编号审批交互范式
- [dsh-lark-bridge](https://github.com/imetn/dsh-lark-bridge)：凭据引用（credentials）用法参考

## License

MIT
