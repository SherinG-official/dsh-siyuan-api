/**
 * `siyuan_search` —— 在思源里找内容。
 *
 * 两种模式:
 *   - `mode=keyword`(默认):对索引库 `blocks` 表做 `LIKE` 匹配,
 *     覆盖正文(content)、标题(name)、别名(alias)、备注(memo);
 *   - `mode=sql`:让模型自己写只读 SELECT,用于统计、按标签 / 时间 / 类型筛选等。
 *
 * 关键词模式之所以走 SQL 而不是 `/api/search/fullTextSearchBlock`:
 * 后者的参数面很大(k、method、types、paths、orderBy、groupBy…),而 `blocks`
 * 表的列名和语义稳定且在思源官方文档里公开,构造出来的语句可预测、可解释,
 * 模型看到报错也知道怎么改。真需要思源分词器的排序质量时,模型仍可用
 * `mode=sql` 自己拼(内核的 `mode:"readonly"` 一直由本插件带上)。
 *
 * @module dsh-siyuan-api/tools/search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { listNotebooks, querySql } from '../api.js'
import {
  blockTypeLabel,
  clip,
  docPathFromHPath,
  formatUpdated,
  notebookIndex,
  renderHits,
  renderRows,
} from '../format.js'
import { assertReadonlySql, ensureRowLimit, KNOWN_TABLES } from '../sql.js'
import { resolveNotebook } from './resolve.js'
import { fail, failFrom, ok, textOutput } from './shared.js'

/** `blocks` 表里我们关心的列。 */
const SEARCH_COLUMNS = 'id, root_id, box, path, hpath, name, content, markdown, type, subtype, updated'

/** 关键词搜索一次最多回头多少行(再按 limit 截断)。 */
const KEYWORD_FETCH_CAP = 200

/**
 * 写进工具描述的库表速查表。
 * 值取自思源 `kernel/sql/*.go` 的建表语句与实际索引数据,只列模型真正会用到的列。
 */
const SCHEMA_HINT =
  '可查的表(只读):\n' +
  'blocks(id, parent_id, root_id, box, path, hpath, name, alias, memo, tag, content, fcontent, markdown, length, type, subtype, ial, sort, created, updated) —— 主表;box=笔记本 ID,root_id=所属文档 ID,hpath=人类可读路径,content=纯文本,markdown=Markdown 源文,ial=块属性(如 tags/alias);\n' +
  'spans(id, block_id, root_id, box, path, content, markdown, type, ial) —— 行内元素(加粗、链接、标签等标记都在这里,blocks 里查不到);\n' +
  'attributes(id, name, value, type, block_id, root_id, box, path) —— 块属性明细,自定义属性形如 custom-*;\n' +
  'refs(id, def_block_id, def_block_root_id, def_block_path, block_id, root_id, box, path, content, markdown, type) —— 块引用(反向链接);\n' +
  'assets(id, block_id, root_id, box, docpath, path, name, title, hash) —— 资源文件;\n' +
  'file_annotation_refs(…) —— PDF 批注引用。\n' +
  'type 取值:d 文档、h 标题、p 段落、l 列表、i 列表项、b 引述、t/tb 表格、c 代码块、m 公式块、s 超级块、av 数据库;' +
  'subtype:标题为 h1..h6,列表 / 列表项为 u(无序)或 o(有序),其余为空。'

/**
 * 转义 LIKE 模式里的通配符,避免用户输入 `%` 时把整库扫出来。
 * @param {string} value
 * @returns {string}
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => '\\' + ch)
}

/**
 * 构造关键词查询。笔记本过滤用 `path LIKE '/<boxId>%'`,因为
 * `blocks.path` 是该笔记本内的文档路径(以 `/` 开头)。
 *
 * @param {string} keyword
 * @param {string} boxId
 * @param {number} fetchLimit
 * @returns {string}
 */
export function buildKeywordSql(keyword, boxId, fetchLimit) {
  const pattern = `'%${escapeLike(keyword)}%'`
  const where = [
    `(content LIKE ${pattern} ESCAPE '\\' OR name LIKE ${pattern} ESCAPE '\\' OR alias LIKE ${pattern} ESCAPE '\\' OR memo LIKE ${pattern} ESCAPE '\\')`,
  ]
  if (boxId !== '') where.push(`box = '${boxId.replace(/'/g, "''")}'`)
  return (
    `SELECT ${SEARCH_COLUMNS} FROM blocks WHERE ${where.join(' AND ')} ` +
    `ORDER BY CASE WHEN type = 'd' THEN 0 ELSE 1 END, updated DESC LIMIT ${fetchLimit}`
  )
}

/**
 * 把 SQL 行整理成命中条目。
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {Map<string, { name: string, closed: boolean }>} notebooks
 * @returns {Array<Record<string, unknown>>}
 */
function toHits(rows, notebooks) {
  return rows.map((row) => {
    const box = String(row.box ?? '')
    const notebookName = notebooks.get(box)?.name ?? ''
    const hpath = String(row.hpath ?? '')
    const docPath = docPathFromHPath(hpath, notebookName)
    const markdown = String(row.markdown ?? '').trim()
    const content = String(row.content ?? '').trim()
    return {
      id: String(row.id ?? ''),
      rootId: String(row.root_id ?? ''),
      box,
      notebook: notebookName,
      docPath,
      title: clip(content !== '' ? content : String(row.name ?? ''), 80),
      snippet: clip(markdown !== '' ? markdown : content, 300),
      blockType: String(row.type ?? ''),
      blockTypeLabel: blockTypeLabel(row.type, row.subtype),
      updated: String(row.updated ?? ''),
      updatedText: formatUpdated(row.updated),
    }
  })
}

