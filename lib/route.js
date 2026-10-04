/**
 * 只读诊断路由:`GET /dsh-siyuan-api/status`。
 *
 * 用途是「确认插件真的挂上了」——在浏览器里打开这个地址,能直接看到
 * 插件注册了哪些工具、当前指向哪个内核地址、Token 有没有配上、内核是否可达。
 * 它不代理任何思源接口,也不回显 Token 内容,只报事实。
 *
 * ## 为什么 webServer 要「延迟注入」而不是写进 inject
 *
 * - 直接读 `ctx.webServer`(没 declare inject)会被 cordis 抛
 *   `cannot get property "webServer" without inject` —— 真机验证时这一条
 *   把整个插件装载搞挂过,所以只能通过 `ctx.get()` 读。
 * - 但 `dsh-host-webserver` 属于 `@deepseek-ai/dsh-web-app`,**不在 dsh-base 里**:
 *   headless / SDK / ACP 这些 profile 根本没有这个服务。把 webServer 写进
 *   inject 会让本插件在那些宿主里永远停在 PENDING,工具也就注册不上。
 * - 所以用 `ctx.inject(['webServer'], …)` 起一个**子 fiber**:服务就绪时它才跑,
 *   没有这个服务的宿主它一直挂着,既不影响工具、也不报错。子 fiber 挂在
 *   本插件 fiber 下,插件卸载时路由随之摘掉。
 *
 * @module dsh-siyuan-api/route
 */

import { getVersion, listNotebooks } from './api.js'

/** 诊断路由路径。 */
export const ROUTE = '/dsh-siyuan-api/status'

/**
 * 在 webServer 就绪后挂上诊断路由。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ client: import('./client.js').SiYuanClient, toolNames: string[], debugLog?: boolean }} deps
 * @returns {boolean} 是否已经进入「等待 webServer」的流程(false 表示上下文不支持,直接跳过)。
 */
export function registerStatusRoute(ctx, deps) {
  const { client, toolNames, debugLog = false } = deps
  if (typeof ctx.inject !== 'function') {
    if (debugLog) console.log('[dsh-siyuan-api] 上下文不支持 ctx.inject,跳过诊断路由。')
    return false
  }

  try {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer
      if (!webServer || typeof webServer.register !== 'function') return

      const state = { appliedAt: new Date().toISOString(), reachable: null, version: '', notebooks: null, note: '' }

      scoped.effect(() =>
        webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler(_req, res) {
            const payload = {
              plugin: 'dsh-siyuan-api',
              ok: state.reachable !== false,
              apiUrl: client.config.apiUrl,
              tokenConfigured: client.config.token !== '',
              timeoutMs: client.config.timeoutMs,
              maxRows: client.config.maxRows,
              defaultNotebook: client.config.defaultNotebook,
              tools: toolNames,
              kernel: {
                reachable: state.reachable,
                version: state.version,
                notebooks: state.notebooks,
                note: state.note,
              },
              appliedAt: state.appliedAt,
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(payload, null, 2))
          },
        }),
      )

      if (debugLog) console.log(`[dsh-siyuan-api] 诊断路由已注册:${ROUTE}`)

      // 挂上后探一次活;失败只记录进 state,不影响任何装载。
      void (async () => {
        try {
          state.version = await getVersion(client)
          state.notebooks = (await listNotebooks(client)).length
          state.reachable = true
        } catch (error) {
          state.reachable = false
          state.note = error instanceof Error ? error.message : String(error)
        }
      })()
    })
    return true
  } catch (error) {
    if (debugLog) {
      console.log(
        `[dsh-siyuan-api] 诊断路由未能挂载(不影响工具):${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return false
  }
}
