# Proxy 模块说明

`@ghcp/proxy` 是本仓库中面向客户端的 Copilot API 代理服务。它接收本地/内部客户端的 OpenAI、Anthropic Messages、Responses 兼容请求，按 `identity` 维护 OpenCode Copilot OAuth token，并把请求直接转发到 GitHub Copilot 后端。

## 1. 模块定位

Proxy 位于客户端与 GitHub Copilot 后端之间，负责：

- 对外提供 Copilot 兼容 API：`/chat/completions`、`/v1/messages`、`/responses`、`/v1/models`。
- 用本地 API Key 保护公共代理接口，用内部 Token 保护管理/服务间接口。
- 按用户身份（默认请求头 `X-User-Identity`）维护账号、Token 状态和请求统计。
- 分别连接 SSO 服务与 Login 服务：未知身份会触发 SSO 用户确保、EMU 同步，并由 Proxy 创建 Login 任务；手动重新授权 Copilot OAuth 也会创建 Login 任务。
- 通过 SQLite 持久化账号、Copilot OAuth token 与最近请求统计。
- 对 Copilot 上游 HTTP、网络和流读取错误保存完整诊断现场，并通过 Console 查看、下载或清空。

## 2. 核心功能

| 能力 | 代码位置 | 说明 |
| --- | --- | --- |
| 公共代理鉴权 | `src/auth/apiKey.ts` | 公共 Copilot 兼容接口必须提供 `Authorization: Bearer <API_KEY>` 或 `x-api-key: <API_KEY>`。 |
| 身份解析 | `src/auth/identityHeader.ts` | 从 `IDENTITY_HEADER` 读取身份；默认必填，关闭后缺省为 `default`。 |
| 内部接口鉴权 | `src/auth/internalAuth.ts` | `/api/*` 与 `/internal/*` 必须提供 `X-Internal-Token`。 |
| 账号初始化 | `src/copilot/copilotAuthManager.ts` | 首次访问未知 `identity` 时异步确保 SSO 用户、同步 GH 登录、创建账号并排队登录任务；请求先返回 202。 |
| Copilot OAuth 管理 | `src/accounts/copilotOauthTokenImport.ts`、`src/db/accountsRepo.ts` | 支持 `/models` 验证后 CSV 导入、Login 服务写入、失败标记和手动重新授权排队。 |
| 模型与路径校验 | `src/copilot/copilotClient.ts` | 使用 OAuth bearer 读取 `/models`，判断模型是否适用于当前 API 路径；缓存按 identity 隔离 1 小时，失败时可短期使用旧缓存。 |
| 请求转发 | `src/routes/compatible.ts` | 使用 OpenCode headers 转发 JSON/SSE 响应；上游 401 时清除 OAuth token 并要求重新授权。 |
| 请求统计 | `src/db/requestStatsRepo.ts` | 记录路径、模型、成功/失败、失败原因、输入/输出/cache token；按账号保留最近 N 条。 |
| 错误诊断 | `src/diagnostics/*` | 保存原始入站请求、实际转发请求和上游错误响应；使用有界轮转的人类可读日志，可选递归脱敏。 |
| Claude Code 优化 | `src/routes/claudeCodeMode.ts`、`src/routes/claudeCodeCompat.ts`、`src/routes/anthropicModelProfiles.ts` | 可选开启，对 `/v1/messages*` 做 Anthropic/Claude Code 兼容处理、模型规范化和 profile 驱动的 thinking/effort 修正；支持请求头覆盖默认模式。 |

当前提供基于 Node test runner 的认证/迁移/路由测试和 `start:prod` 脚本；Dockerfile 未声明 `EXPOSE`/`HEALTHCHECK`。

## 3. 启动方式

以下命令均从仓库根目录执行。

### 3.1 开发运行

```bash
npm install
npm --workspace @ghcp/shared run build
cp src/proxy/.env.example src/proxy/.env
npm --workspace @ghcp/proxy run start
```

`start` 脚本实际执行 `tsx src/index.ts`。由于 `@ghcp/shared` 的运行时入口是 `dist/index.js`，首次运行前需要先构建 shared；Dockerfile 也执行了这一步。

