/**
 * 只读 SQL 防护。
 *
 * 内核自己会校验 SQL(见 kernel/sql/stmt_validate.go:只允许单条 SELECT / WITH),
 * 这里做的**不是**安全边界,而是「提前失败」:在发请求之前把人话讲清楚,
 * 免得模型拿一条明显写错的语句去换一个内核错误码。规则和内核保持一致：
 *   1. 语法上必须是单条语句;
 *   2. 必须以 SELECT 或 WITH 开头(ATTACH / DETACH / PRAGMA / 事务控制一律拒绝)。
 *
 * @module dsh-siyuan-api/sql
 */

import { SIYUAN_ERROR, SiYuanError } from './client.js'

/** 内核索引库里的表名(SELECT ... FROM <table> 的主要目标)。 */
export const KNOWN_TABLES = ['blocks', 'spans', 'attributes', 'refs', 'assets', 'file_annotation_refs']

/**
 * 逐字符扫描 SQL,产出「去掉注释] 之后的可见文本」以及「是否存在第二条语句」。
 * 与内核的 containsMultipleStatements 对齐:引号内的分号不算语句结束,
 * 分号之后若只有空白/注释也不算多条。
 *
 * @param {string} sql
 * @returns {{ cleaned: string, multipleStatements: boolean }}
 */
export function scanSql(sql) {
  const text = String(sql ?? '')
  const runes = Array.from(text)
  let out = ''
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inBracket = false
  let inLineComment = false
  let inBlockComment = false
  let multipleStatements = false

  for (let i = 0; i < runes.length; i++) {
    const ch = runes[i]
    const next = i + 1 < runes.length ? runes[i + 1] : ''

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ' '
      }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        out += ' '
        i++
      }
      continue
    }
    if (inSingle || inDouble || inBacktick || inBracket) {
      if ((inSingle && ch === "'") || (inDouble && ch === '"') || (inBacktick && ch === '`') || (inBracket && ch === ']')) {
        inSingle = inDouble = inBacktick = inBracket = false
      }
      out += ch
      continue
    }

    if (ch === "'") {
      inSingle = true
      out += ch
      continue
    }
    if (ch === '"') {
      inDouble = true
      out += ch
      continue
    }
    if (ch === '`') {
      inBacktick = true
      out += ch
      continue
    }
    if (ch === '[') {
      inBracket = true
      out += ch
      continue
    }
    if (ch === '-' && next === '-') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (ch === ';') {
      // 分号之后还有实质内容 => 多条语句(分号后只有空白/注释不算)。
      const rest = runes.slice(i + 1).join('')
      if (rest.trim() !== '' && scanSql(rest).cleaned.trim() !== '') multipleStatements = true
      out += ';'
      continue
    }
    out += ch
  }

  return { cleaned: out, multipleStatements }
}

/**
 * 校验 SQL 是「单条 + 只读」,否则抛 {@link SiYuanError}。
 * 错误信息直接告诉模型该怎么改,而不是只丢一个「不允许」。
 *
 * @param {string} sql 用户/模型给的语句。
 * @returns {string} 去掉首尾空白的原始语句(保留注释,内核自己会处理)。
 */
export function assertReadonlySql(sql) {
  const raw = String(sql ?? '').trim()
  if (raw === '') {
    throw new SiYuanError(SIYUAN_ERROR.INVALID_ARGUMENT, 'sql 不能为空。')
  }

  const { cleaned, multipleStatements } = scanSql(raw)
  if (multipleStatements) {
    throw new SiYuanError(
      SIYUAN_ERROR.INVALID_ARGUMENT,
      '只允许一条 SQL 语句;检测到分号后还有内容。请去掉多余的语句(思源内核也会拒绝)。',
    )
  }

  const head = cleaned.trim()
  const keyword = (/^[A-Za-z_]+/.exec(head)?.[0] ?? '').toUpperCase()
  if (keyword !== 'SELECT' && keyword !== 'WITH') {
    throw new SiYuanError(
      SIYUAN_ERROR.INVALID_ARGUMENT,
      `只允许只读查询(SELECT / WITH 开头),收到的是「${keyword || '空语句'}」。思源索引库不接受写操作;` +
        '需要改内容请用 siyuan_create_doc 或 siyuan_block(mode=append)。',
    )
  }

  // WITH ... AS (...) DELETE/UPDATE 这类,内核会用 sqlite3_stmt_readonly 拒掉;
  // 这里顺手拦一道,省一次往返。
  if (keyword === 'WITH' && /\)\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(head)) {
    throw new SiYuanError(SIYUAN_ERROR.INVALID_ARGUMENT, 'WITH 子句里不能包含写操作(INSERT / UPDATE / DELETE / REPLACE)。')
  }

  return raw
}

/**
 * 从语句里读出一个显式的正整数字面量 `LIMIT n`,读不到返回 null。
 * 只认顶层裸字面量:`LIMIT 20 OFFSET 5` / `LIMIT 20` 能识别,
 * `limit` 作为列别名(如 `SELECT 1 AS limit`)不会被当成行数上限。
 *
 * @param {string} sql 已通过只读校验的语句。
 * @returns {number | null}
 */
export function findLimit(sql) {
  const { cleaned } = scanSql(sql)
  const pattern = /(?:^|[\s)])LIMIT\s+(\d+)(?:\s*(?:,|\s)\s*(\d+))?(?:\s+OFFSET\s+(\d+))?\s*$/i
  const m = pattern.exec(cleaned.trim())
  if (!m) return null
  // `LIMIT a, b` 形式里 b 才是行数。
  const value = m[2] !== undefined ? Number(m[2]) : Number(m[1])
  return Number.isFinite(value) ? value : null
}

/**
 * 给没有显式 LIMIT 的语句补上行数上限,避免一次拉回整个库。
 *
 * @param {string} sql 已通过只读校验的语句。
 * @param {number} maxRows 本次查询允许的最大行数。
 * @returns {{ sql: string, appliedLimit: number | null }}
 *   appliedLimit 是真正生效的上限(null 表示语句自带 LIMIT,未改动)。
 */
export function ensureRowLimit(sql, maxRows) {
  const existing = findLimit(sql)
  if (existing !== null) return { sql, appliedLimit: null }
  const trimmed = sql.replace(/[\s;]+$/, '')
  return { sql: `${trimmed} LIMIT ${maxRows}`, appliedLimit: maxRows }
}
