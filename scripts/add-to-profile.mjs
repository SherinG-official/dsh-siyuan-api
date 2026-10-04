// 一次性脚本:把 dsh-siyuan-api 写进 desktop profile 的 package.json
// (dependencies + dsh.profile.bundles)。desktop profile 由 Electron 独占,
// CLI 的 `dsh plugin --profile desktop …` 被显式拒绝,所以这里直接改清单。
import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2]
const tarball = process.argv[3]
const name = 'dsh-siyuan-api'

const manifest = JSON.parse(readFileSync(target, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
manifest.dependencies ??= {}
manifest.dependencies[name] = `file:${tarball}`
writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
