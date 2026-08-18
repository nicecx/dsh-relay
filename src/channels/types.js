/**
 * Channel 适配器契约（其他 IM 按此接口接入：Telegram / 钉钉 / 飞书 / Slack …）。
 *
 * 每个适配器是一个工厂函数 createChannel(cfg, deps) 返回：
 * {
 *   id: string           // 通道 id（imessage/email/wechat/...）
 *   label: string        // 展示名
 *   configured(): boolean// 配置是否完备（不完备则不启动）
 *   async start(): void  // 建立连接并开始收消息循环（可阻塞）
 *   async stop(): void   // 停止并清理
 *   async send(text): void   // 推送到 owner
 *   isTrusted(senderId): boolean // 入站发送方鉴权（安全红线）
 *   status(): string     // /status 用的一行状态
 * }
 *
 * 入站统一走 deps.pushInbound({ channelId, senderId, messageId, text })。
 * deps.log 为 {info,warn,debug} 日志器；deps.signal 为 AbortSignal（stop 时触发）。
 */
export {}
