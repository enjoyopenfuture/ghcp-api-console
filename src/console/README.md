# Console 模块说明

`src/console` 是 GHCP API Learning 系统的本地管理控制台：它提供一个 React 管理界面和一个轻量 Express 服务，用于登录控制台、查看/操作 proxy、sso、login 三个服务暴露的管理 API。Console 自身只保存控制台管理员账号文件，不直接承载模型代理、SSO 用户、登录任务等业务数据。

## 1. 模块定位

Console 解决“运维/开发人员如何集中管理各服务状态和手动修复 token/账号问题”的问题。

职责：

- 提供 Web UI：仪表盘、SSO 用户、AI Credits、请求统计、Proxy 账号、Login 任务、上游错误诊断和服务连通性诊断。
- 提供控制台登录鉴权：首次初始化管理员，后续使用 cookie session 登录。
- 作为浏览器到内部服务的 API 网关：浏览器只访问 `/api/console/**`，Console 服务端再转发到 proxy/sso/login 的 `/api/**`。
- 给上游服务补充内部认证头 `X-Internal-Token`，避免前端直接持有内部 token。

非职责/当前未提供：

- 当前未提供 Console 自己的数据数据库；只通过 `admins.json` 保存控制台管理员。
- 当前未提供外部 SSO/OAuth 登录 Console、细粒度 RBAC、多管理员管理界面。
- 当前未提供专门的 Vite dev/HMR npm script；服务端 API proxy 已提供 Node test runner 测试。

## 2. 核心功能

### 登录与鉴权

- `GET /api/console/setup` 判断是否已有启用管理员。
- 首次访问时前端进入初始化页，`POST /api/console/setup` 创建第一个管理员。
- 已初始化后通过 `POST /api/console/login` 登录，`POST /api/console/logout` 退出。
- 已登录管理员可在 Settings 输入当前密码并修改自己的登录密码；修改后当前 session 保持登录。
- 登录态存在 `console_session` cookie 中，`httpOnly`、`sameSite: lax`、有效期 8 小时。

### 管理页面

| 页面 | 代码入口 | 实际能力 |
| --- | --- | --- |
| Dashboard | `DashboardPage` | 汇总 proxy accounts、SSO users、login tasks、request stats；展示近期失败任务/失败请求。 |
| SSO Users | `UsersPage` | 查询/分页、创建、编辑、CSV 导入、批量创建、从 GH/SCIM 预览并应用导入、批量同步/挂起/删除 GH login、分配/移除 Copilot seat。 |
| AI Credits Usage | `AiCreditsUsagePage` | 读取/刷新企业 AI Credits 用量、展示预计本月用量和 Copilot seat 成本。 |
| Request Stats | `RequestStatsPage` | 查看 proxy 请求统计，按 identity/GH login、model、成功状态过滤。 |
| Proxy Accounts | `ProxyAccountsPage` | 查看 identity 映射和 Copilot OAuth 状态、详情、验证后导入 token、发起重新授权、批量删除选中 Proxy account 及其 request stats。 |
| Login Tasks | `LoginTasksPage` | 查询/分页/筛选登录任务，取消、重试失败任务、删除终态任务。 |
| Settings | `SettingsPage` | 修改当前 Console 管理员密码；在线读取/更新 SSO 与 Login runtime settings。 |
| Error Diagnostics | `ErrorDiagnosticsPage` | 分页查看 Copilot 上游失败摘要，预览含 headers/body/curl 的人类可读日志，下载完整 `.log`，清空诊断文件。 |
| Diagnostics | `DiagnosticsPage` | 调用 proxy/sso/login-service 代理路由检查服务连通性和内部 token 是否匹配。 |

### 与 proxy/sso/login 的交互

Console 前端不直接访问这些服务；所有请求先到 Console：

- `/api/console/proxy/**` → `PROXY_BASE_URL/api/**`
- `/api/console/sso/**` → `SSO_BASE_URL/api/**`
- `/api/console/login-service/**` → `LOGIN_BASE_URL/api/**`

转发时 Console 会：

