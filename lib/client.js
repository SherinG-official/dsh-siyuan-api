/**
 * 思源笔记内核 HTTP API 的最小客户端。
 *
 * 只依赖 Node 内置 fetch,不引入运行时依赖。职责边界:
 *   - 拼 URL、加鉴权头(Authorization: Token <token>)、超时 / 取消;
 *   - 拆内核统一响应信封 { code, msg, data },把失败翻译成带 code 的 SiYuanError;
 *   - 把「思源没开 / Token 不对 / 接口报错」区分成不同的错误码,
 *     让上层能给模型一句能照着排查的话。
 *
 * @module dsh-siyuan-api/client
 */

/** 内核默认监听端口。 */
export const DEFAULT_API_URL = 'http://127.0.0.1:6806'
/** 默认单请求超时(毫秒)。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 统一的错误码。前四个是本插件自己判定的「连不上/鉴权/协议」类问题,
 * 其余来自内核 error code 的归类。
 */
export const SIYUAN_ERROR = {
  /** 网络层失败:思源没启动、地址写错、端口不通。 */
  UNREACHABLE: 'SIYUAN_UNREACHABLE',
  /** 请求超时:思源在忙(索引重建、大查询),或地址指向了一个不响应的服务。 */
  TIMEOUT: 'SIYUAN_TIMEOUT',
  /** 鉴权失败:Token 缺失/过期,或配置地址不是内核。 */
  AUTH_FAILED: 'SIYUAN_AUTH_FAILED',
  /** 响应不是内核 JSON(常见于把 URL 配成了思源 Web 界面地址)。 */
  BAD_RESPONSE: 'SIYUAN_BAD_RESPONSE',
  /** 内核返回非 0 code。 */
  API_ERROR: 'SIYUAN_API_ERROR',
  /** 调用方参数不合法(插件侧校验,未发出请求)。 */
  INVALID_ARGUMENT: 'SIYUAN_INVALID_ARGUMENT',
  /** 请求被取消(用户中断)。 */
  ABORTED: 'SIYUAN_ABORTED',
}

/** 描述一次内核错误的基类。`code` 是上面的 SIYUAN_ERROR 之一。 */
export class SiYuanError extends Error {
  /**
   * @param {string} code 本模块定义的错误码。
   * @param {string} message 面向模型/用户的中文说明。
   * @param {{ status?: number, apiCode?: number, apiMsg?: string, url?: string, cause?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'SiYuanError'
    this.code = code
    if (details.status !== undefined) this.status = details.status
    if (details.apiCode !== undefined) this.apiCode = details.apiCode
    if (details.apiMsg !== undefined) this.apiMsg = details.apiMsg
    if (details.url !== undefined) this.url = details.url
  }
}

/** 内核 HTTP 401/403 的原文提示(便于判定,也便于原样透传给模型)。 */
const AUTH_HINT = '思源鉴权失败'

/**
 * 把用户填的地址整理成 `http://host:port/api` 形式。
 * 容错处理几种常见写法:`127.0.0.1:6806`、`http://127.0.0.1:6806/`、
 * `http://127.0.0.1:6806/api`、反向代理下的 `https://note.example.com/siyuan`。
 *
 * @param {string} [raw] 配置里的 apiUrl。
 * @returns {string} 不带尾部斜杠的 API 根地址。
 */
export function normalizeApiUrl(raw) {
  let value = String(raw ?? '').trim()
  if (value === '') value = DEFAULT_API_URL
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value
  value = value.replace(/\/+$/, '')
  if (value.endsWith('/api')) value = value.slice(0, -'/api'.length)
  return value + '/api'
}

/**
 * 归一化配置:补默认值、去空白、约束数值范围。
 * 与 schemastery 的 Config 保持同一套语义,单独抽出来是为了能在没装
 * schemastery 的场景(测试/脚本)复用。
 *
 * @param {Record<string, unknown>} [config] 插件配置。
 * @returns {{ apiUrl: string, token: string, timeoutMs: number, maxRows: number, defaultNotebook: string }}
 */
export function resolveClientConfig(config = {}) {
  const toInt = (value, fallback, min, max) => {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  const tokenFromEnv = typeof process !== 'undefined' ? process.env?.SIYUAN_TOKEN : undefined
  const token = String(config.token ?? '').trim() || String(tokenFromEnv ?? '').trim()
  return {
    apiUrl: normalizeApiUrl(config.apiUrl),
    token,
    timeoutMs: toInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 300_000),
    maxRows: toInt(config.maxRows, 64, 1, 1000),
    defaultNotebook: String(config.defaultNotebook ?? '').trim(),
  }
}

/** 组合「配置超时」与「调用方取消信号」,返回 { signal, dispose }。 */
function withTimeout(timeoutMs, signal) {
  if (timeoutMs <= 0) return { signal, dispose() {} }
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
  return { signal: combined, dispose() {} }
}

/**
 * 内核响应信封。老版本 / 少数端点可能直接返回裸数据,所以这里两种都认:
 * 有 `code` 字段就当信封,否则把整个 body 当 data。
 *
 * @param {unknown} body 已解析的 JSON。
 * @returns {{ enveloped: boolean, code: number, msg: string, data: unknown }}
 */
export function unwrapEnvelope(body) {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'code' in body) {
    const record = /** @type {Record<string, unknown>} */ (body)
    const code = typeof record.code === 'number' ? record.code : Number(record.code) || 0
    return {
      enveloped: true,
      code,
      msg: typeof record.msg === 'string' ? record.msg : '',
      data: record.data,
    }
  }
  return { enveloped: false, code: 0, msg: '', data: body }
}

