/**
 * 内核端点的语义化封装:一函数一接口,返回值都已拆过信封。
 * 工具层只调用这里,不直接拼 endpoint 字符串。
 *
 * @module dsh-siyuan-api/api
 */

import { pickPayload, unwrapEnvelope } from './client.js'

/**
 * 把任意内核返回值收敛成数组。
 * 内核有的端点直接给数组,有的给 `{ items: [...] }` 或 `{ blocks: [...] }`。
 *
 * @param {unknown} value
 * @param {string} [key]
 * @returns {Array<Record<string, unknown>>}
 */
export function asArray(value, key) {
  const payload = pickPayload(value, key)
  if (Array.isArray(payload)) return payload.filter((item) => item !== null && typeof item === 'object')
  if (payload !== null && typeof payload === 'object') {
    for (const candidate of ['blocks', 'items', 'rows', 'notebooks', 'data', 'list']) {
      if (candidate in payload && Array.isArray(/** @type {any} */ (payload)[candidate])) {
        return /** @type {any} */ (payload)[candidate].filter((/** @type {unknown} */ item) => item !== null && typeof item === 'object')
      }
    }
  }
  return []
}

/**
 * 把内核返回值收敛成对象。
 * @param {unknown} value
 * @param {string} [key]
 * @returns {Record<string, unknown> | null}
 */
export function asObject(value, key) {
  const payload = pickPayload(value, key)
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return /** @type {Record<string, unknown>} */ (payload)
  }
  return null
}

/**
 * 从写操作(appendBlock / insertBlock / prependBlock)的返回里取新块 ID。
 * 内核返回事务数组 `[{ doOperations: [{ action:"insert", id, … }] }]`,
 * 新 ID 就在 `doOperations[].id` 上。
 *
 * @param {unknown} data 内核返回值。
 * @returns {string} 新块 ID;取不到返回空串。
 */
export function newBlockIdFromTransaction(data) {
  const transactions = asArray(data)
  for (const transaction of transactions) {
    const operations = Array.isArray(transaction.doOperations) ? transaction.doOperations : []
    for (const operation of operations) {
      const id = operation && typeof operation === 'object' ? String(operation.id ?? '') : ''
      if (id !== '') return id
    }
  }
  return ''
}

/**
 * 内核版本号(`/api/system/version`)。
 * @param {import('./client.js').SiYuanClient} client
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function getVersion(client, options = {}) {
  const data = await client.request('/api/system/version', {}, options)
  for (const key of ['version', 'ver', 'kernelVersion']) {
    const value = data !== null && typeof data === 'object' ? /** @type {any} */ (data)[key] : undefined
    if (typeof value === 'string' && value !== '') return value
  }
  return typeof data === 'string' ? data : ''
}

/**
 * 笔记本列表(`/api/notebook/lsNotebooks`)。
 * @param {import('./client.js').SiYuanClient} client
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ id: string, name: string, closed: boolean, encrypted: boolean, sort: number }>>}
 */
export async function listNotebooks(client, options = {}) {
  const data = await client.request('/api/notebook/lsNotebooks', {}, options)
  const notebooks = asArray(data, 'notebooks')
  return notebooks.map((item) => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    closed: item.closed === true,
    encrypted: item.encrypted === true,
    sort: Number.isFinite(Number(item.sort)) ? Number(item.sort) : 0,
  }))
}

/**
 * 只读 SQL 查询(`/api/query/sql`)。
 *
 * 两个必须知道的内核行为(见思源 3.8.x 的 `kernel/api/query.go` 与
 * `kernel/sql/stmt_validate.go`):
 *   1. **默认 mode 不做只读检查** —— 只有传 `mode:"readonly"` 内核才走
 *      「单条 + SELECT/WITH」校验。本插件永远带上它,不把「不写坏数据」
 *      寄托在自己的正则上。老内核(≤3.1.x)没有 mode 字段,会忽略它。
 *   2. 响应除了 `data`,顶层还有 `limit`(= 思源的 search.limit,默认 64)
 *      与 `truncated`:语句没写 LIMIT 时内核自己截断,这里把事实带回去,
 *      免得模型以为「就这么多」。
 *
 * @param {import('./client.js').SiYuanClient} client
 * @param {string} stmt 已通过只读校验的语句。
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ rows: Array<Record<string, unknown>>, columns: string[], kernelLimit: number | null, truncated: boolean }>}
 */
export async function querySql(client, stmt, options = {}) {
  const body = await client.requestRawChecked('/api/query/sql', { stmt, mode: 'readonly' }, options)
  const envelope = unwrapEnvelope(body)
  const rows = asArray(envelope.data)
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : null
  const kernelLimit = record && Number.isFinite(Number(record.limit)) ? Number(record.limit) : null
  return { rows, columns, kernelLimit, truncated: record?.truncated === true }
}

