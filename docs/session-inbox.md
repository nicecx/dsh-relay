# dsh-relay session-inbox 实施说明

> 设计文档：`~/Documents/Workspace/dsh-relay/docs/review-20260902-020.md`（v3.2，评审 022/023/024/025）
> 协议文档：`~/.dsh/session-inbox/PROTOCOL.md`（权威）
> 实施日期：2026-09-03（v3.2 = 025 三项修复落地）

## 025 修复记录（v3.2，2026-09-03）

1. **audit.jsonl 误扫描/误归档**（已复现缺陷）：inboxTick 文件过滤原为 `*.jsonl` 通配命中
   audit.jsonl → 每 tick 从 0 全量读 + 超限被 rename 归档（审计链断裂）。修复：过滤排除
   `AUDIT_FILE`；补用例（3 次 tick 后 audit.jsonl 原名保留、无水位杂物、无 archived）。
2. **归档重建截断窗口**：tail 空分支原用 `writeFileSync(path,'')`（flag w 截断）——跨进程
   窗口内并发 append 已建文件会被截断。修复：重建一律 `appendFileSync`（O_APPEND|O_CREAT
   永不截断）；补 tail 空归档用例。跨进程安全以单实例为前提（文档 §1 已注明）。
3. **护栏文案**：投递帧不再沿用 GUARDRAIL_PREFIX（"远程通道 iMessage/Email/微信"文案），
   改用会话间专用 `INBOX_GUARDRAIL`（约束条目一致，来源表述为另一 DSH 会话）。

## 变更文件

| 文件 | 变更 |
|---|---|
| `src/inbox.js` | **新增**。inbox 服务模块：`normalizeSessionId` / `scanSessionRegistry`（磁盘扫描持久化注册表）/ `createInboxService`（send 分级校验、水位读写、增量读、归档迁移） |
| `src/index.js` | **修改**。import inbox 模块；inject 增加 `tools`（Cordis 4 双写 `apply.inject`）；DEFAULTS 增 `inboxEnabled/inboxPollSecs/inboxMaxBytes`；apply 内注册 `session_send` 工具 + `dsh-relay-inbox` 轮询 job（宿主 job 机制，无裸定时器）+ `inboxTick` 投递循环（testHooks 导出） |
| `test/inbox.test.mjs` | **新增**。T1-T9 + 注册表扫描用例（`node --test test/inbox.test.mjs`，10/10 通过） |
| `src/apply.smoke.js` | **修改**。冒烟配置 `inboxEnabled: false`（inbox 行为由 inbox.test.mjs 独立覆盖） |
| `~/.dsh/session-inbox/PROTOCOL.md` | **新增**。协议文档（运行目录） |

## 实现要点（与 v3 设计的两处精化）

1. **水位统一为字节 offset**：v3 文档第 2 节"只投递 `id > lastReadId` 的消息"与第 7 节
   "字节偏移增量读"并存。实现统一为 **offset 水位**（uuid 无序，id 比较不可靠）：
   `lastRead.json = {lastReadId, ts, offset}`，`lastReadId` 仅作审计参考，投递判定只按 offset。
   归档后 offset 归 0（迁移行从 0 重读）。
2. **归档迁移**：归档 = ①读未投递尾部（water.offset..size）②rename →
   `<sid>.jsonl.archived-<ts>`（原子）③重建文件先落迁移行（append O_CREAT，append 永有落点）
   ④水位归 0。全程同步段：同一进程内与 send 的 appendFileSync 不交错（单线程事件循环），
   跨进程/线程安全由 O_APPEND 保证（T9 覆盖归档前后 append 不丢行）。

## 投递帧（M4）

role:user 普通消息帧，`GUARDRAIL_PREFIX` 护栏 + 来源标注：
`[会话间消息｜<kind>｜来自 <from>]\n<text>（回复关联 <ref>）`。
收方 agent 视为普通用户消息，自行判断执行——无命令语义。

## 测试

```bash
cd ~/.dsh/plugins/dsh-relay
node --test test/inbox.test.mjs   # T1-T9 + registry（10/10）
node --test src/apply.smoke.js src/dryrun.test.js src/index.test.js  # 既有 3 套件回归（全绿）
```

## 配置（DEFAULTS 兜底，无需改 cordis.patch.yml）

- `inboxEnabled: true` —— 总开关
- `inboxPollSecs: 5` —— 轮询周期（宿主 job，无裸定时器，004 一致）
- `inboxMaxBytes: 1048576` —— 单 inbox 归档阈值
- `inboxHome` —— 可选覆盖 home（默认 `$DSH_HOME`）

## 部署注意

插件代码改动需 **DSH 网关重启** 后生效（cordis 插件装载）。重启经 reset-handoff 通道
由外部 ops agent 执行（禁止本会话直接重启 DSH）。