/**
 * 从 data 里再剥一层同名包装(`data.notebooks`、`data.blocks`……)。
 * 内核有的端点直接给数组/对象,有的给一层命名包装,统一在这里抹平。
 *
 * @param {unknown} data 信封里的 data。
 * @param {string} [key] 期望的包装键。
 * @returns {unknown} 剥壳后的值。
 */
export function pickPayload(data, key) {
  if (key && data !== null && typeof data === 'object' && !Array.isArray(data) && key in data) {
    return /** @type {Record<string, unknown>} */ (data)[key]
  }
  return data
}

/** 从正则匹配里取第一个捕获组,失败返回 null。 */
function matchOne(text, regex) {
  const m = regex.exec(text)
  return m ? m[1] : null
}

/**
 * 把内核的 HTTP 错误响应翻成能照着排查的说明。
 * @param {string} text 响应体原文。
 * @param {number} status HTTP 状态码。
 * @returns {string}
 */
function describeHttpFailure(text, status) {
  if (status === 401 || status === 403) {
    const msg = matchOne(text, /"msg"\s*:\s*"([^"]*)"/)
    return msg
      ? `${AUTH_HINT}(HTTP ${status}):${msg}`
      : `${AUTH_HINT}(HTTP ${status})。请检查「设置 → 关于 → API token」与插件配置里的 token 是否一致。`
  }
  if (status === 404) {
    return `思源内核未找到该接口(HTTP 404)。请确认 apiUrl 指向内核地址(默认 http://127.0.0.1:6806),而不是思源 Web 界面地址。`
  }
  return `思源内核返回 HTTP ${status}: ${text.slice(0, 300)}`
}

/**
 * 创建一个思源内核客户端。
 *
 * @param {Record<string, unknown>} [config] 见 {@link resolveClientConfig}。
 * @param {{ fetch?: typeof fetch }} [deps] 注入 fetch(测试用)。
 * @returns {{
 *   config: ReturnType<typeof resolveClientConfig>,
 *   request: (endpoint: string, payload?: unknown, options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<unknown>,
 *   requestRaw: (endpoint: string, payload?: unknown, options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<{ body: unknown, text: string, status: number }>,
 * }}
 */
