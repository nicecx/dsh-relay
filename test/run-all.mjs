#!/usr/bin/env node
/**
 * dsh-relay 统一测试运行器：依次执行全部测试套件，任一失败即非零退出。
 * 供 CI / 贡献者一键验证：  node test/run-all.mjs   （或 npm test）
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// macOS 专属套件（TCC/osascript/chat.db/iMessage）仅在 darwin 运行——
// CI（ubuntu）跑它们必失败（历史 fail 通知源：08-29 起每次 push 的 test workflow failure）
const isMac = process.platform === 'darwin'
const suites = [
  ['单元测试（路由/语义/编号/存储/脱敏/通道解析）', 'src/index.test.js'],
  ['dry-run 集成（审批/提问//relay 命令）', 'src/dryrun.test.js'],
  ['apply 冒烟（插件装载/监听注册）', 'src/apply.smoke.js'],
  ...(isMac
    ? [
        ['imessage poll dry-run（真实 chat.db 只读 + 重建竞态）', 'test/imessage-poll.dryrun.mjs'],
        ['环境自检（只读：TCC/osascript/buddy/活性；--send 才真实发送）', 'test/env-check.mjs'],
      ]
    : []),
]

let failed = 0
for (const [label, file] of suites) {
  process.stdout.write(`\n=== ${label} ===\n`)
  const res = spawnSync(process.execPath, [join(root, file)], { stdio: 'inherit', cwd: root })
  if (res.status !== 0) {
    console.error(`❌ ${file} 失败（exit=${res.status}）`)
    failed += 1
  } else {
    console.log(`✅ ${file} 通过`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个套件失败`)
  process.exit(1)
}
console.log('\n全部测试套件通过 ✅')
