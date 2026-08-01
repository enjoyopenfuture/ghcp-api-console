# SSO 模块说明

`@ghcp/sso` 是本仓库中的自定义 SSO/EMU 管理服务。它维护本地 SSO 用户，作为 SAML IdP 完成登录，调用 GitHub SCIM 创建/更新 EMU 用户，管理 Copilot seat，并缓存 Copilot AI Credits 用量。服务对外有两类入口：浏览器/SAML 公开路由，以及带内部令牌的 `/api` 路由。

> 本文只基于 `src/sso` 代码、`src/packages/shared` contracts、`package.json`、`.env.example`、`Dockerfile` 和 `tsconfig.json`。代码中没有的能力会标注“当前未提供/未配置”。

## 1. 模块定位

SSO 模块负责“本地 SSO 用户 ↔ GitHub Enterprise Managed User(EMU)”之间的身份桥接：

- **本地身份源**：在 SQLite 中保存 `ssoUser`、密码哈希、email、角色、GH SCIM/登录名、Copilot seat 状态。
- **SAML IdP**：向 GitHub Enterprise 返回 SAMLResponse，NameID/username 使用 `ssoUser`。
- **SCIM provisioning**：通过 GitHub SCIM API 创建、更新、暂停、删除 EMU 用户，并保存 `ghLogin` / `ghScimId`。
- **Copilot 管理**：通过 GitHub Enterprise Copilot selected users API 分配/移除 seat，并查询 AI Credits 用量。
- **与 proxy 联动**：提供 `/api/users/ensure` 供内部服务确保 SSO 用户存在；删除 SSO 用户时会调用 `PROXY_BASE_URL` 的内部清理接口删除 proxy 账号和请求统计。

当前未提供/未配置：

- 不直接获取或保存 GitHub OAuth token。
- 不直接调用 login 服务。
- 没有后台自动对账、自动重试队列或定时任务；跨系统一致性依赖显式 API 操作和重试。

## 2. 核心功能

### SAML 登录

- `GET /metadata` 输出 IdP metadata。
- `GET /sso` 解析 GitHub 发来的 Redirect binding `SAMLRequest`，保存 `InResponseTo` / `RelayState` 到 cookie session。
- `GET /login` / `POST /login` 提供简单 HTML 登录表单，使用本地 `sso_users` 的 scrypt 密码哈希校验。
- 登录成功后生成 POST binding SAMLResponse，自动提交到 SP ACS。
- SAMLResponse 中包含 `username`、`full_name`、`emails` attributes。

### 用户管理

- 创建、查询、分页搜索、修改本地 SSO 用户。
- `ensure` 根据 `identity` / `preferredSsoUser` 生成或复用 `ssoUser`；新用户使用 `SSO_DEFAULT_USER_PASSWORD`，未配置时使用 `ssoUser`。
- CSV 导入支持 `ssoUser` 或 `ssoUser,password`；省略密码时只为新用户应用默认密码，已有用户保持不变。
- 删除本地 SSO 用户当前只通过 batch 的 `delete_sso` 操作提供。

#### 密码修改与 Login

SSO 数据库只保存 scrypt 密码哈希和 salt，不能还原用户的明文密码。`POST /users/ensure` 处理已有用户时，只会依次验证当前 `SSO_DEFAULT_USER_PASSWORD` 和该用户的 `ssoUser`；匹配时才返回 `passwordForLogin`。因此，通过 Console、`PATCH /users/:ssoUser` 或 CSV 导入将密码修改为其他值后，SSO 仍可使用新密码完成 SAML 登录，但不能把该密码自动提供给 Login，未知 identity 的自动初始化会因缺少密码而失败。管理员需要在 Console 的 **Reauthorize Copilot OAuth** 中重新输入新密码。

### SCIM / EMU