- 要求已登录管理员；
- 设置 `Accept: application/json`、`Content-Type: application/json`；
- 设置 `X-Internal-Token: <INTERNAL_API_TOKEN>`；
- GET/HEAD 不带 body，其他方法把前端 JSON body 重新序列化；
- 原样透传上游 HTTP status、content-type、`content-disposition` 和响应 bytes，支持诊断 `.log` 附件下载；转发失败返回 `502 { error: { code: 'service_proxy_failed', message } }`。

## 3. 启动方式

以下命令均从仓库根目录执行。

### 开发/本地运行

```bash
npm install
npm --workspace @ghcp/shared run build
npm --workspace @ghcp/console run build
npm run start:console
```

然后访问 `http://localhost:7004`。首次打开会要求创建管理员。

注意：

- `start:console` 实际执行 `npm --workspace @ghcp/console run start`，即 `tsx src/server/index.ts`。
- Console 服务会从 `dist/web` 提供前端静态文件，所以启动前需要先 `npm --workspace @ghcp/console run build`。
- `@ghcp/shared` 的 package exports 指向 `dist/index.js`，本地启动前需要先构建 shared。
- proxy/sso/login 需按配置分别运行；仓库根脚本提供 `start:proxy`、`start:sso`、`start:login`。

### 类型检查/构建

```bash
npm --workspace @ghcp/console run typecheck
npm --workspace @ghcp/console run build
npm --workspace @ghcp/console run test
```

`build` 会执行 `tsc && vite build`，输出目录由 Vite/TS 配置为 `dist/`、`dist/web`。

### Docker

`src/console/Dockerfile` 支持从仓库根作为构建上下文构建镜像：

```bash
docker build -f src/console/Dockerfile -t ghcp-console .
docker run --rm -p 7004:7004 \
  -e SESSION_SECRET='replace-me' \
  -e INTERNAL_API_TOKEN='same-as-services' \
  -e PROXY_BASE_URL='http://proxy:3000' \
  -e SSO_BASE_URL='http://sso:7001' \
  -e LOGIN_BASE_URL='http://login:7003' \
  -v '<host-admins-dir>:/app/src/console/data' \
  ghcp-console
```

Dockerfile 会安装依赖、构建 `@ghcp/shared` 和 `@ghcp/console`，启动命令为 `npm --workspace @ghcp/console run start`。如果不挂载 `ADMINS_FILE` 所在目录，容器删除后管理员文件会丢失。

## 4. 配置参数

Console 使用 `dotenv/config` 读取当前进程工作目录下的 `.env`，建议复制 `src/console/.env.example` 为 `src/console/.env`，或由进程管理器注入环境变量。

| 变量 | 默认值（代码） | `.env.example` | 是否必须 | 用途/关系 |
| --- | --- | --- | --- | --- |
| `PORT` | `7004` | `7004` | 否 | Console HTTP 端口；代码校验为 1-65535。 |
| `ADMINS_FILE` | `./data/admins.json` | `./data/admins.json` | 否 | 控制台管理员文件路径；首次 setup 会创建目录并以 `0600` 写入。 |
| `SESSION_SECRET` | `dev-secret-change-me` | `change-me` | 生产必须设置 | `cookie-session` 签名密钥；默认值仅适合本地开发。 |
| `INTERNAL_API_TOKEN` | 空字符串 | `change-me` | 集成环境必须设置 | 转发到 proxy/sso/login 时作为 `X-Internal-Token`；必须与上游服务配置一致。 |
| `PROXY_BASE_URL` | `http://localhost:3000` | `http://proxy:3000` | 否 | proxy 服务地址；Console 转发 `/api/console/proxy/**` 到这里。 |
| `SSO_BASE_URL` | `http://localhost:7001` | `http://sso:7001` | 否 | sso 服务地址；Console 转发 `/api/console/sso/**` 到这里。 |
| `LOGIN_BASE_URL` | `http://localhost:7003` | `http://login:7003` | 否 | login 服务地址；Console 转发 `/api/console/login-service/**` 到这里。 |
| `LOG_LEVEL` | `info`（shared logger） | `info` | 否 | `apiProxy` 使用 `loggerFor('console', 'api-proxy')` 输出转发日志；支持 `debug/info/warn/error`。 |

