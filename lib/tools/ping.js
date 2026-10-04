/**
 * `siyuan_status` —— 探活与自检。
 *
 * 只读、无副作用,用来回答三个问题:
 *   1. 插件到底连上了哪个思源内核?
 *   2. Token、地址是否可用?
 *   3. 索引库能否查询(顺便给个规模数字,让模型知道这库有多大)?
 *
 * `/api/system/version` 通常不需要鉴权,所以它能区分「连不上」
 * 和「连上了但 Token 不对」这两种在排查时差别很大的情况。
 *
 * @module dsh-siyuan-api/tools/ping
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { SIYUAN_ERROR, SiYuanError, unwrapEnvelope } from '../client.js'
import { asArray, querySql } from '../api.js'
import { failFrom, ok, textOutput } from './shared.js'

/** 按块类型统计规模时最多列几类。 */
const TYPE_LIMIT = 12

/**
 * 注册 `siyuan_status`。
 *
 * @param {{ tools: { register: (definition: unknown) => unknown } }} ctx 插件上下文。
 * @param {{ client: import('../client.js').SiYuanClient }} deps
 */
export function registerPingTool(ctx, deps) {
  const { client } = deps

  ctx.tools.register(
    defineTool({
      name: 'siyuan_status',
      description:
        '检查思源笔记(SiYuan)连接是否正常:内核版本、API 地址、Token 是否有效、索引库能否查询、库里有多少块。' +
        '在搜索 / 创建文档失败,或用户问「能不能连上思源」时,先调它做一次自检,再根据返回的提示修复配置。它不会修改任何数据。',
      parameters: {
        probe: {
          type: 'boolean',
          description: '是否顺带查询索引库做一次真实 SQL 自检(默认 true)。只想看版本 / 地址时传 false。',
        },
      },
      output: textOutput((_args, value) => value.message),
      timeoutMs: client.config.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const probe = args.probe !== false
        try {
          const { body } = await client.requestRaw('/api/system/version', {}, { signal: exec.signal })
          const envelope = unwrapEnvelope(body)
          const version = typeof envelope.data === 'string' ? envelope.data : ''
          const lines = [
            `地址:${client.config.apiUrl}`,
            `Token:${client.config.token === '' ? '未配置(仅能访问未设锁屏密码的本地内核)' : `已配置(${client.config.token.slice(0, 3)}***)`}`,
            `内核版本:${version === '' ? '未知' : version}`,
            '连通性:正常',
          ]
          if (!probe) return ok(lines.join('\n'))

          try {
            const { rows } = await querySql(client, 'SELECT COUNT(*) AS n FROM blocks LIMIT 1', { signal: exec.signal })
            const total = rows[0]?.n ?? rows[0]?.N ?? rows[0]?.['COUNT(*)']
            lines.push(`索引库:可查询,共 ${String(total ?? '?')} 个块`)
            const types = await querySql(
              client,
              `SELECT type, COUNT(*) AS n FROM blocks GROUP BY type ORDER BY n DESC LIMIT ${TYPE_LIMIT}`,
              { signal: exec.signal },
            )
            const detail = asArray(types.rows)
              .map((row) => `${String(row.type ?? '?')}:${String(row.n ?? '?')}`)
              .join(' ')
            if (detail !== '') lines.push(`块类型分布:${detail}`)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            lines.push(`索引库:查询失败 —— ${message}`)
            lines.push('(索引可能正在重建。多在思源里等索引进度走完,或换一个读写点再试。)')
          }
          return ok(lines.join('\n'))
        } catch (error) {
          if (error instanceof SiYuanError && error.code === SIYUAN_ERROR.UNREACHABLE) {
            return ok(
              `连不上思源内核(${client.config.apiUrl})。\n` +
                '请确认:\n' +
                '1. 思源笔记已启动(窗口最小化到托盘也行,内核必须活着);\n' +
                '2. 配置的 apiUrl 与思源实际监听地址一致(桌面端默认 127.0.0.1:6806,可在「设置 → 关于」看到);\n' +
                '3. 如果改过端口或开了「网络伺服」,把端口一起写进 apiUrl。\n' +
                `原始错误:${error.message}`,
            )
          }
          if (error instanceof SiYuanError && error.code === SIYUAN_ERROR.AUTH_FAILED) {
            return ok(
              `思源可达,但鉴权失败。\n` +
                '请在思源「设置 → 关于 → API token」复制 Token,填到插件配置的 token 里(或在思源里清空锁屏密码 / API token 以允许本机免鉴权访问)。\n' +
                `原始错误:${error.message}`,
            )
          }
          return failFrom(error)
        }
      },
    }),
  )
}
