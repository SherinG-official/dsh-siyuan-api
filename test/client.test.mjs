/**
 * 客户端单元测试:URL 归一化、鉴权头、信封解析、错误分类。
 * 这里不碰网络,用注入的假 fetch 精确控制响应。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_API_URL,
  SIYUAN_ERROR,
  SiYuanError,
  createSiYuanClient,
  normalizeApiUrl,
  pickPayload,
  resolveClientConfig,
  unwrapEnvelope,
} from '../lib/client.js'
import { startFakeKernel } from './helpers.mjs'

/** 造一个记录调用参数的假 fetch。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const result = await handler(url, init)
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => (typeof result.body === 'string' ? result.body : JSON.stringify(result.body)),
    }
  }
  return { impl, calls }
}

test('normalizeApiUrl 容错各种写法', () => {
  assert.equal(normalizeApiUrl(''), `${DEFAULT_API_URL}/api`)
  assert.equal(normalizeApiUrl(undefined), `${DEFAULT_API_URL}/api`)
  assert.equal(normalizeApiUrl('127.0.0.1:6806'), 'http://127.0.0.1:6806/api')
  assert.equal(normalizeApiUrl('http://127.0.0.1:6806/'), 'http://127.0.0.1:6806/api')
  assert.equal(normalizeApiUrl('http://127.0.0.1:6806/api'), 'http://127.0.0.1:6806/api')
  assert.equal(normalizeApiUrl('https://note.example.com/siyuan/api/'), 'https://note.example.com/siyuan/api')
})

test('resolveClientConfig 约束数值范围并回退默认值', () => {
  const config = resolveClientConfig({ apiUrl: ' 10.0.0.5:6807 ', token: ' abc ', timeoutMs: 10, maxRows: 99999 })
  assert.equal(config.apiUrl, 'http://10.0.0.5:6807/api')
  assert.equal(config.token, 'abc')
  assert.equal(config.timeoutMs, 250, '超时下限被夹到 250ms')
  assert.equal(config.maxRows, 1000, '行数上限被夹到 1000')
})

test('unwrapEnvelope 区分信封与裸数据', () => {
  assert.deepEqual(unwrapEnvelope({ code: 0, msg: '', data: [1, 2] }), { enveloped: true, code: 0, msg: '', data: [1, 2] })
  assert.deepEqual(unwrapEnvelope([1, 2]), { enveloped: false, code: 0, msg: '', data: [1, 2] })
  assert.deepEqual(unwrapEnvelope('3.8.6'), { enveloped: false, code: 0, msg: '', data: '3.8.6' })
})

test('pickPayload 支持命名包装', () => {
  assert.deepEqual(pickPayload({ notebooks: [1] }, 'notebooks'), [1])
  assert.deepEqual(pickPayload([1], 'notebooks'), [1])
})

test('请求带上 Authorization: Token 头并使用 /api 前缀', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { code: 0, msg: '', data: 'ok' } }))
  const client = createSiYuanClient({ apiUrl: '127.0.0.1:6806', token: 'secret-token' }, { fetch: impl })
  const data = await client.request('/api/system/version')
  assert.equal(data, 'ok')
  assert.equal(calls[0].url, 'http://127.0.0.1:6806/api/system/version')
  assert.equal(calls[0].init.headers.Authorization, 'Token secret-token')
  assert.equal(calls[0].init.method, 'POST')
})

test('未配置 token 时不发 Authorization 头', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { code: 0, msg: '', data: null } }))
  const client = createSiYuanClient({ token: '' }, { fetch: impl })
  await client.request('/api/system/version')
  assert.equal('Authorization' in calls[0].init.headers, false)
})

test('内核 code != 0 抛 SIYUAN_API_ERROR 并带上 msg', async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: { code: -1, msg: 'SQL statement is not a read-only query' } }))
  const client = createSiYuanClient({ token: 't' }, { fetch: impl })
  await assert.rejects(
    () => client.request('/api/query/sql', { stmt: 'DELETE FROM blocks' }),
    (error) => {
      assert.ok(error instanceof SiYuanError)
      assert.equal(error.code, SIYUAN_ERROR.API_ERROR)
      assert.match(error.message, /read-only/)
      assert.equal(error.apiCode, -1)
      return true
    },
  )
})

test('HTTP 401 归类为鉴权失败', async () => {
  const { impl } = fakeFetch(() => ({ status: 401, body: { code: -1, msg: 'Auth failed: 请检查 API token' } }))
  const client = createSiYuanClient({ token: 'wrong' }, { fetch: impl })
  await assert.rejects(
    () => client.request('/api/notebook/lsNotebooks'),
    (error) => {
      assert.equal(error.code, SIYUAN_ERROR.AUTH_FAILED)
      assert.match(error.message, /Token|鉴权/)
      return true
    },
  )
})

test('连接被拒归为不可达并给出排查提示', async () => {
  const impl = async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:6806')
    error.name = 'TypeError'
    throw error
  }
  const client = createSiYuanClient({}, { fetch: impl })
  await assert.rejects(
    () => client.request('/api/system/version'),
    (error) => {
      assert.equal(error.code, SIYUAN_ERROR.UNREACHABLE)
      assert.match(error.message, /思源已启动/)
      return true
    },
  )
})

test('超时归类为 TIMEOUT', async () => {
  const impl = async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }
  const client = createSiYuanClient({ timeoutMs: 300 }, { fetch: impl })
  await assert.rejects(
    () => client.request('/api/system/version'),
    (error) => {
      assert.equal(error.code, SIYUAN_ERROR.TIMEOUT)
      return true
    },
  )
})

test('返回 HTML(把地址配成 Web 界面)归为不可解析响应', async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: '<!DOCTYPE html><html></html>' }))
  const client = createSiYuanClient({ token: 't' }, { fetch: impl })
  await assert.rejects(
    () => client.request('/api/system/version'),
    (error) => {
      assert.equal(error.code, SIYUAN_ERROR.BAD_RESPONSE)
      assert.match(error.message, /内核地址/)
      return true
    },
  )
})

test('请求可以被 AbortSignal 取消', async () => {
  const controller = new AbortController()
  const impl = async (_url, init) => {
    controller.abort()
    const error = new Error('aborted')
    error.name = 'AbortError'
    void init
    throw error
  }
  const client = createSiYuanClient({ token: 't' }, { fetch: impl })
  await assert.rejects(
    () => client.request('/api/system/version', {}, { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, SIYUAN_ERROR.ABORTED)
      return true
    },
  )
})

test('真实 HTTP 往返:信封 + 命名包装都能解析', async () => {
  const kernel = await startFakeKernel()
  try {
    const client = createSiYuanClient({ apiUrl: kernel.url, token: kernel.token })
    const version = await client.request('/api/system/version')
    assert.equal(version, '3.8.6')
    const notebooks = await client.request('/api/notebook/lsNotebooks')
    assert.equal(notebooks.notebooks.length, 3)
    assert.equal(kernel.requests.at(-1).auth, `Token ${kernel.token}`)
  } finally {
    await kernel.close()
  }
})
