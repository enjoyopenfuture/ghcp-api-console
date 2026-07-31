# `src/` 项目总览

`src/` 是本仓库的核心实现：把 GitHub Copilot 包装成一个可被内部系统调用的 LLM API Provider。它对外提供 OpenAI/Anthropic/Responses 兼容接口，对内拆分账号、SSO/EMU、OpenCode Copilot OAuth、请求统计和后台运维能力。

详细实现请看各模块 README：

| 模块 | 说明 |
| --- | --- |
| [`proxy`](./proxy/README.md) | 面向调用方的 Copilot API 代理；负责 API Key、identity、Copilot OAuth、请求转发和统计。 |
| [`sso`](./sso/README.md) | 本地 SSO/SAML IdP、SSO 用户管理、GitHub SCIM/EMU 同步、Copilot seat 和 AI Credits 用量。 |
| [`login`](./login/README.md) | OpenCode OAuth Device Flow + Playwright 自动登录服务；成功后把 Copilot OAuth token 回写给 proxy。 |
| [`console`](./console/README.md) | React + Express 管理控制台；登录后统一操作 proxy/sso/login 的内部 API。 |
| `mock-github` | 本地 GitHub SCIM mock，供开发时模拟 EMU provisioning。 |
| `packages/shared` | 跨服务共享 DTO、API error、HTTP client、logger、ID、时间和脱敏工具。 |

## 1. 设计思路

系统按“对外流量”和“内部运维流量”拆分：

- **业务调用流量**只进入 `proxy`。调用方携带 `API_KEY` 和身份头，`proxy` 负责找到或初始化该身份对应的账号，再转发到 GitHub Copilot API。
- **账号初始化**由 `proxy` 协调。未知 identity 首次请求通常返回 `202 account_initializing`，后台由 `proxy` 调 `sso` 确保 SSO 用户/同步 EMU，再由 `proxy` 调 `login` 创建登录任务；`login` 成功后把 Copilot OAuth token 回写给 `proxy`。
- **后台运维流量**进入 `console`。浏览器只访问 `/api/console/**`，由 console 服务端补充 `X-Internal-Token` 后转发给 `proxy`、`sso`、`login`。
- **跨服务契约**集中在 `packages/shared/src/contracts.ts` 和 `api.ts`，避免各服务重复定义 DTO、分页、批处理和错误结构。

## 2. 软件架构

```text
  Client / SDK / Internal App
      | Authorization: Bearer <API_KEY>
      | X-User-Identity: <identity>
      v
  proxy
      |-- ensure user / sync EMU ---------------------> sso
      |                                                 |
      |                                                 v
      |                                      GitHub SCIM / Copilot seat / AI Credits APIs
      |
      |-- create login task --------------------------> login
      |                                                 |
      |                                                 v
      |                                      GitHub device flow + browser SSO login
      |
      |<------------- Copilot OAuth token write-back ---|
      |
      v
  GitHub Copilot APIs (direct Bearer)

--------------------- another view ---------------------------------

  Admin Browser
    v
  console -----> proxy /api/*
          -----> sso /api/*
          -----> login /api/*

  mock-github 可替代真实 GitHub SCIM，用于本地开发。（mock未做测试，只在项目初期使用过。）
```

`login` 和 `sso` 没有服务间 API 调度关系：`proxy` 分别调用它们；`login` 只是在浏览器自动化登录过程中跟随 GitHub SAML/SSO 跳转访问 SSO 登录页面或外部 IdP 页面。

默认端口：

| 服务 | 默认端口 | 说明 |
| --- | ---: | --- |
| `proxy` | `3000` | 公共 LLM API 和内部管理 API。 |
| `sso` | `7001` | SAML 公开路由和内部 SSO/EMU API。 |
| `login` | `7003` | 内部登录任务 API。 |
| `console` | `7004` | 后台 Web 控制台。 |
| `mock-github` | `8002` | 本地 SCIM mock 服务。 |

## 3. 快速上手

从仓库根目录安装依赖并先构建 shared：

```bash
npm install
npm --workspace @ghcp/shared run build
```

复制各服务环境变量模板：

