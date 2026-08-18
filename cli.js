#!/usr/bin/env node
/**
 * dsh-relay 命令行工具：罗列未回复诉求与插件状态（只读，不连接运行时）。
 *
 * 用法：
 *   node cli.js              # 默认：罗列未回复诉求
 *   node cli.js status       # 状态总览（开关/通道/会话策略）
 *   node cli.js --json       # JSON 输出（脚本友好）
 *
 * 数据来源：$DSH_HOME/dsh-relay/{state.json,pending.json}（由宿主插件实时落盘）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIR = join(HOME, 'dsh-relay')

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function ago(ms) {
  if (ms < 60_000) return '刚刚'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function collect() {
  const state = readJson(join(DIR, 'state.json')) ?? {}
  const pendingFile = readJson(join(DIR, 'pending.json'))
  const pending = Array.isArray(pendingFile?.pending) ? pendingFile.pending : []
  const now = Date.now()
  return {
    relayEnabled: state.relayEnabled ?? state.relayEnabledDefault ?? true,
    allSessions: state.allSessions ?? true,
    channelEnabled: state.channelEnabled ?? {},
    updatedAt: pendingFile?.updatedAt,
    pending: pending.map((p) => ({
      number: p.number,
      kind: p.kind === 'question' ? '提问' : '审批',
      sessionId: p.sessionId ?? '',
      age: now - (p.createdAt ?? now),
      stale: Boolean(p.stale),
    })).sort((a, b) => a.number - b.number),
  }
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const command = args.find((a) => !a.startsWith('-')) ?? 'list'
const data = collect()

if (asJson) {
  console.log(JSON.stringify(data, null, 2))
  process.exit(0)
}

if (command === 'status') {
  console.log('dsh-relay 状态')
  console.log(`  总开关: ${data.relayEnabled ? '开启' : '关闭'}`)
  console.log(`  会话策略: ${data.allSessions ? '全部开启' : '按白名单'}`)
  console.log('  通道开关:')
  for (const id of ['imessage', 'email', 'wechat']) {
    console.log(`    ${id}: ${data.channelEnabled[id] === false ? '关闭' : '开启'}`)
  }
} else if (command === 'list' || command === '列表') {
  console.log('待回复诉求:')
  if (data.pending.length === 0) {
    console.log('  （无）')
  } else {
    for (const p of data.pending) {
      const extra = p.stale ? '（已随服务重启失效）' : `（${ago(p.age)}创建）`
      console.log(`  #${p.number} ${p.kind}  会话 ${p.sessionId || '?'}  ${extra}`)
    }
  }
} else {
  console.log('用法: node cli.js [list|status] [--json]')
  process.exit(1)
}
