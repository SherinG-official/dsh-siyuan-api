/**
 * `siyuan_notebooks` —— 列出笔记本。
 *
 * 存在的意义是让模型能自己拿到「思源里有哪些笔记本」这个前提条件,
 * 从而在创建文档 / 缩小搜索范围时不必反问用户。
 *
 * @module dsh-siyuan-api/tools/notebooks
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { listNotebooks } from '../api.js'
import { failFrom, ok, textOutput } from './shared.js'

/**
 * @param {Array<{ id: string, name: string, closed: boolean, encrypted: boolean }>} list
 * @returns {string} 面向模型的文本。
 */
export function renderNotebooks(list) {
  if (list.length === 0) {
    return '思源里没有任何笔记本。请先在思源应用中创建一个笔记本,再让我写文档。'
  }
  const lines = list.map((n, i) => {
    const flags = [n.closed ? '已关闭(不能写入)' : '已打开', n.encrypted ? '加密' : ''].filter((v) => v !== '').join('、')
    return `${i + 1}. ${n.name}\n   id=${n.id} | ${flags}`
  })
  return `${list.length} 个笔记本:\n${lines.join('\n')}`
}

/**
 * 注册 `siyuan_notebooks`。
 *
 * @param {{ tools: { register: (definition: unknown) => unknown } }} ctx 插件上下文。
 * @param {{ client: import('../client.js').SiYuanClient }} deps
 */
export function registerNotebooksTool(ctx, deps) {
  const { client } = deps
  ctx.tools.register(
    defineTool({
      name: 'siyuan_notebooks',
      description:
        '列出思源笔记(SiYuan)里的所有笔记本,返回每个笔记本的名称、ID 与开关状态。' +
        '在创建文档(需要 notebook)或把搜索限定到某个笔记本之前,先用它拿到准确的名称 / ID;' +
        '结果里已关闭的笔记本无法写入。',
      parameters: {},
      output: textOutput((_args, value) => value.message),
      timeoutMs: client.config.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        try {
          const list = await listNotebooks(client, { signal: exec.signal })
          return ok(renderNotebooks(list))
        } catch (error) {
          return failFrom(error)
        }
      },
    }),
  )
}
