/**
 * 真实装载验证(可选,不属于单元测试)。
 *
 * 干三件事:
 *   1. 起一个假思源内核(和 test/helpers.mjs 同一个 fixture,但独立端口);
 *   2. 用 `dsh --profile <p> --patch verify-patch.yml <app> --port <n>` 真启动一个
 *      独立的 dsh 实例,把 dsh-siyuan-api 行指向假内核;
 *   3. 请求插件自己的诊断路由 `/dsh-siyuan-api/status`,确认插件真的被装载、
 *      工具真的注册进了宿主(而不是只在单测里能跑)。
 *
 * 用法(需要 dsh-siyuan-api 已装进目标 profile):
 *   node verify-boot.mjs [--profile web] [--port 19401] [--kernelPort 19406] [--dsh <bin.js 路径>]
 *
 * 环境变量:`DSH_HOME` 未设置时按当前用户主目录推导。
 * 输出只包含「工具名 / 是否可达 / 内核版本」,不打印 Token。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixture } from './test/helpers.mjs'
import { createServer } from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))

/** 解析 `--key value` 形式的命令行参数。 */
function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const profile = arg('profile', 'web')
const appPort = Number(arg('port', '19401'))
const kernelPort = Number(arg('kernelPort', '19406'))
const home = process.env.USERPROFILE ?? process.env.HOME ?? ''

/** dsh 命令的默认位置:全局 npm 安装优先,其次常见的自定义前缀。 */
function defaultDshEntry() {
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    join(home, '.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

const dshEntry = arg('dsh', defaultDshEntry())
const nodeBin = process.execPath
const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')

if (!existsSync(dshEntry)) {
  console.error(`找不到 dsh 入口:${dshEntry}(可用 --dsh <path> 指定)`)
  process.exit(2)
}
if (!existsSync(join(dshHome, 'profiles', profile, 'node_modules', 'dsh-siyuan-api'))) {
  console.error(`profile「${profile}」里还没装 dsh-siyuan-api。先跑:\n` + `  dsh plugin --profile ${profile} add <tgz 或包名>`)
  process.exit(2)
}

// ---- 1. 假内核 ----
const fixture = makeFixture()
const token = 'verify-token-' + Math.random().toString(36).slice(2, 10)
const ok = (data) => ({ code: 0, msg: '', data })
const kernel = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw)
    const route = String(req.url ?? '').split('?')[0]
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (route !== '/api/system/version' && req.headers.authorization !== `Token ${token}`) {
      reply(401, { code: -1, msg: 'Auth failed: 请检查 API token' })
      return
    }
    switch (route) {
      case '/api/system/version':
        reply(200, ok('3.8.6-verify'))
        return
      case '/api/notebook/lsNotebooks':
        reply(200, ok({ notebooks: fixture.notebooks }))
        return
      case '/api/query/sql':
        reply(200, ok([{ n: fixture.blocks.length }]))
        return
      default:
        reply(200, ok(null))
    }
  })
})
await new Promise((resolve) => kernel.listen(kernelPort, '127.0.0.1', resolve))
console.log(`[verify] 假内核已启动:http://127.0.0.1:${kernelPort}`)

// ---- 2. 启动 dsh ----
// 注意:web 是 `--profile web` 的别名,不能和父级 flag 混写
// (`dsh web --port x` 会被判成「web takes none of parent --profile …」),
// 所以这里用长形式,并把 web 自己的 flag 直接跟在后面。
const child = spawn(
  nodeBin,
  [dshEntry, '--profile', profile, '--patch', join(here, 'verify-patch.yml'), '--port', String(appPort), '--no-open'],
  {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME: dshHome, SIYUAN_VERIFY_URL: `http://127.0.0.1:${kernelPort}`, SIYUAN_VERIFY_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let log = ''
const record = (chunk) => {
  log += chunk
}
child.stdout.on('data', record)
child.stderr.on('data', record)

/**
 * 从 dsh 自己的启动输出里找真实监听地址与信任 token。
 * 只认 `dsh web: http://host:port/?token=…` 这一行 —— 插件 debug 日志里
 * 也会出现 `http://…/api`(假内核地址),按「第一个 http://」抓会抓错。
 * token 是浏览器信任栅栏要的,诊断路由同样需要带上。
 *
 * @returns {Promise<{ origin: string, token: string }>}
 */
async function discoverWebTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /dsh web:\s*(http:\/\/[0-9.]+:\d+)\/\?token=([\w-]+)/.exec(log)
    if (match) return { origin: match[1], token: match[2] }
    if (child.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return { origin: `http://127.0.0.1:${appPort}`, token: '' }
}

/** 轮询诊断路由,直到有响应或超时。 */
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      // 还没起来,继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

let exitCode = 1
try {
  const target = await discoverWebTarget(20_000)
  const url = `${target.origin}/dsh-siyuan-api/status?token=${target.token}`
  console.log(`[verify] 等待 ${target.origin}/dsh-siyuan-api/status …`)
  const status = await waitFor(url, 60_000)
  if (!status) {
    console.error('[verify] 诊断路由没有响应。dsh 输出如下:\n' + log.slice(-4000))
    exitCode = 1
  } else {
    console.log('[verify] 诊断路由返回:')
    console.log(JSON.stringify(status, null, 2))
    const expected = ['siyuan_status', 'siyuan_notebooks', 'siyuan_search', 'siyuan_create_doc', 'siyuan_block']
    const missing = expected.filter((name) => !status.tools?.includes(name))
    const good = status.ok === true && missing.length === 0 && status.kernel?.version === '3.8.6-verify'
    console.log(
      good
        ? '[verify] PASS:插件已装载,5 个工具注册完成,内核可达。'
        : `[verify] FAIL:missing=${missing.join(',') || '-'} reachable=${status.kernel?.reachable} version=${status.kernel?.version}`,
    )
    exitCode = good ? 0 : 1
  }
} finally {
  child.kill()
  await new Promise((resolve) => kernel.close(resolve))
  // 给子进程一点退出时间,避免残留监听端口。
  await new Promise((resolve) => setTimeout(resolve, 500))
  const leftover = log.match(/error|Error/gi)
  if (leftover) console.log(`[verify] dsh 日志中出现 ${leftover.length} 处 error 关键字(未必是问题,可对照上下文)。`)
}

process.exit(exitCode)