根目录 `.env.example` 中也出现了 `SESSION_SECRET`、`INTERNAL_API_TOKEN` 等共享变量；Console 代码实际只直接读取上表变量。

### Console 环境变量与 Settings 页

Console 自身没有 runtime settings 表。上表环境变量只在 Console 启动时读取，修改后需要重启；它们不会被 Settings 页面覆盖。Settings 页面只是经过 Console 的认证代理调用：

- `GET/PATCH /api/console/sso/settings/runtime` → SSO 的 `/api/settings/runtime`
- `GET/PATCH /api/console/login-service/settings/runtime` → Login 的 `/api/settings/runtime`

SSO settings 保存在 `sso.sqlite`：用户上限、用户名 fallback、默认 email 域、`sync_emu` 并发以及 SCIM delay/retry。Login settings 保存在 `login.sqlite`：Login 并发、认证超时、debug 日志和 debug artifacts。保存请求带 `expectedVersion`；发生 409 时页面重新加载最新值，避免覆盖另一管理员的修改。

Console 管理员密码不是 runtime setting。Settings 页面调用 Console 自身的 `PATCH /api/console/password`，先校验当前密码，再为当前登录用户名生成新的随机 salt 和 scrypt hash，写回 `ADMINS_FILE`。新密码立即用于后续登录；当前 cookie session 不会被注销。

| 服务 | Setting | 默认值 | Console 校验范围 |
| --- | --- | ---: | --- |
| SSO | `maxSsoUsers` | `null`（不限） | 空值或整数 `1..1000000` |
| SSO | `userPrefix` | `user` | 规范化后必须含字母或数字，最长 32 字符 |
| SSO | `emailDomain` | `customsso.com` | 合法域名 |
| SSO | `bulkSyncConcurrency` | `3` | 整数 `1..20` |
| SSO | `scimRequestDelayMs` | `250` | 整数 `0..60000` |
| SSO | `scimMaxRetries` | `3` | 整数 `0..10` |
| SSO | `scimRetryBaseDelayMs` | `1000` | 整数 `0..60000` |
| Login | `concurrency` | `1` | 整数 `1..20` |
| Login | `authTimeoutMs` | `60000` | 整数 `5000..600000` |
| Login | `authDebugLogs` | `false` | boolean |
| Login | `authDebugArtifacts` | `false` | boolean |

Proxy 当前没有可由 Console 修改的 runtime settings。`REQUEST_STATS_PER_ACCOUNT_LIMIT` 和 `PROXY_ERROR_DIAGNOSTICS_*` 只能通过 Proxy 环境变量配置并重启生效；Error Diagnostics 页面只负责读取、下载和清空记录，不修改采集策略。Login task 历史也没有自动 retention setting，只能在 Login Tasks 页面逐条删除终态任务。密钥、服务 URL、文件路径、证书和 token 均不应进入 Settings。

## 5. 接口与 API 边界

### Console 服务端接口

| 方法/路径 | 认证 | 请求核心结构 | 响应核心结构 |
| --- | --- | --- | --- |
| `GET /healthz` | 无 | 无 | `{ status: 'ok', service: 'console' }` |
| `GET /api/console/setup` | 无 | 无 | `{ initialized: boolean }` |
| `POST /api/console/setup` | 无；但已有 enabled admin 时失败 | `{ username?: string, password?: string }` | `201 { username, role: 'admin' }`；失败 `400 ApiErrorResponse` |
| `POST /api/console/login` | 无 | `{ username?: string, password?: string }` | `{ username, role: 'admin' }`；失败 `401 ApiErrorResponse` |
| `POST /api/console/logout` | 无 | 无 | `204` |
| `GET /api/console/me` | Console admin | 无 | `{ username, role: 'admin' }` |
| `PATCH /api/console/password` | Console admin | `{ currentPassword: string, newPassword: string }` | 成功 `204`；当前密码错误返回 `401 invalid_current_password`。 |
| `/api/console/proxy/**` | Console admin | JSON；由前端 API client 决定 | 透传 proxy `/api/**` 响应 |
| `/api/console/sso/**` | Console admin | JSON；由前端 API client 决定 | 透传 sso `/api/**` 响应 |
| `/api/console/login-service/**` | Console admin | JSON；由前端 API client 决定 | 透传 login `/api/**` 响应 |