- `sync_emu`：将本地 `ssoUser` 同步到 GitHub SCIM，保存 `ghScimId`、`ghLogin`，并标记 `emuStatus=active`。
- enterprise role 可由请求显式传入；未传时本地 `role=admin` 映射为 `enterprise_owner`，其他映射为 `user`。
- `suspend_emu`：PATCH SCIM user 的 `active=false`，并标记 `emuStatus=suspended`。
- `delete_emu`：移除 Copilot seat、删除 SCIM user，并将本地 EMU 信息重置为 `not_synced`。
- 反向导入：从 SCIM 拉取用户并分页读取 Enterprise Copilot seats 生成 preview plan，apply 时同步本地身份映射和 `copilot_seat_status`。
- SCIM 请求支持节流和对 `429`、`5xx`、带 `retry-after` 的 `403` 重试。

### Copilot seats 与 AI Credits

- `sync_emu` 成功后会自动尝试分配 Copilot seat。
- 可单独调用 assign/remove seat API。
- seat 状态写入 `sso_users.copilot_seat_*`；失败会记录 `assign_failed` / `remove_failed` 和错误信息。
- AI Credits 刷新会查询 GitHub billing usage summary，固定使用 `sku=copilot_ai_unit`，缓存上月和本月用量。
- seat 月成本在代码中固定按 `19 * assignedSeatCount` 计算。

### 与 proxy 的边界

SSO 只在两处与 proxy 发生代码级关系：

1. 内部服务可调用 `POST /api/users/ensure` 获取或创建 `ssoUser`。
2. `delete_sso` 删除时调用 `DELETE {PROXY_BASE_URL}/internal/accounts/by-sso-user/:ssoUser`，并携带同一个 `X-Internal-Token`。

当前未提供：SSO 侧没有主动同步 proxy 中已存在账号的 `ghLogin`，也没有读取 proxy 状态的 API。

## 3. 启动方式

所有命令从仓库根目录执行。

### 开发运行

```bash
npm install
npm --workspace @ghcp/shared run build
npm run start:sso
```

`start:sso` 实际执行 `npm --workspace @ghcp/sso run start`，而 SSO 的 `start` 脚本是 `tsx src/index.ts`。默认监听 `http://localhost:7001`。

建议先根据 `src/sso/.env.example` 配置环境变量。SAML 启动会从 `CERT_DIR` 读取 `idp-cert.pem` 和 `idp-key.pem`；缺失时服务会在加载 SAML 模块时失败。

### 本地构建/检查

```bash
npm --workspace @ghcp/sso run typecheck
npm --workspace @ghcp/sso run build
```

`@ghcp/sso` 提供 `start`、`start:prod`、`typecheck`、`build` 和 `test` 脚本。

### Docker

`src/sso/Dockerfile` 会在镜像内执行 `npm install`，构建 `@ghcp/shared`，然后运行 `npm --workspace @ghcp/sso run start`。

```bash
docker build -f src/sso/Dockerfile -t ghcp-sso .
docker run --rm -p 7001:7001 --env-file src/sso/.env.example ghcp-sso
```

真实运行时请替换示例密钥，并挂载/设置 `DB_PATH`、`CERT_DIR` 指向可写数据库目录和证书目录。Dockerfile 本身未声明 `EXPOSE`/`HEALTHCHECK`；仓库根 `docker-compose.yml` 已配置端口、卷、依赖和健康检查。

## 4. 配置参数

`src/sso/src/config.ts` 使用 `dotenv/config` 读取环境变量；`.env.example` 是示例值，不代表生产可用值。

