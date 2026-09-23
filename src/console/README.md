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
| Login Tasks | `LoginTasksPage` | 完整筛选、可调分页、跨页批量重试/取消/清理、实际队列、阶段时长、独立尝试及脱敏日志。 |
| Settings | `SettingsPage` | 修改当前 Console 管理员密码；在线读取/更新 SSO 与 Login runtime settings。 |
| Error Diagnostics | `ErrorDiagnosticsPage` | 分页查看 Copilot 上游失败摘要，预览含 headers/body/curl 的人类可读日志，下载完整 `.log`，清空诊断文件。 |
| Diagnostics | `DiagnosticsPage` | 调用 proxy/sso/login-service 代理路由检查服务连通性和内部 token 是否匹配。 |

### Copilot 直接席位状态

SSO Users 的 Copilot seat 只展示企业直接分配的席位，不合并组织或团队授权。正常状态为 `assigned`、`unassigned` 和待取消状态 `pending_cancellation`；待取消时列表与 Import from GH 预览/结果统一显示 **`cancell at <日期>`**。日期直接来自 GitHub 的 `pending_cancellation_date`，不按本地时区转换或推算自然月 1 号。筛选值与导出中的状态仍为 `pending_cancellation`，CSV 另含 `copilotSeatPendingCancellationDate` 列。

**Remove seat** 安排按 GitHub 返回的下个计费周期日期取消，并非立即移除权限。到期后页面仍保留最后同步状态，可通过 **Import from GH** 或再次 **Remove seat** 确认 `unassigned`；**Assign seat** 确认恢复后清除日期。请求已受理但状态回读失败时，显示明确错误并保留之前的状态和日期。未分配直接席位并不代表没有组织/团队权限；仅取消席位不会删除 SSO/GH/Proxy 记录或提前作废 token。

Import from GH 先预览、后应用冻结的状态/日期快照；期间发生席位变更时应重新 Preview。升级前未应用的旧预览需要重新生成。AI Credits 的席位数与月成本估算包含待取消席位，只有显式同步确认未分配后才扣除；数据可能滞后，不代表实际账单。Proxy 自动初始化的现有自动分配行为不变，仍可能恢复待取消席位。

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

Settings 按 SSO、Login、管理员安全排列为独立的全宽区块，不使用等高双列卡片。桌面布局将用途与生效说明放在左侧、分组表单放在右侧；窄屏改为上下排列。SSO 区分账户默认值和同步/重试参数，Login 区分任务执行和调试选项；输入项就近显示单位、范围及说明。每个区块独立保存，版本和更新时间与保存按钮位于同一操作区，原有校验与版本冲突处理不变。

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

Proxy 当前没有可由 Console 修改的 runtime settings。`REQUEST_STATS_PER_ACCOUNT_LIMIT` 和 `PROXY_ERROR_DIAGNOSTICS_*` 只能通过 Proxy 环境变量配置并重启生效；Error Diagnostics 页面只负责筛选、读取、下载和清空记录，不修改采集策略。Login 历史没有自动 retention，可按终态和结束时间预览批量清理。密钥、默认密码、服务 URL、文件路径、证书和 token 均不应进入 Settings。

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

#### 统一列表与操作调用

完整管理列表由 `ManagedList` 直接调用通用 `api<T>()`，使用服务端筛选、排序和分页，不再为每个列表维护单独的 API 包装函数，也不在前端把数组补成分页响应。

| 列表 | Console GET 路径 | 响应 |
| --- | --- | --- |
| SSO Users | `/api/console/sso/users` | `PageResponse<SsoUserDto>` |
| Proxy Accounts | `/api/console/proxy/accounts` | `PageResponse<ProxyAccountDto>` |
| Login Tasks | `/api/console/login-service/tasks` | `PageResponse<LoginTaskDto>` |
| Request Stats | `/api/console/proxy/request-stats` | `PageResponse<ProxyRequestStatDto>` |
| Error Diagnostics | `/api/console/proxy/error-diagnostics` | `ProxyErrorDiagnosticsListResponse` |

Users、Proxy Accounts 和 Login Tasks 的列表操作由 `useOperations` 统一访问对应资源下的 `/operations`：内部冻结目标 `POST /preview`，执行 `POST /:id/execute`，手动查询 `GET /:id`。普通操作直接串联冻结与执行，不弹出预览页面；危险操作仅显示简短确认框，重试/重新授权保留凭据确认。行内操作使用单个目标，复用同样的流程。

Proxy 单账号删除、Login 单任务取消/删除/重试的服务端 HTTP 接口仍保留兼容；只是当前列表不再通过旧的前端包装函数调用它们。接口语义见 [Proxy README](../proxy/README.md) 和 [Login README](../login/README.md)。下列 client 提供摘要读取、详情、设置、导入等专用调用，并保留已有的兼容导入入口。