`ApiErrorResponse` 来自 shared：`{ error: { code, message, details?, requestId? } }`。

### 前端 API client

通用 `api<T>(path, options)`：

- 默认设置 JSON `Accept`/`Content-Type`。
- 非 2xx 时尝试读取 `error.message` 并抛出 `Error`。
- `204` 返回 `undefined`，其他成功响应解析为 JSON。

#### proxy client（`src/web/api/proxy.ts`）

| 函数 | Console 路径 | 核心结构 |
| --- | --- | --- |
| `listProxyAccounts({ q,page,pageSize,sort,dir })` | `GET /api/console/proxy/accounts` | `PageResponse<ProxyAccountDto>`；兼容数组响应并在前端包装分页。 |
| `getProxyAccount(identity)` | `GET /api/console/proxy/accounts/:identity` | `ProxyAccountDto` |
| `deleteProxyAccount(identity)` | `DELETE /api/console/proxy/accounts/:identity` | `DeleteProxyAccountResult`；只删除 Proxy 数据，不删除 SSO/GH 用户。 |
| `listRequestStats({ identity?, limit? })` | `GET /api/console/proxy/request-stats` 或 `/accounts/:identity/request-stats` | `ProxyRequestStatDto[]` |
| `reauthorizeCopilotOauth(identity, { ssoPassword, ssoType })` | `POST /api/console/proxy/accounts/:identity/copilot-oauth/reauthorize` | `ProxyAccountDto | undefined` |
| `importCopilotOauthTokens(csvText)` | `POST /api/console/proxy/accounts/copilot-oauth-token/import` | `BatchResult<ImportCopilotOauthTokenRow>`；请求 `{ csvText }`。 |
| `listErrorDiagnostics({ page,pageSize })` | `GET /api/console/proxy/error-diagnostics` | `ProxyErrorDiagnosticsListResponse` 摘要分页。 |
| `getErrorDiagnostic(id)` | `GET /api/console/proxy/error-diagnostics/:id` | 完整 `ProxyErrorDiagnosticRecordDto`。 |
| `downloadErrorDiagnostic(id)` | `GET /api/console/proxy/error-diagnostics/:id/download` | 返回附件 `Blob` 和服务端文件名。 |
| `clearErrorDiagnostics()` | `DELETE /api/console/proxy/error-diagnostics` | 发送 `{ confirm: true }` 清空全部记录。 |

#### sso client（`src/web/api/sso.ts`）

| 函数 | Console 路径 | 核心结构 |
| --- | --- | --- |
| `listSsoUsers({ q,page,pageSize,sort,dir })` | `GET /api/console/sso/users` | `PageResponse<SsoUserDto>` |
| `getSsoUserCapacity()` | `GET /api/console/sso/users/capacity` | `SsoUserCapacityDto` |
| `getSsoRuntimeSettings()` | `GET /api/console/sso/settings/runtime` | `SsoRuntimeSettingsDto` |
| `updateSsoRuntimeSettings({ expectedVersion, changes })` | `PATCH /api/console/sso/settings/runtime` | `SsoRuntimeSettingsDto` |
| `createSsoUser({ ssoUser,password?,email?,role? })` | `POST /api/console/sso/users` | `SsoUserDto` |
| `patchSsoUser(ssoUser, { password?,email?,role? })` | `PATCH /api/console/sso/users/:ssoUser` | `SsoUserDto` |
| `importSsoUsers(csvText)` | `POST /api/console/sso/users/import` | `BatchResult<{ line, ssoUser, status, detail }>` |
| `importEmuUsers({ ssoUser?, dryRun? })` | `POST /api/console/sso/users/emu/import` | `BatchResult<ImportEmuUserRow>`；当前 App 主要使用 plan 流程。 |
| `createEmuImportPlan({ ssoUser? })` | `POST /api/console/sso/users/emu/import/plans` | `ImportEmuPlanDto` |
| `listEmuImportPlanRows(planId,{ page,pageSize,status })` | `GET /api/console/sso/users/emu/import/plans/:planId/rows` | `PageResponse<ImportEmuUserRow>` |
| `applyEmuImportPlan(planId)` | `POST /api/console/sso/users/emu/import/plans/:planId/apply` | `ImportEmuPlanDto` |
| `deleteEmuImportPlan(planId)` | `DELETE /api/console/sso/users/emu/import/plans/:planId` | `void` |
| `runSsoUserBatch({ operation,ssoUsers,enterpriseRole?,assignCopilotSeat? })` | `POST /api/console/sso/users/batch` | `BatchResult<SsoUserBatchRow>`；`sync_emu` 默认只同步 login，显式传 `assignCopilotSeat=true` 时同时分配 seat。 |
| `readAiCreditsUsage()` | `GET /api/console/sso/ai-credits/usage` | `AiCreditsUsageDto` |
| `refreshAiCreditsUsage()` | `POST /api/console/sso/ai-credits/usage/refresh` | `AiCreditsUsageDto` |