```bash
cp src/proxy/.env.example src/proxy/.env
cp src/sso/.env.example src/sso/.env
cp src/login/.env.example src/login/.env
cp src/console/.env.example src/console/.env
cp src/mock-github/.env.example src/mock-github/.env
```

按需启动服务：

```bash
npm run start:mock-github
npm run start:sso
npm run start:proxy
npm run start:login
npm --workspace @ghcp/console run build
npm run start:console
```

访问控制台：

```text
http://localhost:7004
```

常用健康检查：

```bash
curl http://localhost:3000/healthz
curl http://localhost:7001/healthz
curl http://localhost:7003/healthz
curl http://localhost:7004/healthz
curl http://localhost:8002/healthz
```

> 如果 `.env` 覆盖了端口，请使用实际端口。`console` 当前从 `dist/web` 提供前端静态文件，启动前需要先构建 console。

## 4. 关键配置关系

| 配置 | 作用 | 需要对齐的服务 |
| --- | --- | --- |
| `INTERNAL_API_TOKEN` | 内部 API 鉴权头 `X-Internal-Token`；用于 console 转发、proxy 调 sso 或 login、login 写回 token、sso 删除用户时回调 proxy 清理账号。 | `console`、`proxy`、`sso`、`login` 必须一致。 |
| `API_KEY` | `proxy` 公共 LLM API 的本地 API Key。 | 调用方和 `proxy`。 |
| `IDENTITY_HEADER` | `proxy` 识别调用身份的请求头，默认 `X-User-Identity`。 | 调用方和 `proxy`。 |
| `PROXY_BASE_URL` | 指向 `proxy` 根地址，不带 `/api`。 | `console`、`sso`、`login`。 |
| `SSO_BASE_URL` | 指向 `sso` 根地址，不带 `/api`。 | `console`、`proxy`。 |
| `LOGIN_BASE_URL` | 指向 `login` 根地址，不带 `/api`。 | `console`、`proxy`。 |
| `SCIM_TOKEN` | GitHub/Mock SCIM Bearer token。 | `sso` 与 `mock-github` 或真实 GitHub SCIM。 |
| `SESSION_SECRET` | Cookie session 签名。Compose 复用一个值；SSO 与 Console cookie 独立，单独部署时可使用不同强密钥。 | `sso`、`console`。 |
| `DB_PATH` | 各服务 SQLite 文件路径。 | `proxy`、`sso`、`login` 各自独立。 |
| `LOG_LEVEL` | 结构化日志等级。 | 所有服务。 |

配置来源和生效规则：

- 根 `.env` 服务于 Docker Compose 插值；服务目录 `.env` 服务于单独运行 workspace。只有 Compose 文件显式传递的变量才会进入容器。
- 环境变量负责端口、地址、密钥、文件路径和静态行为，在进程启动时读取，修改后要重启对应服务。
- Console **Settings** 通过内部 API 修改 `sso_runtime_settings` 和 `login_runtime_settings`，保存在各自 SQLite 中；保存后无需重启。
- 两类配置当前没有同名 key。Settings 首次建表使用 migration 中的代码默认值，不读取旧环境变量。
- Proxy 当前没有 runtime settings API；`REQUEST_STATS_PER_ACCOUNT_LIMIT` 是 env-only。Login task 历史当前也没有自动清理 setting 或环境变量。

运行时 Settings：

| 服务 | Setting | 默认值 | 范围/语义 |
| --- | --- | ---: | --- |
| SSO | `maxSsoUsers` | `null` | `null` 或 `1..1000000`；限制 SSO 用户总数。 |
| SSO | `userPrefix` | `user` | 用户名 fallback，规范化后最长 32 字符。 |
| SSO | `emailDomain` | `customsso.com` | 新用户默认 email 域名。 |
| SSO | `bulkSyncConcurrency` | `3` | `1..20`；只控制 `sync_emu` 批处理。 |
| SSO | `scimRequestDelayMs` | `250` | `0..60000`；SCIM 请求最小间隔。 |
| SSO | `scimMaxRetries` | `3` | `0..10`；SCIM 最大重试次数。 |
| SSO | `scimRetryBaseDelayMs` | `1000` | `0..60000`；SCIM 退避基础延迟。 |
| Login | `concurrency` | `1` | `1..20`；当前进程并发任务数。 |
| Login | `authTimeoutMs` | `60000` | `5000..600000`；新任务认证超时。 |
| Login | `authDebugLogs` | `false` | 新任务是否写详细账号日志。 |
| Login | `authDebugArtifacts` | `false` | 新任务是否保存调试产物。 |

