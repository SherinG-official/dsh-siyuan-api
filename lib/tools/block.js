/**
 * `siyuan_block` —— 按块 ID 读 / 写内容。
 *
 * 三种模式:
 *   - `read`  : 读一块的 Markdown 原文(文档 ID 就是整篇文档),附带面包屑与块属性;
 *   - `append`: 往某块内部追加内容(文档 ID 追加到文末,列表项追加为子项);
 *   - `insert`: 在某块的紧邻前 / 后插入同级内容。
 *
 * 写操作要求显式传 `confirm: true`。模型在没读清楚目标块之前就落笔,
 * 是这类桥接插件最容易出的错,加一道「你得先确认」比事后回滚便宜。
 *
 * @module dsh-siyuan-api/tools/block
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendBlock, getBlockAttrs, getBlockBreadcrumb, getBlockKramdown, insertBlock, querySql } from '../api.js'
import { blockTypeLabel, clip, formatUpdated } from '../format.js'
import { fail, failFrom, looksLikeId, ok, textOutput } from './shared.js'

/** read 模式默认返回的 Markdown 字符上限。 */
const READ_CHAR_LIMIT = 8000

/** SQL 字符串字面量转义。 */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 取出块的基础信息(来自索引库)。读不到返回 null。
 *
 * @param {import('../client.js').SiYuanClient} client
 * @param {string} id
 * @param {{ signal: AbortSignal }} exec
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function loadBlockRow(client, id, exec) {
  const { rows } = await querySql(
    client,
    `SELECT id, parent_id, root_id, box, path, hpath, name, content, type, subtype, created, updated ` +
      `FROM blocks WHERE id = ${quote(id)} LIMIT 1`,
    { signal: exec.signal },
  )
  return rows[0] ?? null
}

/**
 * 注册 `siyuan_block`。
 *
 * @param {{ tools: { register: (definition: unknown) => unknown } }} ctx 插件上下文。
 * @param {{ client: import('../client.js').SiYuanClient, config: Record<string, any> }} deps
 */