健康检查：

```bash
curl http://localhost:3000/healthz
# {"status":"ok","service":"proxy"}
```

### 3.2 本地构建/运行

```bash
npm --workspace @ghcp/shared run build
npm --workspace @ghcp/proxy run build
(cd src/proxy && node dist/index.js)
```

Package scripts 提供 `start`、`start:prod`、`build`、`typecheck` 和 `test`。构建后直接运行时建议在 `src/proxy` 目录执行，以便 `dotenv` 读取本模块 `.env`；也可以使用 `start:prod` 或显式注入环境变量。

### 3.3 Docker

`src/proxy/Dockerfile` 支持从仓库根目录构建镜像：

```bash
docker build -f src/proxy/Dockerfile -t ghcp-proxy .
docker run --rm -p 3000:3000 --env-file src/proxy/.env ghcp-proxy
```

Dockerfile 会复制根 `package*.json`、`tsconfig.base.json` 和 `src`，执行 `npm install && npm --workspace @ghcp/shared run build`，最后运行 `npm --workspace @ghcp/proxy run start`。

## 4. 配置参数

Proxy 通过 `dotenv/config` 读取环境变量。未设置时使用 `src/config.ts` 的默认值；`src/proxy/.env.example` 是面向本模块的示例。

| 变量 | 代码默认值 / 示例值 | 必填 | 用途与关系 |
| --- | --- | --- | --- |
| `PORT` | `3000` / `3000` | 否 | HTTP 监听端口。 |
| `LOG_LEVEL` | `info`（shared logger 默认）/ `info` | 否 | 日志级别：`debug`、`info`、`warn`、`error`；无效值回退 `info`。 |
| `DB_PATH` | `./data/proxy.sqlite` / 同 | 否 | SQLite 文件路径；启动时自动创建目录、开启 WAL。 |
| `API_KEY` | 空字符串 / `change-me` | 是 | 公共代理接口的本地 API Key；为空时公共接口无法通过鉴权。 |
| `IDENTITY_HEADER` | `X-User-Identity` / 同 | 否 | 公共请求中用于绑定 proxy 账号的请求头名。 |
| `IDENTITY_HEADER_REQUIRED` | `true` / `true` | 否 | 为 `false` 时缺失身份头会使用 `default`。 |
| `CLAUDE_CODE_OPTIMIZED` | `false` / `true` | 否 | Claude Code 兼容优化和 `/v1/messages/count_tokens` 的默认模式；单个请求可用 `X-Claude-Code-Optimized: true|false` 覆盖。 |
| `INTERNAL_API_TOKEN` | 空字符串 / `change-me` | 是 | `/api`、`/internal` 鉴权；同时用于 Proxy 调用 SSO/Login 服务。 |
| `SSO_BASE_URL` | `http://localhost:7001` / 同 | 否 | SSO 服务地址；用于确保用户、读取 SSO 用户、同步 EMU。 |
| `LOGIN_BASE_URL` | `http://localhost:7003` / 同 | 否 | Login 服务地址；用于创建 Copilot OAuth 重新授权任务。 |
| `ENTERPRISE_SHORTCODE` | `octo` / `octo` | 否 | 初始化身份时从规范化 identity 末尾剥离 `_<shortcode>`，生成 SSO 用户名。 |
| `REQUEST_STATS_PER_ACCOUNT_LIMIT` | `2` / `2` | 否 | 每个 identity 保留的请求统计条数；必须为正整数。 |
| `PROXY_ERROR_DIAGNOSTICS_ENABLED` | `true` / `true` | 否 | 是否保存 Copilot 上游失败诊断。关闭后控制台错误摘要仍会输出。 |
| `PROXY_ERROR_DIAGNOSTICS_DIR` | `./data/error-diagnostics` / 同 | 否 | 轮转文本日志目录；Compose 使用 `/data/error-diagnostics`。 |
| `PROXY_ERROR_DIAGNOSTICS_REDACT` | `false` / `false` | 否 | 是否脱敏敏感 headers 和 JSON 字段。默认不脱敏，会保存凭据与完整用户内容。 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB` | `50` / `50` | 否 | 单个诊断文件目标上限 MB；必须为正整数。超大单条记录保持完整。 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILES` | `5` / `5` | 否 | 包含当前文件在内的最大轮转文件数；必须为正整数。 |
| `COPILOT_API_BASE_URL` | `https://api.githubcopilot.com` / 同 | 否 | GitHub.com Copilot API base URL。 |
| `OPENCODE_VERSION` | `1.0.0` / `1.18.4` | 否 | 生成 `User-Agent: opencode/<version>`。 |
| `OPENCODE_USER_AGENT` | 未设置 / 未设置 | 否 | 显式覆盖完整 User-Agent；非空时优先于 `OPENCODE_VERSION`。 |
| `GITHUB_API_VERSION` | `2026-06-01` / 同 | 否 | `X-GitHub-Api-Version` 请求头。 |