| 变量 | 默认值 | 何时必填 | 用途/关系 |
|---|---:|---|---|
| `PORT` | `7001` | 否 | Express 监听端口。 |
| `LOG_LEVEL` | `info` | 否 | 由 shared logger 读取：`debug` / `info` / `warn` / `error`。 |
| `DB_PATH` | `./data/sso.sqlite` | 否 | SQLite 文件路径；启动时自动建目录、执行 migration。 |
| `INTERNAL_API_TOKEN` | 空字符串 | `/api` 必填 | `/api` 认证令牌；为空时所有内部 API 都会返回 401。也用于调用 proxy。 |
| `BASE_URL` | `http://localhost:7001` | SAML 正确对外访问时必填 | 生成 IdP metadata 中的 entityID、SSO URL、Logout URL。 |
| `PROXY_BASE_URL` | `http://localhost:3000` | 删除 SSO 用户并清理 proxy 时必填 | `delete_sso` 时回调 proxy 内部删除接口。 |
| `MOCK_GITHUB_BASE_URL` | `http://localhost:8002` | 本地/mock 场景 | `SCIM_BASE_URL` 为空时作为 SCIM fallback；`SP_ACS_URL` 为空时作为 mock ACS fallback。 |
| `SESSION_SECRET` | `dev-secret-change-me` | 真实环境必填 | `cookie-session` 签名密钥。 |
| `SSO_DEFAULT_USER_PASSWORD` | 未设置 | 否 | 新用户默认密码；未设置时使用 `ssoUser`。只从环境变量读取，不进入 DB 或 Console。 |
| `SSO_USER_EVENTS_LOG` | `./data/sso-user-events.log` | 否 | 追加写入部分用户事件。 |
| `ENTERPRISE_SLUG` | `acme` | GitHub/SCIM/Copilot 场景必填 | GitHub Enterprise slug；用于 SCIM fallback、Copilot seat、AI Credits、默认 SP entityID。 |
| `ENTERPRISE_SHORTCODE` | `octo` | GH login fallback 时必填 | SCIM 响应无 `githubLogin` 时生成 `<normalized>_<shortcode>`；`ensure` 也会剥离该后缀。 |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | Copilot/API 调用时 | Copilot seat 和 AI Credits 的 GitHub API 根地址。 |
| `GITHUB_COPILOT_SEAT_PAT` | 未设置 | Copilot seat / AI Credits 必填 | Bearer token；代码不在启动时强校验，调用相关功能时校验。 |
| `SCIM_BASE_URL` | 空字符串 | 真实 SCIM 必填 | GitHub SCIM base URL；为空时使用 `MOCK_GITHUB_BASE_URL/scim/v2/enterprises/{ENTERPRISE_SLUG}`。 |
| `SCIM_TOKEN` | 空字符串 | SCIM 调用必填 | SCIM Bearer token；代码不在启动时强校验。 |
| `CERT_DIR` | `../../certs` | SAML 启动必填 | 目录中必须有 `idp-cert.pem`、`idp-key.pem`。`.env.example` 示例为 `../../certs`。 |
| `SP_ENTITY_ID` | 空字符串 | 真实 GitHub SAML 建议配置 | 为空时 fallback 为 `https://github.com/enterprises/{ENTERPRISE_SLUG}`。 |
| `SP_ACS_URL` | 空字符串 | 真实 GitHub SAML 必填 | 为空时 fallback 到 mock GitHub ACS。 |

用户上限、用户名 fallback、默认邮箱域、SCIM 限流/重试和 `sync_emu` 并发保存在 `sso_runtime_settings`，通过 Console Settings 页面保存后对下一次操作生效。

### `.env` 与 runtime Settings

环境变量负责端口、内部密钥、服务/GitHub/SCIM 地址、PAT、SAML 证书、SQLite/事件日志路径和默认密码等部署配置，启动时读取，修改后要重启 SSO。Runtime Settings 保存在 `sso.sqlite`，通过 Console **Settings** 或 `GET/PATCH /api/settings/runtime` 管理，无需重启。

| Setting | 默认值 | 合法范围 | 生效语义 |
| --- | ---: | --- | --- |
| `maxSsoUsers` | `null` | `null` 或整数 `1..1000000` | 限制 SSO 用户总数；`null` 不限。创建、ensure、CSV 导入和导入计划 apply 都受限，降低上限不会删除现有用户。 |
| `userPrefix` | `user` | 规范化后必须含字母或数字，最长 32 字符 | identity 不能生成可用用户名或最终碰撞 fallback 时使用；不重命名现有用户。 |
| `emailDomain` | `customsso.com` | 合法 hostname | 新用户未显式提供 email，以及 EMU 导入缺少主 email 时使用；不修改现有 email。 |
| `bulkSyncConcurrency` | `3` | 整数 `1..20` | 新 `sync_emu` 批处理的并发；其他批处理保持串行。 |
| `scimRequestDelayMs` | `250` | 整数 `0..60000` | 当前 SSO 进程内 SCIM 请求之间的最小间隔。 |
| `scimMaxRetries` | `3` | 整数 `0..10` | 可重试响应/网络错误的最大重试次数；`0` 表示不重试。 |
| `scimRetryBaseDelayMs` | `1000` | 整数 `0..60000` | SCIM 指数退避基础延迟；响应 `Retry-After` 可决定更长等待。 |

