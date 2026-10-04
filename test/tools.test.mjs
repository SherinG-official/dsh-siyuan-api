/**
 * 工具端到端测试:真起一个 HTTP 假内核,走完整链路
 * (注册 → execute → 客户端 → 鉴权头 → 信封 → 渲染文本)。
 */

import { strict as assert } from 'node:assert'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { createSiYuanClient } from '../lib/client.js'
import { makeCtx, runTool, startFakeKernel } from './helpers.mjs'

/** 每个用例组共享一个假内核与一次 apply。 */
let kernel
let tools
let sections

before(async () => {
  kernel = await startFakeKernel()
  const made = makeCtx()
  tools = made.tools
  sections = made.sections
  apply(made.ctx, {
    apiUrl: kernel.url,
    token: kernel.token,
    defaultNotebook: '鸿蒙化学绘图软件',
    maxRows: 5,
    prompt: true,
    debug: false,
  })
})

after(async () => {
  await kernel.close()
})

/** 取一个工具并执行。 */
async function call(name, args) {
  const definition = tools.get(name)
  assert.ok(definition, `工具 ${name} 应已注册`)
  return runTool(definition, args)
}

test('apply 注册全部工具与系统提示词段落', () => {
  for (const name of ['siyuan_status', 'siyuan_notebooks', 'siyuan_search', 'siyuan_create_doc', 'siyuan_block']) {
    assert.ok(tools.has(name), `缺少工具 ${name}`)
  }
  const names = [...tools.keys()].sort()
  assert.deepEqual(names, ['siyuan_block', 'siyuan_create_doc', 'siyuan_notebooks', 'siyuan_search', 'siyuan_status'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-siyuan-api:guide')
  assert.equal(sections[0].order, 3000)
  const text = sections[0].text({ scope: undefined })
  assert.match(text, /siyuan_search/)
  assert.match(text, /思源/)
})

test('siyuan_status 报出版本、Token 状态与索引库规模', async () => {
  const result = await call('siyuan_status', {})
  assert.equal(result.ok, true)
  assert.match(result.message, /内核版本:3\.8\.6/)
  assert.match(result.message, /已配置\(tes\*\*\*\)/)
  assert.match(result.message, /可查询,共 4 个块/)
  assert.match(result.message, /块类型分布:/)
})

test('siyuan_notebooks 标出关闭状态', async () => {
  const result = await call('siyuan_notebooks', {})
  assert.equal(result.ok, true)
  assert.match(result.message, /3 个笔记本/)
  assert.match(result.message, /化学学习/)
  assert.match(result.message, /归档\n.*已关闭/m)
})

test('siyuan_search 关键词命中并给出处', async () => {
  const result = await call('siyuan_search', { query: '量子力学' })
  assert.equal(result.ok, true)
  assert.match(result.message, /第一章 量子力学基础/)
  assert.match(result.message, /化学学习/)
  assert.match(result.message, /id=20260811175622-5cowqoa/)
  assert.match(result.message, /更新 2026-08-11 21:39/)
})

test('siyuan_search 支持限定笔记本与 limit', async () => {
  const scoped = await call('siyuan_search', { query: '量子力学', notebook: '化学学习', limit: 1 })
  assert.equal(scoped.ok, true)
  assert.match(scoped.message, /范围:笔记本「化学学习」/)
  assert.equal((scoped.message.match(/id=/g) ?? []).length, 1)

  const other = await call('siyuan_search', { query: '量子力学', notebook: '鸿蒙化学绘图软件' })
  assert.equal(other.ok, true)
  assert.match(other.message, /没有匹配的笔记/)
})

test('siyuan_search 按名称匹配不到时给出可选笔记本清单', async () => {
  const result = await call('siyuan_search', { query: '量子', notebook: '不存在的本子' })
  assert.equal(result.ok, false)
  assert.match(result.message, /找不到名为「不存在的本子」的笔记本/)
  assert.match(result.message, /化学学习\(20260811175028-isqw6x5/)
})

test('siyuan_search 拒绝已关闭的笔记本', async () => {
  const result = await call('siyuan_search', { query: '量子', notebook: '归档' })
  assert.equal(result.ok, false)
  assert.match(result.message, /关闭状态/)
})

test('siyuan_search 支持名称子串匹配且歧义时报错', async () => {
  const substring = await call('siyuan_search', { query: '量子', notebook: '鸿蒙' })
  assert.equal(substring.ok, true)
  assert.match(substring.message, /范围|没有匹配/)

  const ambiguous = await call('siyuan_search', { query: '量子', notebook: '学' })
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.message, /匹配到多个笔记本/)
})

test('siyuan_search 空 query 直接拒绝', async () => {
  const result = await call('siyuan_search', { query: '   ' })
  assert.equal(result.ok, false)
  assert.match(result.message, /query 不能为空/)
})

test('siyuan_search sql 模式:自检 LIMIT、渲染表格、拒绝写操作', async () => {
  const auto = await call('siyuan_search', { mode: 'sql', query: 'SELECT id, type FROM blocks' })
  assert.equal(auto.ok, true)
  assert.match(auto.message, /id\s+\|\s+type/)
  assert.match(auto.message, /未写 LIMIT,已自动追加 LIMIT 5/)

  const write = await call('siyuan_search', { mode: 'sql', query: 'DELETE FROM blocks' })
  assert.equal(write.ok, false)
  assert.match(write.message, /只读/)
})

test('每次 SQL 都带 mode:"readonly"(内核只在 readonly 下才拦写操作)', async () => {
  const start = kernel.requests.length
  await call('siyuan_search', { mode: 'sql', query: 'SELECT id FROM blocks LIMIT 2' })
  await call('siyuan_search', { query: '量子' })
  const sqlCalls = kernel.requests.slice(start).filter((r) => r.path === '/api/query/sql')
  assert.ok(sqlCalls.length >= 2, '至少应有两次查询')
  for (const call of sqlCalls) {
    assert.equal(call.body.mode, 'readonly', `SQL 请求必须带 mode=readonly:${call.body.stmt}`)
  }
  // 关键词搜索也不该绕过:假内核在 mode 缺失时直接报错 unknown [mode],能走到这里说明两边都带了。
})

test('内核按 search.limit 截断时,把 truncated 转述给模型', async () => {
  // 未截断时不该出现 truncated 提示(避免误报)。
  const plain = await call('siyuan_search', { mode: 'sql', query: 'SELECT type, COUNT(*) AS n FROM blocks GROUP BY type' })
  assert.equal(plain.ok, true)
  assert.doesNotMatch(plain.message, /truncated/)

  // 直接验证查询层把内核的顶层 limit / truncated 带回来了。
  const { querySql } = await import('../lib/api.js')
  const client = createSiYuanClient({ apiUrl: kernel.url, token: kernel.token })
  const result = await querySql(client, 'SELECT id FROM blocks')
  assert.equal(result.truncated, false)
  assert.equal(result.kernelLimit, 64, '未写 LIMIT 时内核给的 limit 应透传')

  const withLimit = await querySql(client, 'SELECT id FROM blocks LIMIT 2')
  assert.equal(withLimit.kernelLimit, 0, '写了 LIMIT 时内核 limit 为 0')
})

test('写操作回包里的新块 ID 会被取出来', async () => {
  const { newBlockIdFromTransaction } = await import('../lib/api.js')
  const transaction = [
    {
      timestamp: 1,
      doOperations: [{ action: 'insert', id: '20260920000001-appended', parentID: 'x' }],
      undoOperations: null,
    },
  ]
  assert.equal(newBlockIdFromTransaction(transaction), '20260920000001-appended')
  assert.equal(newBlockIdFromTransaction([]), '')
  assert.equal(newBlockIdFromTransaction(null), '')

  // insertBlock 的优先级:nextID 优先于 previousID,且只传一个。
  const start = kernel.requests.length
  await call('siyuan_block', { id: '20260811213614-1kpwors', mode: 'insert', data: 'x', position: 'after', confirm: true })
  const sent = kernel.requests.slice(start).filter((r) => r.path === '/api/block/insertBlock').at(-1).body
  assert.equal(sent.nextID, '20260811213614-1kpwors')
  assert.equal('previousID' in sent, false)
})

test('siyuan_create_doc 用默认笔记本并按父文档拼路径', async () => {
  const flat = await call('siyuan_create_doc', { title: '测试笔记', markdown: '# 标题\n\n正文' })
  assert.equal(flat.ok, true)
  assert.match(flat.message, /已创建文档「测试笔记」/)
  assert.match(flat.message, /笔记本:鸿蒙化学绘图软件/)
  assert.match(flat.message, /路径:\/鸿蒙化学绘图软件\/测试笔记/)
  assert.match(flat.message, /文档 ID:2026092/)

  const child = await call('siyuan_create_doc', {
    notebook: '化学学习',
    title: '子文档',
    parentID: '20260811175622-5cowqoa',
  })
  assert.equal(child.ok, true)
  assert.match(child.message, /父文档:\/化学学习\/book\/物质结构导论\/第一章 量子力学基础/)
  assert.match(child.message, /路径:\/化学学习\/book\/物质结构导论\/第一章 量子力学基础\/子文档/)
})

test('siyuan_create_doc 校验标题与父文档', async () => {
  const emptyTitle = await call('siyuan_create_doc', { title: '  //  ' })
  assert.equal(emptyTitle.ok, false)
  assert.match(emptyTitle.message, /title 不能为空/)

  const badParent = await call('siyuan_create_doc', { title: 'x', parentID: 'not-an-id' })
  assert.equal(badParent.ok, false)
  assert.match(badParent.message, /不像思源块 ID/)

  const missingParent = await call('siyuan_create_doc', { title: 'x', parentID: '20260101000000-zzzzzzz' })
  assert.equal(missingParent.ok, false)
  assert.match(missingParent.message, /找不到 ID/)

  const notDoc = await call('siyuan_create_doc', { title: 'x', parentID: '20260811213614-1kpwors' })
  assert.equal(notDoc.ok, false)
  assert.match(notDoc.message, /不是文档/)

  const wrongBox = await call('siyuan_create_doc', {
    notebook: '鸿蒙化学绘图软件',
    title: 'x',
    parentID: '20260811175622-5cowqoa',
  })
  assert.equal(wrongBox.ok, false)
  assert.match(wrongBox.message, /不在笔记本/)
})

test('siyuan_create_doc 透传内核错误', async () => {
  kernel.queueCreateResult(200, { code: -1, msg: 'open notebook failed: notebook not found' })
  const result = await call('siyuan_create_doc', { notebook: '化学学习', title: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.message, /notebook not found/)
})

test('siyuan_block read 返回 Markdown、面包屑与属性', async () => {
  const result = await call('siyuan_block', { id: '20260811213614-1kpwors' })
  assert.equal(result.ok, true)
  assert.match(result.message, /块类型:段落/)
  assert.match(result.message, /文档 ID:20260811175622-5cowqoa/)
  assert.match(result.message, /位置:化学学习 \/ book \/ 物质结构导论 \/ 第一章 量子力学基础/)
  assert.match(result.message, /本章核心问题/)
  assert.match(result.message, /custom-tag: chemistry/)
})

test('siyuan_block read 对找不到的块给出可执行建议', async () => {
  const result = await call('siyuan_block', { id: '20260101000000-aaaaaaa' })
  assert.equal(result.ok, false)
  assert.match(result.message, /索引里找不到块/)
  assert.match(result.message, /siyuan_search/)
})

test('siyuan_block 校验 ID 形状', async () => {
  const result = await call('siyuan_block', { id: '123' })
  assert.equal(result.ok, false)
  assert.match(result.message, /不像思源块 ID/)
})

test('siyuan_block 写操作必须带 confirm', async () => {
  const result = await call('siyuan_block', { id: '20260811175622-5cowqoa', mode: 'append', data: '新内容' })
  assert.equal(result.ok, false)
  assert.match(result.message, /confirm=true/)

  const empty = await call('siyuan_block', { id: '20260811175622-5cowqoa', mode: 'append', data: '   ', confirm: true })
  assert.equal(empty.ok, false)
  assert.match(empty.message, /非空的 data/)
})

test('siyuan_block append / insert 成功路径', async () => {
  const before = kernel.requests.length
  const appended = await call('siyuan_block', {
    id: '20260811175622-5cowqoa',
    mode: 'append',
    data: '## 补充\n\n一段新内容',
    confirm: true,
  })
  assert.equal(appended.ok, true)
  assert.match(appended.message, /已把内容追加到 文档/)
  assert.match(appended.message, /新块 ID:20260920000001-appended/)
  assert.match(appended.message, /写入字符数:/)

  const insertBefore = await call('siyuan_block', {
    id: '20260811213614-1kpwors',
    mode: 'insert',
    data: '插在原块之前',
    position: 'before',
    confirm: true,
  })
  assert.equal(insertBefore.ok, true)
  assert.match(insertBefore.message, /的前面插入同级内容/)

  const insertAfter = await call('siyuan_block', {
    id: '20260811213614-1kpwors',
    mode: 'insert',
    data: '插在原块之后',
    position: 'after',
    confirm: true,
  })
  assert.equal(insertAfter.ok, true)
  assert.match(insertAfter.message, /的后面插入同级内容/)

  // 只统计本次调用产生的请求(不要 clear 全局列表,避免影响其它用例)。
  const inserts = kernel.requests
    .slice(before)
    .filter((r) => r.path === '/api/block/insertBlock')
    .map((r) => r.body)
  assert.equal(inserts.length, 2)
  assert.equal(inserts[0].previousID, '20260811213614-1kpwors')
  assert.equal(inserts[1].nextID, '20260811213614-1kpwors')
})

test('鉴权失败时不再重试,直接返回可读原因', async () => {
  const made = makeCtx()
  apply(made.ctx, { apiUrl: kernel.url, token: 'wrong-token', prompt: false })
  const result = await runTool(made.tools.get('siyuan_notebooks'), {})
  assert.equal(result.ok, false)
  assert.match(result.message, /Token|鉴权/)
})

test('思源未启动时给出排查清单', async () => {
  const made = makeCtx()
  apply(made.ctx, { apiUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 400 })
  const result = await runTool(made.tools.get('siyuan_status'), {})
  assert.equal(result.ok, true)
  assert.match(result.message, /连不上思源内核/)
  assert.match(result.message, /思源笔记已启动/)
})

test('prompt=false 时不注入系统提示词', () => {
  const made = makeCtx()
  apply(made.ctx, { apiUrl: kernel.url, token: kernel.token, prompt: false })
  assert.equal(made.sections.length, 0)
  assert.equal(made.tools.size, 5)
})