#### proxy client（`src/web/api/proxy.ts`）

| 函数 | Console 路径 | 核心结构 |
| --- | --- | --- |
| `getProxyAccount(identity)` | `GET /api/console/proxy/accounts/:identity` | `ProxyAccountDto` |
| `listRequestStats({ identity?, limit? })` | `GET /api/console/proxy/request-stats` 或 `/accounts/:identity/request-stats` | `ProxyRequestStatDto[]`；供 Dashboard 和账号详情读取近期样本，不用于完整列表分页。 |
| `reauthorizeCopilotOauth(identity, { credentialMode, ssoPassword?, ssoType? })` | `POST /api/console/proxy/accounts/:identity/copilot-oauth/reauthorize` | `ProxyAccountDto`；密码默认由服务端解析 |
| `importCopilotOauthTokens(csvText)` | `POST /api/console/proxy/accounts/copilot-oauth-token/import` | `BatchResult<ImportCopilotOauthTokenRow>`；请求 `{ csvText }`。 |
| `getErrorDiagnostic(id)` | `GET /api/console/proxy/error-diagnostics/:id` | `ProxyErrorDiagnosticDetailDto`。 |
| `downloadErrorDiagnostic(id)` | `GET /api/console/proxy/error-diagnostics/:id/download` | 返回附件 `Blob` 和服务端文件名。 |
| `clearErrorDiagnostics()` | `DELETE /api/console/proxy/error-diagnostics` | 发送 `{ confirm: true }` 清空全部记录。 |

#### sso client（`src/web/api/sso.ts`）

| 函数 | Console 路径 | 核心结构 |
| --- | --- | --- |
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
| `listLoginTasks(limit)` | `GET /api/console/login-service/tasks?limit=...` | `LoginTaskDto[]`；供 Dashboard 读取近期任务，不用于完整列表分页。 |
| `getLoginRuntimeSettings()` | `GET /api/console/login-service/settings/runtime` | `LoginRuntimeSettingsDto` |
| `updateLoginRuntimeSettings({ expectedVersion, changes })` | `PATCH /api/console/login-service/settings/runtime` | `LoginRuntimeSettingsDto` |

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
- `LoginTaskStatus`: `'pending' | 'running' | 'cancelling' | 'success' | 'failed' | 'cancelled'`
- `CopilotOauthStatus`: `'valid' | 'expired' | 'missing' | 'refreshing' | 'failed'`
- `EmuStatus`: `'active' | 'suspended' | 'deleted' | 'not_synced'`
- `CopilotSeatStatus`: `'unknown' | 'assigned' | 'unassigned' | 'assign_failed' | 'remove_failed'`
- `SsoUserBatchOperation`: `'sync_emu' | 'suspend_emu' | 'delete_emu' | 'delete_sso' | 'assign_copilot' | 'remove_copilot'`

### 统一列表与批量操作

`ManagedList` 提供 10 / 25 / 50 / 100 分页（默认 25）、多页时的页码跳转、稳定排序、筛选草稿/应用、URL hash 状态、表头当前页全选和逐行跨页选择、列显隐、紧凑模式和表格内横向滚动。每页条数/列/密度写入本地偏好；选择和滚动现场仅在当前页面会话保留。缓存的列偏好优先于新默认配置。

搜索/筛选、表格和分页位于同一容器。所有列表的批量操作区常驻，动作按钮、导出选中项和清除选择在空选择时也不隐藏；需要目标的操作在未选择记录时禁用，空间不足时自动换行。搜索和筛选始终保留，不随选择切换。不提供 `Select all N matches` 按钮；表头复选框只选择当前页，翻页保留已勾选记录。View 只管理列和密度，Export 提供当前页/全部匹配的导出。SSO 用户的 CSV/GH 导入位于 Import，“同步时分配席位”常驻批量操作区，可在选择记录前设置。

Login Tasks 的 Status 使用可多选下拉菜单，不再使用常驻列表框；未选表示全部状态，勾选或清空后点击 Apply filters 才会提交，URL 仍支持多个状态。Task 列直接显示完整 ID 并保留复制按钮，点击 ID 不会打开详情；任务详情和日志查看入口移至行内更多菜单的 Details。

**默认手动快照，仅 SSO 新提交操作做有限完成跟踪**：空闲页面没有定时轮询、可见性/焦点恢复取数或实时模式。首次进入页面、打开详情、提交查询/翻页时正常读取；创建、编辑、删除等操作提交成功后回读一次当前相关数据。SSO 批量操作接口返回的是已受理，不代表后台执行完成，因此还会跟踪本次已确认提交（含手动恢复确认）的批次：GET 间隔从 1 秒逐步退避至 5 秒，每批最多跟踪 2 分钟，单次查询最多 15 秒；终态到达后自动回读列表和容量，不每次状态查询都重载列表。完成、读取失败/超时或离开页面时停止相应跟踪，超时不代表操作失败；提示通过 Refresh 查询，绝不自动重放。确认框打开或提交结果不确定期间暂停跟踪，返回页面不自动恢复旧批次的跟踪。Proxy、Login（包括运行中的任务和操作）、详情及其他页面仍保持手动快照。

