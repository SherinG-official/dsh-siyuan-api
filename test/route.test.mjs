/**
 * 诊断路由的单元测试。
 *
 * 重点覆盖真机验证踩到的两个坑:
 *   1. **没 declare inject 就读 `ctx.webServer` 会被 cordis 抛错**
 *      (`cannot get property "webServer" without inject`),把插件装载搞挂 ——
 *      所以实现必须走 `ctx.inject(['webServer'], …)`;
 *   2. webServer 不存在时(headless / SDK)必须安静跳过,不能抛、不能卡住工具注册。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerStatusRoute, ROUTE } from '../lib/route.js'
import { createSiYuanClient } from '../lib/client.js'
import { startFakeKernel } from './helpers.mjs'

/** 假 webServer:记录注册进来的路由。 */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

/**
 * 假 cordis 上下文:实现 ctx.inject 的延迟语义。
 * webServer 为 undefined 时回调**不会**执行(和 cordis 里服务永不就绪一致)。
 */
function fakeCtx(webServer) {
  const state = { injected: [], ran: 0, disposed: 0 }
  const ctx = {
    state,
    inject(deps, callback) {
      state.injected.push(deps)
      const scoped = {
        get webServer() {
          if (!webServer) throw new Error('cannot get property "webServer" without inject')
          return webServer
        },
        effect(body) {
          const disposer = body()
          return () => {
            state.disposed++
            if (typeof disposer === 'function') disposer()
          }
        },
      }
      if (webServer) {
        state.ran++
        callback(scoped)
      }
      return { dispose() {} }
    },
  }
  return ctx
}

test('webServer 就绪后挂上 /dsh-siyuan-api/status', async () => {
  const kernel = await startFakeKernel()
  try {
    const webServer = fakeWebServer()
    const ctx = fakeCtx(webServer)
    const client = createSiYuanClient({ apiUrl: kernel.url, token: kernel.token })
    assert.equal(registerStatusRoute(ctx, { client, toolNames: ['siyuan_search'] }), true)
    assert.deepEqual(ctx.state.injected, [['webServer']])
    assert.equal(ctx.state.ran, 1)
    assert.equal(webServer.routes.length, 1)
    assert.equal(webServer.routes[0].path, ROUTE)
    assert.equal(webServer.routes[0].kind, 'exact')

    let payload = ''
    webServer.routes[0].handler({}, { writeHead() {}, end: (text) => (payload = text) })
    const parsed = JSON.parse(payload)
    assert.equal(parsed.plugin, 'dsh-siyuan-api')
    assert.deepEqual(parsed.tools, ['siyuan_search'])
    assert.equal(parsed.tokenConfigured, true)
    assert.equal(parsed.apiUrl, kernel.url + '/api')
  } finally {
    await kernel.close()
  }
})

test('没有 webServer(headless / SDK)时安静待命,不抛异常', () => {
  const ctx = fakeCtx(undefined)
  const client = createSiYuanClient({ token: 'x' })
  // 返回 true 表示「已进入等待流程」,回调没跑是正常状态。
  assert.equal(registerStatusRoute(ctx, { client, toolNames: [] }), true)
  assert.equal(ctx.state.ran, 0, '回调不该在服务缺失时执行')
})

test('上下文连 inject 都没有时直接跳过', () => {
  const client = createSiYuanClient({ token: 'x' })
  assert.equal(registerStatusRoute({}, { client, toolNames: [] }), false)
})

test('回调内部抛错不会外泄(路由是增强项)', () => {
  const ctx = {
    inject(_deps, callback) {
      const scoped = {
        get webServer() {
          return { register: () => { throw new Error('duplicate route') } }
        },
        effect(body) {
          body()
        },
      }
      callback(scoped)
      return { dispose() {} }
    },
  }
  const client = createSiYuanClient({ token: 'x' })
  // register 在 effect 回调里抛,应该被 registerStatusRoute 的 try/catch 吃掉。
  const result = registerStatusRoute(ctx, { client, toolNames: [] })
  assert.equal(typeof result, 'boolean')
})

test('探活失败只记录在状态里,路由照样可用', async () => {
  const webServer = fakeWebServer()
  const ctx = fakeCtx(webServer)
  // 指向一个没人监听的端口。
  const client = createSiYuanClient({ apiUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 300 })
  assert.equal(registerStatusRoute(ctx, { client, toolNames: ['siyuan_status'] }), true)
  await new Promise((resolve) => setTimeout(resolve, 700))

  let payload = ''
  webServer.routes[0].handler({}, { writeHead() {}, end: (text) => (payload = text) })
  const parsed = JSON.parse(payload)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.kernel.reachable, false)
  assert.match(parsed.kernel.note, /连不上思源内核/)
})
