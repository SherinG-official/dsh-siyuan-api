/**
 * 笔记本解析:模型更可能说「运维笔记」而不是 `20260919125932-lkhz1ad`,
 * 所以这里把 ID / 名称 / 默认值三种输入统一解析成一个确定的笔记本 ID。
 *
 * @module dsh-siyuan-api/tools/resolve
 */

import { listNotebooks } from '../api.js'
import { looksLikeId } from './shared.js'

/**
 * @typedef {{ id: string, name: string, closed: boolean, encrypted: boolean }} Notebook
 */

/**
 * 解析目标笔记本。
 *
 * 顺序:精确 ID → 精确名称 → 唯一子串匹配 → 配置里的 defaultNotebook。
 * 匹配不到时返回 `{ notebook: null, reason }`,`reason` 里带上现有笔记本清单,
 * 让模型能立刻换个说法重试而不是再来回问。
 *
 * @param {import('../client.js').SiYuanClient} client
 * @param {{ notebook?: string, defaultNotebook?: string }} input
 * @param {{ signal?: AbortSignal, allowDefault?: boolean }} [options]
 * @returns {Promise<{ notebook: Notebook | null, notebooks: Notebook[], reason: string }>}
 */
export async function resolveNotebook(client, input, options = {}) {
  const notebooks = await listNotebooks(client, options)
  const wanted = String(input.notebook ?? '').trim()
  const fallback = String(input.defaultNotebook ?? '').trim()
  const listing = () => notebooks.map((n) => `${n.name}(${n.id}${n.closed ? ',已关闭' : ''})`).join('、') || '(没有笔记本)'

  const findById = (id) => notebooks.find((n) => n.id === id) ?? null
  const findByName = (name) => notebooks.find((n) => n.name === name) ?? null

  let hit = null
  if (wanted !== '') {
    hit = looksLikeId(wanted) ? findById(wanted) : findByName(wanted)
    if (!hit) {
      const lowered = wanted.toLowerCase()
      const partial = notebooks.filter((n) => n.name.toLowerCase().includes(lowered))
      if (partial.length === 1) hit = partial[0]
      else if (partial.length > 1) {
        return {
          notebook: null,
          notebooks,
          reason: `「${wanted}」匹配到多个笔记本(${partial.map((n) => n.name).join('、')}),请给出完整名称或 ID。`,
        }
      }
    }
    if (!hit) {
      return {
        notebook: null,
        notebooks,
        reason: `找不到名为「${wanted}」的笔记本。现有笔记本:${listing()}。可以先用 siyuan_notebooks 确认,再传 notebook 的 ID 或完整名称。`,
      }
    }
  } else if (options.allowDefault !== false && fallback !== '') {
    hit = looksLikeId(fallback) ? findById(fallback) : findByName(fallback)
    if (!hit) {
      return {
        notebook: null,
        notebooks,
        reason: `配置里的 defaultNotebook「${fallback}」不存在。现有笔记本:${listing()}。`,
      }
    }
  }

  if (!hit) {
    return {
      notebook: null,
      notebooks,
      reason: `没有指定笔记本,也没有配置 defaultNotebook。请传 notebook(名称或 ID)。现有笔记本:${listing()}。`,
    }
  }
  if (hit.closed) {
    return {
      notebook: null,
      notebooks,
      reason: `笔记本「${hit.name}」当前处于关闭状态,内核不会写入。请先在思源里打开该笔记本再试。`,
    }
  }
  return { notebook: hit, notebooks, reason: '' }
}
