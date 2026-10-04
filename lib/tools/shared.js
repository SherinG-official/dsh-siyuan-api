/**
 * 工具的公共部分:统一的输出契约、统一的错误话术。
 *
 * 每个工具都返回 `{ ok, message, ... }`:
 *   - `render` 只把 `message` 交给模型(其余字段留给 UI / 调试);
 *   - 失败也走正常返回值而不是抛异常 —— 思源没启动、Token 不对这类问题
 *     属于「工具没办成事」,不应该让整轮对话中断。
 *
 * @module dsh-siyuan-api/tools/shared
 */

import { SIYUAN_ERROR, SiYuanError } from '../client.js'

/**
 * 构造 `output` 声明:`message` 是模型唯一看到的东西。
 *
 * @param {(args: any, value: any) => string} [compose]
 *   当工具想用结构化字段拼 message 时传(默认直接用 value.message)。
 * @returns {{ schema: Record<string, unknown>, render: (args: any, value: any) => Array<{ type: 'text', text: string }> }}
 */
export function textOutput(compose) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        message: { type: 'string', required: true },
      },
    },
    render(args, value) {
      const text = compose ? compose(args, value) : value.message
      return [{ type: 'text', text: text === '' ? (value.ok ? '完成。' : '操作未完成。') : text }]
    },
  }
}

/** 成功结果的形状。 */
export function ok(message) {
  return { ok: true, message }
}

/** 失败结果的形状。 */
export function fail(message) {
  return { ok: false, message }
}

/**
 * 把任意异常翻成给模型看的失败结果。
 * 已知的 {@link SiYuanError} 直接用它的说明;未知异常兜一层,避免抛穿工具边界。
 *
 * @param {unknown} error
 * @returns {{ ok: false, message: string }}
 */
export function failFrom(error) {
  if (error instanceof SiYuanError) {
    return fail(`${error.message}`)
  }
  const detail = error instanceof Error ? error.message : String(error)
  return fail(`操作失败:${detail}`)
}

export { SIYUAN_ERROR }

/**
 * 判断一个字符串是不是思源 ID(22 位 `yyyyMMddHHmmss-xxxxxxx`)。
 * 用来区分「用户给的是笔记本 ID 还是笔记本名」。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeId(value) {
  return /^\d{14}-[0-9a-z]{7}$/i.test(String(value ?? '').trim())
}