其他重要配置：

- `sso` 的 SAML 需要 `BASE_URL`、`SP_ENTITY_ID`、`SP_ACS_URL`、`CERT_DIR`，证书目录中必须有 `idp-cert.pem` 和 `idp-key.pem`。
- `sso` 的 GitHub SCIM/Copilot 功能需要 `ENTERPRISE_SLUG`、`SCIM_BASE_URL`/`MOCK_GITHUB_BASE_URL`、`SCIM_TOKEN`、`GITHUB_COPILOT_SEAT_PAT`。
- `login` 的 Playwright 流程可通过 `AUTH_*_SELECTOR` 覆盖页面选择器，通过 `AUTH_HEADLESS` 和 Console 中的运行时 debug 设置调试。
- `console` 的管理员文件由 `ADMINS_FILE` 指定，默认 `./data/admins.json`。

## 5. 功能边界与 API 约定

### 5.1 通用约定

- 内部 API 统一使用请求头：`X-Internal-Token: <INTERNAL_API_TOKEN>`。
- 公共 LLM API 使用 `Authorization: Bearer <API_KEY>` 或 `x-api-key: <API_KEY>`。
- JSON 错误响应统一为：

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

- 分页响应统一为 `PageResponse<T>`：`{ items, total, page, pageSize }`。
- 批处理响应统一为 `BatchResult<Row>`：`{ batchId, startedAt, finishedAt, summary, rows }`。

### 5.2 proxy

公共接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 返回 OpenAI 风格模型列表；请求解析为 Claude Code 优化模式时只返回 `/v1/messages` 模型，保持 Copilot 原始模型名。 |
| `POST` | `/chat/completions` | 转发 OpenAI Chat Completions 形状请求。 |
| `POST` | `/responses` | 转发 OpenAI Responses 形状请求。 |
| `POST` | `/v1/messages` | 转发 Anthropic Messages 形状请求。 |
| `POST` | `/v1/messages/count_tokens` | 仅请求解析为 Claude Code 优化模式时提供；必要时本地估算 token。 |

管理/服务间接口：

| 路径 | 说明 |
| --- | --- |
| `/api/accounts*` | 查询账号、验证并导入 Copilot OAuth token、发起重新授权。 |
| `/api/request-stats` | 查看最近请求统计。 |
| `/internal/accounts/:identity/copilot-oauth-token` | `login` 成功后回写 Copilot OAuth token。 |
| `/internal/accounts/:identity/mark-copilot-oauth-failed` | `login` 失败后标记 OAuth authorization failed。 |
| `/internal/accounts/by-sso-user/:ssoUser` | `sso` 删除用户时清理 proxy 账号和统计。 |

边界：`proxy` 不在 OpenAI、Anthropic、Responses 请求体之间互转；调用方必须把请求发到匹配的路径。未知 identity 会先触发初始化并返回 202。

### 5.3 sso

