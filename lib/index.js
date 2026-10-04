/**
 * dsh-siyuan-api —— 让 DeepSeek Harness 直接读写思源笔记(SiYuan)。
 *
 * 设计要点:
 *   1. 只走思源内核的本地 HTTP API(默认 http://127.0.0.1:6806),不写思源插件、
 *      不碰工作区文件,所有改动都经内核事务层,思源能正常做索引与同步;
 *   2. 依赖只有 Node 内置 fetch,外加宿主已有的 `@deepseek-ai/dsh-tools`
 *      与 `@deepseek-ai/schemastery`,不引入第三方运行时依赖;
 *   3. 工具一律「正常返回失败」:思源没开、Token 不对、笔记本不存在都变成
 *      一句可照着排查的 message,而不是把整轮对话打断;
 *   4. 只读 SQL 在插件侧先做一次「单条 + SELECT/WITH」预检(内核同样会再校验),
 *      默认还会补 LIMIT,避免一次拉回整个索引库。
 *
 * 工具集:
 *   - siyuan_status     探活 + 自检(内核版本 / Token / 索引库规模)
 *   - siyuan_notebooks  列出笔记本(拿准确的名称与 ID)
 *   - siyuan_search     关键词搜索 / 只读 SQL 查询
 *   - siyuan_create_doc 在指定笔记本新建文档
 *   - siyuan_block      按块 ID 读原文、追加内容、前后插入
 *
 * @module dsh-siyuan-api
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_API_URL, DEFAULT_TIMEOUT_MS, createSiYuanClient, resolveClientConfig } from './client.js'
import { registerStatusRoute } from './route.js'
import { registerBlockTool } from './tools/block.js'
import { registerCreateDocTool } from './tools/create-doc.js'
import { registerNotebooksTool } from './tools/notebooks.js'
import { registerPingTool } from './tools/ping.js'
import { registerSearchTool } from './tools/search.js'

/** Cordis 插件名(loader 诊断用)。 */
export const name = 'dsh-siyuan-api'

/**
 * 需要的宿主服务。
 *
 * 关于 `webServer`:它只用于挂 `/dsh-siyuan-api/status` 诊断路由,但它**必须**
 * 写进 inject —— cordis 的 inject 语义是「等这些服务就绪再跑 apply」,而不是
 * 「缺了就崩」:没有 webServer 的宿主(headless / SDK / 没有 web-app 的裁剪配置)
 * 只会让本插件停在 PENDING,工具就不会注册了。所以这里采取的策略是:
 *   - inject 里**不写** webServer,保证任何宿主都能装载并注册工具;
 *   - 在 apply 里用 `ctx.get('webServer')` 探测(**只能**用 ctx.get,直接读
 *     `ctx.webServer` 会抛 "cannot get property without inject" 把装载搞挂),
 *     时机上晚于 host-webserver 的装载就挂路由,否则安静跳过。
 * 用 ctx.get 探测的代价是「谁先装谁后装」不确定,所以路由是尽力而为的增强项,
 * 而不是插件可用性的前提。
 */
export const inject = ['tools', 'systemPrompt']

/** 注册系统提示词段落的名字(诊断 / 排查时可 grep 它)。 */
export const PROMPT_SECTION = 'dsh-siyuan-api:guide'

/** 本插件注册的工具名。诊断路由、测试与文档共用这一份清单。 */
export const TOOL_NAMES = ['siyuan_status', 'siyuan_notebooks', 'siyuan_search', 'siyuan_create_doc', 'siyuan_block']

/** 插件配置。写进 profile 的 cordis.patch.yml 或设置页。 */
export const Config = z.object({
  apiUrl: z
    .string()
    .default(DEFAULT_API_URL)
    .description('思源内核 API 地址。桌面端默认 http://127.0.0.1:6806;填 IP:端口 或 https://域名/siyuan 也能识别。'),
  token: z
    .string()
    .default('')
    .description('思源 API Token(思源「设置 → 关于 → API token」)。留空则只对未设锁屏密码的本机内核有效。'),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS).description('单次内核请求超时(毫秒),默认 15000。'),
  maxRows: z.number().default(64).description('搜索 / SQL 单次返回的行数上限,默认 64,最大 1000。'),
  defaultNotebook: z
    .string()
    .default('')
    .description('默认笔记本(名称或 ID)。调用工具时没传 notebook 就用它;留空则必须先指定笔记本。'),
  prompt: z
    .boolean()
    .default(true)
    .description('是否把思源工具的使用规范注入系统提示词。关掉后模型仍可用工具,只是少了主动使用的引导。'),
  debug: z.boolean().default(false).description('打开后在宿主日志里打印解析后的配置与每次调用的地址(不含 Token 明文)。'),
})