/**
 * 注册 `siyuan_search`。
 *
 * @param {{ tools: { register: (definition: unknown) => unknown } }} ctx 插件上下文。
 * @param {{ client: import('../client.js').SiYuanClient, config: Record<string, any> }} deps
 */
export function registerSearchTool(ctx, deps) {
  const { client, config } = deps
  const maxRows = client.config.maxRows

  ctx.tools.register(
    defineTool({
      name: 'siyuan_search',
      description:
        '在思源笔记(SiYuan)里搜索内容。mode=keyword(默认)按关键词做模糊匹配,一次搜出正文 / 标题 / 别名 / 备注里的命中,返回块 ID、所属文档、笔记本、路径与片段;' +
        'mode=sql 执行一条只读 SELECT,用于统计、按标签 / 类型 / 时间 / 引用关系筛选等关键词搜不出来的问题。' +
        '只用它读数据,不会改动笔记;要用它定位到的 ID 去读全文或追加内容,请接着调 siyuan_block。\n' +
        SCHEMA_HINT,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description:
            'mode=keyword 时是要搜的关键词(中文 / 英文皆可,不分大小写,支持子串);mode=sql 时是完整的 SELECT 语句(不要写分号后的第二条语句)。',
        },
        mode: {
          type: 'string',
          enum: ['keyword', 'sql'],
          description:
            'keyword(默认):关键词模糊搜索,最省事;sql:自己写只读查询。只有在关键词搜不到、或需要聚合 / 过滤(COUNT、GROUP BY、按 type/subtype/ial 筛)时才用 sql。',
        },
        notebook: {
          type: 'string',
          description:
            '可选,把搜索限定在一个笔记本内,传笔记本名称或 ID(先用 siyuan_notebooks 查)。不传则搜全部笔记本。mode=sql 时忽略此项。',
        },
        limit: {
          type: 'integer',
          description: `可选,返回条数上限(1-${maxRows},默认 20)。命中很多时先用小 limit 看方向,再决定是否放大。`,
        },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: client.config.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const mode = args.mode === 'sql' ? 'sql' : 'keyword'
        const rawLimit = Number(args.limit)
        const limit = Number.isFinite(rawLimit) ? Math.min(maxRows, Math.max(1, Math.trunc(rawLimit))) : Math.min(20, maxRows)
        const query = String(args.query ?? '').trim()
        if (query === '') {
          return fail('query 不能为空:keyword 模式请给关键词,sql 模式请给 SELECT 语句。')
        }

        try {
          if (mode === 'sql') {
            return await runSql(query, limit, exec)
          }
          return await runKeyword(query, args.notebook, limit, exec)
        } catch (error) {
          return failFrom(error)
        }
      },
    }),
  )

  /**
   * 关键词搜索。
   * @param {string} keyword
   * @param {unknown} notebookArg
   * @param {number} limit
   * @param {{ signal: AbortSignal }} exec
   */
  async function runKeyword(keyword, notebookArg, limit, exec) {
    let boxId = ''
    let notebookNote = ''
    /** @type {Map<string, { name: string, closed: boolean }>} */
    let notebooks = new Map()

    const wanted = String(notebookArg ?? '').trim()
    if (wanted !== '') {
      const resolved = await resolveNotebook(client, { notebook: wanted, defaultNotebook: config.defaultNotebook }, { signal: exec.signal })
      if (!resolved.notebook) return fail(resolved.reason)
      boxId = resolved.notebook.id
      notebooks = notebookIndex(resolved.notebooks)
      notebookNote = `(范围:笔记本「${resolved.notebook.name}」)`
    } else {
      // 关键词模式不带 notebook 时仍要一次 lsNotebooks,把 box ID 翻成可读名称。
      const all = await listNotebooks(client, { signal: exec.signal })
      notebooks = notebookIndex(all)
    }

    const fetchLimit = Math.min(KEYWORD_FETCH_CAP, Math.max(limit * 3, limit))
    const { rows } = await querySql(client, buildKeywordSql(keyword, boxId, fetchLimit), { signal: exec.signal })
    const total = rows.length
    const hits = toHits(rows.slice(0, limit), notebooks)
    const message = renderHits(hits, { total, notebookNote })
    return ok(message === '' ? `没有找到包含「${keyword}」的内容。${notebookNote}` : message)
  }

  /**
   * 只读 SQL 模式。
   * @param {string} rawSql
   * @param {number} limit
   * @param {{ signal: AbortSignal }} exec
   */
  async function runSql(rawSql, limit, exec) {
    const statement = assertReadonlySql(rawSql)
    const { sql, appliedLimit } = ensureRowLimit(statement, Math.min(maxRows, limit))
    const { rows, columns, kernelLimit, truncated } = await querySql(client, sql, { signal: exec.signal })
    const table = renderRows(rows, columns)
    const notes = []
    if (appliedLimit !== null) notes.push(`语句未写 LIMIT,已自动追加 LIMIT ${appliedLimit};需要更多行请自己写 LIMIT。`)
    if (truncated) {
      notes.push(
        `内核按 search.limit=${kernelLimit ?? '?'} 截断了结果(响应里的 truncated 为 true),实际匹配行数更多:` +
          '请用 LIMIT / WHERE 收窄,或改用 COUNT(*) 先看规模。',
      )
    }
    return ok(`返回 ${rows.length} 行:\n\n${table}${notes.length === 0 ? '' : '\n(' + notes.join(' ') + ')'}`)
  }
}