export function createSiYuanClient(config = {}, deps = {}) {
  const resolved = resolveClientConfig(config)
  const doFetch = deps.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new SiYuanError(SIYUAN_ERROR.BAD_RESPONSE, '当前运行环境没有可用的 fetch,无法访问思源内核。')
  }

  /**
   * 拼出完整请求地址。
   * 同时接受两种写法:`/system/version`(相对 API 根)与 `/api/system/version`(内核路由原文),
   * 免得调用方为了「这个函数要不要带 /api」反复核对。
   *
   * @param {string} endpoint
   * @returns {string}
   */
  function resolveUrl(endpoint) {
    const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint
    if (path === '/api' || path.startsWith('/api/')) return resolved.apiUrl.replace(/\/api$/, '') + path
    return resolved.apiUrl + path
  }

  /**
   * 发一次 POST 并原样返回解析结果(不抛 API 错误),供 ping 之类需要
   * 观察原始 code 的场景使用。
   *
   * @param {string} endpoint `/api/...` 结尾的路径。
   * @param {unknown} [payload] 请求体。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   */
  async function requestRaw(endpoint, payload = {}, options = {}) {
    const url = resolveUrl(endpoint)
    const headers = { 'Content-Type': 'application/json' }
    if (resolved.token !== '') headers.Authorization = 'Token ' + resolved.token

    const timeoutMs = options.timeoutMs ?? resolved.timeoutMs
    const { signal } = withTimeout(timeoutMs, options.signal)

    let response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal,
      })
    } catch (error) {
      const name = error && typeof error === 'object' ? error.name : ''
      if (name === 'TimeoutError') {
        throw new SiYuanError(
          SIYUAN_ERROR.TIMEOUT,
          `请求思源超时(${timeoutMs} ms):${url}。思源可能在重建索引或执行大查询,可稍后重试或调大 timeoutMs。`,
          { cause: error, url },
        )
      }
      if (name === 'AbortError') {
        throw new SiYuanError(SIYUAN_ERROR.ABORTED, '思源请求已取消。', { cause: error, url })
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new SiYuanError(
        SIYUAN_ERROR.UNREACHABLE,
        `连不上思源内核(${url}):${detail}。请确认思源已启动、apiUrl 正确(默认 http://127.0.0.1:6806)。`,
        { cause: error, url },
      )
    }

    const text = await response.text().catch(() => '')
    let body
    let parseFailed = false
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      parseFailed = true
      body = null
    }

    if (!response.ok) {
      throw new SiYuanError(
        response.status === 401 || response.status === 403 ? SIYUAN_ERROR.AUTH_FAILED : SIYUAN_ERROR.API_ERROR,
        describeHttpFailure(text, response.status),
        { status: response.status, url },
      )
    }

    if (parseFailed) {
      const looksLikeHtml = /^\s*</.test(text)
      throw new SiYuanError(
        SIYUAN_ERROR.BAD_RESPONSE,
        looksLikeHtml
          ? `${url} 返回的是 HTML 而不是内核 JSON —— 这个地址多半是思源 Web 界面。请把 apiUrl 改成内核地址(默认 http://127.0.0.1:6806)。`
          : `${url} 返回了无法解析的内容(不是 JSON):${text.slice(0, 200)}`,
        { status: response.status, url },
      )
    }

    return { body, text, status: response.status }
  }

  /**
   * 发一次内核请求并在 code !== 0 时抛错。
   *
   * 返回值是**整个响应体**:内核在信封里除了 `data` 还会带别的顶层字段
   * (例如 `/api/query/sql` 的 `limit` / `truncated`),丢掉就再也看不到了。
   * 绝大多数调用方只关心 data —— 直接用 `requestPayload()` 更省事。
   *
   * @param {string} endpoint `/api/...` 结尾的路径。
   * @param {unknown} [payload] 请求体。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<unknown>} 内核响应体(信封或裸数据)。
   */
  async function requestRawChecked(endpoint, payload = {}, options = {}) {
    const { body, status } = await requestRaw(endpoint, payload, options)
    const envelope = unwrapEnvelope(body)
    if (envelope.enveloped && envelope.code !== 0) {
      const detail = envelope.msg === '' ? '(内核未给出 msg)' : envelope.msg
      const authLike = /auth|token|forbidden|permission|权限|鉴权|解锁|锁屏/i.test(detail)
      throw new SiYuanError(
        authLike ? SIYUAN_ERROR.AUTH_FAILED : SIYUAN_ERROR.API_ERROR,
        `思源接口 ${endpoint} 报错(code=${envelope.code}):${detail}`,
        { status, apiCode: envelope.code, apiMsg: envelope.msg, url: resolveUrl(endpoint) },
      )
    }
    return body
  }

  /**
   * 与 {@link requestRawChecked} 相同,但只返回信封里的 `data`。
   *
   * @param {string} endpoint
   * @param {unknown} [payload]
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<unknown>}
   */
  async function request(endpoint, payload = {}, options = {}) {
    return unwrapEnvelope(await requestRawChecked(endpoint, payload, options)).data
  }

  return { config: resolved, request, requestRaw, requestRawChecked }
}
