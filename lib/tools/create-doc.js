/**
 * `siyuan_create_doc` —— 在指定笔记本里新建 Markdown 文档。
 *
 * 内核接口:`POST /api/filetree/createDocWithMd`
 *   请求 `{ notebook, path, markdown, parentID?, tags? }`,
 *   `path` 是「人类可读路径」(hpath),`/` 表示层级,内核会自动补 `.sy`;
 *   响应 `data` 就是新文档的块 ID。
 *
 * 注意内核会清掉路径里的换行 / 制表符 / 斜杠,所以标题里带 `/` 时
 * 这里先自己剥掉,免得「建成功了但名字少一截」这种意外。
 *
 * @module dsh-siyuan-api/tools/create-doc
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDocWithMd, querySql } from '../api.js'
import { resolveNotebook } from './resolve.js'
import { fail, failFrom, looksLikeId, ok, textOutput } from './shared.js'

/**
 * 清理标题:去掉内核会剔除的字符,压掉首尾空白。
 * @param {string} title
 * @returns {string}
 */
export function sanitizeTitle(title) {
  return String(title ?? '')
    .replace(/[\r\n\u2028\u2029\t]/g, ' ')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.md$/i, '')
    .trim()
}

/**
 * 注册 `siyuan_create_doc`。
 *
 * @param {{ tools: { register: (definition: unknown) => unknown } }} ctx 插件上下文。
 * @param {{ client: import('../client.js').SiYuanClient, config: Record<string, any> }} deps
 */
export function registerCreateDocTool(ctx, deps) {
  const { client, config } = deps

  ctx.tools.register(
    defineTool({
      name: 'siyuan_create_doc',
      description:
        '在思源笔记(SiYuan)的指定笔记本里新建一篇文档。标题会作为文档名,markdown 作为正文(标准 Markdown:标题、列表、表格、代码块、行内公式 $..$ 等)。' +
        '想建子文档就传 parentID(父文档 ID,来自 siyuan_search 的结果)或用「父文档/子文档」形式的标题,不要自己写完整路径。' +
        '笔记本要传名称或 ID(不确定就先调 siyuan_notebooks)。这是写操作,创建前请确认标题与位置符合用户意图。',
      parameters: {
        notebook: {
          type: 'string',
          description: '目标笔记本,传名称(如「运维笔记」)或 22 位 ID。已关闭的笔记本无法写入。',
        },
        title: {
          type: 'string',
          required: true,
          description: '文档标题,也是文件名。可用「父文档/子文档」表示放在某个已有文档下面(最多一层,更深的层级请用 parentID)。',
        },
        markdown: {
          type: 'string',
          description: '文档正文,标准 Markdown。省略则创建空文档(之后再调 siyuan_block 追加内容)。',
        },
        parentID: {
          type: 'string',
          description: '可选,父文档 ID。传了它就会新建在该文档下面(标题只当作文档名),优先级高于标题里的「/」。',
        },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: client.config.timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const title = sanitizeTitle(args.title)
        if (title === '') {
          return fail('title 不能为空(内核会剔除换行 / 制表符 / 斜杠,清理后标题为空)。请换一个标题。')
        }

        try {
          const resolved = await resolveNotebook(
            client,
            { notebook: args.notebook, defaultNotebook: config.defaultNotebook },
            { signal: exec.signal },
          )
          if (!resolved.notebook) return fail(resolved.reason)
          const notebook = resolved.notebook

          let path = title
          let parentNote = ''
          const parentID = String(args.parentID ?? '').trim()
          if (parentID !== '') {
            if (!looksLikeId(parentID)) {
              return fail(`parentID「${parentID}」不像思源块 ID(应为 22 位,形如 20260919135122-lw63vfz)。`)
            }
            const { rows } = await querySql(
              client,
              `SELECT id, hpath, type, box FROM blocks WHERE id = '${parentID.replace(/'/g, "''")}' LIMIT 1`,
              { signal: exec.signal },
            )
            const parent = rows[0]
            if (!parent) return fail(`找不到 ID 为 ${parentID} 的块,无法作为父文档。请用 siyuan_search 重新确认。`)
            if (String(parent.type ?? '') !== 'd') {
              return fail(`块 ${parentID} 不是文档(type=${String(parent.type ?? '')}),只能把文档建在文档下面。`)
            }
            if (String(parent.box ?? '') !== notebook.id) {
              return fail(`父文档 ${parentID} 不在笔记本「${notebook.name}」里,思源不支持跨笔记本建子文档。`)
            }
            const parentHPath = String(parent.hpath ?? '').trim()
            path = parentHPath === '' || parentHPath === '/' ? title : `${parentHPath.replace(/\/+$/, '')}/${title}`
            parentNote = `\n父文档:${parentHPath || parentID}`
          }

          const markdown = typeof args.markdown === 'string' ? args.markdown : ''
          const id = await createDocWithMd(
            client,
            { notebook: notebook.id, path, markdown, parentID: parentID === '' ? undefined : parentID },
            { signal: exec.signal },
          )
          if (id === '') {
            return fail('思源返回成功但没有给出新文档 ID,无法确认创建结果。请在思源里检查一下「' + path + '」。')
          }

          // 用 sql 取一次 hpath,把可读路径回给模型(展示 / 后续引用都方便)。
          let hpath = path
          try {
            const { rows } = await querySql(
              client,
              `SELECT hpath FROM blocks WHERE id = '${id.replace(/'/g, "''")}' LIMIT 1`,
              { signal: exec.signal },
            )
            const found = String(rows[0]?.hpath ?? '').trim()
            if (found !== '') hpath = found
          } catch {
            // 读回路径失败不影响创建结果,忽略。
          }

          return ok(
            `已创建文档「${title}」。\n` +
              `笔记本:${notebook.name}(${notebook.id})\n` +
              `路径:${hpath}\n` +
              `文档 ID:${id}` +
              parentNote +
              (markdown === '' ? '\n(正文为空,可以接着用 siyuan_block 的 append 模式写内容。)' : `\n正文字符数:${markdown.length}`),
          )
        } catch (error) {
          return failFrom(error)
        }
      },
    }),
  )
}