### `.env` 与 runtime Settings

Proxy 当前没有 runtime settings 表、Settings 页面字段或 `/api/settings/runtime` 接口；上表全部是启动期环境变量，修改后需要重启 Proxy。密钥、服务地址和数据库路径不会写入 SQLite。

`REQUEST_STATS_PER_ACCOUNT_LIMIT` 是 env-only 的数据保留策略：每次写入统计后清理当前 identity 的旧记录，服务启动时还会对所有 identity 清理一次。代码、Compose fallback、根 `.env.example` 和 `src/proxy/.env.example` 均默认为 `2`。该值必须是正整数。

错误诊断同样是 env-only。默认启用并写入 `diagnostics.log`、`diagnostics.1.log` 等轮转文件；Compose 的目录位于现有 `proxy-data` volume，容器重启后仍保留。每条记录直接列出 headers、格式化后的 JSON/text body、入站请求和实际上游请求的 curl 命令。`PROXY_ERROR_DIAGNOSTICS_REDACT=false` 时，文件会原样包含 API Key、Copilot Authorization、用户 prompt、工具参数和响应内容，必须限制 volume、备份和 Console 管理员权限。设置为 `true` 后会脱敏敏感 headers，并递归脱敏可安全解析的 JSON；无法安全脱敏的非 JSON 或不完整 body 不写正文。

根 `.env` 还包含其他服务的变量，但 Proxy 只读取上表项目。Docker Compose 只会把 `docker-compose.yml` 中 Proxy `environment` 明确列出的变量传入容器。

### 日志等级与错误诊断

`LOG_LEVEL` 是最低控制台日志等级：

| 设置 | 控制台输出 | 推荐场景 |
| --- | --- | --- |
| `debug` | debug、info、warn、error | 短时间排障；会额外打印经过常规 logger 脱敏的入站 headers。 |
| `info` | info、warn、error | 生产默认，能看到常规操作、上游 4xx 和严重故障。 |
| `warn` | warn、error | 只关注异常；仍能看到上游 4xx/5xx。 |
| `error` | error | 仅严重故障；上游 4xx 警告会被隐藏，不建议常态使用。 |

无效值和未设置都按 `info` 处理。完整错误现场是否落盘由 `PROXY_ERROR_DIAGNOSTICS_ENABLED` 独立控制，不要求开启 `debug`；脱敏开关也只影响诊断文件，不改变普通 logger 的脱敏。

## 5. 接口与 API 边界

### 5.1 通用鉴权

公共 Copilot 兼容接口需要：

```http
Authorization: Bearer <API_KEY>
# 或 x-api-key: <API_KEY>
X-User-Identity: <identity>
Content-Type: application/json
X-Claude-Code-Optimized: true|false  # 可选；覆盖 CLAUDE_CODE_OPTIMIZED 默认值
```

内部管理/服务间接口需要：

```http
X-Internal-Token: <INTERNAL_API_TOKEN>
```

`GET /healthz` 不需要鉴权。

### 5.2 健康检查

| 方法 | 路径 | 认证 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 无 | `{ status: "ok", service: "proxy" }` |

### 5.3 公共 Copilot 兼容接口