- 列表 Refresh 保留查询、分页、选择、滚动和列偏好，同时读取当前页面会话中尚未结束或提交结果不确定的批次。多个批次也只回读一次列表；Login Tasks 同时读取一次队列和汇总，各区单独报告读取失败。终态批次不重复请求。
- 任务/账号详情使用 Refresh details；不再提供单独的操作结果面板或 Refresh status 按钮。日志仍通过 Preview/Download 显式读取。
- 时间和耗时表示上次成功查询的快照，不是实时状态。后台服务仍会独立执行任务、重试和恢复；关闭详情不取消服务端执行。
- 刷新期间保留已显示数据；失败保留上次成功获取时间，并明确提示数据可能过期，而不是清空为零条。手动刷新操作状态只执行 GET，不重新执行批次。

批次由业务服务执行，Console 不保存业务状态。后台先冻结最多 1000 个目标：同步 GH login、分配席位、取消任务直接提交；删除、挂起 GH login 和移除席位只显示包含目标数量及影响范围的确认框，不展示完整预览页面。预览超过 10 分钟需重新生成，预览已丢失（过期或服务重启）时执行接口返回 `404 operation_not_found`（提示重新预览），而不是把它报成覆盖密码无效。重复提交同一预览由服务端返回当前状态，不会再次执行；普通操作提交失败可在原列表中 Retry submission，沿用原批次而不是重新生成目标。运行中目标的进度由服务端轮询下游确认，间隔逐步退避；同一目标连续 10 次读不到进度（或下游明确返回 404）会标记为 `interrupted` 并附上原因，不会无限停留在 `running`。

SSO、Proxy 和 Login 提交后均不显示结果弹窗或 `Operation:` 内嵌面板：操作按钮在提交期间显示忙状态，接受后给出“已提交”的轻量提示，SSO 完成后另行通知。共享列表已移除 Last action 列，不会因提交或刷新操作结果而新增列；这是 Console 展示层变更，不改变业务服务的接口、数据结构或队列逻辑。操作错误、失败/中断目标及原因统一显示在可关闭的固定浮层中，长详情限高滚动，不挤动表格；相同错误不会因普通重绘反复弹出，显式 Refresh 可重新查看。成功提示自动消失，错误/警告保留至关闭；必要确认框中的表单错误仍留在框内。已提交不等于已完成。列表 Refresh 统一更新所有运行中批次，旧批次的完成不能覆盖较新操作的结果或取消其选择；失败/中断项继续保持选择，可直接再次点击原动作。跨页或筛选外的失败同样保留，Export 中保留最后一次操作的结果/失败项下载。

网络或上游故障导致提交结果不确定时，保留原操作 ID 并阻止新建批次；使用 Refresh 查询原批次，或通过错误浮层中的 Retry submission 重试同一执行接口，避免重新冻结并重复执行。关闭提示不删除操作 ID、不解除保护，仍可通过 Refresh 恢复。切换管理页面仍保留非敏感操作快照和未确认的提交 ID，不保存密码、不自动发请求；整页重载、登出或会话过期会清空客户端状态。服务端结果丢失/过期时保留明确的目标级中断提示，不自动重放。批次结果只保存在服务进程内存中、结束后保留约 1 小时，没有历史列表；离开页面不取消已接受的操作。本交互不修改数据库结构或队列调度；现有 SSO 并发仍按批次计算，不代表新增了服务端跨批次互斥。

重试和重新授权保留必要的凭据确认框。默认密码由服务端解析，单账号覆盖只保留在本次表单和执行内存，提交、关闭或退出后清除；不会保存到 URL、localStorage、日志或批次历史。提交失败时保留已输入的覆盖密码，成功后才清空。Azure/已改密账号必须覆盖，不能靠重试自动重置密码。Proxy 重新授权（单账号与批量）默认选择 Custom，重新打开也恢复此默认值，提交时显式携带 `ssoType: "custom"`，无需再次选择；Azure 账号仍需切换为 Azure 并填写覆盖密码。Proxy 不保存账号所属 SSO 提供方，API 仍要求传入 `ssoType`，缺省返回 `400 sso_type_required`。