Settings 更新使用 `expectedVersion` 乐观锁；版本落后返回 `409 settings_version_conflict`。首次 migration 使用上表代码默认值，不读取旧 `.env`。`SSO_DEFAULT_USER_PASSWORD` 始终是 env-only：它是敏感启动配置，不会显示或保存到 Settings。

Runtime settings snapshot 当前缓存在进程内；多个 SSO 实例共享同一 SQLite 时，其他实例不会自动收到某一实例保存的设置，需要额外的跨进程失效机制或重启。

## 5. 接口与 API 边界

### 认证规则

- `/healthz`、`/metadata`、`/sso`、`/login`、`/logout` 不需要 `X-Internal-Token`。
- 所有 `/api/*` 路由都需要请求头：`X-Internal-Token: <INTERNAL_API_TOKEN>`。
- JSON 错误响应统一为 `{ "error": { "code": string, "message": string, ... } }`。
- JSON body 限制为 `5mb`；URL encoded body 限制为 `1mb`。

### 公开/SAML 路由

| 方法 | 路径 | 认证 | 请求核心 | 响应核心 |
|---|---|---|---|---|
| `GET` | `/healthz` | 无 | 无 | `{ status: "ok", service: "sso" }` |
| `GET` | `/metadata` | 无 | 无 | SAML IdP metadata XML |
| `GET` | `/sso` | cookie session | `SAMLRequest?`, `RelayState?` query | 未登录跳 `/login`；已登录返回自动提交到 ACS 的 HTML |
| `GET` | `/login` | 无 | 无 | HTML 登录表单 |
| `POST` | `/login` | 无 | form: `username`, `password` | 登录失败 401 HTML；成功后返回 SAML POST HTML 或登录状态 HTML |
| `POST` | `/logout` | cookie session | 无 | 清空 session，重定向 `/login` |

### 用户与 EMU API（全部带 `/api` 前缀）

| 方法 | 路径 | 请求核心 | 响应核心 |
|---|---|---|---|
| `POST` | `/users/ensure` | `{ identity, preferredSsoUser? }` | `EnsureSsoUserResponse`：`{ user, passwordForLogin?, created }` |
| `GET` | `/settings/runtime` | 无 | `SsoRuntimeSettingsDto`，包含设置、`version`、`updatedAt`。 |
| `PATCH` | `/settings/runtime` | `{ expectedVersion, changes }` | 保存 runtime settings；校验失败返回 400，版本冲突返回 409。 |
| `GET` | `/users/capacity` | 无 | `{ current, limit, remaining, reached }`。 |
| `GET` | `/users` | query: `q?`, `page?`, `pageSize?`, `sort?`, `dir?` | `PageResponse<SsoUserDto>` |
| `POST` | `/users` | `{ ssoUser, password?, email?, role? }` | `201 SsoUserDto` |
| `POST` | `/users/import` | `{ csvText }` | `BatchResult<{ line, ssoUser, status, detail }>` |
| `POST` | `/users/batch` | `{ operation, ssoUsers, enterpriseRole? }` | `BatchResult<SsoUserBatchRow>` |
| `POST` | `/users/emu/import` | `{ ssoUser?, dryRun? }` | `BatchResult<ImportEmuUserRow>` |
| `POST` | `/users/emu/import/plans` | `{ ssoUser? }` | `ImportEmuPlanDto` |
| `GET` | `/users/emu/import/plans/:planId` | path: `planId` | `ImportEmuPlanDto` |
| `GET` | `/users/emu/import/plans/:planId/rows` | query: `status?`, `page?`, `pageSize?` | `PageResponse<ImportEmuUserRow>` |
| `POST` | `/users/emu/import/plans/:planId/apply` | path: `planId` | `ImportEmuPlanDto` |
| `DELETE` | `/users/emu/import/plans/:planId` | path: `planId` | `204 No Content` |
| `GET` | `/users/:ssoUser` | path: `ssoUser` | `SsoUserDto` |
| `PATCH` | `/users/:ssoUser` | `{ password?, email?, role? }` | `SsoUserDto` |
| `POST` | `/users/:ssoUser/copilot-seat` | path: `ssoUser` | `SsoUserDto` |
| `DELETE` | `/users/:ssoUser/copilot-seat` | path: `ssoUser` | `SsoUserDto` |

