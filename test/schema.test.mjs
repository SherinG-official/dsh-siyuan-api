/**
 * 工具参数的**对外契约**检查 —— 也就是模型实际收到的那份 JSON Schema。
 *
 * 为什么单独测这一层:这些断言不碰任何 mock,直接读每个工具的声明。
 * 写错一个 `required`、忘了 `enum`、描述里漏掉关键约束,其它测试照样全绿,
 * 但模型会开始乱传参数。
 *
 * 关键事实:宿主 `defineTool` 会把作者写的参数 DSL **编译**成标准 JSON Schema ——
 * 属性上的 `required: true` 会消失,变成根节点的 `required: [...]` 数组。
 * 所以这里断言的是**编译后**的形状(和宿主一致;`test/stubs/dsh-tools` 复刻了同一套编译规则)。
 */

import { strict as assert } from 'node:assert'
import { before, test } from 'node:test'
import { validateArgs } from '@deepseek-ai/dsh-tools'
// 替身模块本身:用来断言「DSL -> 模型可见 schema」的编译规则没有被改坏。
// 装了真 dsh-tools 时这个 import 仍指向 test/stubs 里的同一份源码,所以断言恒成立。
import * as stubModule from './stubs/dsh-tools/index.js'
import { TOOL_NAMES, apply } from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

/** 注册一次,拿到所有编译后的工具定义。 */
const tools = new Map()
before(() => {
  const made = makeCtx()
  apply(made.ctx, { apiUrl: 'http://127.0.0.1:6806', token: 'x', prompt: false })
  for (const [name, definition] of made.tools) tools.set(name, definition)
})

/** 取某个参数在模型侧看到的 schema。 */
const propertyOf = (tool, key) => tools.get(tool).parameters.properties[key]

test('声明的工具名与 TOOL_NAMES 一致', () => {
  assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort())
})

test('parameters 是编译后的对象根 JSON Schema', () => {
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.type, 'object', `${name}.parameters 应为对象根`)
    assert.equal(typeof tool.parameters.properties, 'object', `${name}.parameters 应有 properties`)
    // 属性上不能再出现作者侧的 required 注解(它只应该出现在根节点)。
    for (const [key, node] of Object.entries(tool.parameters.properties)) {
      assert.equal('required' in node, false, `${name}.${key} 的 required 不应留在属性上`)
    }
    if (tool.parameters.required !== undefined) {
      assert.ok(Array.isArray(tool.parameters.required), `${name}.parameters.required 应为数组`)
    }
  }
})

test('每个工具都有可读的名称、描述与输出渲染', () => {
  for (const [name, tool] of tools) {
    assert.equal(tool.name, name, 'defineTool 的 name 必须与注册表键一致')
    assert.match(name, /^siyuan_[a-z_]+$/, `${name} 命名应统一为 siyuan_*`)
    assert.ok(tool.description.length > 60, `${name} 的描述太短,模型判断不了何时调用`)
    assert.match(tool.description, /思源/, `${name} 的描述应点明是思源相关能力`)
    assert.equal(typeof tool.output.render, 'function', `${name} 缺少 output.render`)
    assert.equal(tool.output.schema.type, 'object', `${name} 的输出应为对象`)
    assert.equal(typeof tool.execute, 'function')
  }
})

test('每个参数都有描述(模型的唯一说明来源)', () => {
  for (const [name, tool] of tools) {
    for (const [key, node] of Object.entries(tool.parameters.properties)) {
      assert.ok(typeof node.description === 'string' && node.description.length > 5, `${name}.${key} 缺少有意义的 description`)
      assert.ok(typeof node.type === 'string' || node.oneOf, `${name}.${key} 缺少 type`)
    }
  }
})

test('枚举参数的取值与实现一致', () => {
  assert.deepEqual(propertyOf('siyuan_search', 'mode').enum, ['keyword', 'sql'])
  assert.deepEqual(propertyOf('siyuan_block', 'mode').enum, ['read', 'append', 'insert'])
  assert.deepEqual(propertyOf('siyuan_block', 'dataType').enum, ['markdown', 'dom'])
  assert.deepEqual(propertyOf('siyuan_block', 'position').enum, ['before', 'after'])
})