公开/SAML 路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/metadata` | 输出 SAML IdP metadata。 |
| `GET` | `/sso` | 处理 GitHub 发来的 SAMLRequest。 |
| `GET/POST` | `/login` | 本地 SSO 登录表单。 |
| `POST` | `/logout` | 清理 session。 |

内部 API：

| 路径 | 说明 |
| --- | --- |
| `/api/users/ensure` | 根据 identity 确保 SSO 用户存在，供 proxy 初始化账号。 |
| `/api/settings/runtime` | 读取/更新 SSO runtime settings；更新使用 `expectedVersion` 乐观锁。 |
| `/api/users`、`/api/users/:ssoUser` | 用户查询、创建、修改。 |
| `/api/users/import` | CSV 导入 SSO 用户。 |
| `/api/users/batch` | 批量 `sync_emu`、`suspend_emu`、`delete_emu`、`delete_sso`、`assign_copilot`、`remove_copilot`。 |
| `/api/users/emu/import*` | 从 GitHub/SCIM 反向导入预览、查看、应用、删除计划。 |
| `/api/ai-credits/usage*` | 读取或刷新 AI Credits 用量缓存。 |

边界：`sso` 不获取 GitHub OAuth token，不直接调用 `login`；删除 SSO 用户时会调用 `proxy` 内部清理接口。

### 5.4 login

内部 API：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/tasks` | 查询最近任务或分页搜索任务。 |
| `POST` | `/api/tasks` | 创建登录任务，返回 `202 LoginTaskDto`。 |
| `GET` | `/api/tasks/:id` | 查看单个任务。 |
| `POST` | `/api/tasks/:id/cancel` | 取消 pending/running 任务。 |
| `POST` | `/api/tasks/:id/retry` | 复用原任务信息并重新提供密码后重试。 |
| `DELETE` | `/api/tasks/:id` | 删除 success/failed/cancelled 任务。 |
| `GET/PATCH` | `/api/settings/runtime` | 读取/更新 Login runtime settings；更新使用 `expectedVersion` 乐观锁。 |

边界：`login` 没有面向终端用户的 UI，也不维护最终账号状态；成功/失败结果都回写给 `proxy`。

### 5.5 console

Console 自身接口：

| 路径 | 说明 |
| --- | --- |
| `/api/console/setup` | 首次创建管理员，或查询是否已初始化。 |
| `/api/console/login`、`/api/console/logout`、`/api/console/me` | 控制台登录态。 |
| `/api/console/proxy/**` | 转发到 `PROXY_BASE_URL/api/**`。 |
| `/api/console/sso/**` | 转发到 `SSO_BASE_URL/api/**`。 |
| `/api/console/login-service/**` | 转发到 `LOGIN_BASE_URL/api/**`。 |

边界：Console 只保存管理员文件，不保存 proxy/sso/login 的业务数据；浏览器不直接持有 `INTERNAL_API_TOKEN`。

### 5.6 mock-github