| 方法 | 路径 | 认证 | 请求核心结构 | 响应核心结构 |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/models` | API Key + identity | 可选请求头 `X-Cache: false` 强制绕过当前 identity 的内存缓存并禁止 stale fallback | 非优化模式返回 OpenAI/Copilot 风格 `{ object: "list", data: [...] }`。Claude Code 优化模式下只返回支持 `/v1/messages` 的模型，并返回 Anthropic 风格 `{ data: [{ type: "model", id, display_name, max_input_tokens, max_tokens }], has_more, first_id, last_id }`；`id` 保持 Copilot 原始模型名。 |
| `POST` | `/chat/completions` | API Key + identity | JSON 对象，必须含 `model: string`；其余字段保持上游 Chat Completions 形状 | 直接返回 Copilot 上游状态、`content-type` 和 body；支持 SSE。 |
| `POST` | `/responses` | API Key + identity | JSON 对象，必须含 `model: string`；其余字段保持上游 Responses 形状 | 同上。 |
| `POST` | `/v1/messages` | API Key + identity | JSON 对象，必须含 `model: string`；其余字段保持 Anthropic Messages 形状 | 同上；优化模式会做 Claude Code 兼容预处理。 |
| `POST` | `/v1/messages/count_tokens` | API Key + identity | 仅当前请求解析为优化模式时可用；JSON 对象，必须含 `model: string` | 优先转发到上游；若上游返回 404/405/501，则本地估算并返回 `{ input_tokens: number }`。 |
| 任意 | `/v1/files*` | API Key + identity | 当前未提供 Files API | 优化模式下返回 Anthropic 风格 `not_supported`；非优化模式走统一 404。 |

边界说明：

- Proxy 不在 OpenAI/Anthropic/Responses 之间转换请求体；调用方必须发送目标路径对应的 body；非常简单的透传模式。
- 转发前会检查 `body.model` 是否存在、模型是否支持当前路径；不支持时返回 400。
- 上游 401 会清除当前 identity 的 OAuth token 并标记为 `expired`；管理员需要重新授权或导入新 token。403 作为 seat/组织策略错误透传，不清除 token。
- 未知 identity 会触发初始化并返回 202：`{ error: { code: "account_initializing", ... } }`。
- 不支持的路径返回 404，并列出当前支持路径。
- 所有 POST 转发都会向 Copilot 发送 `x-initiator`。若入站 `x-initiator` 去除首尾空白并忽略大小写后为 `user` 或 `agent`，Proxy 会优先采用并规范为小写；其他值不会透传，而是回退到请求内容判断。无合法 header 时，Anthropic Messages 的末条 `tool_result`、compact/summary 和自动 `Please continue.`，Chat Completions 的末条 `role:"tool"`，以及 Responses 的末条 `*_call_output` 输入会判为 `agent`，其余请求判为 `user`。该规则同时适用于直接转发和 Claude Code 优化模式。

#### Claude Code 优化模式

当请求解析为 Claude Code 优化模式时，Proxy 将 `/v1/messages` 和 `/v1/messages/count_tokens` 视为 Claude Code 入口，但仍然转发到 Copilot 原生 Anthropic Messages API，不做 Anthropic/OpenAI 大模型协议转换。默认值来自 `CLAUDE_CODE_OPTIMIZED`，单个请求可用 `X-Claude-Code-Optimized: true|false` 覆盖。当前优化逻辑包括：

- **模型与路径**：`GET /v1/models` 只暴露 Copilot `/models` 中支持 `/v1/messages` 的模型；请求体中的 Claude 日期后缀模型名会先规范化，例如 `claude-sonnet-4-5-20250929` -> `claude-sonnet-4.5`，再做路径校验和上游转发。
- **模型 profile**：`anthropicModelProfiles.ts` 维护 Claude 模型的 thinking/effort 能力。enabled-only 模型会去掉不支持的 `output_config.effort`，并把 `thinking.type=adaptive` 改成合法的 enabled 形态；adaptive-only 模型会把 `thinking.type=enabled` 改成 `adaptive`；预算会限制到 profile 上限并保持 `< max_tokens`，thinking 打开时会把强制工具选择 `any/tool` 改成 `auto`。
- **请求体清理**：递归移除 `cache_control.scope`；删除 Claude Code 注入的易变 `# currentDate` 块；过滤无签名、占位或签名含 `@` 的历史 assistant `thinking` 块；去掉 `"Tool loaded."` 边界消息；合并普通 user message 内的 `tool_result + text`，但含 `tool_reference` 的 ToolSearch result 保持独立 content，避免构造 Copilot 不接受的混合 block；末尾 assistant message 后追加 `Please continue.`；非 `defer_loading` 的 `mcp__ide__executeCode` 会被移除。
- **mid-conversation system**：对多数模型，历史中间位置的 `role:"system"` 会改成 `role:"user"`，并给首个 text block 加 `[Claude Code injected]\n` 前缀；仅 profile 标记可接受且位置合法的模型会保留原 system message。
- **Headers / beta**：转发时使用 OpenCode 风格 header：OAuth `Authorization: Bearer`、`User-Agent: opencode/<version>`、`X-GitHub-Api-Version: 2026-06-01`、`Openai-Intent: conversation-edits` 和 `x-initiator`。`anthropic-version` 默认 `2023-06-01`；`anthropic-beta` 只保留允许的 token，并按请求内容派生 `interleaved-thinking-2025-05-14`、`context-management-2025-06-27`、`advanced-tool-use-2025-11-20`、`token-counting-2024-11-01`；会丢弃 `claude-code-*`、陈旧 prompt-caching 和已知 Copilot 不接受的全局 beta。
- **请求意图**：沿用公共 POST 转发的 `x-initiator` 优先级；合法入站值优先于内容推断。无合法 header 时，普通用户请求发送 `user`，compact、`tool_result` 续轮和自动 continue 发送 `agent`；compact 无论 initiator 是否由 header 覆盖，都会额外发送 `x-interaction-type: conversation-other`。
- **视觉与不支持能力**：请求中出现 image content block 时设置 `Copilot-Vision-Request: true`。`/v1/files*` 返回 Anthropic 风格 `not_supported`；`web_search` / `web_search_*` server tool 会在本地前置拒绝，提示改用支持的模型/账号或 MCP 搜索工具。
- **token count**：`/v1/messages/count_tokens` 复用同一套 body 预处理和前置错误检查，优先转发 Copilot；若上游返回 404/405/501，则用本地 JSON 长度估算 `{ input_tokens }`。
- **SSE**：`/v1/messages` 的 SSE 基本透传，保留 Copilot 扩展字段；仅过滤 Copilot 末尾的 OpenAI 风格 `[DONE]` 事件，避免 Claude Code 按 Anthropic SSE 解析时报错。

