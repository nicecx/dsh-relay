# 贡献指南（Contributing）

感谢你愿意帮忙！dsh-relay 的设计目标就是**可扩展的诉求中转框架**——除了内置的 iMessage / Email / 微信，我们希望社区补上更多通道。

## 当前最需要的贡献

| 任务 | 说明 | 难度 |
|---|---|---|
| **Telegram 通道** | 按通道契约接入 Bot API 长轮询（成熟参考：[LoserFox/telegram](https://github.com/LoserFox/telegram)） | 中等 |
| **飞书/Lark 通道** | 卡片审批/提问交互（成熟参考：[imetn/dsh-lark-bridge](https://github.com/imetn/dsh-lark-bridge)） | 中等 |
| **钉钉通道** | 参照 im-bridge 通道层契约接入 | 中等 |
| **更多平台 E2E 验证** | 在非 macOS 平台验证 iMessage/Email/微信，补充手动验收记录 | 简单 |
| **文档/示例** | 更好的安装示例、常见问题、故障排查 | 简单 |

通道契约见 [`src/channels/types.js`](src/channels/types.js)：实现 `configured/start/stop/send/isTrusted/status` 五个方法 + 用 `deps.pushInbound()` 上报入站，然后在 `src/index.js` 的 `channels` 列表注册即可。

## 提代码前必读

1. **测试是硬门槛**：运行 `npm test`，输出必须以 `全部测试套件通过 ✅` 结尾；
2. **测试输出贴进 PR 描述**（缺失会被打回）；
3. 新增/改动通道时，附**手动验收记录**（真实通道 E2E，清单见 [TESTING.md](TESTING.md)）或至少 dry-run 测试；
4. 现有测试都是回归锚点，**不可删除/弱化**（历史事故见 TESTING.md「历史修复」）。

## 流程

1. Fork 本仓库，建特性分支（`feat/telegram-channel` 之类）；
2. 实现 + 跑通测试；
3. 开 PR：描述改动、贴测试输出、标注手动验收情况；
4. 评审通过后合并。

## 讨论

- 想接新通道但不确定怎么做 → 开 issue 讨论；
- 发现 bug → 开 issue（附 `npm test` 输出与复现步骤）；
- 隐私红线：**个人真实信息（邮箱/手机号/会话 id/授权码）不得进入代码或测试数据**，一律用占位符。