test('必填参数就是实现真正要求的那些', () => {
  assert.deepEqual(Object.keys(tools.get('siyuan_notebooks').parameters.properties), [])
  assert.deepEqual(Object.keys(tools.get('siyuan_status').parameters.properties), ['probe'])
  assert.equal(tools.get('siyuan_notebooks').parameters.required, undefined, '无参工具不该有 required')

  assert.deepEqual(tools.get('siyuan_search').parameters.required, ['query'])
  assert.deepEqual(tools.get('siyuan_create_doc').parameters.required, ['title'])
  assert.deepEqual(tools.get('siyuan_block').parameters.required, ['id'])
})

test('写操作工具声明为非并发安全,只读工具可以并发', () => {
  assert.equal(tools.get('siyuan_search').isConcurrencySafe({ query: 'x' }), true)
  assert.equal(tools.get('siyuan_notebooks').isConcurrencySafe({}), true)
  assert.equal(tools.get('siyuan_create_doc').isConcurrencySafe({ title: 'x' }), false)
  assert.equal(tools.get('siyuan_block').isConcurrencySafe({ id: 'x' }), false)
})

test('参数校验能挡住缺必填与类型错误', () => {
  // validateArgs 吃的是作者侧 DSL(不是编译后的 schema),所以这里手持 DSL 校验。
  // 用同一份 DSL 做双向断言:合法输入必须过,非法输入必须被点名。
  const searchDsl = {
    query: { type: 'string', required: true },
    mode: { type: 'string', enum: ['keyword', 'sql'] },
    limit: { type: 'integer' },
  }
  assert.deepEqual(validateArgs(searchDsl, { query: '量子' }), [])
  assert.deepEqual(validateArgs(searchDsl, { query: '量子', mode: 'sql', limit: 5 }), [])
  assert.match(validateArgs(searchDsl, {}).join(';'), /query/)
  assert.match(validateArgs(searchDsl, { query: 42 }).join(';'), /query/)
  assert.match(validateArgs(searchDsl, { query: 'x', mode: 'delete' }).join(';'), /mode/)
  assert.match(validateArgs(searchDsl, { query: 'x', limit: 1.5 }).join(';'), /limit/)

  const blockDsl = {
    id: { type: 'string', required: true },
    mode: { type: 'string', enum: ['read', 'append', 'insert'] },
    dataType: { type: 'string', enum: ['markdown', 'dom'] },
    confirm: { type: 'boolean' },
  }
  assert.match(validateArgs(blockDsl, {}).join(';'), /id/)
  assert.match(validateArgs(blockDsl, { id: 'x', dataType: 'html' }).join(';'), /dataType/)
  assert.deepEqual(validateArgs(blockDsl, { id: 'x', confirm: true }), [])

  // 声明的 DSL 与编译结果必须一致:必填集合改一处,两处都要动。
  assert.deepEqual(tools.get('siyuan_search').parameters.required, ['query'])
  assert.deepEqual(
    Object.values(tools.get('siyuan_search').parameters.properties).filter((node) => 'required' in node),
    [],
  )
})

test('编译结果就是模型会收到的形状(防止替身与宿主跑偏)', () => {
  // 这条断言写死了「作者 DSL -> 模型可见 JSON Schema」的映射规则。
  // 如果哪天宿主的编译语义变了,它会先亮,而不是等模型开始乱传参数。
  const { compileParameters } = stubModule
  const compiled = compileParameters({
    id: { type: 'string', required: true, description: '块 ID' },
    mode: { type: 'string', enum: ['read', 'append'], description: '模式' },
    confirm: { type: 'boolean', description: '确认位' },
  })
  assert.deepEqual(compiled, {
    type: 'object',
    properties: {
      id: { type: 'string', description: '块 ID' },
      mode: { type: 'string', description: '模式', enum: ['read', 'append'] },
      confirm: { type: 'boolean', description: '确认位' },
    },
    required: ['id'],
  })
  assert.deepEqual(compileParameters({}), { type: 'object', properties: {} })
})

test('systemPrompt 段落里提到的工具名都真实存在', () => {
  const made = makeCtx()
  apply(made.ctx, { apiUrl: 'http://127.0.0.1:6806', token: 'x', prompt: true })
  assert.equal(made.sections.length, 1)
  const text = made.sections[0].text({ scope: undefined })
  const mentioned = [...text.matchAll(/siyuan_[a-z_]+/g)].map((m) => m[0])
  assert.ok(mentioned.length >= 5, '提示词里应点名工具')
  for (const name of new Set(mentioned)) {
    assert.ok(TOOL_NAMES.includes(name), `提示词提到的 ${name} 不存在`)
  }
})
