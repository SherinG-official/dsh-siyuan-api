# SiYuan Note (思源笔记) Kernel HTTP API — Implementation Reference

**Target:** a local-first note app whose kernel serves an HTTP API on `http://127.0.0.1:6806` by default.

**Version this document was verified against:** SiYuan **v3.8.6** (the current stable release; `kernel/util/working.go` → `const Ver = "3.8.6"`, master branch). Version-sensitive facts are flagged inline and summarised in [§0](#0-version-map).

**How this was verified**

* Official docs: the API doc **moved out of the repo root**. `API.md` 404s on master; the live official documents are
  [`docs/API.md`](https://github.com/siyuan-note/siyuan/blob/master/docs/API.md) (English), `docs/API.zh-CN.md`, `docs/API.ja.md`,
  and [`docs/API-CONTRACTS.md`](https://github.com/siyuan-note/siyuan/blob/master/docs/API-CONTRACTS.md) (contract/generation rules).
  The mirrors listed in the task (`2aeb531d…/API.md`, `dujingwei/siyuan`, `gitee v2.10.13-dev1`) are the **legacy** doc, still
  accurate for the stable core endpoints but missing everything added since ~v2.10.
* Source of truth: the Go kernel sources on master (`kernel/api/router.go`, `kernel/model/session.go`, `kernel/model/auth.go`,
  `kernel/apicontract/*.go`, `kernel/sql/*.go`, `kernel/model/search.go`, `kernel/util/net.go`, `kernel/treenode/node.go`,
  `app/electron/main.js`). Field-level facts below come from the `json:"…"` struct tags, not from prose docs.
* A generated TypeScript declaration of every migrated request/response type exists at
  [`app/src/types/api/index.d.ts`](https://github.com/siyuan-note/siyuan/blob/master/app/src/types/api/index.d.ts) (~615 KB).
  That is the best machine-checkable companion to this document.
* **Not verified:** no live kernel was reachable while writing this (nothing was listening on `127.0.0.1:6806`), so every
  response sample is taken from the official docs or reconstructed from the Go structs. Items I could only infer from code
  are marked **[inferred]**.

---

## 0. Version map

| Fact | ≤ v3.1.x | v3.8.6 (verified) |
|---|---|---|
| Response envelope | `{code, msg, data}` | `{code, msg, data}` + `limit`/`truncated` on `/api/query/sql` |
| `/api/query/sql` request | `{"stmt": "…"}` only | `{"stmt": "…", "mode": ""\|"readonly"\|"multiple"}` |
| `/api/query/sql` read-only enforcement | none | only when `mode:"readonly"` |
| `fullTextSearchBlock` request | `page, pageSize, query, paths, types, method, orderBy, groupBy` | + `notebook`, `subTypes`, `searchHPath` |
| `fullTextSearchBlock` `types` | flat `map[string]bool` | flat `map[string]bool` (unchanged); `subTypes` is a nested object |
| `pageSize` default | 32 | 32 |
| `search.limit` default (SQL row cap) | 64 | 64 |
| Encrypted notebooks | n/a | notebook lease handling in every block/filetree handler |
| Contract/type generation | n/a | `kernel/apicontract/` + generated `.d.ts` |

If the plugin must run against an unknown user version, **use the ≤v3.1.x shape as the common denominator** and treat
`mode`, `limit`, `truncated`, `subTypes`, `notebook`, `searchHPath` as optional extras.

---

## 1. Authentication

### 1.1 The token header

The API token goes in a single header, exactly:

```
Authorization: Token <token>
```

`kernel/model/session.go` → `CheckAuth()` parses the `Authorization` header by stripping one of four prefixes, case-sensitively,
in this order: `"Token "`, `"token "`, `"Bearer "`, `"bearer "`. So `Token abc`, `token abc`, `Bearer abc` and `bearer abc`
all work; `TOKEN abc` (all caps) does **not** (the prefix won't match and the header is ignored). v3.8.6 also accepts the token
as a URL query parameter `?token=<token>` (`c.Query("token")`) — **[inferred]** that this query-param path is newer than v3.1.x.

Browser clients that load the API from another origin must also satisfy CORS — see [§8.2](#82-cors).

### 1.2 Other accepted credentials (checked in this order)

1. A **JWT** in the header `X-Auth-Token` (used by first-party kernel plugins; grants `RoleAdministrator`). The constant is
   `model.XAuthTokenKey = "X-Auth-Token"`.
2. The **API token**, from `Authorization: Token …` or from the `token` query parameter.
3. **Anonymous loopback access** (see [§1.4](#14-what-happens-when-no-access-authorization-code-is-set)).
4. The **session cookie** `siyuan` (set by `POST /api/system/loginAuth`).
5. **HTTP Basic auth**, where username = the workspace folder name and password = the access authorization code (lock-screen
   password). Only tried when `conf.AccessAuthCode != ""`.

### 1.3 Where the token is configured

* **UI (current):** <kbd>Settings - Authentication - API token</kbd> (`docs/API.md` wording).
* **UI (older builds, ≤ ~v2.10):** <kbd>Settings - About</kbd> — this is the wording in the legacy `API.md` mirrors.
* **Programmatically:** `POST /api/system/setAPIToken` (admin role required).

### 1.4 What happens when no access authorization code is set

**Unauthenticated requests work** — from a *loopback* client, provided all of these hold
(`kernel/model/session.go`, `CheckAuth`, and `kernel/util/net.go`):

* `RemoteAddr` is a loopback address **and** the resolved client IP is loopback;
* the `Host` header is a loopback host — `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`;
* the `Origin` header, if present, is a loopback origin;
* `X-Forwarded-Host`, if present, is a loopback host (this header is only honoured from trusted proxies `127.0.0.1`/`::1`);
* `Sec-Fetch-Site` is absent, or is `same-origin`, or `none` (i.e. not a browser cross-site request).

When satisfied, the request is granted `RoleAdministrator` **with no token at all**.

If `util.SiYuanAccessAuthCodeBypass` is set (an internal startup flag), the loopback check is skipped entirely.

### 1.5 Exact error behaviour on bad / missing credentials

| Situation | HTTP | Body |
|---|---|---|
| `Authorization` header present but token wrong/mismatched | **401** | `{"code":-1,"msg":"Auth failed [header: Authorization]"}` |
| `?token=` wrong | **401** | `{"code":-1,"msg":"Auth failed [query: token]"}` |
| No credentials, access code set, non-browser client (no `SiYuan/`/`Mozilla/` UA) or non-GET method | **401** | `{"code":-1,"msg":"<localised> Lock screen password authentication failed, please <button …>refresh</button> or reopen"}` (i18n index 156) |
| No credentials, access code set, browser UA, `GET` | **302** | `Location: /check-auth?to=<original URL>` |
| No credentials, **no** access code set, request came from non-loopback or with a non-loopback `Host`/`Origin` | **401** | `{"code":-1,"msg":"Auth failed: for security reasons, please set [Lock screen password] when using non-127.0.0.1 access\n\n为安全起见，使用非 127.0.0.1 访问时请设置 [锁屏密码]"}` |
| No credentials, no access code, browser sent `Sec-Fetch-Site: cross-site` | **401** | `{"code":-1,"msg":"Cross-site requests are not allowed"}` (i18n 378) |
| Session cookie invalid and origin not allowed | **401** | `{"code":-1,"msg":"Auth failed: invalid request origin"}` |
| Authenticated but not administrator (only reachable via a non-admin JWT/session role) | **403** | empty body (`c.AbortWithStatus(http.StatusForbidden)`) |
| Authenticated as admin but kernel is in read-only / publish mode | **200** | JSON `{"code":-1,"msg":"This operation is not supported in read-only mode","data":{"closeTimeout":5000}}` |
| Rate-limited after repeated auth failures | **429** | `{"code":-1,"msg":"Too many failed authentication attempts, please try again later"}` + `Retry-After: <seconds>` header |

`msg` strings come from the language pack (`app/appearance/langs/*.json`, keys are numeric indices) and are **localised** —
match on `code` and on the stable English/Chinese substrings if you must, and never on the full string.

### 1.6 Rate limiting / lockout

Per client IP (`kernel/util/session.go`):

* 5 consecutive failures → lockout starts.
* Lockout = `30s × 2^(failCount − 5)`, capped at **15 minutes**.
* Failure counter window: 15 minutes of inactivity resets it.
* Max 10 000 tracked IPs; above that new IPs are not tracked.
* Lockout responses are `HTTP 429` with `Retry-After`.
* This applies to **all** auth paths, including Basic auth and the API token path — a burst of bad tokens will lock the IP out
  for 30 s and then longer.

---

## 2. General request conventions

* **Base URL:** `http://127.0.0.1:6806`. The kernel binds `127.0.0.1` by default; it binds `0.0.0.0` only when
  <kbd>Settings - Network serve</kbd> (`Conf.System.NetworkServe`) is on, or in Docker.
* **Method:** essentially every `/api/*` endpoint is **POST**. Verified exceptions in `kernel/api/router.go`:
  `GET /api/system/bootProgress` (POST also works), `GET /api/system/bootProgressSSE`, `GET /api/system/getBootAppearance`,
  `GET /api/system/version` (POST also works), `GET /api/system/getCaptcha`, `GET /api/icon/getDynamicIcon`,
  `GET /api/system/oidc/callback`, `GET /api/ai/mcp/oauth/callback/:flowID`, plus the OAuth/`.well-known` routes.
* **Content-Type:** `application/json` for JSON endpoints. A few endpoints take `multipart/form-data`
  (`/api/asset/upload`, `/api/file/putFile`, `/api/import/*`, some `/api/notebook/import*`).
* **Body:** a JSON **object** in the body. Request fields are **required by default** in the modern contract layer; a field is
  optional only if its struct tag says `api:"optional"` (or the endpoint body mode is `LegacyOptionalBody`, e.g.
  `/api/notebook/lsNotebooks`, which accepts no body at all).
* **Response envelope** (always HTTP 200 for handled requests, even on business errors):

  ```json
  { "code": 0, "msg": "", "data": {} }
  ```

  * `code: 0` = the kernel reported no error handling the request. It does **not** guarantee that indexes/caches/WebSocket
    broadcasts/sync have caught up, and it does not mean a write has been indexed for SQL yet (see
    `/api/sqlite/flushTransaction` in [§4.2](#42-sql-query-apiquerysql)).
  * `code != 0` = failure. `msg` carries the error text.
    The API doc explicitly warns: *an interface may trim, ignore, complete or transform input; use the returned `data` as the
    actually-accepted result*, and *do not infer that an operation is read-only from its name*.
  * `data` may be an object, an array, a string, a number, or `null`. `null` is written as JSON `null` (the `Null` type
    marshals to literal `null`).
  * `/api/query/sql` additionally puts `limit` and `truncated` at the **top level of the envelope**, next to `code`/`msg`/`data`.
* **HTTP status codes actually used:**

  | Status | When |
  |---|---|
  | 200 | every handled JSON request, success **and** business error |
  | 204 | `OPTIONS` CORS preflight |
  | 302 / 401 | unauthenticated browser navigation / failed auth (see [§1.5](#15-exact-error-behaviour-on-bad--missing-credentials)) |
  | 403 | authenticated but not administrator |
  | 429 | auth rate limit |
  | 202 | error status for `/api/file/getFile` (a binary-output endpoint) |
  | 101 | WebSocket upgrades |

  Do **not** use the HTTP status as the success signal for `/api/*`; always read `code`.
* **Concurrency:** the kernel installs a global middleware `model.ControlConcurrency` that **serialises API requests per URL
  path** with a mutex (`requesting map[string]*sync.Mutex`). Two concurrent calls to the same path are executed one after the
  other. Static paths (`/stage/`, `/assets/`, …), `/api/plugin/rpc`, and `/api/file/putFile` are exempt. Design for
  sequential-per-path latency, not parallel throughput.
* **Timeouts:** there is no per-request handler timeout. The only timeout instrumentation is `model.Timing`, which watches
  `/api/search/fullTextSearchBlock` and warns (server-side log + a UI toast) when it exceeds **15 s**
  (`SIYUAN_PERFORMANCE_TIMING` env var changes the threshold). Gin's HTTP server has no `ReadTimeout`/`WriteTimeout` set.
  Practical guidance: use a client timeout ≥ 30 s for search/SQL and longer for export/import.
* **Localisation:** error `msg` text follows the UI language. Match on `code` first.

---

## 3. Notebooks

### 3.1 List notebooks — `POST /api/notebook/lsNotebooks`

No parameters (`LegacyOptionalBody`). Auth required; no admin role required.

**Response** (`data.boxDocEnabled` is new in 3.8.x):

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "notebooks": [
      {
        "id": "20210817205410-2kvfpfn",
        "name": "Test Notebook",
        "icon": "1f41b",
        "sort": 0,
        "sortMode": 0,
        "closed": false,
        "subFileCount": 0,
        "newFlashcardCount": 0,
        "dueFlashcardCount": 0,
        "flashcardCount": 0,
        "encrypted": false,
        "unlocked": false,
        "state": ""
      }
    ],
    "boxDocEnabled": false
  }
}
```

* `closed` = the notebook is closed in the file tree (its docs are not indexed). `encrypted`/`unlocked`/`state` are v3.8.x
  additions; older builds return only `id, name, icon, sort, closed` (the legacy doc shows exactly those five).
* `sort` is the notebook's sort weight; `sortMode` is its default child-document sort mode.

```bash
curl -s -X POST http://127.0.0.1:6806/api/notebook/lsNotebooks \
  -H 'Authorization: Token <token>' -H 'Content-Type: application/json' -d '{}'
```

### 3.2 Open a notebook — `POST /api/notebook/openNotebook`

Request: `{"notebook": "20210831090520-7dvbdv0"}` — `notebook` (string, required, must be an ID-shaped string).
Response: `{"code":0,"msg":"","data":null}`. Requires admin role and read-write mode (fails with
`code:-1, msg:"This operation is not supported in read-only mode"` otherwise).

Related: `closeNotebook`, `renameNotebook` (`{notebook, name}`), `createNotebook` (`{name}` → `data.notebook`),
`removeNotebook` (`{notebook}`), `getNotebookConf` / `setNotebookConf`, `changeSortNotebook`,
`reorder`, `setNotebookIcon`, `getNotebookInfo`.

**Implication:** if you retrieve notebooks and one has `closed: true`, most read endpoints still work (they read the SQL index /
block tree), but to be safe call `openNotebook` first — that is the documented way to make a closed notebook active.

---

## 4. Search

### 4.1 Full-text search — `POST /api/search/fullTextSearchBlock`

This is the endpoint the search UI uses. **It is not in `docs/API.md`**, i.e. by the official policy it is an *internal*
endpoint without compatibility guarantees — but it has been stable for years and is what the community docs and MCP bridges
use. Treat it as "stable in practice, unsupported in writing".

Auth: `model.CheckAuth` only (no admin role, no read-only gate except for `method: 2`).

**Request**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `query` | string | no (defaults to `""`) | the search keyword / query string |
| `page` | number | no | 1-based page. `null`, `0` or negative → `1` |
| `pageSize` | number | no | rows per page. `null`, `0` or negative → **32** |
| `types` | object `{string: bool}` | no | block-type whitelist. If omitted/null, the user's saved search settings apply. See the key list below |
| `subTypes` | object | v3.8.6 only, optional | nested subtype filter, see below |
| `paths` | array of string | no | path filter. Each element is `"<notebookID>/<doc-path-or-hpath>"`; the first `/`-segment is parsed out as the notebook (box) filter, the remainder is the path filter. Entries containing SQL metacharacters in the box/path are silently dropped |
| `method` | number | no | `0` keyword (default), `1` query syntax, `2` SQL, `3` regular expression, `4` semantic — `4` is only used by `/api/search/semanticSearchBlock` |
| `orderBy` | number | no | see the table below. Default `0` |
| `groupBy` | number | no | `0` no grouping (default), `1` group by document |
| `notebook` | string | v3.8.6 only, optional | restrict to one notebook ID |
| `searchHPath` | bool | v3.8.6 only, optional | default `true`; include human-readable paths in the match |

`types` keys (all `bool`, absent = `false`): `mathBlock`, `table`, `blockquote`, `superBlock`, `paragraph`, `document`,
`heading`, `list`, `listItem`, `codeBlock`, `htmlBlock`, `embedBlock`, `databaseBlock`, `audioBlock`, `videoBlock`,
`iframeBlock`, `widgetBlock`, `callout`, `tabs`, `tabItem`, plus `customBlock`, `mindmap`, `mindmapItem` in newer builds.
These keys are mapped to the SQL `blocks.type` abbreviations listed in [§4.5](#45-blocks-type-and-subtype-values).

`subTypes` (3.8.6) is **nested objects**, and unknown top-level keys — including the historical flat `h1`…`h6` / `o`/`u`/`t`
flags — are **ignored without error**:

```json
"subTypes": {
  "heading":  { "h1": true, "h2": false },
  "list":     { "o": true, "u": false, "t": true },
  "listItem": { "o": false, "u": false, "t": true }
}
```

A missing/empty group, or a group whose flags are all `false`, leaves that parent type **unrestricted by subtype** (the parent
must still be enabled in `types`). In ≤3.1.x, `subTypes` did not exist at all.

`orderBy` values (from the source comment on `model.FullTextSearchBlock`, line ~1601):

| `orderBy` | Meaning |
|---|---|
| `0` | by block type (default) |
| `1` | created time ascending |
| `2` | created time descending |
| `3` | updated time ascending |
| `4` | updated time descending |
| `5` | content order (only meaningful with `groupBy: 1`) |
| `6` | relevance ascending |
| `7` | relevance descending |

> ⚠️ The community doc at `leolee9086.github.io/siyuan-kernelApi-docs` claims `orderBy` is
> `0 相关度 / 1 创建时间 / 2 更新时间 / 3 内容长度`. **That is wrong** — the authoritative mapping is the table above. Also note
> that `types` values are `bool`, not inferred from an array, and there is no `pageSize` omission in the doc's example.

**Response**

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "blocks": [
      {
        "box": "20210808180117-czj9bvb",
        "path": "/20220301153724-r5zsw01.sy",
        "hPath": "/教程/思源笔记简介",
        "id": "20220301153724-r5zsw01",
        "rootID": "20210808180117-czj9bvb",
        "parentID": "20220301153724-aaaaaaa",
        "name": "",
        "alias": "",
        "memo": "",
        "tag": "",
        "content": "思源笔记是一款本地优先的个人知识管理系统",
        "fcontent": "",
        "markdown": "…",
        "folded": false,
        "type": "p",
        "subType": "",
        "refText": "",
        "refs": null,
        "defID": "",
        "defPath": "",
        "ial": { "id": "20220301153724-r5zsw01", "updated": "20220301153724" },
        "children": null,
        "depth": 0,
        "count": 0,
        "refCount": 0,
        "sort": 0,
        "created": "20220301153724",
        "updated": "20220301153724",
        "riffCardID": "",
        "riffCard": null
      }
    ],
    "matchedBlockCount": 1,
    "matchedRootCount": 1,
    "pageCount": 1,
    "docMode": false
  }
}
```

Field list is exact, from `kernel/apicontract/search_block.go` (`SearchBlock`): `box, path, hPath, id, rootID, parentID, name,
alias, memo, tag, content, number?, fcontent, markdown, folded, type, subType, refText, refs, defID, defPath, ial, children,
depth, count, refCount, sort, created, updated, riffCardID, riffCard`. `number` is omitted when empty.
`created`/`updated` are **strings** `"yyyyMMddHHmmss"` (14 chars), not epoch numbers. `ial` is a decoded
attribute map (`Record<string,string>`), not the raw `{: …}` token string.

`matchedRootCount` and `docMode` are absent from the community doc but **are** returned (`docMode: true` means the search was
evaluated in document mode). `matchedRootCount` is the number of distinct root documents.

**Method `2` (SQL) is special:** it runs your raw SQL as the search, requires an administrator role
(otherwise `code:-1, msg:"SQL search requires administrator privileges"`), and is blocked in read-only mode
(`code:-1, msg:"This operation is not supported in read-only mode"`).

```bash
curl -s -X POST http://127.0.0.1:6806/api/search/fullTextSearchBlock \
  -H 'Authorization: Token <token>' -H 'Content-Type: application/json' \
  -d '{"query":"思源","page":1,"pageSize":32,"method":0,"orderBy":0,"groupBy":0,
       "types":{"document":true,"heading":true,"paragraph":true},
       "paths":["20210808180117-czj9bvb/教程"]}'
```

**"Search by keyword in a notebook"** is not a separate endpoint: pass `notebook` (3.8.6+) **or** put the notebook ID in the
first segment of a `paths` entry (all versions), and additionally check `data.blocks[].box` client-side if you must be exact on
older versions.

### 4.2 SQL query — `POST /api/query/sql`

**Request**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `stmt` | string | **yes** (trimmed) | the SQL text |
| `mode` | string \| null | no (v3.8.6+) | `""` (default) = single statement, **no read-only check**; `"readonly"` = single statement **and** enforced read-only; `"multiple"` = **no validation at all**, multiple statements allowed. Any other value → `code:-1, msg:"unknown [mode]"` |

```json
{ "stmt": "SELECT id, content FROM blocks WHERE type = 'p' LIMIT 5" }
```

**Response (v3.8.6)**

```json
{
  "code": 0,
  "msg": "",
  "data": [ { "id": "20220301153724-r5zsw01", "content": "…" } ],
  "limit": 64,
  "truncated": false
}
```

* `data` is an array of objects keyed by **column name as written in the SQL**; values are JSON scalars (BLOB values arrive
  base64-encoded as text).
* `limit` is the server default applied (the `search.limit` config value, **default 64**), or `0` when your SQL supplies an
  explicit outer `LIMIT`. It is not the value of your own LIMIT clause.
* `truncated` is `true` only when the server default limit dropped at least one row. Hitting the limit exactly is not
  truncation.
* On error, `limit`/`truncated`/`data` are omitted entirely.
* `code: 1` = SQL execution/parse failure (e.g. `no such table: x`), `msg` = the SQLite error text.
  `code: -1` = validation failure (multi-statement in default or readonly mode, non-read-only statement in readonly mode,
  unknown mode).

**Version note:** in ≤v3.1.x the request is only `{"stmt": "…"}` and the response has no `limit`/`truncated`:

```json
{ "code": 0, "msg": "", "data": [ { "col": "val" } ] }
```

**Is it read-only?** — read this carefully:

* With `mode` omitted (the default **and the only behaviour in ≤v3.1.x**), the kernel applies **only**
  `CheckSingleStatement` — "the SQL is a single statement". **There is no read-only enforcement.**
* The connection is opened on `siyuan.db` with
  `?_journal_mode=WAL&_synchronous=OFF&_mmap_size=4294967296&_secure_delete=OFF&_cache_size=-128000&_page_size=32768&_busy_timeout=7000&_ignore_check_constraints=ON&_temp_store=MEMORY&_case_sensitive_like=OFF`
  — **no `mode=ro`, no `_query_only`.**
* The handler then hands the statement to `db.Query`. So `INSERT`/`UPDATE`/`DELETE`/`DROP` are **not rejected in default mode**.
  **[inferred]** from the code path (`kernel/api/sql.go` → `sql.QueryWithLimitInfo` → `queryRawStmtWithLimitInfo` → `db.Query`),
  not empirically executed here. The community consensus matches this: the widely-cited SiYuan API introduction says write
  statements through `/api/query/sql` are *"极不推荐，可能导致系统损坏"* — i.e. possible, and index-corrupting.
* `mode: "readonly"` is the only mode that enforces read-only. Its check (`kernel/sql/stmt_validate.go`) is strict: the trimmed
  statement's first keyword must be `SELECT` or `WITH`, leading `--`/`/* */` comments are skipped, then the statement is
  `Prepare`d and `sqlite3_stmt_readonly()` must report read-only. This explicitly blocks `ATTACH`, `DETACH`, transaction control,
  and `WITH … DELETE`. `mode: " readonly "` (with spaces) is **rejected** — the value is not trimmed.
* `mode: "multiple"` disables all checks, including the single-statement rule.

**Recommendation:** never let an integration send anything but `mode: "readonly"` (or `SELECT`-only statements) to this endpoint.
Writing through SQL bypasses the block tree, the `.sy` files, the FTS index, sync and history, and *will* desynchronise the
workspace. All writes should go through `/api/block/*`, `/api/filetree/*`, `/api/attr/*`.

**Also:** this endpoint is **prohibited in Publish Mode** (`CheckReadonly` middleware), and the admin role is required.

```bash
curl -s -X POST http://127.0.0.1:6806/api/query/sql \
  -H 'Authorization: Token <token>' -H 'Content-Type: application/json' \
  -d '{"stmt":"SELECT id, hpath, type, subtype FROM blocks WHERE type = '"'"'d'"'"' LIMIT 20","mode":"readonly"}'
```

**Index freshness:** block-writing APIs can return after the block-tree transaction commits but **before** the asynchronous SQL
index catches up. If you must immediately query what you just wrote, first call
`POST /api/sqlite/flushTransaction` (no params, `data: null`) and wait for `code: 0`. Note also that Kramdown, DOM and SQL
columns are different representations and are *not* normalised plain text.

### 4.3 Queryable tables

The kernel database (`workspace/temp/siyuan.db`, SQLite with FTS5) contains these tables. All are queryable through
`/api/query/sql`:

| Table | Created as |
|---|---|
| `blocks` | `CREATE TABLE blocks (id, parent_id, root_id, hash, box, path, hpath, name, alias, memo, tag, content, fcontent, markdown, length, type, subtype, ial, sort, created, updated)` |
| `blocks_fts` | FTS5 virtual table over `blocks` (`content='blocks'`), columns `id, parent_id, root_id, hash, box, path, hpath, name, alias, memo, tag, content, fcontent, markdown, length, type, subtype, ial, sort, created, updated`, indexed: `name, alias, memo, tag, content, fcontent, ial` (the rest are `UNINDEXED`) |
| `spans` | `CREATE TABLE spans (id, block_id, root_id, box, path, content, markdown, type, ial)` |
| `assets` | `CREATE TABLE assets (id, block_id, root_id, box, docpath, path, name, title, hash)` |
| `attributes` | `CREATE TABLE attributes (id, name, value, type, block_id, root_id, box, path)` |
| `refs` | `CREATE TABLE refs (id, def_block_id, def_block_parent_id, def_block_root_id, def_block_path, block_id, root_id, box, path, content, markdown, type)` |
| `file_annotation_refs` | `CREATE TABLE file_annotation_refs (id, file_path, annotation_id, block_id, root_id, box, path, content, type)` |
| `block_embeddings` | `CREATE TABLE block_embeddings (id, root_id, box, path, embedding, model, content_len, updated, fail_count, last_tried, ignored_type)` |
| `stat` | `CREATE TABLE stat (key, value)` |

> There is **no** table named `file_annotation` — the file-annotation table is **`file_annotation_refs`**.

Indexes: `idx_blocks_id`, `idx_blocks_parent_id`, `idx_blocks_root_id`, `idx_blocks_root_id_id_hash`,
`idx_blocks_doc_hpath (hpath) WHERE type='d'`, `idx_spans_root_id`, `idx_assets_root_id`, `idx_attributes_block_id`,
`idx_attributes_root_id`, `idx_refs_def_block_id`, `idx_refs_def_block_root_id`, `idx_block_embeddings_root_id`.

The dialect is **SQLite** (via `mattn/go-sqlite3`, `sqlite3_extended` driver, FTS5 enabled). Consequences worth knowing:

* `LIKE` is case-`INsensitive` for ASCII by default (`_case_sensitive_like=OFF`), and SiYuan flips it at runtime according to
  the "case-sensitive search" setting (`PRAGMA case_sensitive_like = ON/OFF`).
* `||` string concatenation works (there is explicit support code for it). `UNION` also works.
* Joins, CTEs, window functions, `json_extract`, `PRAGMA`-free introspection (`SELECT name FROM sqlite_master`) all work.
* Only **one** statement per request unless `mode: "multiple"`.

### 4.4 `blocks` — every column

Built by `buildBlockFromNode` (`kernel/sql/database.go`). Column meanings:

| Column | Meaning |
|---|---|
| `id` | block ID. 22 chars: 14-digit local timestamp `yyyyMMddHHmmss` + `-` + 7 lowercase alphanumerics, e.g. `20210808180117-6v0mkxr`. Enforced by `ast.IsNodeIDPattern` |
| `parent_id` | parent block ID. **Special rule:** if the block sits under a heading, the *heading's* ID is stored here instead of the immediate container — so list items under a heading report the heading as parent |
| `root_id` | the containing document's block ID (the `.sy` root) |
| `hash` | content hash of the block subtree (`treenode.NodeHash`), used for change detection |
| `box` | notebook ID (the "box"), e.g. `20210808180117-czj9bvb` |
| `path` | storage path of the containing document, relative to the notebook, **including the leading `/` and the `.sy` extension**, e.g. `/20210808180117-6v0mkxr.sy` or `/20210917220500-sz588nq/20210917220056-yxtyl7i.sy` |
| `hpath` | human-readable path of the containing document, e.g. `/Foo/Bar`. Set from `tree.HPath` |
| `name` | the block's `name` IAL attribute (block "命名"); empty for most blocks |
| `alias` | the block's `alias` IAL attribute (block alias) |
| `memo` | the block's `memo` IAL attribute (block memo/remark) |
| `tag` | derived tag string. For a **document** block: the `tags` IAL attribute split on `,`, rendered as `#tag1# #tag2#`. For **other** blocks: every inline tag text-mark inside the block, rendered as `#tag# `. Empty when there are no tags. See [§8.7](#87-are-tags-in-blockstag-or-only-in-ial) |
| `content` | static plain-ish text of the block *with* asset paths indexed (`indexAssetPath=true`); for a document it is the document title |
| `fcontent` | "first content" — for container blocks it is the static content of the **first leaf block**; for a document it is the title. Used for ordering/backlink logic |
| `markdown` | the block exported as **standard Markdown** (`ExportNodeStdMd`) |
| `length` | rune count of `content` (of `fcontent` for container blocks) |
| `type` | block type abbreviation — see [§4.5](#45-blocks-type-and-subtype-values) |
| `subtype` | subtype abbreviation — heading level, list flavour, callout type, else empty |
| `ial` | the block's inline attribute list as a raw Kramdown token string, e.g. `{: id="20210808180117-6v0mkxr" updated="20210808180117"}`. Empty string when the node has no IAL. Values are **not** re-escaped, so a raw substring search on it is safe-ish but should not be trusted for parsing |
| `sort` | the block's `sort` value from its IAL (integer; `0` when unset) — the manual ordering weight |
| `created` | `yyyyMMddHHmmss` derived from the first 14 chars of `id` |
| `updated` | the `updated` IAL attribute, `yyyyMMddHHmmss`. Not a DB write timestamp |

`blocks_fts` is an FTS5 external-content table over `blocks`; because it is `content='blocks'` you can query either, but
`blocks_fts` supports `MATCH`, `bm25()` and `snippet()`. Writing to `blocks` via SQL directly will desynchronise
`blocks_fts` (the FTS index is maintained by triggers/queue code, not by you).

**`attributes`** rows are only created for a whitelisted set of IAL names
(`isAttr`: `custom-*`, `name`, `alias`, `memo`, `bookmark`, `fold`, `heading-fold`, `style`). `type` is `"b"` for block-level
IAL and `"s"` for span-level IAL.

**`spans`** rows are inline elements. `type` is `treenode.TypeAbbr(nodeType) + " " + TextMarkType` for text marks
(e.g. `"textmark tag"`, `"textmark a"`, `"textmark block-ref"`, `"textmark code"`, …) and just the abbreviation for images
(`"img"`). `spans.content` is the span text; `spans.markdown` its Markdown.

**`assets`/`refs`/`file_annotation_refs`:** `refs.type` is the type abbreviation of the *referencing* node — in 3.8.6 that is
`textmark` for inline `((id "text"))` references and `query_embed` for embed blocks; treat this column as
version-dependent and verify on the user's build. `file_annotation_refs.annotation_id` is a bare annotation ID (older rows may
carry a `?`/`#` suffix, which the kernel handles specially).

### 4.5 `blocks.type` and `subtype` values

Exact mapping, from `kernel/treenode/node.go` (`typeAbbrMap`, `SubTypeAbbr`):

| `type` | Node | Meaning |
|---|---|---|
| `d` | NodeDocument | document (the `.sy` root) |
| `h` | NodeHeading | heading |
| `l` | NodeList | list container |
| `i` | NodeListItem | list item |
| `c` | NodeCodeBlock | code block |
| `m` | NodeMathBlock | math block |
| `t` | NodeTable | table |
| `b` | NodeBlockquote | blockquote |
| `s` | NodeSuperBlock | super block |
| `p` | NodeParagraph | paragraph |
| `html` | NodeHTMLBlock | HTML block |
| `query_embed` | NodeBlockQueryEmbed | query-embed (embedded block) |
| `av` | NodeAttributeView | database / attribute view |
| `iframe` | NodeIFrame | iframe block |
| `widget` | NodeWidget | widget block |
| `tb` | NodeThematicBreak | thematic break / horizontal rule (this is the `tb` you were unsure about — **not** "theme") |
| `video` | NodeVideo | video block |
| `audio` | NodeAudio | audio block |
| `custom` | NodeCustomBlock | custom block |
| `callout` | NodeCallout | callout |
| `tabs` | NodeTabs | tab container |
| `tab` | NodeTabItem | one tab page |
| `mindmap` / `mindmap_item` | NodeMindmap / NodeMindmapItem | mind map / its items |
| `ial` | NodeKramdownBlockIAL | IAL node (never a queryable block row in practice) |
| `text`, `img`, `link_text`, `link_dest`, `textmark` | inline nodes | appear only in `spans.type` |

`subtype` values:

* headings → `h1` … `h6` (from `HeadingLevel`).
* lists and list items → `u` (unordered/bullet), `o` (ordered), `t` (task list).
* callouts → the callout type string.
* everything else → `""` (empty).
* There is **no** `subtype` for marks like `mark`/`tag`/`link` on the `blocks` table — those are inline marks and live in
  `spans`, not in `blocks.subtype`.

### 4.6 The `ial` format and where tags/aliases live

An IAL ("inline attribute list") is the Kramdown-style token attached to a block, written exactly as:

```
{: id="20210808180117-6v0mkxr" updated="20210808180117" title="Foo" tags="a,b" alias="Bar" custom-x="y"}
```

* It always starts `{: ` and ends `}`; attributes are `key="value"` pairs separated by single spaces; values are
  HTML-entity-escaped and **`blocks.ial` stores this string un-decoded**.
* The **tag list** for a document lives in the IAL attribute **`tags`**, comma-separated (e.g. `tags="work,notes"`), and the
  `block.tag` column is derived from it (see [§4.4](#44-blocks--every-column)).
* **Alias** lives in the IAL attribute **`alias`**, mirrored into `blocks.alias`. **`name`** and **`memo`** likewise.
* Inline (span-level) IALs live in `spans.ial` and in `attributes` with `type = 's'`.
* When you need the IAL **decoded** into a map, prefer `/api/attr/getBlockAttrs` (returns `{"key": "value", …}` plus
  `id`, `type`, `updated`, `title`), or `data.blocks[].ial` from `fullTextSearchBlock`, rather than parsing `blocks.ial`
  yourself. Searching `blocks.ial LIKE '%alias="X"%'` works but is fragile because values are escaped.

### 4.7 `/api/search/fullTextSearchBlock` vs `/api/query/sql` for full-text search

| | `fullTextSearchBlock` | `/api/query/sql` |
|---|---|---|
| Purpose | the real, user-facing full-text search | arbitrary SQL against the index |
| Matching | FTS5 index + the user's tokenizer settings, query-syntax/`method:1`, regex (`method:3`), SQL (`method:2`), relevance ranking (`orderBy 6/7`), hpath search, document grouping | whatever you write; you can use `MATCH` on `blocks_fts` manually |
| Highlighting | returns `content`, `markdown`, `fcontent` and full block metadata | returns raw columns |
| Filters | `types`, `subTypes`, `paths`, `notebook`, `groupBy`, `orderBy` | full SQL |
| Auth | any authenticated role (admin only for `method:2`) | **admin role required**, blocked in Publish Mode |
| Pagination | `page`/`pageSize`, plus `matchedBlockCount`/`matchedRootCount`/`pageCount` | your own `LIMIT`/`OFFSET` (server cap `search.limit`, default 64) |
| Stability | undocumented/internal, in practice stable | documented public API |

**Recommendation:** use `fullTextSearchBlock` when you want "what the user would find", with ranking, tokenizer parity
(CJK segmentation, case sensitivity) and block metadata. Use `/api/query/sql` (read-only!) for structured/aggregate questions
— tag counts, backlink analysis, listing documents, joins across `blocks`/`attributes`/`refs`. Do not reimplement
full-text ranking in SQL: you will not match the configured tokenizer.

---

## 5. Reading content

### 5.1 Export a document as Markdown — `POST /api/export/exportMdContent`

**Request**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | **yes** (trimmed) | the **document** block ID |
| `refMode` | number | no | block-reference export mode; default from `Conf.Export.BlockRefMode` |
| `embedMode` | number | no | block-embed export mode; default from `Conf.Export.BlockEmbedMode` |
| `yfm` | bool | no | include YAML front matter; default `true` |
| `fillCSSVar` | bool | no | inline CSS variables |
| `adjustHeadingLevel` | bool | no | normalise heading levels |
| `imgTag` | bool | no | emit `<img>` tags |
| `addTitle` | bool | no | prepend the document title; default from `Conf.Export.AddTitle` |

**Response**

```json
{ "code": 0, "msg": "", "data": { "hPath": "/Please Start Here", "content": "## 🍫 Content Block\n\n…" } }
```

Errors: invalid `id` → `code:-1, msg:"invalid ID argument"`.
Requires admin role (it is registered with `CheckAdminRole`) but **not** read-only gating.

### 5.2 Block Kramdown — `POST /api/block/getBlockKramdown`

Exact path and params verified. Request:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | **yes** | the block ID (any block, not just documents) |
| `mode` | string | no (v3.8.x) | `"md"` (default, Markdown markers) or `"textmark"` (span-based export). Any other value → `code:-1, msg:"Invalid mode"` |
| `notebook` | string | no (v3.8.x) | explicit notebook for encrypted-notebook routing |
| `ids` | array of string | no (v3.8.x) | additional IDs for lease acquisition |

**Response**

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "id": "20201225220954-dlgzk1o",
    "kramdown": "* {: id=\"20201225220954-e913snx\"}Create a new notebook…\n  {: id=\"20210131161940-kfs31q6\"}\n* {: id=\"20201225220954-ygz217h\"}Enter <kbd>/</kbd> …\n  {: id=\"20210131161940-eo0riwq\"}"
  }
}
```

* Kramdown is the native SiYuan Markdown dialect: it keeps `{: id="…"}` IALs, `((id "anchor"))` block refs, `((id 'text'))`,
  `{{…}}` embeds, `{: style="…"}` spans. It is **not** CommonMark.
* The returned Kramdown canonicalises block-level IAL attribute ordering; the order is stable while content and attributes are
  unchanged.
* Reading a non-existent but well-formed ID returns `code: 0` with an empty `kramdown` string — the kernel does not error.
* `mode` on this endpoint is **newer**; on older builds the request is just `{"id": "…"}`.

Batch variant: `POST /api/block/getBlockKramdowns` with `{"ids": ["…","…"]}` → `data` is a
`map[string]string` of `id → kramdown` (invalid IDs are silently skipped).

### 5.3 Child blocks — `POST /api/block/getChildBlocks`

Request: `{"id": "<parent block ID>"}` (`id` required). Response: `data` is an **array** of
`{id, type, subType?, content?, markdown?}` (from `apicontract.ChildBlock`; the docs example only shows `id`/`type`/`subType`).

```json
{
  "code": 0, "msg": "",
  "data": [
    { "id": "20230512083858-mjdwkbn", "type": "h", "subType": "h1" },
    { "id": "20230513213727-thswvfd", "type": "s" },
    { "id": "20230513213633-9lsj4ew", "type": "l", "subType": "u" }
  ]
}
```

Note: blocks **below a heading are also counted as child blocks**. Requires admin role.
Related: `getTailChildBlocks` (`{id, n}`), `getBlockDOM` / `getBlockDOMs` (`data: {id, dom}`).

### 5.4 How `id`, `path` and `hpath` relate

* **`id`** — a block ID. Format verified in `lute/ast/node.go`:
  `NewNodeID()` = `time.Now().Format("20060102150405") + "-" + randStr(7)`;
  `IsNodeIDPattern()` requires **exactly** 22 characters: 14 digits, one `-`, 7 chars from `[a-z0-9]`.
  Example: `20210808180117-6v0mkxr`. The first 14 characters are the **creation time** and are what `blocks.created` holds.
  The document's *own* ID is also the `.sy` file name stem.
* **`path`** — the storage path of the document inside the notebook, leading `/` and `.sy` suffix included:
  `/20210808180117-6v0mkxr.sy` for a top-level doc, `/20210917220500-sz588nq/20210917220056-yxtyl7i.sy` for a nested one.
  Every block inside a document shares that document's `path`; use `root_id` to tell documents apart.
* **`hpath`** — the human-readable path of the document: `/Foo/Bar` (no `.sy`, titles not IDs). It is what
  `createDocWithMd`'s `path` field means.
* Conversions:
  * ID → hpath: `POST /api/filetree/getHPathByID` `{"id":"20210917220056-yxtyl7i"}` → `data: "/foo/bar"`
  * ID → storage path: `POST /api/filetree/getPathByID` `{"id":"20210808180320-fqgskfj"}` →
    `data: {"notebook":"20210808180117-czj9bvb","path":"/20200812220555-lj3enxa/20210808180320-fqgskfj.sy"}`
  * hpath → IDs: `POST /api/filetree/getIDsByHPath` `{"path":"/foo/bar","notebook":"20210808180117-czj9bvb"}` →
    `data: ["20200813004931-q4cu8na"]`
  * path → hpath: `POST /api/filetree/getHPathByPath` `{"notebook":"…","path":"/20210917220500-sz588nq/20210917220056-yxtyl7i.sy"}`
    → `data: "/foo/bar"`
  * ID → full hpath incl. notebook: `POST /api/filetree/getFullHPathByID`
  * Also available: `getHPathsByPaths`.

### 5.5 Breadcrumb — `POST /api/block/getBlockBreadcrumb`

**Request**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | **yes** | block ID |
| `ids` | array of string | no | extra IDs (encrypted-notebook lease) |
| `notebook` | string | no | explicit notebook |
| `excludeTypes` | array of string | no | block types to skip while walking up the tree, e.g. `["l","i"]` to hide list wrappers |

**Response** — `data` is an array of `BlockPath` from the block itself **up to the notebook root**:

```json
{
  "code": 0, "msg": "",
  "data": [
    { "id": "20230513213633-9lsj4ew", "name": "item text", "type": "i", "subType": "u", "children": null },
    { "id": "20210917220056-yxtyl7i", "name": "My Doc",       "type": "d", "subType": "",  "children": null },
    { "id": "20210817205410-2kvfpfn", "name": "My Notebook/My Doc", "type": "", "subType": "", "children": null }
  ]
}
```

* Each item: `{id, name, type, subType, children, hasChildren?}`. `hasChildren` is `omitempty` and only present when true.
* `name` is resolved by the kernel: the `name` IAL attribute if set; for a **document** it is
  `<notebook name><hPath>` (just the notebook name for the notebook-root document); for an attribute view it is the database
  name; for a tab item it is the block ref text; otherwise the first leaf block's text.
* The **last** element is the notebook pseudo-entry — `id` is the notebook ID. Do not assume `type == "d"` for it.
* A well-formed but unknown ID yields `code: 0, data: []` (the model swallows "tree not found").
* Related: `getBlockBreadcrumbChildren` (`{id, excludeTypes, offset, limit}` — `limit` default 64, clamped to 1…256) →
  `data: {items: [BlockPath…], hasMore: bool}`.

---

## 6. Creating documents and blocks

### 6.1 `POST /api/filetree/createDocWithMd`

**Request** (from `apicontract.FileTreeCreateMarkdownRequest`; `notebook` and `path` are required, everything else optional)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `notebook` | string | **yes** | notebook ID (validated as an ID pattern → else `code:-1, msg:"invalid ID argument"`) |
| `path` | string | **yes** | document path in **hpath** terms: starts with `/`, levels separated by `/`. **No `.sy`** |
| `markdown` | string | **yes** | GFM Markdown content |
| `tags` | string | no | comma-separated tags to set on the document |
| `parentID` | string | no | create the document *under* this block/document |
| `id` | string | no | force the new document's ID (must be ID-shaped); otherwise generated |
| `withMath` | bool | no | treat `$…$` / `$$…$$` as math when parsing |
| `clippingHref` | string | no | source URL recorded for clipped content |
| `titleEmpty` | bool | no | allow an empty title |
| `sortTargetID` | string | no | sibling ID to sort relative to |
| `sortPosition` | string | no | `before` / `after` |
| `docCreateTemplatePath` | string | no | template to apply |
| `listDocTree` | bool | no | include a doc tree in the response context |

**Semantics of `path`** (this is the part that bites people):

* It corresponds to the database **`hpath`** field, *not* to the storage `path`. `/Notes/Programming in C/C++` creates a
  document literally titled `C++` inside a document `Programming in C` inside `Notes` — because `/` is the hierarchy
  separator and there is **no escaping for a literal slash in a title**.
* **Missing parent documents are created automatically.**
* Each level's title is sanitised: CR/LF/U+2028/U+2029/TAB and `/` are stripped, and the base name is truncated to
  **512 runes**.
* The kernel **never auto-appends `.sy`** and never should — you pass the title path.
* If you need a literal `/` in a title, replace it with full-width `／` (U+FF0F) before joining, e.g.
  `/Notes/Programming in C／C++`. This changes the title text.
* Calling the endpoint repeatedly with the same `path` does **not** overwrite: the legacy doc says a new document with a
  random suffix is created (current docs simply say the existing document is not overwritten). Treat it as
  "created, possibly a second document" and dedupe yourself.

**Response:** `data` is the **new document ID as a plain JSON string**:

```json
{ "code": 0, "msg": "", "data": "20210914223645-oj2vnx2" }
```

**Errors:** no dedicated "notebook not found" / "path exists" codes. Everything surfaces as `code: -1` with a text `msg`:
non-ID notebook → `"invalid ID argument"`; a missing notebook, a bad path, or a write failure → the model's error string
(`err.Error()` from `model.CreateWithMarkdown`). Read `msg`.

```bash
curl -s -X POST http://127.0.0.1:6806/api/filetree/createDocWithMd \
  -H 'Authorization: Token <token>' -H 'Content-Type: application/json' \
  -d '{"notebook":"20210817205410-2kvfpfn","path":"/Inbox/My new note","markdown":"# Hello\n\nbody"}'
```

**Creating under a specific parent document:** pass that parent's block ID in `parentID`, and pass **only the new
document's own title** in `path` (the kernel still resolves/creates the hierarchy described by `path`):

```json
{ "notebook": "20210817205410-2kvfpfn", "parentID": "20210917220056-yxtyl7i", "path": "/Child doc", "markdown": "…" }
```

### 6.2 Appending / inserting / prepending blocks

All three take `dataType` ∈ `{"markdown","dom"}` and return `data: [BlockTransaction]` (array).
`dom` means a Protyle block DOM fragment such as
`<div data-node-id="…" data-type="NodeParagraph" class="p"><div contenteditable="true">…</div><div class="protyle-attr"></div></div>`.

**`POST /api/block/appendBlock`** — append as the **last** child of `parentID`.

| Field | Type | Required |
|---|---|---|
| `data` | string | **yes** |
| `dataType` | string | **yes** (trimmed) |
| `parentID` | string | **yes** (trimmed) |

**`POST /api/block/prependBlock`** — insert as the **first** child of `parentID`. Same three required fields.

**`POST /api/block/insertBlock`** — insert relative to a sibling. `dataType` and `data` required;
`nextID`, `previousID`, `parentID` are all optional individually but **at least one must be non-empty**, with priority
`nextID` > `previousID` > `parentID` (documented). The handler validates that the anchors belong to the same document.

Batch variants exist with the same shape wrapped in an array: `batchAppendBlock` / `batchPrependBlock`
(`{"blocks":[{data,dataType,parentID}, …]}`) and `batchInsertBlock` (`{"blocks":[{data,dataType,parentID,previousID,nextID}, …]}`).

**Response** (identical shape for all three; `data` is an array containing one transaction):

```json
{
  "code": 0, "msg": "",
  "data": [
    {
      "timestamp": 1631850968131,
      "doOperations": [
        {
          "action": "insert",
          "data": "<div data-node-id=\"20211230115020-g02dfx0\" data-node-index=\"1\" data-type=\"NodeParagraph\" class=\"p\"><div contenteditable=\"true\" spellcheck=\"false\">foo<strong style=\"color: var(--b3-font-color8);\">bar</strong>baz</div><div class=\"protyle-attr\" contenteditable=\"false\"></div></div>",
          "id": "20211230115020-g02dfx0",
          "rootID": "",
          "parentID": "",
          "previousID": "20211229114650-vrek5x6",
          "nextID": "",
          "retData": null,
          "blockIDs": null,
          "blockID": "", "deckID": "", "avID": "", "srcIDs": null, "srcs": null,
          "isDetached": false, "name": "", "type": "", "format": "",
          "keyID": "", "rowID": "", "isTwoWay": false, "backRelationKeyID": "",
          "removeDest": false, "layout": "", "groupID": "", "targetGroupID": "",
          "viewID": "", "ignoreDefaultFill": false, "context": null
        }
      ],
      "undoOperations": null
    }
  ]
}
```

* `doOperations[].action` ∈ `delete | insert | update | foldHeading | unfoldHeading | setAttrs | moveOutlineHeading | appendInsert | prependInsert`.
* **Take the new block ID from `doOperations[0].id`** — that is the ID of the first inserted top-level block. When you insert
  multiple top-level blocks in one call, only one ID is reported; send one block per request if you need every ID.
* `undoOperations` is `null` on the wire for API calls.
* `dataType: "dom"` also accepts `"markdown"`-ish text — the kernel runs it through Lute.

**Update / delete:**

* `POST /api/block/updateBlock` — `{id (required, trimmed), data, dataType, lockType?}` → same transaction shape with
  `action: "update"`.
* `POST /api/block/deleteBlock` — `{id (required, trimmed)}` → `action: "delete"`, `data: null`.
  (The community article's `/api/block/removeBlock` name is **wrong** — the route is `deleteBlock`.)
* `POST /api/block/moveBlock` — `{id, parentID?, previousID?}`.
* `POST /api/block/foldBlock` / `unfoldBlock` — `{id}` → `data: null`.
* Also useful: `attr/setBlockAttrs` (`{id, attrs: {"custom-x":"y"}}`), `attr/getBlockAttrs` (`{id}`), and
  `POST /api/sqlite/flushTransaction` to force the SQL index to catch up.

```bash
curl -s -X POST http://127.0.0.1:6806/api/block/appendBlock \
  -H 'Authorization: Token <token>' -H 'Content-Type: application/json' \
  -d '{"dataType":"markdown","data":"appended **paragraph**","parentID":"20220107173950-7f9m1nb"}'
```

### 6.3 Rename / move / delete documents

All require admin role and read-write mode.

| Operation | Endpoint | Request | Response `data` |
|---|---|---|---|
| Rename by path | `/api/filetree/renameDoc` | `{notebook, path, title}` | `null` |
| Rename by ID | `/api/filetree/renameDocByID` | `{id, title}` | `null` |
| Delete by path | `/api/filetree/removeDoc` | `{notebook, path}` | `null` |
| Delete by ID | `/api/filetree/removeDocByID` | `{id}` | `null` |
| Delete many | `/api/filetree/removeDocs` | `{paths: [ … ]}` | `null` |
| Move | `/api/filetree/moveDocs` | `{fromPaths: ["/a.sy"], toNotebook, toPath}` | `null` |
| Move by ID | `/api/filetree/moveDocsByID` | `{fromIDs: ["…"], toID}` (`toID` = target parent doc **or** notebook ID) | `null` |
| Reorder as sibling | `/api/filetree/reorderDocs` | `{sourceIDs, targetID, position: "before"\|"after"}` | `{changed, notebook, parentPath}` |
| Set sort values | `/api/filetree/setSort` | `{notebookSorts:[{id,sort}], docSorts:[{id,sort}]}` (≥1 non-empty) | `{notebookIDs, docIDs}` |
| Set child sort mode | `/api/filetree/setDocSortMode` | `{id, sortMode: 0..14 \| null}` | `{box, id, path, sortMode, effectiveSortMode}` |
| Duplicate | `/api/filetree/duplicateDoc` | `{id}` | new doc ID (string) |

`path` in all of the above is the **storage path** (`/20210902210113-0avi12f.sy`), not the hpath. `renameDoc` also accepts
only the storage path; use `renameDocByID` if all you have is an ID.

**Danger:** removal goes to the notebook's trash/history rather than being unrecoverable in normal desktop use, but there is no
undo endpoint here — undo is a client-side transaction stack (`/api/transactions/undo`) and API-issued transactions are pushed
to it, so an immediate undo may be possible. Do not rely on it.

---

## 7. Error codes

The contract layer declares the complete set of `code` values an endpoint may return
(`ResponseOptions{AdditionalCodes: …, Text: …, NonNullable: …}`). Across the whole public surface there are only a **few**
meaningful values:

| `code` | Meaning | Where it appears | Typical `msg` |
|---|---|---|---|
| `0` | success | everywhere | `""` |
| `-1` | **generic failure** — the overwhelmingly common error code. Validation failures, "not found", "invalid id", permission-ish, read-only mode, decryption failures, everything that isn't a raw SQL/SQLite error | almost every endpoint | free text (see below) |
| `1` | **SQL / index-level failure** | `/api/query/sql` (declared `AdditionalCodes: []int{1}`), `/api/search/fullTextSearchAssetContent` | raw SQLite error text, e.g. `no such table: foo` |
| `-3` | file-system/parameter failure for `file/putFile` | `/api/file/putFile` | — |
| `400` | declared for `/api/system/importCustomFont` (`"Field [file] must not be empty"`) | one endpoint | — |
| `403`, `404`, `409`, `500`, `503` | declared error codes for `/api/file/getFile` (which also returns HTTP 202 on error) | file endpoints | — |

**There are no distinct numeric codes for "not found", "duplicate", "forbidden" or "invalid id"** — they all come back as
`-1` with a message. 403 comes back as an **HTTP status**, not a `code`, when the role check fails. Authentication failures are
`HTTP 401` with `code: -1`.

**Stable message patterns you can match on:**

| `msg` (exact) | Cause |
|---|---|
| `invalid ID argument` | the `id`/`notebook` string is not 22-char ID-shaped (`util.InvalidIDPattern`, sets `code:-1`) |
| `block not found` | `/api/block/*` on a well-formed ID that does not resolve (when no encrypted notebooks exist) |
| `block not found or its encrypted notebook is locked` | same, but encrypted notebooks are configured |
| `encrypted notebook is locked, please unlock it first` | encrypted notebook lease acquisition failed |
| `Content block with id [<id>] not found` | `fmt.Sprintf(Conf.Language(15), id)` — used by embed-block search |
| `This operation is not supported in read-only mode` | `CheckReadonly` middleware; `data` is `{"closeTimeout":5000}` |
| `Auth failed [header: Authorization]` | bad API token in the header |
| `Auth failed [query: token]` | bad `?token=` |
| `Auth failed [session]` | no session and no other credential |
| `Auth failed: invalid request origin` | cross-origin session request |
| `Cross-site requests are not allowed` | `Sec-Fetch-Site` marked cross-site |
| `Too many failed authentication attempts, please try again later` | auth throttle (HTTP 429) |
| `SQL statement is not single` | multi-statement SQL in default/readonly mode |
| `SQL statement is not a read-only query` / `SQL statement is not read-only` / `SQL statement is empty` | `mode:"readonly"` violations |
| `unknown [mode]` | `mode` not in `""`/`"readonly"`/`"multiple"` |
| `Invalid mode` | `getBlockKramdown` `mode` not `md`/`textmark` |
| `SQL search requires administrator privileges` | `fullTextSearchBlock` with `method:2` as non-admin |
| `Field [id] must not be empty` | some block endpoints |

Because `msg` is localised and free-form, the recommended client logic is:
`if (resp.code !== 0) throw` → then branch on `msg` substrings only for the few cases you actually need to special-case
(`invalid ID argument`, `not supported in read-only mode`, `Auth failed`).

---

## 8. Gotchas

### 8.1 Non-loopback `Host`/`Origin` is rejected when no access code is set

Yes — this is real and is the most common "why does my script get 401" cause.
`isLocalHostRequestAllowed()` requires the client IP, `Host`, `Origin` and `X-Forwarded-Host` to all be loopback. If the
kernel is exposed on `0.0.0.0` (Network serve) or you send `Host: myserver.local`, then **without an access authorization
code** you get:

```
HTTP 401
{"code":-1,"msg":"Auth failed: for security reasons, please set [Lock screen password] when using non-127.0.0.1 access\n\n为安全起见，使用非 127.0.0.1 访问时请设置 [锁屏密码]"}
```

**There is no required custom header** (no `X-SiYuan-*` requirement for `/api/*`; `X-SiYuan-App-ID` merely appears in the CORS
allow-list). Required-ish headers for practical clients: `Content-Type: application/json` and `Authorization: Token …`.
`User-Agent` matters only for the unauthenticated redirect behaviour: a UA starting with `SiYuan/` or `Mozilla/` gets a 302 to
`/check-auth` for GETs instead of a 401; send a non-browser UA (`curl/8.x`, your own) to always get JSON 401s.

**A valid API token short-circuits all of these checks**, including the cross-site and Host checks — so remote access works
whenever the token is correct. Conversely, when the token is *wrong*, the Host check is still reached (and the throttle still
counts the failure).

### 8.2 CORS

`corsMiddleware` (applied globally, before auth) sets on **every** response:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
Access-Control-Allow-Headers: origin, Content-Length, Content-Type, Authorization, X-SiYuan-App-ID
Access-Control-Allow-Private-Network: false
Access-Control-Allow-Methods: <HttpMethods joined with ", ">
```

and answers `OPTIONS` with **`204`** plus `Access-Control-Max-Age: 600`.

Notes for browser clients:

* `Allow-Origin: *` **plus** `Allow-Credentials: true` is contradictory per the Fetch spec: browsers will refuse to *send*
  credentials (cookies) on a wildcard-origin CORS response. So the session cookie path will not work cross-origin; use the
  `Authorization: Token …` header instead, which is explicitly allowed.
* A cross-origin XHR from a web page still hits the `Sec-Fetch-Site: cross-site` guard **unless** a valid API token is
  presented (token check runs first). So: cross-origin browser → always send the token.
* WebSocket and `/webdav`, `/caldav`, `/carddav` get their own method lists.

### 8.3 Does the API work while the app window is closed?

Yes. The kernel is a **separate OS process** spawned by the Electron shell; the window is only a client. In
`app/electron/main.js` the main window's `close` handler calls `event.preventDefault()` and only triggers the "save & hide"
flow — the app is not quit, the tray icon remains, and `kernelProcess` keeps listening on its port. Closing the window to the
tray therefore leaves the HTTP API fully available. The API stops only when SiYuan is actually exited (tray → Quit, or
`POST /api/system/exit`, which is admin-only and loopback-trusted).

Caveats: on some platforms (mobile) the kernel is embedded in the app process and is suspended with the app; and "remote
kernel"/connection-manager setups mean the port you talk to may be a per-workspace port rather than 6806.

### 8.4 Rate limits, timeouts, result caps

* **Rate limiting** exists only for **authentication failures** (see [§1.6](#16-rate-limiting--lockout)): 5 failures → 30 s
  lockout, exponential up to 15 min, `HTTP 429` + `Retry-After`.
* **No general request-rate limit.**
* **Request serialisation:** `ControlConcurrency` serialises requests **per URL path** (mutex per path). Concurrent identical
  calls queue; this is the main throughput limit for a plugin.
* **Timeouts:** none enforced by the kernel. The only timing hook is the 15-second warning on `fullTextSearchBlock`.
  Client-side timeouts of 30–60 s for search/SQL/export are sensible.
* **Max JSON result size:** `/api/query/sql` caps rows at `search.limit`, **default 64** (configurable in
  <kbd>Settings - Search</kbd>). An explicit outer `LIMIT` **overrides** the cap and may exceed it.
  `fullTextSearchBlock` is capped by `pageSize` (default 32) but `matchedBlockCount` tells you the true total.
  There is no documented byte cap on JSON bodies. `MaxMultipartMemory` is 32 MiB (uploads spill to disk beyond that).
* **Upload size:** `ginServer.MaxMultipartMemory = 32 MiB`; larger multipart bodies are buffered to temp files rather than
  rejected, so effectively the disk is the limit.

### 8.5 SQL must be read-only — what actually happens on a write

See [§4.2](#42-sql-query-apiquerysql) in full. Short version:

* Default `mode` (and all ≤3.1.x builds): **only** the single-statement rule is enforced. `INSERT`/`UPDATE`/`DELETE` are not
  blocked by the kernel, and the DB connection is not read-only. **[inferred from source]**
* `mode:"readonly"`: `SELECT`/`WITH` only, verified through `sqlite3_stmt_readonly()`, `ATTACH`/`DETACH`/transactions
  hard-rejected up front. This is the mode you should use.
* Writing through SQL corrupts the workspace (index vs. `.sy` divergence, FTS desync, broken history/sync). Always use the
  block/filetree APIs for writes.

### 8.6 `fullTextSearchBlock` vs `/api/query/sql`

Covered in [§4.7](#47-apifulltextsearchblock-vs-apiqueryapi-sql-for-full-text-search):
use `fullTextSearchBlock` for ranked, tokenizer-correct, metadata-rich search; use read-only SQL for structured/aggregate
queries. Note that `fullTextSearchBlock` is technically **not** a documented public API (see the "Behavior semantics" section of
`docs/API.md`: only interfaces with their own section are public API, "other kernel routes … provide no compatibility or
behavioral stability guarantees").

### 8.7 Are tags in `blocks.tag` or only in `ial`?

**Both, by derivation — `blocks.tag` is a generated column value, not an independent store.**

* For a **document** block, `blocks.tag` is built from the IAL attribute `tags` (`node.IALAttr("tags")`), split on `,`,
  trimmed, each wrapped as `#tag#`, joined with spaces → e.g. `tags="a,b"` becomes `#a# #b#`.
* For **every other block**, `blocks.tag` is built by walking the block for inline tag text-marks
  (`n.IsTextMarkType("tag")`) and joining `#<content># ` → e.g. `#work# #urgent#`.
* A block with no tags has `tag = ''`.

So a SQL tag query should use `blocks.tag LIKE '%#mytag#%'`, or `attributes` with
`SELECT value FROM attributes WHERE name='tags'` for document-level tag lists. In the Kramdown source, the authoritative
representation is the IAL `tags="…"` attribute on the document and the `#tag#` text marks inline in content.

### 8.8 Other traps

* **`blocks.parent_id` is heading-aware.** Under a heading, a block's `parent_id` is the **heading's** ID, not its immediate
  container. Walk with `parent_id` for outline semantics, and be aware list items therefore appear as children of the heading
  when the list follows a heading.
* **`blocks.path` includes `.sy`; `hpath` does not.** Do not mix them.
* **ID validation is strict**: exactly 22 chars, one `-`, 7 lowercase alphanumerics. Uppercase or an extra `-` →
  `invalid ID argument` with `code:-1` (and note `closeNotebook` is documented as *not* trimming whitespace while many other
  endpoints do).
* **Read a write's own result from the response.** `code: 0` says nothing about indexes, caches, WebSocket broadcast or sync.
  Call `/api/sqlite/flushTransaction` before querying SQL for what you just wrote.
* **`data` on error.** Almost always absent. A few endpoints return `data` on failure
  (`FailureWithData`, `FailureWithText`, `FailureWithTimeout` → `{"closeTimeout": 5000}`), so `data` may be present with a
  non-zero `code`; always check `code` first.
* **Body must be valid JSON or absent.** Endpoints declared `JSONBody` treat a missing/invalid body as a decode failure and
  return `code:-1` with the decode error — for example `{"stmt": null}` on `/api/query/sql` returns `code:-1`.
* **`LegacyOptionalBody`** endpoints (`/api/notebook/lsNotebooks`) accept no body at all; sending `{}` also works.
* **Localisation** changes `msg`. Do not assert on it.

---

## Appendix A — verified endpoint index (subset used above)

```
POST /api/notebook/lsNotebooks            POST /api/notebook/openNotebook / closeNotebook / renameNotebook
                                          / createNotebook / removeNotebook / getNotebookConf / setNotebookConf
POST /api/filetree/createDocWithMd        POST /api/filetree/renameDoc | renameDocByID | removeDoc | removeDocByID
                                          | removeDocs | moveDocs | moveDocsByID | reorderDocs | setSort | setDocSortMode
                                          | duplicateDoc | duplicateDocTree
POST /api/filetree/getHPathByPath | getHPathsByPaths | getHPathByID | getPathByID | getFullHPathByID | getIDsByHPath
                                          | listDocsByPath | getDoc | searchDocs | listDocTree
POST /api/query/sql                       POST /api/sqlite/flushTransaction
POST /api/search/fullTextSearchBlock      POST /api/search/semanticSearchBlock | searchRefBlock | searchEmbedBlock
                                          | findReplace | searchAsset | searchTag
POST /api/block/getBlockKramdown | getBlockKramdowns | getChildBlocks | getTailChildBlocks
                                          | getBlockBreadcrumb | getBlockBreadcrumbChildren
                                          | getBlockDOM | getBlockDOMs | getBlockInfo | getDocInfo | getTreeStat
POST /api/block/appendBlock | prependBlock | insertBlock | batchAppendBlock | batchPrependBlock | batchInsertBlock
                                          | updateBlock | batchUpdateBlock | deleteBlock | moveBlock | foldBlock | unfoldBlock
POST /api/attr/setBlockAttrs | getBlockAttrs | batchSetBlockAttrs | batchGetBlockAttrs | resetBlockAttrs
POST /api/export/exportMdContent          POST /api/export/exportMd | exportMds | exportHTML | exportDocx
                                          | exportNotebookMd | exportResources
POST /api/file/getFile | putFile | removeFile | renameFile | readDir
POST /api/asset/upload | setFileAnnotation | getFileAnnotation | getDocAssets | resolveAssetPath
POST /api/system/version | currentTime | bootProgress | getConf | getWorkspaceInfo | setAPIToken | setAccessAuthCode
POST /api/tag/getTag | renameTag | removeTag      POST /api/bookmark/getBookmark | renameBookmark | removeBookmark
POST /api/ref/getBacklink2 | getBacklinkDoc | getBackmentionDoc | refreshBacklink | getGlobalBacklinks
POST /api/outline/getDocOutline | getDocHeadingNumbers     POST /api/template/render | renderSprig
GET  /api/system/version | bootProgress | getBootAppearance | getCaptcha | /api/icon/getDynamicIcon
```

`/api/transactions` (the raw Protyle transaction channel) exists and is what the UI uses for edits, but the official docs
classify its operations as internal with no compatibility guarantee. Prefer the typed `/api/block/*` endpoints.

## Appendix B — sources consulted

* [docs/API.md (official English API reference)](https://github.com/siyuan-note/siyuan/blob/master/docs/API.md) — current official doc; also `docs/API.zh-CN.md`, `docs/API.ja.md`
* [docs/API-CONTRACTS.md](https://github.com/siyuan-note/siyuan/blob/master/docs/API-CONTRACTS.md) — contract/generation rules, required-by-default semantics
* [Legacy API.md mirror](https://raw.githubusercontent.com/siyuan-note/siyuan/2aeb531d6504df63204a23b85163082fa587ad70/API.md) — older root-level doc, still the only doc for ≤v2.10 shapes
* Source files read (master @ v3.8.6): `kernel/api/router.go`, `kernel/api/sql.go`, `kernel/api/search.go`, `kernel/api/block.go`, `kernel/api/filetree.go`, `kernel/api/export.go`, `kernel/api/contract.go`, `kernel/api/box_lease.go`, `kernel/model/session.go`, `kernel/model/auth.go`, `kernel/model/search.go`, `kernel/model/blockinfo.go`, `kernel/model/index.go`, `kernel/apicontract/{response,query,search,search_block,search_query,block,block_inputs,block_edit,block_tree,block_transaction,filetree_input,filetree_remaining,notebook,export,contracts}.go`, `kernel/sql/{database,block_query,stmt_validate,query_limit,file_annotation_ref}.go`, `kernel/treenode/node.go`, `kernel/util/{net,session,misc,result}.go`, `kernel/conf/search.go`, `kernel/server/serve.go`, `app/electron/main.js`, `app/src/types/api/index.d.ts`, `app/appearance/langs/en.json`, `88250/lute` `ast/node.go`
* Community: [leolee9086 kernel API docs](https://leolee9086.github.io/siyuan-kernelApi-docs/) (useful, but its `orderBy` semantics and `pageSize` handling are wrong — see [§4.1](#41-full-text-search--api-search-fulltextsearchblock)), [SiYuan API 基础入门](https://segmentfault.com/a/1190000047858475) (write-via-SQL warning), [DeepWiki: Full-Text Search](https://deepwiki.com/siyuan-note/siyuan/9.1-full-text-search), [siyuan-mcp](https://github.com/PurpleLiu/siyuan-mcp)
* `docs.siyuan-note.club` (cited by the SegmentFault article as the official doc host) is **dead** — the domain is parked for sale. Use the in-repo `docs/` files instead.

---

## About this document

Written for **dsh-siyuan-api** — the DeepSeek Harness plugin that drives SiYuan over this API. It records the
field-level facts the plugin depends on, so a future contributor (or a future model session) does not have to
re-derive them from the kernel sources.

- **Provenance:** compiled from SiYuan's public sources and official documentation, cited in Appendix B.
  Field names and response shapes are quoted from Go `json:"…"` struct tags; no SiYuan source code is reproduced.
- **Fidelity:** everything was read from source at v3.8.6. Items that could not be verified by reading code are
  marked `[inferred]` inline — treat those as hypotheses, not facts.
- **Not official**: this is a third-party reference. When it disagrees with SiYuan's own
  [`docs/API.md`](https://github.com/siyuan-note/siyuan/blob/master/docs/API.md), that document wins.
- **SiYuan licensing:** SiYuan itself is AGPL-3.0; this document is an independent description of its public
  HTTP interface, published under the same MIT license as the rest of this repository.

