// Launch smoke test for the embedded Funnel helper on the machine it runs on.
//
// Unit tests only prove every bin/<os>-<arch> file exists. This script proves
// the one for the current platform actually starts: it resolves the binary
// with the plugin's own bundledHelperCandidates() (the lookup that failed with
// ENOENT before 2026-08-27, when bin/ carried a single platform), runs it with
// no arguments, and requires the refusal the helper emits for a missing
// --origin, parsed by the plugin's own parseHelperEvent(). That path touches
// neither the network nor a Tailscale account, so it runs on any CI runner,
// yet it still exercises process start (exec format, loader, Go runtime init)
// and the stdout JSON contract the supervisor reads.
//
// CI runs it on one runner per supported platform (.github/workflows/ci.yml,
// helper-smoke). Locally:
//   npm run smoke:helper
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  bundledHelperCandidates,
  bundledHelperPlatformDir,
  parseHelperEvent,
} from '../src/remote-supervisor.ts'

// A healthy helper rejects the missing --origin before any I/O, so it exits
// within milliseconds; the timeout only guards against a hang.
const TIMEOUT_MS = 30_000
// helper/main.go: fail() emits {"phase":"error",...} and exits with status 1.
const EXPECTED_EXIT_CODE = 1
const EXPECTED_MESSAGE = 'origin must be an http://127.0.0.1 URL'

function fail(message: string): never {
  console.error(`helper 冒烟失败：${message}`)
  process.exit(1)
}

const platformDir = bundledHelperPlatformDir()
// Candidate 0 is the npm package layout, the one a normal install uses; the
// remaining candidates are fallbacks and must not mask a missing binary here.
const helper = bundledHelperCandidates()[0]
if (helper === undefined || !existsSync(helper)) {
  fail(`当前平台 ${platformDir} 缺少内置 helper（${helper ?? '无候选路径'}）`)
}

const child = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })

const timer = setTimeout(() => {
  child.kill()
  fail(`helper 在 ${TIMEOUT_MS / 1000} 秒内未退出（${platformDir}）`)
}, TIMEOUT_MS)

child.on('error', (error) => {
  clearTimeout(timer)
  fail(`helper 无法启动（${platformDir}，${error.message}）`)
})

child.on('close', (code, signal) => {
  clearTimeout(timer)
  if (code !== EXPECTED_EXIT_CODE) {
    fail(`退出码应为 ${EXPECTED_EXIT_CODE}，实际为 ${code ?? `信号 ${signal}`}（stderr: ${stderr.trim()}）`)
  }
  const firstLine = stdout.split('\n', 1)[0]?.trim() ?? ''
  const event = parseHelperEvent(firstLine)
  if (event === null) fail(`首行输出无法被插件解析（${firstLine}）`)
  if (event.phase !== 'error' || event.message !== EXPECTED_MESSAGE) {
    fail(`输出事件与预期不符（${JSON.stringify(event)}）`)
  }
  console.log(`helper 冒烟通过：${platformDir}，${helper}`)
})