当请求解析为非优化模式时，Proxy 不会因为请求来自 Claude Code 就拒绝；`POST /v1/messages` 仍会按 Anthropic Messages 形状直接转发，但不会做 Claude Code body 预处理，也不会开放 `/v1/messages/count_tokens`。

公共兼容接口的主要拒绝/错误返回逻辑：

| 场景 | 返回 |
| --- | --- |
| 缺 API Key | `401 missing_api_key`，提示使用 `Authorization: Bearer` 或 `x-api-key`。 |
| API Key 不匹配 | `401 invalid_api_key`。 |
| 缺 identity header，且 `IDENTITY_HEADER_REQUIRED=true` | `400 missing_identity_header`。 |
| `X-Claude-Code-Optimized` 不是合法布尔值 | `400 invalid_request_error`。 |
| 请求 body 不是 JSON 对象 | `400 invalid_request_error`。 |
| 请求 body 缺少字符串类型 `model` | `400 invalid_request_error`。 |
| `model` 不存在，或不支持当前路径 | `400 invalid_request_error`。 |
| 当前请求解析为非优化模式时请求 `/v1/messages/count_tokens` | `404 invalid_request_error`，并列出当前支持路径。 |
| 请求未支持路径，例如 `/v1/files*` | `404 invalid_request_error`；优化模式下 `/v1/files*` 返回 Anthropic 风格 `not_supported`。 |
| 上游 Copilot 返回 401/403 | 返回对应 `401` / `403`。 |
| 其他上游或转发错误 | 通常返回 `502 api_error`。 |