#### login client（`src/web/api/login.ts`）

| 函数 | Console 路径 | 核心结构 |
| --- | --- | --- |
| `listLoginTasks(limit)` | `GET /api/console/login-service/tasks?limit=...` | `LoginTaskDto[]` |
| `getLoginRuntimeSettings()` | `GET /api/console/login-service/settings/runtime` | `LoginRuntimeSettingsDto` |
| `updateLoginRuntimeSettings({ expectedVersion, changes })` | `PATCH /api/console/login-service/settings/runtime` | `LoginRuntimeSettingsDto` |
| `listLoginTasksPage({ q,status,page,pageSize })` | `GET /api/console/login-service/tasks?...` | `PageResponse<LoginTaskDto>` |
| `cancelLoginTask(id)` | `POST /api/console/login-service/tasks/:id/cancel` | `LoginTaskDto` |
| `deleteLoginTask(id)` | `DELETE /api/console/login-service/tasks/:id` | `void` |
| `retryLoginTask(id,{ ssoPassword,ssoType? })` | `POST /api/console/login-service/tasks/:id/retry` | `LoginTaskDto` |

## 6. 数据结构

### `admins.json`

`ADMINS_FILE` 指向一个 JSON 数组。Console 不读取默认文件内容；结构由 `adminsStore.ts` 定义：

```json
[
  {
    "username": "admin",
    "password_hash": "<scrypt hex hash>",
    "salt": "<16-byte random hex salt>",
    "role": "admin",
    "enabled": true
  }
]
```

说明：

- `setupAdmin` 仅在当前没有 enabled admin 时允许创建。
- `changeAdminPassword` 只修改当前登录的 enabled admin，必须先通过旧密码校验，并重新生成 salt/hash。
- 密码使用 Node `crypto.scryptSync(password, salt, 64)` 计算 hex hash。
- 校验使用 `timingSafeEqual`。
- 读取时只要求对象里有字符串 `username` 才会进入后续校验；无效文件会导致读取失败抛错。

### Console 本地会话

```ts
interface ConsoleSession {
  admin?: { username: string; role: 'admin' };
}
```

`requireAdmin` 只检查 `session(req).admin` 是否存在。

### 前端主要模型

主要模型来自 `@ghcp/shared/src/contracts.ts`：

- `ProxyAccountDto`：`identity`、`ssoUser`、可选 `ghLogin`、Copilot OAuth 状态与更新时间。
- `ProxyRequestStatDto`：请求时间、identity、path、model、成功/失败原因、input/output/cache token 统计。
- `ProxyErrorDiagnosticRecordDto`：失败类型、原始入站请求、实际 Copilot 请求、上游响应或 transport/stream 异常；可能包含未脱敏凭据和用户内容。
- `SsoUserDto`：`ssoUser`、email、role、可选 `ghLogin/ghScimId`、EMU 状态、Copilot seat 状态与错误。
- `LoginTaskDto`：任务 id、identity、ssoUser、可选 ghLogin、`ssoType`、状态、尝试次数、失败原因、时间戳。
- `SsoRuntimeSettingsDto` / `LoginRuntimeSettingsDto`：运行时设置值、乐观锁 `version` 和 `updatedAt`。
- `AiCreditsUsageDto`：企业名、上月/本月用量、当前月预测、seat 数量与成本。
- `ImportEmuPlanDto` / `ImportEmuUserRow`：GH/SCIM 导入预览、应用结果、行级状态与摘要。
- `ImportCopilotOauthTokenRow`、`SsoUserBatchRow`：批处理行结果。
- 通用 `PageResponse<T>`：`{ items, total, page, pageSize }`。
- 通用 `BatchResult<Row>`：`{ batchId, startedAt, finishedAt, summary, rows }`。