本地 SCIM mock，数据只保存在进程内存中，重启会清空。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET/POST` | `/scim/v2/enterprises/:enterprise/Users` | 列表/创建 SCIM 用户。 |
| `PUT/PATCH/DELETE` | `/scim/v2/enterprises/:enterprise/Users/:id` | 更新、暂停、删除 SCIM 用户。 |

## 6. 核心数据结构

主要共享类型在 `packages/shared/src/contracts.ts`：

| 类型 | 归属 | 用途 |
| --- | --- | --- |
| `ProxyAccountDto` | `proxy` | identity、SSO/GH 映射和 Copilot OAuth 状态，不包含原始 token。 |
| `ProxyRequestStatDto` | `proxy` | 一次 LLM 请求的路径、模型、成功状态、失败原因和 token 用量。 |
| `SsoUserDto` | `sso` | SSO 用户、email、role、GH login/SCIM id、EMU 状态、Copilot seat 状态。 |
| `ImportEmuPlanDto`、`ImportEmuUserRow` | `sso` | 从 SCIM 反向导入 EMU 用户的预览计划与行结果。 |
| `AiCreditsUsageDto` | `sso` | 企业 AI Credits 上月/本月用量、预测用量、seat 数量和成本。 |
| `CreateLoginTaskRequest` | `login` | 创建登录任务所需 identity、SSO 用户、密码、GH login、OAuth attempt id 和 SSO 类型。 |
| `LoginTaskDto` | `login` | 登录任务状态、尝试次数、失败原因、日志路径和时间戳。 |

各服务本地持久化：

| 服务 | 存储 | 主要内容 |
| --- | --- | --- |
| `proxy` | SQLite | `proxy_accounts`、`proxy_request_stats`。 |
| `sso` | SQLite + 事件日志 | `sso_users`、`sso_runtime_settings`、`sso_budget_cache`、`sso_emu_import_plans`、`sso_emu_import_plan_rows`。 |
| `login` | SQLite + 文件日志 | `login_tasks`、`login_runtime_settings` 和每账号登录日志。 |
| `console` | JSON 文件 | `admins.json`，保存控制台管理员用户名、scrypt hash、salt、role、enabled。 |
| `mock-github` | 内存 Map | 模拟 SCIM user resource。 |

关键枚举：

| 枚举 | 值 |
| --- | --- |
| `CopilotOauthStatus` | `valid`、`expired`、`missing`、`refreshing`、`failed` |
| `EmuStatus` | `active`、`suspended`、`deleted`、`not_synced` |
| `CopilotSeatStatus` | `unknown`、`assigned`、`unassigned`、`assign_failed`、`remove_failed` |
| `LoginTaskStatus` | `pending`、`running`、`success`、`failed`、`cancelled` |
| `SsoType` | `azure`、`custom` |

## 7. 代码结构

```text
src/
  proxy/
    src/server.ts                 # Express app、公共兼容 API、/api、/internal
    src/copilot/                  # Copilot OAuth 凭据、模型缓存和请求转发
    src/db/                       # proxy_accounts、proxy_request_stats
  sso/
    src/server.ts                 # SAML 公开路由、/api 内部路由
    src/users/                    # SSO 用户、SCIM/EMU、batch、导入计划
    src/saml/                     # SAML metadata、AuthnRequest、SAMLResponse
    src/db/                       # 用户、预算、导入计划、事件日志
  login/
    src/server.ts                 # /api/tasks、/api/settings/runtime
    src/tasks/                    # 内存队列、runtime concurrency、runner、账号日志
    src/auth/                     # device flow、Playwright 登录策略
  console/
    src/server/                   # 控制台登录、静态资源、API proxy
    src/web/                      # React 管理界面和前端 API client
  mock-github/
    src/server.ts                 # 本地 SCIM mock
  packages/shared/
    src/contracts.ts              # 跨服务 DTO
    src/api.ts                    # INTERNAL_AUTH_HEADER、ApiError、分页、批处理
    src/httpClient.ts             # JsonHttpClient
    src/logger.ts                 # 结构化 logger
    src/redact.ts                 # 敏感字段脱敏
```

## 8. 开发维护建议

- **改 API 或 DTO**：先改对应服务 route/repo，再同步 `packages/shared/src/contracts.ts`，最后更新 console 前端 API client 和页面。
- **改数据库字段**：更新服务 `db/migrations.ts`、repo row mapper、DTO、README。
- **新增服务间调用**：上游新增 route，下游新增 `clients/*Client.ts`；内部调用统一使用 `JsonHttpClient` 和 `X-Internal-Token`。
- **改登录流程**：优先通过 `login` 的 `AUTH_*_SELECTOR` 和 debug 配置验证；确认是流程变化后再改 `HeadlessPlaywrightAuthStrategy.ts`。
- **排查转发问题**：从 `console` Network 看 `/api/console/**`，再看 `[console:api-proxy]` 日志和上游服务日志。
- **排查账号初始化**：看 `proxy` 的 token manager 日志、`sso_users`、`login_tasks`、`proxy_accounts` 四处状态是否一致。
- **敏感信息**：不要提交 `.env`、SQLite 数据库、管理员文件、登录日志、Copilot OAuth token、SSO 密码或 trace 截图。

## 9. 构建与检查

常用命令：

```bash
npm run build --workspaces --if-present
npm run typecheck --workspaces --if-present
```

按模块检查：

```bash
npm --workspace @ghcp/shared run typecheck
npm --workspace @ghcp/proxy run typecheck
npm --workspace @ghcp/sso run typecheck
npm --workspace @ghcp/login run typecheck
npm --workspace @ghcp/console run typecheck
npm --workspace @ghcp/mock-github run typecheck
```

Proxy、SSO、Login 提供 workspace 测试脚本；Console 和 mock-github 当前没有测试脚本。文档变更通常只需要检查 Markdown diff，代码变更至少运行受影响 workspace 的 typecheck/test。