`/users/batch.operation` 当前支持：`sync_emu`、`suspend_emu`、`delete_emu`、`delete_sso`、`assign_copilot`、`remove_copilot`。`enterpriseRole` 仅允许 `user` 或 `enterprise_owner`。

`GET /users` 的 `sort` 当前支持 `ssoUser`、`email`、`role`、`emuStatus`、`createdAt`；`dir` 支持 `asc` / `desc`；`pageSize` 最大 100。

EMU import row 状态当前支持：`pending_create`、`pending_update`、`created`、`updated`、`skipped`、`conflict`、`failed`。

### AI Credits API（全部带 `/api` 前缀）

| 方法 | 路径 | 请求核心 | 响应核心 |
|---|---|---|---|
| `GET` | `/ai-credits/usage` | 无 | `AiCreditsUsageDto`；缓存缺失返回 404 |
| `POST` | `/ai-credits/usage/refresh` | 无 | 重新查询 GitHub、写入缓存并返回 `AiCreditsUsageDto` |

## 6. 数据结构

### SQLite 表

| 表 | 主键/索引 | 主要字段 | 作用 |
|---|---|---|---|
| `sso_users` | `sso_user` PK | `password_hash`, `salt`, `email`, `role`, `gh_login`, `gh_scim_id`, `emu_status`, `copilot_seat_status`, `copilot_seat_last_operation`, `copilot_seat_last_error`, `copilot_seat_updated_at`, `created_at`, `updated_at` | 本地 SSO 用户和外部身份映射。 |
| `sso_runtime_settings` | `id=1` | `max_sso_users`, `user_prefix`, `email_domain`, `bulk_sync_concurrency`, SCIM delay/retry 字段、`version`, `updated_at` | 持久化 Console runtime settings 和乐观锁版本。 |
| `sso_budget_cache` | `period_key` PK | `year`, `month`, `quantity`, `unit_type`, `raw_json`, `fetched_at` | AI Credits 月度用量缓存。 |
| `sso_emu_import_plans` | `id` PK | `sso_user`, `status`, `created_at`, `updated_at`, `applied_at` | SCIM 反向导入 preview/apply 计划。 |
| `sso_emu_import_plan_rows` | `(plan_id, row_index)` PK；`(plan_id,status,row_index)` 索引 | `sso_user`, `email`, `gh_login`, `gh_scim_id`, `emu_status`, `copilot_seat_status`, `status`, `detail`, `action` | 导入计划明细。 |

当前未配置：`gh_login`、`gh_scim_id` 没有数据库唯一索引；重复绑定主要依赖业务逻辑检查。

### 主要领域对象

- `SsoUserRecord`：数据库用户记录，等于 `SsoUserDto` 加上 `passwordHash`、`salt`。
- `ScimUserResource`：SCIM 用户资源，包含 `id`、`userName`、`externalId`、`emails`、`roles`、`active`、`githubLogin`。
- `ProvisionResult`：SCIM 同步结果 `{ scimId, ghLogin }`。
- `ImportEmuPlanDto` / `ImportEmuUserRow`：包含 SCIM 身份与 Copilot seat 状态的反向导入计划及行结果。
- `AiCreditsUsageDto`：上月、本月、预计本月用量、已分配 seat 数、seat 月成本。
- `BatchResult<T>` / `PageResponse<T>`：共享的批处理和分页响应壳。