/**
 * 系统提示词段落。放在汇总顺序 3000(内置工具之后、PTC/交付物之前),
 * 既能让模型在需要写笔记时想到这些工具,又不至于抢在最前面喧宾夺主。
 */
const PROMPT_ORDER = 3000

/** 工具都可见时才注入这段引导,插件被禁用 / 工具被 restrict 掉时不占提示词。 */
const PROMPT_TEXT = `## 思源笔记(SiYuan)

思源笔记是本机知识库,已通过 dsh-siyuan-api 插件接入。当用户提到「我的笔记」「思源」「知识库里」或需要把结论沉淀成文档时,用下面这些工具,不要靠猜:

- siyuan_status:连不上或报错时先自检(地址、Token、索引库)。
- siyuan_notebooks:拿到笔记本的准确名称与 ID。创建文档前不确定笔记本时先调它。
- siyuan_search:找内容。默认 mode=keyword 做关键词模糊搜索,返回块 ID、所属文档、笔记本与片段;需要统计 / 按标签、类型、时间筛选时用 mode=sql 写只读 SELECT(表 blocks/spans/attributes/refs/assets,列名见工具描述)。搜不到就换关键词,不要直接断言「笔记里没有」。
- siyuan_create_doc:在指定笔记本新建 Markdown 文档;建子文档用 parentID 或「父文档/子文档」标题。
- siyuan_block:mode=read 读某块原文(传文档 ID 得到整篇);mode=append / insert 追加或插入内容(必须带 confirm=true)。

约定:
1. 写入前先确认目标:用 siyuan_search 定位,或先用 siyuan_block(mode=read) 看清内容,别凭记忆直接改;
2. 引用笔记内容时要给出处(文档路径或块 ID),便于用户核对;
3. 搜索 / 建文档请带上 notebook 限定范围,避免在错误的本子里写东西;
4. 工具返回的失败信息里有具体原因(思源未启动、Token 失效、笔记本已关闭等),照它说的修,不要重复同样的调用。`

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context & { tools: any, systemPrompt: any }} ctx
 * @param {Record<string, unknown>} config 经 {@link Config} 校验后的配置。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveClientConfig(config)
  const debug = config.debug === true
  const client = createSiYuanClient(config)

  if (debug) {
    // 只打印地址与是否带 Token,不打印 Token 明文。
    console.log(
      `[dsh-siyuan-api] apiUrl=${resolved.apiUrl} token=${resolved.token === '' ? '(空)' : '(已设置)'} ` +
        `timeoutMs=${resolved.timeoutMs} maxRows=${resolved.maxRows} ` +
        `defaultNotebook=${resolved.defaultNotebook === '' ? '(未设置)' : resolved.defaultNotebook}`,
    )
    if (resolved.token === '') {
      // 只在 debug 下提示:没设锁屏密码的本地内核无需 Token,不该天天刷屏。
      console.log(
        '[dsh-siyuan-api] 未配置 API Token:只有「未设置锁屏密码」的本机内核会放行匿名访问。' +
          '若调用返回鉴权失败,请在思源「设置 → 关于 → API token」复制 Token 并填入插件配置的 token。',
      )
    }
  }

  // ---- 系统提示词:讲清什么时候用哪个工具、以及写入前的纪律 ----
  const promptEnabled = config.prompt !== false
  if (promptEnabled) {
    ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: ({ scope }) =>
        ctx.tools.get('siyuan_search', scope) === undefined && ctx.tools.get('siyuan_create_doc', scope) === undefined
          ? ''
          : PROMPT_TEXT,
    })
  }

  // ---- 工具注册 ----
  // register() 返回的 disposer 已经挂在插件 fiber 上(见 dsh-tools:它走 ctx.effect),
  // 插件热重载 / 关闭时宿主会自动摘掉,这里不需要手工清理。
  const deps = { client, config: { ...resolved, ...config } }
  registerPingTool(ctx, deps)
  registerNotebooksTool(ctx, deps)
  registerSearchTool(ctx, deps)
  registerCreateDocTool(ctx, deps)
  registerBlockTool(ctx, deps)

  // ---- 诊断路由(尽力而为:宿主有 webServer 时延迟挂载,细节见 route.js) ----
  // 纯属锦上添花,内部已兜住异常,绝不影响工具注册。
  registerStatusRoute(ctx, { client, toolNames: [...TOOL_NAMES], debugLog: debug })
}