Export page / selected / matches 分别导出页、已选目标、完整保留范围，使用服务端一致读快照；选中导出最多 1000 行，全部匹配导出使用分块下载流。CSV 转义引号、换行和公式型单元格（纯数字不加前缀，避免负数列被破坏），不导出凭据。导出完整匹配范围时，服务端在开始导出时统计的行数通过 `X-Export-Matched-At-Start` 返回；与页面显示的总数不一致时列表会提示文件是生成时刻的快照。下载错误保留原 Console 页面；API 会话过期提示重新登录并保留查询现场。登出或会话过期会清空跨页选择和滚动现场，避免下一位管理员继承上一位的选择。

Dashboard 使用 summary API；Recent tokens 明确只是近期保留请求的样本。Request Stats 使用服务端筛选分页，不再从最近 1000 条中本地过滤。所有管理表格中的用户名和身份直接展示，不提供关联页面跳转；请求错误不提供诊断跳转，用户/账号行不提供账号/任务跳转。队列、任务详情和批量结果中的身份及关联任务也只展示文本。详情、错误展开、复制、重试、重新授权和下载等实际操作保留；侧边导航、Dashboard 的完整列表入口、任务快捷筛选和并发设置入口仍可使用。

Dashboard 的任务摘要固定展示 Identity、SSO user、Status、Failure；Dashboard 和账号详情的请求摘要固定展示 Identity、Path、Model、Outcome、Total、Failure，均使用紧凑布局。摘要组件不承担完整列表和选择操作；完整列表的列显隐、选择及密度设置仍由 `ManagedList` 提供。

管理区通过 `.console-admin` 和共享 UI 组件统一尺寸、轻边框、焦点、表格、表单及弹窗；不影响登录/初始化页。普通内容卡片弱化阴影。工具栏、行内操作、更多菜单入口和复制等图标按钮使用有边框、浅底色的次级按钮，悬停、按下、展开、焦点和禁用状态明确区分；行内按钮保持紧凑，菜单内部的普通动作仍使用无框样式。主要提交操作保留实心按钮，危险操作保留警示色和明确的确认范围。宽表在自身容器滚动，状态标签保持内容宽度且不只靠颜色表达。

`npm run test` 覆盖 server 和 web 状态逻辑；`npm run test:browser` 构建后运行 Playwright 交互回归，包括跨页操作、空闲零自动刷新请求、SSO 有限完成跟踪、显式刷新范围、可关闭且不改变布局的操作提示、管理页面响应式布局、记录无关联跳转、次级按钮边框对比度（至少 3:1）及交互状态，需要 Chromium、系统运行库和字体。浏览器测试使用隔离 mock 服务，不操作真实业务数据。根 README 提供隔离 `.env` 的多服务回归命令。

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
        ├── components/
        │   ├── ManagedList.tsx     # 统一列表、查询、选择、导出与行内操作
        │   ├── Operations.tsx     # useOperations、直接提交/必要确认与行内结果
        │   ├── LoginTaskDetails.tsx # 任务、尝试和日志详情
        │   └── ui/                # Button/Input/Select/Checkbox/Table/Dialog 等共享组件
        └── lib/
            ├── management.ts # 查询、选择和页面偏好
            └── format.ts     # 日期、数字、状态样式和 token 汇总格式化
```

## 8. 开发提示

- 入口定位：后端从 `src/server/index.ts` 看路由和中间件；前端从 `src/web/App.tsx` 的 `pages` 数组和 `AdminApp` 看页面入口。
- 新增管理页面：先在 `Page` union 和 `pages` 数组加页面，再在 `AdminApp` 中挂载组件；完整列表复用 `ManagedList`，批量及行内管理动作复用 `useOperations`。
- 新增上游调用：列表查询沿用通用组件，专用调用放到对应 `src/web/api/*.ts` client，避免添加没有调用方的包装；如果是新服务，需要在 `apiProxy.ts`、`config.ts` 和 `.env.example` 增加 base URL 与转发挂载。
- 调试认证：先看 `/api/console/setup`、`/api/console/me`；服务间 401/403 多半是 `INTERNAL_API_TOKEN` 与上游不一致。
- 调试转发：设置 `LOG_LEVEL=debug` 或 `info`，查看 `[console:api-proxy]` 日志中的 target、method、suffix、status、durationMs。
- 调试 Copilot 请求：在 proxy 日志中找到 `diagnosticId`，到 **Error Diagnostics** 查看逐行 headers、格式化 body 和 curl；大记录优先下载完整 `.log`，页面只做有限预览。
- 调试前端：浏览器 Network 中应只看到 `/api/console/**`；如果直接访问 proxy/sso/login，说明调用边界被破坏。
- 敏感信息：`SESSION_SECRET`、`INTERNAL_API_TOKEN`、SSO 密码、Copilot OAuth token 不要提交。Error Diagnostics 默认不脱敏，Console 管理员可以看到和下载 API Key、上游 Authorization、prompt、工具内容及响应，必须严格控制管理员账号。
