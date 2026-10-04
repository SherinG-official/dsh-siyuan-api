/**
 * 只读 SQL 防护的测试。
 * 关注两件事:该拦的拦得住(写操作 / 多语句),该放的放得行(注释、引号内分号、CTE)。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { SIYUAN_ERROR } from '../lib/client.js'
import { assertReadonlySql, ensureRowLimit, findLimit, scanSql } from '../lib/sql.js'

/** 断言抛出的错误码是「参数不合法」。 */
function assertRejects(sql, pattern) {
  assert.throws(
    () => assertReadonlySql(sql),
    (error) => {
      assert.equal(error.code, SIYUAN_ERROR.INVALID_ARGUMENT)
      if (pattern) assert.match(error.message, pattern)
      return true
    },
    `应当拒绝:${sql}`,
  )
}

test('放行常规只读查询', () => {
  assert.equal(assertReadonlySql('SELECT * FROM blocks LIMIT 10'), 'SELECT * FROM blocks LIMIT 10')
  assert.equal(assertReadonlySql('  select id from blocks  '), 'select id from blocks')
  assert.equal(assertReadonlySql('WITH t AS (SELECT 1 AS a) SELECT * FROM t'), 'WITH t AS (SELECT 1 AS a) SELECT * FROM t')
})

test('拒绝写操作与 DDL', () => {
  // 起始关键字不是 SELECT / WITH 的,报错信息里要带上「只读」与实际的起始关键字。
  for (const sql of [
    'DELETE FROM blocks',
    'UPDATE blocks SET content = "x"',
    'INSERT INTO blocks (id) VALUES (1)',
    'DROP TABLE blocks',
    'ATTACH DATABASE "x.db" AS x',
    'PRAGMA table_info(blocks)',
  ]) {
    assertRejects(sql, /只读/)
  }
  // BEGIN; COMMIT 先撞上「单条语句」这道闸,同样要拒绝。
  assertRejects('BEGIN; COMMIT', /一条 SQL|只读/)
})

test('拒绝多语句,但容忍末尾分号与分号后的注释', () => {
  assertRejects('SELECT 1; SELECT 2', /一条 SQL/)
  assertRejects('SELECT 1; DROP TABLE blocks', /一条 SQL/)
  assert.equal(assertReadonlySql('SELECT 1;'), 'SELECT 1;')
  assert.equal(assertReadonlySql('SELECT 1; -- 说明'), 'SELECT 1; -- 说明')
  assert.equal(assertReadonlySql('SELECT 1; /* 说明 */'), 'SELECT 1; /* 说明 */')
})

test('引号内的分号不算多语句', () => {
  assert.equal(assertReadonlySql("SELECT 'a;b' AS x"), "SELECT 'a;b' AS x")
  assert.equal(assertReadonlySql('SELECT content FROM blocks WHERE content LIKE "%a;b%"'), 'SELECT content FROM blocks WHERE content LIKE "%a;b%"')
})

test('WITH 里夹写操作要拒绝', () => {
  assertRejects('WITH t AS (SELECT 1) DELETE FROM blocks', /写操作|只读/)
})

test('空语句与纯注释拒绝', () => {
  assertRejects('   ', /不能为空/)
  assertRejects('-- 只有注释', /只读/)
})

test('scanSql 去掉注释后再判断首关键字', () => {
  const { cleaned } = scanSql('-- 注释\n/* 块注释 */\nSELECT 1')
  assert.match(cleaned.trim(), /^SELECT/)
})

test('findLimit 只认顶层 LIMIT 字面量', () => {
  assert.equal(findLimit('SELECT * FROM blocks LIMIT 20'), 20)
  assert.equal(findLimit('SELECT * FROM blocks LIMIT 20 OFFSET 5'), 20)
  assert.equal(findLimit('SELECT * FROM blocks LIMIT 5, 20'), 20)
  assert.equal(findLimit('SELECT * FROM blocks'), null)
  assert.equal(findLimit('SELECT 1 AS limit FROM blocks'), null)
  assert.equal(findLimit('SELECT * FROM blocks WHERE content LIKE "%limit 5%"'), null)
})

test('ensureRowLimit 只给没写 LIMIT 的语句补上限', () => {
  assert.deepEqual(ensureRowLimit('SELECT * FROM blocks', 25), { sql: 'SELECT * FROM blocks LIMIT 25', appliedLimit: 25 })
  assert.deepEqual(ensureRowLimit('SELECT * FROM blocks LIMIT 3', 25), { sql: 'SELECT * FROM blocks LIMIT 3', appliedLimit: null })
  assert.deepEqual(ensureRowLimit('SELECT * FROM blocks;', 25), { sql: 'SELECT * FROM blocks LIMIT 25', appliedLimit: 25 })
})
