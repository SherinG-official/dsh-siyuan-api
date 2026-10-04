/**
 * 测试替身:一个「够像思源」的假内核 + 一个最小 cordis 上下文。
 *
 * 假内核实现了本插件真正会用到的那些端点,并且刻意复刻内核的响应约定:
 *   - 统一信封 `{ code, msg, data }`;
 *   - `data.notebooks` 这类命名包装;
 *   - 鉴权失败走 HTTP 401 + 非 0 code;
 *   - 笔记本不存在 / 路径重复时 `code: -1` 带中文 msg。
 * 这样测的是「插件对不对」,而不是「我 mock 得顺不顺手」。
 *
 * @module dsh-siyuan-api/test/helpers
 */

import { createServer } from 'node:http'

/**
 * 造一个内存版思源索引库。
 * @returns {{ blocks: Array<Record<string, unknown>>, notebooks: Array<Record<string, unknown>> }}
 */
export function makeFixture() {
  const notebooks = [
    { id: '20260811175028-isqw6x5', name: '化学学习', closed: false, encrypted: false, sort: 0 },
    { id: '20260919125932-lkhz1ad', name: '鸿蒙化学绘图软件', closed: false, encrypted: false, sort: 1 },
    { id: '20260101000000-closed1', name: '归档', closed: true, encrypted: false, sort: 2 },
  ]
  const blocks = [
    {
      id: '20260811175622-5cowqoa',
      parent_id: '20260811213907-29vzv0a',
      root_id: '20260811175622-5cowqoa',
      box: '20260811175028-isqw6x5',
      path: '/20260811175132-1qxjm8l/20260811213907-29vzv0a/20260811175622-5cowqoa.sy',
      hpath: '/化学学习/book/物质结构导论/第一章 量子力学基础',
      name: '',
      alias: '',
      memo: '',
      content: '第一章 量子力学基础',
      markdown: '# 第一章 量子力学基础',
      type: 'd',
      subtype: '',
      created: '20260811175622',
      updated: '20260811213929',
    },
    {
      id: '20260811213614-1kpwors',
      parent_id: '20260811213614-w7xzrh9',
      root_id: '20260811175622-5cowqoa',
      box: '20260811175028-isqw6x5',
      path: '/20260811175132-1qxjm8l/20260811213907-29vzv0a/20260811175622-5cowqoa.sy',
      hpath: '/化学学习/book/物质结构导论/第一章 量子力学基础',
      name: '',
      alias: '',
      memo: '',
      content: '经典物理学为什么无法描述微观世界？量子力学是如何建立起来的？',
      markdown: '**本章核心问题：** 经典物理学为什么无法描述微观世界？量子力学是如何建立起来的？',
      type: 'p',
      subtype: '',
      created: '20260811213614',
      updated: '20260811213614',
    },
    {
      id: '20260811213614-4rmp195',
      parent_id: '20260811175622-5cowqoa',
      root_id: '20260811175622-5cowqoa',
      box: '20260811175028-isqw6x5',
      path: '/20260811175132-1qxjm8l/20260811213907-29vzv0a/20260811175622-5cowqoa.sy',
      hpath: '/化学学习/book/物质结构导论/第一章 量子力学基础',
      name: '',
      alias: '',
      memo: '',
      content: '1.1 波函数与概率密度',
      markdown: '## 1.1 波函数与概率密度',
      type: 'h',
      subtype: 'h2',
      created: '20260811213614',
      updated: '20260811213614',
    },
    {
      id: '20260919135122-lw63vfz',
      parent_id: '',
      root_id: '20260919135122-lw63vfz',
      box: '20260919125932-lkhz1ad',
      path: '/20260919135122-lw63vfz.sy',
      hpath: '/鸿蒙化学绘图软件/V1',
      name: '',
      alias: '',
      memo: '',
      content: 'V1',
      markdown: '',
      type: 'd',
      subtype: '',
      created: '20260919135122',
      updated: '20260919222057',
    },
  ]
  return { blocks, notebooks }
}

/** 从 LIKE 模式里粗略还原出关键词(测试里够用)。 */
function likeToKeyword(pattern) {
  return String(pattern).replace(/^%/, '').replace(/%$/, '').replace(/\\(.)/g, '$1')
}

/**
 * 按 SELECT 列表裁剪列,模拟真 SQLite 的投影行为。
 * 这样测试能真的验证「列名拼错了会被发现」,而不是被 mock 兜住。
 * @param {string} stmt
 * @param {Array<Record<string, unknown>>} rows
 */
