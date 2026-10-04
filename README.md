# dsh-siyuan-api

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-51%20passing-brightgreen.svg)](test/)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)直接读写
[思源笔记](https://b3log.org/siyuan/)(SiYuan)的插件。

走思源**内核 HTTP API**(默认 `http://127.0.0.1:6806`),不装思源插件、不碰工作区文件、不直接改 `siyuan.db` ——
所有写入都经内核事务层,思源能正常做索引与同步。

| 工具 | 干什么 |
|---|---|
| `siyuan_status` | 探活自检:内核版本、Token 是否有效、索引库能否查询、库里有多少块 |
| `siyuan_notebooks` | 列出笔记本(拿准确的名称与 ID) |
| `siyuan_search` | 搜内容:`mode=keyword` 关键词模糊搜索,`mode=sql` 只读 SELECT |
| `siyuan_create_doc` | 在指定笔记本新建 Markdown 文档(可指定父文档) |
| `siyuan_block` | 按块 ID 读 Markdown 原文、追加内容(`append`)、前后插入(`insert`) |

除了工具,插件还会往系统提示词里注入一小段使用规范(可用 `prompt: false` 关掉),
并在有 HTTP 宿主时挂一个只读诊断路由 `GET /dsh-siyuan-api/status`。

**不需要装思源插件,也不需要 Python** —— 运行时只用 Node 内置的 `fetch`。

---

## 1. 安装

### 1.1 从本地目录 / tarball 安装

```sh
# 打成 tarball(路径里不要有空格,pnpm 的 file: 依赖会被空格切断)
node <pnpm> pack --pack-destination C:/somewhere/no-spaces

# 装进目标 profile(web / headless / 你自己的 profile)
dsh plugin --profile web add "file:C:/somewhere/no-spaces/dsh-siyuan-api-0.1.2.tgz"
```

`dsh plugin add` 会自动同时做两件事:写入 profile 的 `dependencies`,并把包名加进
`dsh.profile.bundles`。装完重启该 profile 即可生效。

### 1.2 desktop profile(Electron 桌面端)

`dsh plugin --profile desktop …` 被 CLI 显式拒绝(桌面端 profile 由 Electron 独占),
需要手工改清单,或用本包附带的脚本:

```sh
node scripts/add-to-profile.mjs \
  "$DSH_HOME/profiles/desktop/package.json" \
  "C:/somewhere/no-spaces/dsh-siyuan-api-0.1.2.tgz"

# 然后在 profile 目录里装依赖(用 profile 自己的 pnpm 配置,不要加 --ignore-workspace)
cd "$DSH_HOME/profiles/desktop" && pnpm install
```

改完重启 DSH Desktop 生效。

### 1.3 依赖说明

运行时只需要 Node 内置 `fetch`。`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`、
`@deepseek-ai/schemastery` 都由 **dsh 宿主**提供(通过 `$DSH_HOME/profiles/node_modules`
的符号链接解析),所以刻意**没有**写进 `dependencies`:

- 写成 `dependencies` 会让 profile 的 `pnpm install` 去 npm 拉一份宿主私有版本,直接失败;
- 写成 `peerDependencies` 同样会被 pnpm 解析并下载,还会锁死版本区间。

`schemastery` 保留为可选 peer(版本与宿主一致时用得上,缺了也不影响插件装载)。

---

## 2. 配置

### 2.1 思源侧准备

1. 思源要**处于运行状态**。窗口最小化到托盘也算(内核是独立进程),但真正退出就没了。
2. 记下内核地址。桌面端默认 `127.0.0.1:6806`;如果你在思源里改过端口或开了「网络伺服」,
   就用实际地址(思源「设置 → 关于」能看到)。
3. 拿 API Token:思源「设置 → 关于 → API token」(老版本在「设置 → 关于」)。
   - **没设锁屏密码时**,本机访问(127.0.0.1)免鉴权,Token 可以留空;
   - 设了锁屏密码、或要让 dsh 走非 127.0.0.1 访问时,必须填 Token。

### 2.2 插件配置项

写进 profile 的 `cordis.patch.yml`(按行 id 覆盖),或用设置页:

```yaml
- id: dsh-siyuan-api
  name: dsh-siyuan-api
  config:
    apiUrl: http://127.0.0.1:6806   # 内核地址;填 127.0.0.1:6806 这种简写也认
    token: ''                       # 思源 API Token;留空 = 只访问免鉴权的本机内核
    timeoutMs: 15000                # 单请求超时
    maxRows: 64                     # 搜索 / SQL 单次返回行数上限(1-1000)
    defaultNotebook: ''             # 默认笔记本(名称或 ID);留空则每次都要显式指定
    prompt: true                    # 是否注入系统提示词使用规范
    debug: false                    # 打开后在宿主日志里打印解析后的配置(不含 Token 明文)
```

也可以把 Token 放在环境变量 `SIYUAN_TOKEN` 里(配置文件里留空即可,配置文件优先)。

> 提示:`!!js` 表达式在 patch 里可用,所以 Token 不必落盘在配置里,例如
> `token: !!js process.env.SIYUAN_TOKEN || ''`。

### 2.3 自检

装好后先问一句「思源连上了吗」,或直接调 `siyuan_status`。也可以打开诊断路由
(仅 web profile 有):

```
http://127.0.0.1:<dsh端口>/dsh-siyuan-api/status
```

它只报事实(地址、是否配 Token、工具清单、内核版本、笔记本数),不回显 Token。

---

## 3. 工具用法

### `siyuan_search` —— 找内容

| 参数 | 说明 |
|---|---|
| `query` | 必填。`keyword` 模式给关键词(中文 / 英文、不分大小写、支持子串);`sql` 模式给完整 SELECT |
| `mode` | `keyword`(默认)/ `sql` |
| `notebook` | 可选,限定笔记本(名称或 ID) |
| `limit` | 可选,返回条数(默认 20,上限 = `maxRows`) |

关键词模式覆盖 `blocks` 表的 `content`(正文)、`name`(标题)、`alias`(别名)、`memo`(备注),
返回块 ID、所属文档、笔记本、路径、片段与更新时间 —— 这些 ID 就是后面
`siyuan_block` / `siyuan_create_doc(parentID)` 的输入。

`sql` 模式可查的表(`blocks` 为主):

```
blocks(id, parent_id, root_id, box, path, hpath, name, alias, memo, tag,
       content, fcontent, markdown, length, type, subtype, ial, sort, created, updated)
spans(id, block_id, root_id, box, path, content, markdown, type, ial)
attributes(id, name, value, type, block_id, root_id, box, path)
refs(id, def_block_id, def_block_root_id, def_block_path, block_id, root_id, box, path, content, markdown, type)
assets(id, block_id, root_id, box, docpath, path, name, title, hash)
file_annotation_refs(...)
```

- `box` = 笔记本 ID;`root_id` = 所属文档 ID;`hpath` = 人类可读路径;`markdown` = Markdown 源文;
- `type`:`d` 文档、`h` 标题、`p` 段落、`l` 列表、`i` 列表项、`b` 引述、`t`/`tb` 表格、`c` 代码块、`m` 公式块、`s` 超级块、`av` 数据库;
- `subtype`:标题是 `h1..h6`,列表 / 列表项是 `u`(无序)`o`(有序),其余为空;
- 行内标记(加粗、链接、标签)在 `spans` 里,不在 `blocks`;标签值在 `blocks.tag` 与 `ial` 里都有。

例子:

```sql
-- 最近改过的 10 篇文档
SELECT id, content, hpath, updated FROM blocks WHERE type = 'd' ORDER BY updated DESC LIMIT 10
-- 各笔记本的块数量
SELECT box, COUNT(*) AS n FROM blocks GROUP BY box ORDER BY n DESC
-- 带「TODO」的段落
SELECT id, hpath, content FROM blocks WHERE type = 'p' AND content LIKE '%TODO%' LIMIT 20
```

### `siyuan_create_doc` —— 新建文档

| 参数 | 说明 |
|---|---|
| `title` | 必填,文档标题(也是文件名)。写「父文档/子文档」可建一层子文档 |
| `notebook` | 目标笔记本名称或 ID;不传则用 `defaultNotebook` |
| `markdown` | 正文,标准 Markdown(省略则建空文档,之后用 `siyuan_block` 追加) |
| `parentID` | 可选,父文档 ID(来自 `siyuan_search`),优先级高于标题里的 `/` |

写入前请确认目标:笔记本用 `siyuan_notebooks` 查,父文档用 `siyuan_search` 定位。

### `siyuan_block` —— 读写某个块

| 参数 | 说明 |
|---|---|
| `id` | 必填,块 ID(22 位,形如 `20260919135122-lw63vfz`)。传文档 ID 就是整篇文档 |
| `mode` | `read`(默认)/ `append`(追加为子块)/ `insert`(前后插入同级块) |
| `data` | `append` / `insert` 要写的内容(Markdown;`dataType=dom` 时是思源块 DOM) |
| `position` | `insert` 的位置:`before`(默认)/ `after` |
| `confirm` | `append` / `insert` 必须显式传 `true`,否则拒绝执行 |

`confirm` 是刻意的摩擦:先 `mode=read` 看清目标,再带着 `confirm=true` 落笔,
比事后回滚便宜。

---

## 4. 设计要点

**错误处理:失败也是正常返回。** 思源没启动、Token 不对、笔记本不存在 / 已关闭、
块 ID 抄错 —— 这些都变成一句能照着排查的 `message`,而不是抛异常打断整轮对话。
错误按原因分了码(`SIYUAN_UNREACHABLE` / `SIYUAN_TIMEOUT` / `SIYUAN_AUTH_FAILED` /
`SIYUAN_BAD_RESPONSE` / `SIYUAN_API_ERROR` / `SIYUAN_INVALID_ARGUMENT`),
文案里直接给出下一步动作,例如把 API 地址错配成思源 Web 界面地址时会明确说
「这个地址多半是 Web 界面,请改成内核地址」。

**只读 SQL 是双保险。** 插件侧先做「单条 + SELECT/WITH」预检(带注释 / 引号内分号处理),
再给没写 `LIMIT` 的语句补上上限;发请求时**始终带 `mode: "readonly"`** ——
思源 3.8.x 的内核只在 `mode=readonly` 时才真正做只读校验,默认 mode 并不拦写操作,
不能把「不写坏数据」寄托在自己的正则上。内核返回的 `truncated` / `limit` 也会转述给模型,
免得它把「被截断的结果」当成全部。

**笔记本解析。** 模型更可能说「运维笔记」而不是 22 位 ID,所以 `notebook` 参数
接受 ID、精确名称、唯一子串;匹配不到时报错里直接列出所有可用笔记本,
模型能立刻换个说法重试,不用回头问用户。

**webServer 是延迟注入的。** `dsh-host-webserver` 属于 `@deepseek-ai/dsh-web-app`,
不在 `dsh-base` 里 —— headless / SDK / ACP 这些 profile 根本没有这个服务。
把 `webServer` 写进 `inject` 会让插件在那些宿主里永远停在 PENDING(工具也注册不上);
直接读 `ctx.webServer` 又会被 cordis 抛 `cannot get property "webServer" without inject`
并把装载搞挂。所以实现用 `ctx.inject(['webServer'], …)` 起一个子 fiber:
服务就绪才挂路由,没有就安静待命,工具在任何宿主都正常。

---

## 5. 开发

```sh
# 单元测试 + 端到端(假内核,不需要真思源)
node --test "test/*.test.mjs"

# 真启动一个 dsh 实例验证插件装载(独立假内核 + 独立端口,不动你正在用的 GUI)
node verify-boot.mjs --profile web --port 19401
```

`verify-boot.mjs` 会:起一个假思源内核 → 用 `--patch verify-patch.yml` 覆盖插件配置 →
启动 `dsh --profile <p> --port <n> --no-open` → 请求插件的诊断路由 →
核对「5 个工具都注册了 + 内核可达」。这是**真机装载**验证,能抓出单测抓不到的问题
(比如上面那条 `without inject` 的装载崩溃,就是它发现的)。

目录结构:

```
lib/
  index.js        插件入口:Config 声明、系统提示词注入、工具注册
  client.js       内核 HTTP 客户端:URL 归一化、Token 头、信封解析、错误分类
  api.js          端点语义化封装(一函数一接口)
  sql.js          只读 SQL 预检、LIMIT 处理
  format.js       把内核数据渲染成模型可读文本
  route.js        /dsh-siyuan-api/status 诊断路由(延迟注入 webServer)
  tools/          五个工具的 defineTool 声明
docs/             思源内核 HTTP API 实现参考(字段级,含版本矩阵)
test/             客户端 / SQL / 工具 / 诊断路由的测试
scripts/          add-to-profile.mjs:往 desktop profile 清单里写插件行
verify-boot.mjs   真机装载验证(可选)
verify-patch.yml  验证时用的配置覆盖层
```

`verify-boot.mjs` 用 `DSH_HOME` 定位 profile(未设置时按主目录推导),必要时可显式指定:
`node verify-boot.mjs --dsh /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。

改了代码后重新验证的完整流程:

```sh
node <pnpm> pack --pack-destination C:/somewhere/no-spaces
cd "$DSH_HOME/profiles/<p>" && pnpm install --force   # 同版本 tarball 需要强制重装
```

### 5.1 内核接口参考

[docs/siyuan-kernel-api-reference.md](docs/siyuan-kernel-api-reference.md) 是思源内核 HTTP API 的字段级参考
(约 1120 行,对着 **v3.8.6 源码**逐条核对):鉴权矩阵、响应信封约定、端点清单、`blocks` 等表的完整列名、
`type`/`subtype` 取值、错误码、以及一堆容易踩的坑(例如 `fullTextSearchBlock` 的 `orderBy` 语义与社区文档
**不同**、`/api/query/sql` 默认不拦写操作、`blocks.tag` 与 IAL 的关系)。扩展这个插件、或写别的思源桥接时
先看它,可以省掉重新翻 Go 源码的时间。

---

## 6. 已知限制

- **只读的边界靠内核**:插件带 `mode:"readonly"`,但思源 ≤3.1.x 没有这个字段,会忽略它;
  那些版本上「不写坏数据」完全依赖插件侧的正则预检。建议思源 3.8.x 及以上。
- **关键词搜索走 SQL LIKE,不是思源分词器**。中文子串匹配没问题,但没有相关性排序;
  需要思源自己的分词 / 排序质量时,用 `mode=sql` 自行组合(或直接用思源的全文搜索界面)。
- **写入类工具刻意不做删除 / 移动 / 重命名**。要删要在思源里做,或者自己调内核接口 ——
  让模型手滑删笔记的代价太高。
- **思源没启动时工具不可用**。插件不会替你启动思源,也不会缓存上次结果;
  调用会明确告诉你「连不上」以及怎么排查。
- 单条 SQL 的结果受思源 `search.limit`(默认 64)约束,超出时内核会返回 `truncated`,
  工具会把这件事转述给模型,但它仍可能只看到前 64 行。

## 7. 许可

MIT。思源笔记本体是 AGPL-3.0,本项目只通过它的公开 HTTP 接口交互,不包含其源码。

