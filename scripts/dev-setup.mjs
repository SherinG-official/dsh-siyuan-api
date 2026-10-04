/**
 * 本地开发环境引导:把测试需要的两个宿主包放到 `node_modules` 下。
 *
 * 本仓库不提交 `node_modules`,但测试要能解析:
 *   - `@deepseek-ai/schemastery` —— npm 上有公开发布,直接装;
 *   - `@deepseek-ai/dsh-tools`   —— 每个 npm 版本都拖着一长串 `@deepseek-ai/dsh-*`
 *     peer 依赖,装它会把整棵 dsh 树拉下来。所以优先「链接本机 dsh 自带的真包」,
 *     找不到就退回复制 `test/stubs/dsh-tools` 里的替身。
 *
 * 用法:
 *   node scripts/dev-setup.mjs            # 自动挑选
 *   node scripts/dev-setup.mjs --stub     # 强制用替身
 *
 * 幂等:可以反复跑。两个包都就位后打印 OK。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const modulesDir = join(root, 'node_modules')
const scopeDir = join(modulesDir, '@deepseek-ai')
const forceStub = process.argv.includes('--stub')

/** 在几个常见位置找本机 dsh 自带的 dsh-tools。 */
function findHostDshTools() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools',
    join(home, '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools'),
  ]
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json'))) ?? null
}

/** 目录里是否已经有东西(用来判断「已就位」)。 */
function installed(path) {
  return existsSync(join(path, 'package.json'))
}

function main() {
  mkdirSync(scopeDir, { recursive: true })

  const schemastery = join(scopeDir, 'schemastery')
  if (installed(schemastery)) {
    console.log('· @deepseek-ai/schemastery 已存在')
  } else {
    console.log('! 缺少 @deepseek-ai/schemastery —— 测试会 import 失败,请先装:')
    console.log('    npm install --no-save @deepseek-ai/schemastery')
  }

  const target = join(scopeDir, 'dsh-tools')
  if (installed(target)) {
    console.log('· @deepseek-ai/dsh-tools 已存在')
  } else {
    const host = forceStub ? null : findHostDshTools()
    if (host) {
      try {
        // Windows 上 junction 不需要管理员权限;目录符号链接需要,所以用 'junction'。
        symlinkSync(host, target, process.platform === 'win32' ? 'junction' : 'dir')
        console.log(`· 已链接本机 dsh 自带的 dsh-tools -> ${host}`)
      } catch (error) {
        console.log(`! 链接失败(${error instanceof Error ? error.message : error}),改用替身`)
      }
    }
    if (!installed(target)) {
      cpSync(join(root, 'test/stubs/dsh-tools'), target, { recursive: true })
      console.log('· 已复制测试替身 test/stubs/dsh-tools -> node_modules/@deepseek-ai/dsh-tools')
    }
  }

  const missingPackages = readdirSync(scopeDir).filter((name) => !installed(join(scopeDir, name)))
  if (missingPackages.length === 0 && installed(schemastery) && installed(target)) {
    console.log('OK —— 现在可以跑:node --test "test/*.test.mjs"')
    return
  }
  process.exitCode = 1
}

main()