function projectColumns(stmt, rows) {
  const listMatch = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s/i.exec(stmt.trim())
  if (!listMatch || listMatch[1].trim() === '*') return rows
  const columns = listMatch[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const aliased = /^([\w.]+)\s+AS\s+(\w+)$/i.exec(part)
      if (aliased) return { source: aliased[1], out: aliased[2] }
      const bare = /^([\w.]+)$/.exec(part)
      if (bare) return { source: bare[1], out: bare[1] }
      return null
    })
  if (columns.some((c) => c === null)) return rows
  return rows.map((row) => {
    const out = {}
    for (const column of columns) {
      out[column.out] = row[column.source]
    }
    return out
  })
}

/**
 * 起一个假内核。
 *
 * @param {{ token?: string, fixture?: ReturnType<typeof makeFixture> }} [options]
 * @returns {Promise<{ url: string, token: string, fixture: ReturnType<typeof makeFixture>, requests: Array<{ path: string, body: any, auth: string | undefined }>, close: () => Promise<void> }>}
 */
export async function startFakeKernel(options = {}) {
  const token = options.token ?? 'test-token-123456'
  const fixture = options.fixture ?? makeFixture()
  /** @type {Array<{ path: string, body: any, auth: string | undefined }>} */
  const requests = []
  const createQueue = []

  const ok = (data) => ({ code: 0, msg: '', data })
  const bad = (msg) => ({ code: -1, msg, data: null })

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = {}
      try {
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        body = {}
      }
      const auth = req.headers.authorization
      requests.push({ path: String(req.url ?? ''), body, auth })
      // 真内核带查询串也在同一路由上,这里按路径匹配。
      const route = String(req.url ?? '').split('?')[0]

      const reply = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      // 鉴权:/api/system/version 免鉴权(和真内核一致),其余都要 Token。
      if (route !== '/api/system/version' && auth !== `Token ${token}`) {
        reply(401, { code: -1, msg: 'Auth failed: 请检查 API token' })
        return
      }

      switch (route) {
        case '/api/system/version':
          reply(200, ok('3.8.6'))
          return
        case '/api/notebook/lsNotebooks':
          reply(200, ok({ notebooks: fixture.notebooks }))
          return
        case '/api/query/sql': {
          const stmt = String(body.stmt ?? '')
          // 真内核:只有 mode=readonly 才做「单条 + 只读」校验;默认 mode 不拦写操作。
          // 假内核照样实现,这样「插件有没有带上 mode」这件事真的会被测出来。
          if (body.mode !== 'readonly') {
            reply(200, bad('unknown [mode]'))
            return
          }
          if (!/^\s*(SELECT|WITH)/i.test(stmt)) {
            reply(200, bad('SQL statement is not a read-only query'))
            return
          }
          if (/;\s*\S/.test(stmt)) {
            reply(200, bad('SQL statement is not single'))
            return
          }
          const limitMatch = /LIMIT\s+(\d+)\s*$/i.exec(stmt)
          const explicitLimit = limitMatch ? Number(limitMatch[1]) : null
          const limit = explicitLimit ?? 64 // 内核 search.limit 默认 64
          let rows
          if (/COUNT\(\*\)/i.test(stmt)) {
            rows = [{ n: fixture.blocks.length }]
          } else if (/GROUP BY\s+type/i.test(stmt)) {
            const counts = new Map()
            for (const b of fixture.blocks) counts.set(b.type, (counts.get(b.type) ?? 0) + 1)
            rows = [...counts].map(([type, n]) => ({ type, n }))
          } else {
            const likePatterns = [...stmt.matchAll(/(?:content|name|alias|memo)\s+LIKE\s+'((?:[^'\\]|\\.)*)'/gi)].map((m) => m[1])
            const boxMatch = /box\s*=\s*'([^']*)'/.exec(stmt)
            const idMatch = /id\s*=\s*'([^']*)'/.exec(stmt)
            const keywords = likePatterns.map(likeToKeyword)
            rows = fixture.blocks.filter((b) => {
              if (boxMatch && b.box !== boxMatch[1]) return false
              if (idMatch && b.id !== idMatch[1]) return false
              if (keywords.length === 0) return true
              const haystack = [b.content, b.name, b.alias, b.memo].join('\n')
              return keywords.some((k) => haystack.includes(k))
            })
            if (/^\s*SELECT\s+hpath\s+FROM\s+blocks/i.test(stmt.trim())) rows = rows.map((b) => ({ hpath: b.hpath }))
            else rows = projectColumns(stmt, rows)
          }
          // 真内核会带上顶层 limit / truncated:显式 LIMIT 时 limit 为 0,截断时 truncated 为 true。
          const truncated = rows.length > limit
          reply(200, {
            code: 0,
            msg: '',
            data: rows.slice(0, limit),
            limit: explicitLimit === null ? limit : 0,
            truncated,
          })
          return
        }
        case '/api/filetree/getHPathByID': {
          const block = fixture.blocks.find((b) => b.id === body.id)
          reply(200, block ? ok({ notebook: block.box, path: block.path, hPath: block.hpath }) : bad('not found'))
          return
        }
        case '/api/filetree/createDocWithMd': {
          if (createQueue.length > 0) {
            const next = createQueue.shift()
            reply(next.status ?? 200, next.payload)
            return
          }
          const notebook = fixture.notebooks.find((n) => n.id === body.notebook)
          if (!notebook) {
            reply(200, bad(`open notebook failed: notebook not found [${String(body.notebook)}]`))
            return
          }
          if (notebook.closed) {
            reply(200, bad(`notebook is closed [${notebook.name}]`))
            return
          }
          const path = String(body.path ?? '')
          const id = `20260920000000-new${String(fixture.blocks.length).padStart(4, '0')}`.slice(0, 22)
          const parent = body.parentID ? fixture.blocks.find((b) => b.id === body.parentID) : null
          const hpath = parent ? `${String(parent.hpath).replace(/\/+$/, '')}/${path.split('/').pop()}` : `/${notebook.name}/${path.replace(/^\//, '')}`
          fixture.blocks.push({
            id,
            parent_id: body.parentID ?? '',
            root_id: id,
            box: notebook.id,
            path: `/${id}.sy`,
            hpath,
            name: '',
            alias: '',
            memo: '',
            content: path.split('/').pop(),
            markdown: String(body.markdown ?? ''),
            type: 'd',
            subtype: '',
            created: '20260920000000',
            updated: '20260920000000',
          })
          reply(200, ok(id))
          return
        }
        case '/api/block/getBlockKramdown': {
          const block = fixture.blocks.find((b) => b.id === body.id)
          reply(200, block ? ok({ id: block.id, kramdown: block.markdown }) : ok({ id: body.id, kramdown: '' }))
          return
        }
        case '/api/block/getBlockAttrs': {
          const block = fixture.blocks.find((b) => b.id === body.id)
          reply(200, block ? ok({ id: block.id, updated: block.updated, 'custom-tag': 'chemistry' }) : ok({}))
          return
        }
        case '/api/block/getBlockBreadcrumb': {
          const block = fixture.blocks.find((b) => b.id === body.id)
          if (!block) {
            reply(200, ok([]))
            return
          }
          const parts = String(block.hpath).split('/').filter((s) => s !== '')
          reply(200, ok(parts.map((name) => ({ id: 'x', name, type: 'd', subType: '' }))))
          return
        }
        case '/api/block/appendBlock': {
          fixture.blocks.push({
            id: '20260920000001-appended',
            parent_id: body.parentID,
            root_id: body.parentID,
            box: '20260811175028-isqw6x5',
            path: '/x.sy',
            hpath: '/x',
            name: '',
            alias: '',
            memo: '',
            content: String(body.data ?? ''),
            markdown: String(body.data ?? ''),
            type: 'p',
            subtype: '',
            created: '20260920000001',
            updated: '20260920000001',
          })
          reply(200, ok([{ doOperations: [{ action: 'insert', id: '20260920000001-appended' }] }]))
          return
        }
        case '/api/block/insertBlock': {
          if (!body.previousID && !body.nextID) {
            reply(200, bad('insertBlock requires previousID or nextID'))
            return
          }
          reply(200, ok([{ doOperations: [{ action: 'insert', id: '20260920000002-inserted' }] }]))
          return
        }
        default:
          reply(404, { code: -1, msg: 'not found' })
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    fixture,
    requests,
    /** 让下一次 createDocWithMd 返回指定响应(测异常分支用)。 */
    queueCreateResult(status, payload) {
      createQueue.push({ status, payload })
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * 最小 cordis 上下文:只实现本插件用到的 `tools.register` 与 `systemPrompt.section`。
 * @returns {{ ctx: any, tools: Map<string, any>, sections: Array<any> }}
 */
export function makeCtx() {
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {Array<any>} */
  const sections = []
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(toolName) {
        return tools.get(toolName)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      getSectionOrder() {
        return 3000
      },
    },
  }
  return { ctx, tools, sections }
}

/**
 * 直接调用一个已注册工具的 execute,返回规范化结果。
 * @param {any} definition
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal }} [exec]
 * @returns {Promise<any>}
 */
export async function runTool(definition, args, exec = {}) {
  const signal = exec.signal ?? new AbortController().signal
  return definition.execute(args, { signal, callId: 'test', arguments: args })
}