export function registerBlockTool(ctx, deps) {
  const { client } = deps

  ctx.tools.register(
    defineTool({
      name: 'siyuan_block',
      description:
        '按块 ID 读写思源笔记(SiYuan)的内容。mode=read 读出一块的 Markdown 原文(传文档 ID 得到整篇文档),适合在搜索命中后展开细读;' +
        'mode=append 往某块内部追加内容,传文档 ID 则追加到文档末尾;mode=insert 在某块的紧邻前 / 后插入同级块。' +
        '块 ID 来自 siyuan_search 或 siyuan_create_doc 的结果。append / insert 是写操作,必须显式传 confirm=true。',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: '目标块 ID(22 位,形如 20260919135122-lw63vfz)。文档的 ID 同时也是文档根块的 ID。',
        },
        mode: {
          type: 'string',
          enum: ['read', 'append', 'insert'],
          description: 'read(默认):读取;append:追加为子块;insert:在前后插入同级块。',
        },
        data: {
          type: 'string',
          description: 'append / insert 要写入的内容。dataType=markdown(默认)时是标准 Markdown;dataType=dom 时是思源块 DOM 片段。',
        },
        dataType: {
          type: 'string',
          enum: ['markdown', 'dom'],
          description: '写入内容的格式,默认 markdown。只有需要插入思源专有结构(如挂件、数据库块)时才用 dom。',
        },
        position: {
          type: 'string',
          enum: ['before', 'after'],
          description: 'mode=insert 时的插入位置:before 插到目标块之前(默认),after 插到之后。',
        },
        confirm: {
          type: 'boolean',
          description: '写操作确认位。append / insert 必须传 true;传 false 或省略会直接拒绝执行。',
        },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: client.config.timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const id = String(args.id ?? '').trim()
        if (id === '') return fail('id 不能为空。')
        if (!looksLikeId(id)) return fail(`id「${id}」不像思源块 ID(应为 22 位,形如 20260919135122-lw63vfz)。`)

        const mode = args.mode === 'append' ? 'append' : args.mode === 'insert' ? 'insert' : 'read'

        try {
          if (mode === 'read') return await runRead(id, exec)
          if (args.confirm !== true) {
            return fail(
              `mode=${mode} 是写操作,需要显式传 confirm=true 才会执行。` +
                '请先用 mode=read 确认目标块内容与位置,再带着 confirm=true 重试。',
            )
          }
          const data = typeof args.data === 'string' ? args.data : ''
          if (data.trim() === '') return fail(`mode=${mode} 需要非空的 data(要写入的 Markdown 或 DOM)。`)
          const dataType = args.dataType === 'dom' ? 'dom' : 'markdown'
          return await runWrite(id, mode, data, dataType, args.position === 'after' ? 'after' : 'before', exec)
        } catch (error) {
          return failFrom(error)
        }
      },
    }),
  )

  /**
   * 读一块。
   * @param {string} id
   * @param {{ signal: AbortSignal }} exec
   */
  async function runRead(id, exec) {
    const row = await loadBlockRow(client, id, exec)
    if (!row) {
      return fail(`索引里找不到块 ${id}。可能已被删除,或 ID 抄错了 —— 请用 siyuan_search 重新取一次 ID。`)
    }

    const [kramdownResult, breadcrumbResult] = await Promise.allSettled([
      getBlockKramdown(client, id, { signal: exec.signal }),
      getBlockBreadcrumb(client, id, { signal: exec.signal }),
    ])
    const markdown = kramdownResult.status === 'fulfilled' ? kramdownResult.value.kramdown : ''
    const breadcrumb = breadcrumbResult.status === 'fulfilled' ? breadcrumbResult.value : ''

    let attrs = {}
    try {
      attrs = await getBlockAttrs(client, id, { signal: exec.signal })
    } catch {
      // 属性读不到不影响正文阅读。
    }

    const type = String(row.type ?? '')
    const label = blockTypeLabel(type, row.subtype)
    const header = [
      `块类型:${label}${String(row.subtype ?? '') === '' ? '' : `(type=${type}, subtype=${String(row.subtype)})`}`,
      `文档 ID:${String(row.root_id ?? '')}`,
      `笔记本:${String(row.box ?? '')}`,
      `路径:${String(row.hpath ?? '')}`,
      `更新:${formatUpdated(row.updated)}`,
    ]
    if (breadcrumb !== '') header.push(`位置:${breadcrumb}`)
    if (type === 'd') header.push('(这是文档根块,下面正文即整篇文档内容)')

    const attrKeys = Object.keys(attrs).filter((k) => k !== 'id' && k !== 'updated')
    const attrText = attrKeys.length === 0 ? '' : `\n\n块属性:\n${attrKeys.map((k) => `- ${k}: ${clip(attrs[k], 120)}`).join('\n')}`

    const body = markdown.trim()
    const truncated = body.length > READ_CHAR_LIMIT
    const markdownText =
      body === ''
        ? '(该块没有 Markdown 内容,可能是空段落或纯容器块)'
        : truncated
          ? `${body.slice(0, READ_CHAR_LIMIT)}\n\n…(已截断,原文共 ${body.length} 字符。需要后续内容请读它的子块,或用 mode=insert / append 精确改一小段。)`
          : body

    return ok(`${header.join('\n')}${attrText}\n\n--- Markdown ---\n${markdownText}`)
  }

  /**
   * 写一块。
   * @param {string} id
   * @param {'append' | 'insert'} mode
   * @param {string} data
   * @param {'markdown' | 'dom'} dataType
   * @param {'before' | 'after'} position
   * @param {{ signal: AbortSignal }} exec
   */
  async function runWrite(id, mode, data, dataType, position, exec) {
    const row = await loadBlockRow(client, id, exec)
    if (!row) {
      return fail(`索引里找不到块 ${id},不会写入。请用 siyuan_search 重新确认目标块。`)
    }
    const where = `${blockTypeLabel(row.type, row.subtype)} ${id}(${String(row.hpath ?? '')})`

    if (mode === 'append') {
      const newId = await appendBlock(client, { parentID: id, data, dataType }, { signal: exec.signal })
      return ok(
        `已把内容追加到 ${where} 内部。\n` +
          `写入字符数:${data.length} | 格式:${dataType}` +
          (newId === '' ? '' : `\n新块 ID:${newId}`) +
          `\n提示:要核对结果可就地调 siyuan_block(mode=read, id="${newId === '' ? id : newId}")。`,
      )
    }

    if (position === 'after') {
      const newId = await insertBlock(client, { nextID: id, data, dataType }, { signal: exec.signal })
      return ok(
        `已在 ${where} 的后面插入同级内容。\n` +
          `写入字符数:${data.length} | 格式:${dataType}` +
          (newId === '' ? '' : `\n新块 ID:${newId}`),
      )
    }

    const insertedId = await insertBlock(client, { previousID: id, data, dataType }, { signal: exec.signal })
    return ok(
      `已在 ${where} 的前面插入同级内容。\n` +
        `写入字符数:${data.length} | 格式:${dataType}` +
        (insertedId === '' ? '' : `\n新块 ID:${insertedId}`),
    )
  }
}