/**
 * 新建 Markdown 文档(`/api/filetree/createDocWithMd`),返回新文档 ID。
 *
 * `path` 是 **hpath**(人类可读路径,不带 `.sy`),`/` 分隔层级,缺失的父级
 * 内核会自动创建;每一级标题会被内核清理并截断到 512 字符。
 * 响应 `data` 就是新文档 ID(纯字符串,不是对象)。
 *
 * @param {import('./client.js').SiYuanClient} client
 * @param {{ notebook: string, path: string, markdown?: string, parentID?: string, tags?: string[] }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>} 新文档块 ID。
 */
export async function createDocWithMd(client, input, options = {}) {
  const payload = {
    notebook: input.notebook,
    path: input.path,
    markdown: input.markdown ?? '',
  }
  if (input.parentID) payload.parentID = input.parentID
  if (Array.isArray(input.tags) && input.tags.length > 0) payload.tags = input.tags
  const data = await client.request('/api/filetree/createDocWithMd', payload, options)
  const record = asObject(data)
  const id = record ? String(record.id ?? '') : typeof data === 'string' ? data : ''
  return id
}

/**
 * 文档 / 块的 Kramdown 原文(`/api/block/getBlockKramdown`)。
 *
 * `mode` 固定用 `"md"`:思源菜单里「复制为 Markdown」用的就是它,输出是模型
 * 最熟悉的标准 Markdown(另一档 `"textmark"` 会带思源自己的标记语义)。
 *
 * @param {import('./client.js').SiYuanClient} client
 * @param {string} id 块 ID(文档 ID 亦可)。
 * @param {{ signal?: AbortSignal, mode?: 'md' | 'textmark' }} [options]
 * @returns {Promise<{ id: string, kramdown: string }>}
 */
export async function getBlockKramdown(client, id, options = {}) {
  const data = await client.request(
    '/api/block/getBlockKramdown',
    { id, mode: options.mode ?? 'md' },
    options,
  )
  const record = asObject(data)
  return {
    id: String(record?.id ?? id),
    kramdown: String(record?.kramdown ?? ''),
  }
}

/**
 * 块的属性表(`/api/block/getBlockAttrs`)。
 * @param {import('./client.js').SiYuanClient} client
 * @param {string} id
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function getBlockAttrs(client, id, options = {}) {
  const data = await client.request('/api/block/getBlockAttrs', { id }, options)
  const record = asObject(data) ?? asObject(data, 'attrs')
  /** @type {Record<string, string>} */
  const out = {}
  if (record) {
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined) continue
      out[key] = String(value)
    }
  }
  return out
}

/**
 * 面包屑(`/api/block/getBlockBreadcrumb`)。
 * @param {import('./client.js').SiYuanClient} client
 * @param {string} id
 * @param {{ signal?: AbortSignal, excludeTypes?: string[] }} [options]
 * @returns {Promise<string>} `文档 / 一级标题 / 二级标题` 形式的路径;失败时为空串。
 */
export async function getBlockBreadcrumb(client, id, options = {}) {
  const payload = { id }
  if (Array.isArray(options.excludeTypes)) payload.excludeTypes = options.excludeTypes
  const data = await client.request('/api/block/getBlockBreadcrumb', payload, options)
  const items = asArray(data)
  const names = items
    .map((item) => String(item.name ?? '').trim())
    .filter((name) => name !== '')
  return names.join(' / ')
}

/**
 * 追加块(`/api/block/appendBlock`)。
 *
 * 内核返回事务数组,新块的 ID 在 `doOperations[].id` 上 —— 拿到它才能让模型
 * 继续对着新块做后续操作,所以这里直接返回 ID 而不是原始事务。
 *
 * @param {import('./client.js').SiYuanClient} client
 * @param {{ parentID: string, data: string, dataType?: 'markdown' | 'dom' }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>} 新块 ID;取不到返回空串。
 */
export async function appendBlock(client, input, options = {}) {
  const data = await client.request(
    '/api/block/appendBlock',
    {
      parentID: input.parentID,
      data: input.data,
      dataType: input.dataType ?? 'markdown',
    },
    options,
  )
  return newBlockIdFromTransaction(data)
}

/**
 * 在指定块之前 / 之后插入(`/api/block/insertBlock`)。
 *
 * 内核按 `nextID` > `previousID` > `parentID` 的优先级定位,一次只传一个。
 *
 * @param {import('./client.js').SiYuanClient} client
 * @param {{ data: string, dataType?: 'markdown' | 'dom', previousID?: string, nextID?: string, parentID?: string }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string>} 新块 ID;取不到返回空串。
 */
export async function insertBlock(client, input, options = {}) {
  const payload = {
    data: input.data,
    dataType: input.dataType ?? 'markdown',
  }
  if (input.nextID) payload.nextID = input.nextID
  else if (input.previousID) payload.previousID = input.previousID
  else if (input.parentID) payload.parentID = input.parentID
  const data = await client.request('/api/block/insertBlock', payload, options)
  return newBlockIdFromTransaction(data)
}