当 Copilot 上游失败时，Proxy 只在常规控制台输出一行摘要，并提供 `diagnosticId` 与诊断文件关联：

- 上游 HTTP 4xx 使用 `WARN upstream-http-error`。
- 上游 HTTP 5xx、fetch/network/abort 和响应流读取失败使用 `ERROR`。
- 摘要包含 identity、path、model、状态码、上游 URL 和 body 字节数，不输出完整正文。
- 诊断文件记录原始入站 method/URL/raw headers/raw body、转换后实际发送的 URL/headers/body，以及上游 status/headers/body 或异常 stack。
- `/v1/messages/count_tokens` 遇到 404/405/501 后即使成功使用本地估算，也会记录该次上游失败。
- 响应诊断最多捕获 20 MB 并标记截断；入站请求沿用 Express 的 20 MB JSON 上限，压缩请求保存解压前原始字节。

### 5.4 管理接口 `/api/*`

全部要求 `X-Internal-Token`。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/api/accounts?q=&page=&pageSize=&sort=&dir=` | 查询参数可选；`sort` 支持 `identity`、`ssoUser`、`ghLogin`、`copilotOauthStatus`、`createdAt`、`updatedAt`；`dir` 支持 `asc`/`desc` | `PageResponse<ProxyAccountDto>`，不返回原始 Token。 |
| `GET` | `/api/accounts/:identity` | 路径参数 identity | `ProxyAccountDto`；不存在返回 404。 |
| `DELETE` | `/api/accounts/:identity` | 路径参数 identity | 删除该 Proxy account、OAuth credential 和 request stats；不删除 SSO/GH 用户。返回 `DeleteProxyAccountResult`。 |
| `POST` | `/api/accounts/copilot-oauth-token/import` | `{ csvText: string }`；CSV 头必须是 `name,copilotOauthToken`，name 不可重复 | `BatchResult<ImportCopilotOauthTokenRow>`；每个 token 通过 `/models` 验证后才写入。 |
| `GET` | `/api/accounts/:identity/request-stats?limit=` | `limit` 默认 100，最大 1000 | `ProxyRequestStatDto[]`。 |
| `GET` | `/api/request-stats?limit=` | 同上 | 跨账号最近请求统计。 |
| `POST` | `/api/accounts/:identity/copilot-oauth/reauthorize` | `{ ssoPassword: string, ssoType?: "azure" | "custom" }`；`ssoPassword` 必填 | 标记 OAuth `refreshing` 并创建 Login 任务，返回 `ProxyAccountDto`。 |
| `GET` | `/api/error-diagnostics?page=&pageSize=` | 分页参数可选，`pageSize` 最大 100 | `ProxyErrorDiagnosticsListResponse`，只返回摘要并指明功能是否开启、是否脱敏。 |
| `GET` | `/api/error-diagnostics/:id` | 诊断 UUID | `ProxyErrorDiagnosticDetailDto`，包含摘要字段和完整人类可读日志；不存在返回 404，功能关闭返回 503。 |
| `GET` | `/api/error-diagnostics/:id/download` | 诊断 UUID | 以 `Content-Disposition: attachment` 下载 `.log` 文本。 |
| `DELETE` | `/api/error-diagnostics` | `{ confirm: true }` | 原子清空全部轮转文件；未确认返回 400。 |

### 5.5 服务间接口 `/internal/*`

全部要求 `X-Internal-Token`，主要供 Login 回写 Copilot OAuth token/失败状态，以及 SSO 删除用户时清理账号。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| `PUT` | `/internal/accounts/:identity/copilot-oauth-token` | `{ oauthAttemptId: string, copilotOauthToken: string, ghLogin?: string }`；授权代次和 token 必填 | 仅当前授权代次匹配时保存 token；过期任务返回 409。 |
| `DELETE` | `/internal/accounts/by-sso-user/:ssoUser` | 路径参数 ssoUser | `{ ssoUser, matchedAccounts, deletedAccounts, deletedRequestStats }`。 |
| `POST` | `/internal/accounts/:identity/mark-copilot-oauth-failed` | `{ oauthAttemptId: string }` | 仅当前授权代次匹配时将 OAuth 状态置为 `failed`；过期失败回写被忽略。 |

## 6. 数据结构

### 6.1 SQLite 表

`src/db/connection.ts` 会按 `DB_PATH` 创建数据库目录，打开 SQLite，设置 `journal_mode = WAL` 和 `foreign_keys = ON`，再运行迁移。

#### `proxy_accounts`

| 字段 | 含义 |
| --- | --- |
| `identity` | Proxy 账号主键，来自身份头。 |
| `sso_user` | SSO 用户名，账号初始化/导入时写入。 |
| `gh_login` | GitHub 登录名，可为空。 |
| `copilot_oauth_token` | OpenCode OAuth client 获取的 OAuth token，DTO 不会返回该字段。 |
| `copilot_oauth_status` | `valid`、`expired`、`missing`、`refreshing`、`failed`。 |
| `copilot_oauth_updated_at` | OAuth token 更新时间。 |
| `copilot_oauth_attempt_id` | 当前/最近一次授权代次，用于防止旧任务覆盖新 token。 |
| `created_at` / `updated_at` | ISO 时间戳。 |

#### `proxy_request_stats`

| 字段 | 含义 |
| --- | --- |
| `id` | UUID。 |
| `identity` / `gh_login` | 请求归属账号。 |
| `requested_at` | 请求时间。 |
| `path` | `/chat/completions`、`/v1/messages`、`/v1/messages/count_tokens`、`/responses`、`/v1/models`。 |
| `model` | 请求中的模型名，可为空。 |
| `success` | 1/0。 |
| `failure_reason` | 失败原因或上游 HTTP 状态。 |
| `input_tokens` / `output_tokens` | 从 JSON/SSE usage 字段解析。 |
| `cache_tokens` / `cache_input_tokens` / `cache_write_tokens` | cache token 统计。 |

索引：`idx_proxy_request_stats_identity_time(identity, requested_at DESC)`。每次写入后会按 `REQUEST_STATS_PER_ACCOUNT_LIMIT` 清理该账号旧记录；服务启动时也会清理一次。

### 6.2 错误诊断文本日志

诊断不写入 SQLite。`ErrorDiagnosticsStore` 串行化 append/rotate/clear，确保并发错误不会交错写入；列表按最新记录优先扫描轮转文件，并忽略进程异常退出留下的不完整记录。每条记录使用明确的 BEGIN/END 标记，正文包含：

- `failureKind`: `http`、`fetch` 或 `stream`；
- identity、兼容 API path、model 和时间；
- 客户端原始 method、URL、按顺序保留并逐行显示的 headers、格式化 body 和 curl；
- 实际发送给 Copilot 的 method、URL、生成后的 headers、格式化 body 和 curl；
- 上游 status、headers、完整或截断的 body；
- transport/stream 异常的 name、message、stack 和 cause。

普通 JSON、text、SSE 等 body 直接以 UTF-8 明文保存，可解析 JSON 会缩进格式化。只有压缩或二进制 body 才标记编码并使用 base64。管理页面直接预览同一文本记录，下载文件与磁盘 `.log` 内容一致。

### 6.3 主要领域对象

| 对象 | 来源 | 用途 |
| --- | --- | --- |
| `ProxyAccountRecord` | `src/db/accountsRepo.ts` | 数据库内部账号记录，包含原始 Token。 |
| `ProxyAccountDto` | `@ghcp/shared` | 对外账号状态 DTO，不包含 `copilot_oauth_token`。 |
| `CopilotAuthContext` | `src/copilot/copilotAuth.ts` | identity、OAuth access token 和 Copilot API endpoint。 |
| `ModelInfo` | `src/copilot/copilotClient.ts` | Copilot `/models` 返回的模型对象，保留额外元数据。 |
| `ProxyRequestStatDto` | `@ghcp/shared` | 请求统计返回结构。 |
| `ProxyErrorDiagnosticRecordDto` | `@ghcp/shared` | 完整错误现场；summary/list DTO 用于 Console 分页。 |
| `BatchResult<T>` / `ImportCopilotOauthTokenRow` | `@ghcp/shared` | CSV 验证并导入 Copilot OAuth token 的批处理结果。 |
| `EnsureSsoUserRequest/Response`、`SsoUserDto` | `@ghcp/shared` | Proxy 调 SSO 服务初始化/查询用户。 |
| `CreateLoginTaskRequest`、`LoginTaskDto` | `@ghcp/shared` | Proxy 调 Login 服务创建登录/刷新任务。 |
| `ApiErrorResponse` | `@ghcp/shared` | 管理/鉴权错误的统一 `{ error: { code, message } }` 结构。 |

## 7. 代码结构

```text
src/proxy/
├── package.json                 # workspace 名称与 scripts
├── Dockerfile                   # Proxy 镜像构建入口
├── .env.example                 # 本模块环境变量示例
├── tsconfig.json                # TS 编译到 dist/
└── src/
    ├── index.ts                 # 进程入口，调用 startServer()
    ├── server.ts                # Express app、路由挂载顺序、404 与启动逻辑
    ├── config.ts                # 环境变量读取、默认值、类型校验
    ├── logger.ts                # proxy scope logger
    ├── auth/                    # API Key、identity header、internal token 中间件
    ├── routes/
    │   ├── compatible.ts        # 公共 Copilot 兼容 API、转发、统计
    │   ├── claudeCodeCompat.ts  # Claude Code 请求预处理与错误适配
    │   ├── anthropicModelProfiles.ts # Claude 模型规范化与 profile
    │   ├── adminApi.ts          # /api 管理接口
    │   └── internalApi.ts       # /internal 服务间接口
    ├── copilot/
    │   ├── copilotAuth.ts       # Copilot OAuth auth context
    │   ├── copilotAuthManager.ts # 账号初始化、OAuth 状态与重新授权
    │   └── copilotClient.ts     # Copilot 模型列表、路径校验、转发 headers
    ├── clients/                 # SSO/Login 服务 JSON client
    ├── accounts/                # Copilot OAuth token 验证与 CSV 导入
    ├── diagnostics/             # 错误现场构造、人类可读格式、轮转文本 store 与测试
    └── db/                      # SQLite 连接、迁移、accounts/stats repo
```

`src/packages/shared/src/contracts.ts` 和 `api.ts` 定义 Proxy 与其他服务共享的 DTO、分页、批处理和错误结构。

## 8. 开发提示

- 看入口：从 `src/index.ts` -> `src/server.ts` 开始，先理解路由挂载顺序：`/healthz` 无鉴权，`/api` 和 `/internal` 走内部鉴权，其余公共请求先 API Key 再 identity。
- 排查账号初始化：看 `copilotAuthManager.getAuth()`；未知 identity 的第一次请求通常返回 202，同时后台创建 SSO/Login 流程。
- 排查转发失败：先从控制台错误摘要取得 `diagnosticId`，在 Console **Error Diagnostics** 查看/下载现场，再看 `compatible.ts` 的 `handleForward()`、`forwardAuthenticated()` 和 `copilotClient.assertModelSupportsPath()`。
- 排查 Claude Code：确认 `CLAUDE_CODE_OPTIMIZED=true`，再看 `claudeCodeCompat.ts` 的 body 预处理、token count fallback 和 Files/WebSearch 错误适配。
- 排查数据：优先查看管理接口 `/api/accounts`、`/api/request-stats`；不要在响应中暴露数据库内的原始 Token。
- 扩展新 Copilot 路径时，至少同步更新 `COPILOT_FORWARD_PATHS`、`compatible.ts` 路由、模型路径推断、`ProxyRequestStatDto.path`、SQLite 统计语义和本文档。
- 新增配置时，同时更新 `config.ts`、`src/proxy/.env.example` 和本 README；若配置影响其他服务，也要检查 shared contracts 或调用客户端。
- 本模块提供 `test` 脚本；改代码后运行 `npm --workspace @ghcp/proxy run test` 和 `npm --workspace @ghcp/proxy run typecheck`，涉及 shared 类型时也运行 shared typecheck。