### shared contracts 中本模块使用的类型

来自 `src/packages/shared/src/contracts.ts` 和 `api.ts`：

- `SsoUserDto`
- `EnsureSsoUserResponse`
- `SsoUserBatchRequest`、`SsoUserBatchOperation`、`SsoUserBatchRow`
- `ImportEmuUsersRequest`、`CreateImportEmuPlanRequest`
- `ImportEmuPlanDto`、`ImportEmuPlanSummary`、`ImportEmuUserRow`
- `AiCreditsUsageDto`、`AiCreditsPeriodUsageDto`
- `BatchResult<T>`、`BatchSummary`、`PageResponse<T>`
- `ApiErrorResponse`、`INTERNAL_AUTH_HEADER`（值为 `X-Internal-Token`）

## 7. 代码结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 入口，只调用 `startServer()`。 |
| `src/server.ts` | 创建 Express app，注册 body parser、cookie session、公开路由、`/api` 内部路由和 404。 |
| `src/config.ts` | 环境变量解析和默认值。 |
| `src/routes/samlRoutes.ts` | SAML metadata、SSO、登录、登出 HTML 路由。 |
| `src/saml/saml.ts` | SAML IdP/SP 配置、证书读取、AuthnRequest 解析、SAMLResponse 构造。 |
| `src/routes/usersApi.ts` | 用户、batch、EMU import、Copilot seat API 参数校验和响应封装。 |
| `src/routes/settingsApi.ts` | Runtime settings 读取、校验、乐观锁更新。 |
| `src/users/service.ts` | 用户生命周期、SCIM 同步、导入计划、batch、proxy 清理的核心业务逻辑。 |
| `src/users/bulkImport.ts` | 简单 CSV 解析，支持 header、去重和错误收集。 |
| `src/scim/scimClient.ts` | SCIM create/update/list/suspend/delete、鉴权、重试、节流。 |
| `src/scim/handle.ts` | 从 `ssoUser` 和 enterprise shortcode 推导 GH login。 |
| `src/copilot/seats.ts` | GitHub Copilot selected users assign/remove，以及 Enterprise seat 列表分页查询。 |
| `src/budget/budgetService.ts` | AI Credits usage 查询、缓存和投影计算。 |
| `src/routes/budgetApi.ts` | AI Credits cache 读取/刷新 API。 |
| `src/db/*` | SQLite 连接、migration、用户/settings repo、预算 cache repo、导入计划 repo、事件日志。 |
| `src/auth/*` | 内部 token middleware、scrypt 密码哈希和校验。 |
| `src/clients/proxyClient.ts` | 删除 SSO 用户时调用 proxy 内部清理接口。 |

## 8. 开发提示

- 新人定位入口：`src/index.ts` → `src/server.ts` → 对应 `routes/*` → `users/service.ts` → `db/*` 或外部 client。
- 新增内部 API：优先放到现有 `/api` router，默认会经过 `requireInternalToken`；如需新 DTO，同步更新 shared contracts。
- 新增公开 SAML 行为：从 `routes/samlRoutes.ts` 和 `saml/saml.ts` 开始，注意 cookie session 与证书读取。
- 修改 SQLite 结构：更新 `db/migrations.ts`，同时更新对应 repo 的 row mapper 和 shared DTO。
- 调试 SCIM：设置 `LOG_LEVEL=debug`，并在 Console Settings 中检查 SCIM delay、max retries 和 retry base delay。
- 调试 Copilot/AI Credits：确认 `GITHUB_COPILOT_SEAT_PAT`、`GITHUB_API_BASE_URL`、`ENTERPRISE_SLUG`；相关功能调用时才会校验 PAT。
- 调试 SAML：确认 `BASE_URL`、`SP_ENTITY_ID`、`SP_ACS_URL`、`CERT_DIR`；证书文件缺失会导致服务启动失败。
- `sync_emu` 批量操作使用 Console Settings 中的并发值，其他破坏性批量操作保持串行。
