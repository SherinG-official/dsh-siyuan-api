/**
 * `@deepseek-ai/dsh-tools` 的测试替身。
 *
 * ## 为什么需要它
 *
 * `@deepseek-ai/dsh-tools` 在 npm 上的 `latest` tag 停在 `0.0.1-rc.1`,而 dsh 实际装载的是
 * `0.1.x-rc.x`;更麻烦的是**它运行时真的会 import `@deepseek-ai/cordis`**,而每个版本都声明了
 * 一长串 `@deepseek-ai/dsh-*` peer 依赖 —— 在干净的 CI 里装它等于把整棵 dsh 依赖树拉下来。
 *
 * 所以测试装的是这个替身。它必须实现本插件真正依赖的那部分契约,而且要**实现得像**:
 * 插件在 `apply` 里调 `defineTool(options)` 拿回定义对象,只有两个字段会被真正使用 ——
 * `output.render`(渲染给模型的文本)和 `execute`(执行)。其余字段是宿主读的。
 *
 * ## 关键契约:`parameters` 是**编译后**的 JSON Schema
 *
 * 真 `defineTool` 会把作者写的参数 DSL(逐属性 `required: true`)**编译**成一份标准 JSON Schema:
 *
 * ```js
 * // 输入(作者写法)
 * parameters: { a: { type: 'string', required: true, description: 'A' } }
 * // 输出(模型看到的)
 * { type: 'object', properties: { a: { type: 'string', description: 'A' } }, required: ['a'] }
 * ```
 *
 * 注意 `required` 从属性上**消失**了,变成根节点的数组。替身必须复刻这一点:
 * 否则测试会去断言一个模型根本收不到的形状 —— 这正是接手这个仓库时实际踩到的坑
 * (用真包跑测试时,4 条「参数契约」用例全挂)。
 *
 * 同理,`additionalProperties` 不会被投影到属性里,`type: 'json'` 只是作者侧的「任意 JSON」标记。
 *
 * ## 边界
 *
 * 覆盖的是**本插件的逻辑**(参数处理、SQL 生成、渲染、错误话术)和**它发布的参数契约**,
 * 不是宿主的行为。真机装载由 `verify-boot.mjs` 负责,那一层跑的是真 dsh、真 dsh-tools。
 *
 * @module dsh-siyuan-api/test/stubs/dsh-tools
 */

/** 参数声明里的类型名 -> 运行时判定(用于 validateArgs)。 */
const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  json: () => true,
}

/**
 * 把作者侧的值声明投影成 JSON Schema 节点。
 * `required` 是属性级注解,不写进节点(与真 defineTool 一致)。
 *
 * @param {Record<string, any>} spec 属性声明。
 * @returns {Record<string, unknown>} JSON Schema 节点。
 */
function compileValueSchema(spec) {
  if (Array.isArray(spec.oneOf)) {
    return { oneOf: spec.oneOf.map((branch) => compileValueSchema(branch)) }
  }
  const node = { type: spec.type === 'json' ? undefined : spec.type }
  if (typeof spec.description === 'string') node.description = spec.description
  if (typeof spec.title === 'string') node.title = spec.title
  if (spec.default !== undefined) node.default = spec.default
  if (spec.examples !== undefined) node.examples = spec.examples
  if (Array.isArray(spec.enum)) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  if (spec.type === 'array' && spec.items) node.items = compileValueSchema(spec.items)
  if (spec.type === 'object') {
    node.properties = compileParameters(spec.properties ?? {})
    if (spec.additionalProperties !== undefined) node.additionalProperties = spec.additionalProperties
  }
  if (node.type === undefined) delete node.type
  return node
}

/**
 * 编译隐式参数对象:逐属性投影 + 把 `required: true` 收集成根节点的 `required` 数组。
 *
 * @param {Record<string, any>} spec 参数声明表。
 * @returns {{ type: 'object', properties: Record<string, unknown>, required?: string[] }}
 */
export function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, declaration] of Object.entries(spec ?? {})) {
    properties[key] = compileValueSchema(declaration)
    if (declaration?.required === true) required.push(key)
  }
  const compiled = { type: 'object', properties }
  if (required.length > 0) compiled.required = required
  return compiled
}

/**
 * 按参数声明校验实参。与宿主一致:必填缺失、类型不符、enum 越界都算违规,
 * 返回按路径描述的违规列表(空数组 = 通过)。
 *
 * @param {Record<string, any>} spec 参数声明(作者侧 DSL,不是编译后的 schema)。
 * @param {unknown} args 实参。
 * @returns {string[]} 违规描述。
 */
export function validateArgs(spec, args) {
  const violations = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['<args>: 必须是对象']
  }
  for (const [key, declaration] of Object.entries(spec ?? {})) {
    const value = /** @type {any} */ (args)[key]
    if (value === undefined) {
      if (declaration.required === true) violations.push(`${key}: 缺少必填参数`)
      continue
    }
    const expected = declaration.type
    const check = expected ? TYPE_CHECKS[expected] : null
    if (check && !check(value)) {
      violations.push(`${key}: 期望 ${expected},收到 ${Array.isArray(value) ? 'array' : typeof value}`)
      continue
    }
    if (Array.isArray(declaration.enum) && !declaration.enum.includes(value)) {
      violations.push(`${key}: 只接受 ${declaration.enum.join(' / ')},收到 ${JSON.stringify(value)}`)
    }
  }
  return violations
}

/**
 * 与宿主同名的工具声明入口:校验定义完整性,并把参数 DSL 编译成 JSON Schema。
 *
 * @param {Record<string, any>} options 工具定义。
 * @returns {Record<string, any>} 供注册的 `ToolDefinition`。
 */
export function defineTool(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool 需要一个定义对象')
  if (typeof options.name !== 'string' || options.name === '') throw new Error('defineTool 需要非空 name')
  if (typeof options.description !== 'string' || options.description === '') {
    throw new Error(`工具 ${options.name} 缺少 description`)
  }
  if (typeof options.execute !== 'function') throw new Error(`工具 ${options.name} 缺少 execute`)
  if (!options.output || typeof options.output.render !== 'function') {
    throw new Error(`工具 ${options.name} 缺少 output.render`)
  }
  return { ...options, parameters: compileParameters(options.parameters ?? {}) }
}

export default { defineTool, validateArgs, compileParameters }