关键枚举：

- `SsoType`: `'azure' | 'custom'`
- `LoginTaskStatus`: `'pending' | 'running' | 'success' | 'failed' | 'cancelled'`
- `CopilotOauthStatus`: `'valid' | 'expired' | 'missing' | 'refreshing' | 'failed'`
- `EmuStatus`: `'active' | 'suspended' | 'deleted' | 'not_synced'`
- `CopilotSeatStatus`: `'unknown' | 'assigned' | 'unassigned' | 'assign_failed' | 'remove_failed'`
- `SsoUserBatchOperation`: `'sync_emu' | 'suspend_emu' | 'delete_emu' | 'delete_sso' | 'assign_copilot' | 'remove_copilot'`

## 7. 代码结构

```text
src/console/
├── Dockerfile                 # 容器构建：安装依赖，构建 shared 和 console，启动 console
├── package.json               # start/typecheck/build 脚本；依赖 @ghcp/shared
├── tsconfig.json              # TS 编译配置，输出到 dist
├── vite.config.ts             # React/Vite/Tailwind，前端输出 dist/web
├── .env.example               # Console 运行所需环境变量示例
└── src/
    ├── server/
    │   ├── index.ts           # Express app、cookie session、auth/setup/login、静态资源、服务代理挂载
    │   ├── config.ts          # 环境变量读取和 PORT 校验
    │   ├── auth.ts            # ConsoleSession 与 requireAdmin
    │   ├── adminsStore.ts     # admins.json 读写、scrypt hash、管理员验证
    │   ├── apiProxy.ts        # proxy/sso/login 转发、附件透传与 X-Internal-Token 注入
    │   └── apiProxy.test.ts   # 二进制附件和 Content-Disposition 透传测试
    └── web/
        ├── main.tsx           # React 挂载入口
        ├── App.tsx            # 页面状态、路由 hash、所有管理页面与弹窗
        ├── api/               # 前端 API client：client/proxy/sso/login
        ├── components/ui/     # Button/Input/Badge/Card/Dialog/Textarea
        └── lib/format.ts      # 日期、数字、状态样式和 token 汇总格式化
```

## 8. 开发提示

- 入口定位：后端从 `src/server/index.ts` 看路由和中间件；前端从 `src/web/App.tsx` 的 `pages` 数组和 `AdminApp` 看页面入口。
- 新增管理页面：先在 `Page` union 和 `pages` 数组加页面，再在 `AdminApp` 中挂载组件，API 调用放到 `src/web/api/*.ts`。
- 新增上游调用：优先在对应 client 文件声明函数；如果是新服务，需要在 `apiProxy.ts`、`config.ts` 和 `.env.example` 增加 base URL 与转发挂载。
- 调试认证：先看 `/api/console/setup`、`/api/console/me`；服务间 401/403 多半是 `INTERNAL_API_TOKEN` 与上游不一致。
- 调试转发：设置 `LOG_LEVEL=debug` 或 `info`，查看 `[console:api-proxy]` 日志中的 target、method、suffix、status、durationMs。
- 调试 Copilot 请求：在 proxy 日志中找到 `diagnosticId`，到 **Error Diagnostics** 查看逐行 headers、格式化 body 和 curl；大记录优先下载完整 `.log`，页面只做有限预览。
- 调试前端：浏览器 Network 中应只看到 `/api/console/**`；如果直接访问 proxy/sso/login，说明调用边界被破坏。
- 敏感信息：`SESSION_SECRET`、`INTERNAL_API_TOKEN`、SSO 密码、Copilot OAuth token 不要提交。Error Diagnostics 默认不脱敏，Console 管理员可以看到和下载 API Key、上游 Authorization、prompt、工具内容及响应，必须严格控制管理员账号。
