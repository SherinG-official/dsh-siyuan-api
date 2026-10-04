/**
 * 展示层的小工具:把内核数据整理成模型读得懂的短文本。
 * 工具返回给模型的是 `output.render()` 产出的文本,所以这里的取舍是
 * 「一屏内能看清 + 保留定位信息(id / 路径 / 笔记本)」。
 *
 * @module dsh-siyuan-api/format
 */

/** 单条搜索结果片段的默认截断长度。 */
export const SNIPPET_LIMIT = 280

/**
 * 折叠空白并把超长文本截断,避免一条命中就把上下文吃满。
 *
 * @param {unknown} value 原始文本。
 * @param {number} [limit] 最大字符数。
 * @returns {string}
 */
export function clip(value, limit = SNIPPET_LIMIT) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  return text.slice(0, Math.max(1, limit - 1)) + '…'
}

/**
 * 生成 Markdown 引用行前缀,让命中条目在回复里自带出处。
 * @param {unknown} text
 * @returns {string}
 */
export function inline(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').trim()
}

/**
 * 把内核的 `updated` 字段(格式为 `yyyyMMddHHmmss`,兼容 13 位毫秒时间戳)
 * 转成 `yyyy-MM-dd HH:mm`。认不出来就原样返回。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatUpdated(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  if (/^\d{14}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`
  }
  if (/^\d{13}$/.test(raw)) {
    const d = new Date(Number(raw))
    if (!Number.isNaN(d.getTime())) return formatUpdated(toLocalStamp(d))
  }
  return raw
}

/** Date -> `yyyyMMddHHmmss`(本地时区)。 */
function toLocalStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * 从 `hpath` 里取「所属文档路径」。`hpath` 形如
 * `/笔记本名/父文档/子文档`,第一段是笔记本名,去掉它就是文档路径。
 *
 * @param {unknown} hpath 内核的 hpath。
 * @param {unknown} notebookName 笔记本名(可能是空串)。
 * @returns {string}
 */
export function docPathFromHPath(hpath, notebookName) {
  const raw = String(hpath ?? '').trim()
  if (raw === '') return ''
  const name = String(notebookName ?? '').trim()
  if (name !== '' && (raw === '/' + name || raw.startsWith('/' + name + '/'))) {
    const rest = raw.slice(name.length + 1)
    return rest === '' ? '/' : rest
  }
  return raw
}

/**
 * 内核 blocks.type 说明表。仅用于给模型补一句「这是什么块」,
 * 取值来自内核 sql/block.go 与真实索引数据统计。
 */
const BLOCK_TYPE_LABEL = {
  d: '文档',
  h: '标题',
  p: '段落',
  l: '列表',
  i: '列表项',
  b: '引述',
  s: '超级块',
  t: '表格',
  tb: '表格',
  m: '公式块',
  c: '代码块',
  html: 'HTML 块',
  av: '数据库',
  query_embed: '嵌入块',
  audio: '音频',
  video: '视频',
  iframe: 'iframe',
  widget: '挂件',
}

/**
 * @param {unknown} type 内核 blocks.type。
 * @param {unknown} subtype 内核 blocks.subtype。
 * @returns {string} 便于阅读的块类型标签。
 */
export function blockTypeLabel(type, subtype) {
  const key = String(type ?? '').trim()
  const sub = String(subtype ?? '').trim()
  const base = BLOCK_TYPE_LABEL[key] ?? (key === '' ? '块' : key)
  if (key === 'h' && /^h[1-6]$/.test(sub)) return `${base} ${sub.slice(1)} 级`
  if (key === 'l') return sub === 'o' ? '有序列表' : '无序列表'
  if (key === 'i') return sub === 'o' ? '有序列表项' : '无序列表项'
  return base
}

/**
 * 笔记本名解析:`listNotebooks` 的结果 -> `Map<boxId, name>`。
 * @param {unknown} notebooks lsNotebooks 的 data.notebooks。
 * @returns {Map<string, { name: string, closed: boolean }>}
 */
export function notebookIndex(notebooks) {
  /** @type {Map<string, { name: string, closed: boolean }>} */
  const map = new Map()
  if (!Array.isArray(notebooks)) return map
  for (const item of notebooks) {
    if (item === null || typeof item !== 'object') continue
    const id = String(/** @type {any} */ (item).id ?? '').trim()
    if (id === '') continue
    map.set(id, {
      name: String(/** @type {any} */ (item).name ?? '').trim(),
      closed: /** @type {any} */ (item).closed === true,
    })
  }
  return map
}

/**
 * 命中列表渲染成模型可读的文本。
 *
 * @param {Array<Record<string, unknown>>} items
 * @param {{ total: number, notebookNote?: string }} meta
 * @returns {string}
 */
export function renderHits(items, meta) {
  if (items.length === 0) {
    return `思源里没有匹配的笔记。${meta.notebookNote ?? ''}可以换个关键词、放宽 mode=sql 自己写查询,或用 siyuan_notebooks 确认笔记本。`
  }
  const lines = items.map((item, i) => {
    const where = [item.notebook, item.docPath].filter((v) => String(v ?? '') !== '').join(' · ')
    const head = `${i + 1}. ${clip(item.title, 80) || '(无标题)'}`
    const metaLine = [
      item.blockTypeLabel ? String(item.blockTypeLabel) : '',
      where,
      item.updatedText ? `更新 ${item.updatedText}` : '',
      `id=${item.id}`,
    ]
      .filter((v) => v !== '')
      .join(' | ')
    const snippet = clip(item.snippet, 320)
    return `${head}\n   ${metaLine}${snippet === '' ? '' : `\n   ${snippet}`}`
  })
  const truncated =
    meta.total > items.length
      ? `(命中 ${meta.total} 条,仅列前 ${items.length} 条;可用 mode=sql 精确筛选或加 limit${meta.notebookNote ?? ''})\n`
      : ''
  return `${truncated}${lines.join('\n')}`
}

/**
 * SQL 结果渲染成对齐的文本表(SELECT 的列顺序即表头顺序)。
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} columns
 * @returns {string}
 */
export function renderRows(rows, columns) {
  if (rows.length === 0) return '(查询成功,但没有返回任何行)'
  const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {})
  const cell = (value) => {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'object') return clip(JSON.stringify(value), 120)
    return clip(value, 120)
  }
  const matrix = rows.map((row) => cols.map((c) => cell(/** @type {any} */ (row)[c])))
  const widths = cols.map((c, i) => Math.min(40, Math.max(String(c).length, ...matrix.map((r) => r[i].length))))
  const cut = (s, w) => (s.length <= w ? s : s.slice(0, Math.max(1, w - 1)) + '…')
  const header = cols.map((c, i) => cut(String(c), widths[i]).padEnd(widths[i])).join(' | ')
  const divider = widths.map((w) => '-'.repeat(w)).join('-+-')
  const body = matrix.map((r) => r.map((s, i) => cut(s, widths[i]).padEnd(widths[i])).join(' | '))
  return [header, divider, ...body].join('\n')
}
