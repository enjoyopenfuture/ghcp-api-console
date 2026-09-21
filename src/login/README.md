# Login 服务

`src/login` 是内部登录服务，负责把“需要重新授权 Copilot OAuth 的账号”转换成可执行的登录任务：使用 OpenCode OAuth client 通过 GitHub Device Flow 获取一次性设备码，使用 Playwright 自动完成 GitHub/SSO 登录授权，拿到 OAuth token 后回写给 `proxy` 服务。它不提供面向终端用户的 UI，也不直接代理 Copilot 请求；账号与 token 的最终状态由 `proxy` 维护。

## 核心功能

- **登录任务队列**：`POST /api/tasks` 创建任务，内存队列按 DB 运行时设置控制并发；任务元数据持久化到 SQLite。
- **任务状态管理**：状态包括 `pending`、`running`、`cancelling`、`success`、`failed`、`cancelled`；支持完整筛选、批量预览、独立尝试历史和实际队列快照。重启时未完成任务直接标记为中断（取消中的标记为已取消）并通知 Proxy 放弃对应 attempt，不自动重放；若 token 在重启前已写回，Proxy 因 attempt 已清空会忽略该通知，账号保持可用，只是任务记录显示中断。
- **Device flow + Playwright 自动授权**：先请求 GitHub device code，再用 `playwright-extra` + stealth 插件打开验证页，处理 GitHub 账号选择、GitHub 登录、企业 SSO 中转、自定义 SSO 或 Azure SSO，最后轮询 access token。**这是最消耗资源的部分，单次登陆大约1分钟**。
- **尝试级日志与调试产物**：每次任务尝试使用独占日志文件；可开启 debug 日志、失败截图和 trace，旧账号级日志仅保留为不完整历史。
- **Token 回传 Proxy**：成功时调用 `proxy` 的 `/internal/accounts/:identity/copilot-oauth-token` 保存 token；失败时调用 `/internal/accounts/:identity/mark-copilot-oauth-failed` 标记失败。
- **单账号调试命令**：`login:copilot-oauth` 可跳过任务队列，直接登录并把原始 Copilot OAuth token 输出到 stdout。

### SSO 密码来源与改密影响

Login 不读取 SSO 数据库，也不还原密码。创建任务的服务间请求仍传入运行时 `ssoPassword`；重试可以显式选择 `{ credentialMode: 'default' }`，由 Proxy 调用 SSO 只读内部接口，验证配置默认密码或用户名候选值。单账号覆盖使用 `{ credentialMode: 'override', ssoPassword }`，旧的非空 `ssoPassword` 请求仍兼容。Azure、已改密或默认值不可验证时必须提供覆盖值；不创建用户、不改密。密码只存在于本次传输和执行内存，不进入任务、批次、日志、URL 或导出。

启动恢复统一由 `tasks/recovery.ts` 的 `recoverLoginOutcomes()` 负责：释放中断的删除标记，把 pending/running 任务标记为 `failed / service_interrupted`、把 cancelling 任务标记为 cancelled（同步完成，不依赖 Proxy），再在后台顺序调用 Proxy 的 `mark-copilot-oauth-failed` 放弃这些 attempt，避免账号停留在 `refreshing`；没有 attempt 的旧任务单独标记中断。通知失败只记录日志，账号若仍显示 `refreshing`，从 Console 重新授权即可覆盖。不会重新执行登录。

token 写回失败（包括超时、响应丢失）时任务标记为 `token_write_failed`，队列随后向 Proxy 上报失败；该上报按 attempt 栅栏，如果写回其实已经落地，Proxy 会忽略它，账号保持有效而任务记录显示失败。取消时先等待被中止的运行释放浏览器与 device code，再判定：运行在此期间自行成功则保留成功，否则标记 cancelled 并通知 Proxy 放弃该 attempt。

## 启动方式

先在仓库根目录安装依赖：

```bash
npm install
```

### 开发运行

```bash
npm run start:login
# 等价于：npm --workspace @ghcp/login run start
```

`start` 使用 `tsx src/index.ts`。本地第一次跑 Playwright 如缺少浏览器，可执行：

```bash
npx playwright install chromium
```

健康检查：

```bash
curl http://localhost:7003/healthz
```

### 本地构建/运行

```bash
npm --workspace @ghcp/shared run build
npm --workspace @ghcp/login run build
node src/login/dist/index.js
```

`@ghcp/login` 提供 `start`、`start:prod`、`build`、`typecheck`、`test` 和单次登录调试脚本。

### 调试单次登录

```bash
npm run login:token -- \
  --gh-login <github-login> \
  --sso-user <sso-user> \
  --sso-password <password> \
  --sso-type custom
```

可选：`--sso-url <url>`、`--sso-type azure`、`--headful`、`--debug-logs`、`--debug-artifacts`。也支持 `LOGIN_GH_LOGIN`、`LOGIN_SSO_USER`、`LOGIN_SSO_PASSWORD`、`LOGIN_SSO_TYPE`、`LOGIN_SSO_URL` 环境变量。

### Docker

`src/login/Dockerfile` 会安装依赖、构建 `@ghcp/shared`，并安装 Chromium 及系统依赖；容器启动命令是 `npm --workspace @ghcp/login run start`。

```bash
docker build -f src/login/Dockerfile -t ghcp-login .
docker run --rm -p 7003:7003 \
  -e INTERNAL_API_TOKEN=change-me-internal-token \
  -e PROXY_BASE_URL=http://host.docker.internal:3000 \
  -v "$PWD/data:/app/data" \
  -v "$PWD/logs:/app/logs" \
  ghcp-login
```

Linux 下如需访问宿主机的 proxy，可能还要给 Docker 增加 `--add-host=host.docker.internal:host-gateway`。`Dockerfile` 当前不负责注入环境变量、端口或卷，运行时需自行传入。

## 配置参数

配置来自 `src/login/src/config.ts`，并通过 `dotenv/config` 读取环境变量。

| 变量 | 代码默认值 | 必填 | 用途 |
| --- | --- | --- | --- |
| `PORT` | `7003` | 否 | Login HTTP 端口。 |
| `LOG_LEVEL` | `info` | 否 | 结构化日志等级：`debug`、`info`、`warn`、`error`。 |
| `DB_PATH` | `./data/login.sqlite` | 否 | SQLite 文件路径。 |
| `INTERNAL_API_TOKEN` | 空字符串 | **是** | `/api/*` 入站认证和调用 proxy 的 `X-Internal-Token`；必须与 proxy/console 使用同一值。未设置时内部 API 会拒绝访问。`.env.example` 已提供示例。 |
| `PROXY_BASE_URL` | `http://localhost:3000` | 视环境 | Token 成功/失败回写的 proxy 地址。 |
| `LOG_DIR` | `./logs/login` | 否 | 账号级登录日志目录。 |
| `GITHUB_OAUTH_CLIENT_ID` | `Ov23li8tweQw6odWQebz` | 否 | OpenCode GitHub Device Flow OAuth client id。 |
| `GITHUB_OAUTH_SCOPE` | `read:user` | 否 | GitHub Device Flow 请求 scope。 |
| `OPENCODE_VERSION` | `1.0.0` | 否 | 生成 `User-Agent: opencode/<version>`。 |
| `OPENCODE_USER_AGENT` | 当前未配置 | 否 | 显式覆盖完整 User-Agent；非空时优先于 `OPENCODE_VERSION`。 |
| `SSO_URL` | 当前未配置 | 否 | 预期 SSO 地址；任务里的 `ssoUrl` 可覆盖。 |
| `AZURE_STAY_SIGNED_IN` | `false` | 否 | Azure “保持登录”提示选择 Yes/No。 |
| `AUTH_HEADLESS` | `true` | 否 | Playwright 是否无头运行。 |
| `AUTH_DEBUG_ARTIFACT_DIR` | `.auth-debug` | 否 | 调试产物目录。 |
| `AUTH_*_SELECTOR` | 当前未配置 | 否 | 覆盖各登录步骤的 CSS selector，见下方说明。 |

登录并发、Playwright 超时、debug 日志和 debug artifacts 保存在 `login_runtime_settings`，通过 Console Settings 页面保存后对排队任务和新启动任务生效；运行中的任务继续使用启动时快照。

支持的 selector 环境变量：

- GitHub/device：`AUTH_DEVICE_CODE_INPUT_SELECTOR`、`AUTH_DEVICE_CODE_SUBMIT_SELECTOR`、`AUTH_GITHUB_LOGIN_INPUT_SELECTOR`、`AUTH_GITHUB_LOGIN_SUBMIT_SELECTOR`、`AUTH_GITHUB_SSO_SUBMIT_SELECTOR`、`AUTH_GITHUB_AUTHORIZE_SUBMIT_SELECTOR`
- 通用 SSO：`AUTH_SSO_USERNAME_INPUT_SELECTOR`、`AUTH_SSO_PASSWORD_INPUT_SELECTOR`、`AUTH_SSO_SUBMIT_SELECTOR`
- Azure SSO：`AUTH_AZURE_USERNAME_INPUT_SELECTOR`、`AUTH_AZURE_NEXT_SUBMIT_SELECTOR`、`AUTH_AZURE_PASSWORD_INPUT_SELECTOR`、`AUTH_AZURE_SIGN_IN_SUBMIT_SELECTOR`、`AUTH_AZURE_STAY_SIGNED_IN_YES_SELECTOR`、`AUTH_AZURE_STAY_SIGNED_IN_NO_SELECTOR`

本模块 `.env.example` 只保留 login 服务会读取的变量；不要加入 proxy/sso 专属配置，例如 `API_KEY`、`SCIM_TOKEN`、`ENTERPRISE_SLUG`、`SP_ENTITY_ID`。

### `.env` 与 runtime Settings

环境变量负责端口、内部密钥、Proxy/SSO 地址、SQLite/日志/调试产物路径、OAuth client、headless 模式和 selector 等启动期配置；修改后要重启 Login。Runtime Settings 保存在 `login.sqlite` 的单例 `login_runtime_settings` 行中，通过 Console **Settings** 或 `GET/PATCH /api/settings/runtime` 管理，无需重启。

| Setting | 默认值 | 合法范围 | 生效语义 |
| --- | ---: | --- | --- |
| `concurrency` | `1` | 整数 `1..20` | 每个 Login 进程的并发上限。调高后立即启动更多 pending 任务；调低不会中断已运行任务，只限制后续启动。 |
| `authTimeoutMs` | `60000` | 整数 `5000..600000` | 新启动任务的 Device Flow/Playwright 认证超时；运行中任务保持启动时快照。 |
| `authDebugLogs` | `false` | boolean | 新启动任务是否写详细账号日志。 |
| `authDebugArtifacts` | `false` | boolean | 新启动任务是否保存失败截图、trace 等调试产物；目录仍由 `AUTH_DEBUG_ARTIFACT_DIR` 环境变量决定。 |

Settings 更新必须携带当前 `expectedVersion`；其他管理员已先保存时返回 `409 settings_version_conflict`，Console 会重新加载最新值。首次迁移使用上表代码默认值，不从旧 `.env` 导入。当前 settings snapshot 和任务队列都是进程内状态；多个 Login 实例共享 SQLite 时，其他实例不会自动收到 setting 更新，而且任务队列本身也没有分布式领取机制。

任务的 `ssoUrl` 和 `selectorOverrides` 分别覆盖默认 SSO URL 和环境 selector。Provider 由任务必填的 `ssoType` 决定；单次调试命令使用 `--sso-type` / `LOGIN_SSO_TYPE`（兼容 `SSO_TYPE`），默认 `custom`。旧 `SSO_PROVIDER`（Compose 中的 `LOGIN_SSO_PROVIDER`）始终被任务/CLI 参数覆盖，现已移除，不再读取。单次调试 CLI flag 会覆盖对应 runtime setting 或环境变量。Runtime Settings 与 `.env` 没有同名 key。

Login task 历史没有自动 retention。可按终态和 `finishedBefore` 手动预览删除；`pending/running/cancelling` 都不可删除。清理仅移除任务、尝试记录及有所有权证明的独占日志，保留共享旧日志和批次结果摘要。日志清理失败时保留任务供显式重试；清理中拒绝同任务重试，重启只释放清理占用，不自动继续删除。

## 接口与 API 边界

### 认证

- `GET /healthz` 不需要认证。
- `/api/*` 都需要请求头 `X-Internal-Token: <INTERNAL_API_TOKEN>`。
- 错误响应使用共享结构：`{ "error": { "code": string, "message": string, "details"?: unknown } }`。

### 健康检查

| 方法 | 路径 | 认证 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 否 | `{ "status": "ok", "service": "login" }` |

### 任务接口（`src/login/src/routes/tasksApi.ts`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/tasks?limit=100` | 返回最近任务数组，按 `created_at` 倒序。 |
| `GET` | `/api/tasks?page=1&pageSize=25&q=keyword&status=failed` | 完整分页；支持逗号分隔多状态、`from/to`、`identity`、`minAttempts`、`failureCode`、`minWaitSeconds/minRunSeconds`、`finishedBefore` 和白名单排序。`q` 中的 `%`、`_` 按字面匹配。`minWaitSeconds` 只匹配排队中的 `pending` 任务，`minRunSeconds` 只匹配 `running`/`cancelling` 任务；两者互斥，同时传入或与不相交的 `status` 组合会返回 `400 invalid_query`，而不是静默返回空页。 |
| `POST` | `/api/tasks` | 创建登录任务，返回 `202` 和初始 `LoginTaskDto`。 |
| `GET` | `/api/tasks/:id` | 查看单个任务；不存在返回 `404 task_not_found`。 |
| `POST` | `/api/tasks/:id/cancel` | 待执行任务立即移出队列；运行中贯通 AbortSignal，保持 `cancelling` 到资源释放；运行若已成功则保留成功，否则标记取消并通知 Proxy。 |
| `DELETE` | `/api/tasks/:id` | 删除终态任务及独占日志；活动或正在清理的任务返回 `400 task_delete_not_allowed`。 |
| `POST` | `/api/tasks/:id/retry` | 保留任务 ID，原子创建新 attempt；支持默认密码/单账号覆盖及原有 `ssoUrl`、selector 覆盖。 |
| `GET` | `/api/tasks/summary`、`/api/queue` | 全部保留任务聚合；实际 preparing/pending/active/cancelling、槽位、排队位置、等待与运行时长。 |
| `GET` | `/api/tasks/by-attempt/:attemptId` | 按独立尝试查询接受结果，用于响应丢失核对；不会误认后来的重试。 |
| `GET` | `/api/tasks/:id/attempts` | 独立尝试历史；旧数据缺失部分标记 `historyIncomplete`，不伪造历史。 |
| `GET` | `/api/tasks/:id/attempts/:attemptId/log` | 最多 20 KB 脱敏预览；`download=1` 下载完整文本，仅允许该 attempt 所属受控文件。 |
| `GET/POST` | `/api/tasks/export` | GET 导出全部匹配；`scope=page` 导出当前页；POST `{ selection }` 导出已选项（最多 1000）。 |
| `POST` | `/api/tasks/operations/preview` | `{ action: 'retry' \| 'cancel' \| 'delete', selection: { ids } \| { query, excludedIds } }`；冻结最多 1000 个 ID，预览有效期 10 分钟。 |
| `POST` | `/api/tasks/operations/:id/execute` | `{ overrides?: [{ id, password }] }`；202 返回批次，重复提交同一 `:id` 返回当前状态而不会再执行，密码不落库。 |
| `GET` | `/api/tasks/operations/:id`、`/:id/export` | 批次进度及结果 CSV；导出加 `failed=1` 仅取失败项；预览/结果只在进程内存中，没有可列出全部批次的接口。 |
| `GET` | `/api/settings/runtime` | 返回 `LoginRuntimeSettingsDto`，包含四个 setting、`version` 和 `updatedAt`。 |
| `PATCH` | `/api/settings/runtime` | `{ expectedVersion, changes }`；保存 runtime settings，校验失败返回 400，版本冲突返回 409。 |

创建任务请求核心结构：

```ts
{
  identity: string;        // proxy 中的账号身份，必填
  ssoUser: string;         // SSO 用户名，必填
  ssoPassword: string;     // 成功执行必须提供；缺失时任务会失败
  ghLogin: string;         // GitHub 登录名，必填
  oauthAttemptId: string;  // proxy 生成的授权代次；成功/失败回写必须匹配
  ssoType: 'custom' | 'azure';
  ssoUrl?: string;
  accountType?: 'business' | 'enterprise'; // 当前接收但 login 执行逻辑未使用
  selectorOverrides?: Record<string, string>;
}
```

任务响应核心结构见 `LoginTaskDto`：`id`、`identity`、`ssoUser`、`ghLogin`、`ssoType`、`status`、`attempts`、`failureReason`、`logPath`、`createdAt`、`startedAt`、`finishedAt`。

### 对外依赖边界

- GitHub：调用 `https://github.com/login/device/code` 和 `https://github.com/login/oauth/access_token`。
- Proxy：通过 `PROXY_BASE_URL` 调用内部接口：
  - `POST /internal/accounts/:identity/oauth-attempts/:attemptId/prepare`，body 含凭据模式、账号映射、`ssoType` 与 `previousAttemptId`（任务上一次的 attempt，账号当前 attempt 不一致时 Proxy 返回 `409 authorization_conflict`）；Proxy 解析本次凭据并把账号切到新 attempt。
  - `PUT /internal/accounts/:identity/copilot-oauth-token`，body `{ oauthAttemptId, copilotOauthToken, ghLogin }`
  - `POST /internal/accounts/:identity/mark-copilot-oauth-failed`，body `{ oauthAttemptId, failureReason }`
- Console/proxy 可通过共享 `X-Internal-Token` 访问 login；login 本身当前未提供浏览器 UI。

## 数据结构

### SQLite 表

`login_tasks`：

| 字段 | 说明 |
| --- | --- |
| `id` | UUID，主键。 |
| `identity` | proxy 账号身份。 |
| `sso_user` | SSO 用户。 |
| `gh_login` | GitHub 登录名。 |
| `oauth_attempt_id` | proxy 生成的授权代次，用于拒绝过期任务回写。 |
| `sso_type` | `custom` 或 `azure`。 |
| `status` | `pending/running/cancelling/success/failed/cancelled`。 |
| `attempts` | 执行次数，进入 running 时递增。 |
| `failure_reason` | 失败或取消原因。 |
| `log_path` | 最新尝试的独占日志路径；旧账号级日志只作为不完整历史保留。 |
| `created_at`、`started_at`、`finished_at` | ISO 时间。 |

索引：`idx_login_tasks_status_created_at(status, created_at)`。

`login_task_attempts` 保存 `(task_id, attempt_number)`、授权 attempt、阶段/时间、错误代码和日志引用；`(task_id, attempt_number)` 上建有唯一索引（仅在历史数据本身不含重复时创建），避免并发写入产生两个相同编号的尝试。当前任务回调必须同时匹配任务和 attempt，终态不被迟到回调覆盖。删除任务时会把被覆盖的 `stage` 暂存到 `prior_stage`，删除失败后恢复原阶段而不是退回到状态名。批量操作（`/api/tasks/operations`）的冻结目标和逐项结果只保存在 Login 进程内存中，预览 10 分钟内有效、结果在结束后保留约 1 小时，重启即丢失且不自动重新执行。登录重试批次追踪实际尝试结果，不把入队当作成功。

`login_runtime_settings` 是 `id=1` 的单例严格表，保存 `concurrency`、`auth_timeout_ms`、`auth_debug_logs`、`auth_debug_artifacts`、乐观锁 `version` 和 `updated_at`。Migration 只在不存在时写入代码默认值，不覆盖已经保存的设置。

### 主要领域对象

- `LoginQueue`：维护内存 `pending` 队列、`active` 集合和 `cancelled` 集合。
- `RuntimeTaskPayload`：`CreateLoginTaskRequest` 加上 `taskId`。
- `HeadlessPlaywrightAuthStrategy`：实现 `AuthStrategy.authorize(device)`。
- `DeviceCodeResponse`：GitHub device flow 返回的 `device_code/user_code/verification_uri/expires_in/interval`。
- `AccountLogger`：新任务按任务/attempt 的摘要生成独占文件，字段及实际运行密码均脱敏；旧共享日志不覆盖迁移、不通过新下载接口暴露。

### 使用的共享 contracts

来自 `@ghcp/shared`：`CreateLoginTaskRequest`、`LoginTaskDto`、`LoginTaskStatus`、`SsoType`、`AccountType`、`PageResponse`、`ApiErrorResponse`、`INTERNAL_AUTH_HEADER`、`JsonHttpClient`、`newTaskId`、`nowIso`、`loggerFor`。

## 代码结构

```text
src/login/
├── Dockerfile                 # login 镜像构建与启动
├── package.json               # workspace 脚本
├── tsconfig.json              # TypeScript 配置
└── src/
    ├── index.ts               # 入口：startServer()
    ├── server.ts              # Express app、healthz、tasks/settings API 挂载
    ├── config.ts              # 环境变量解析
    ├── debugToken.ts          # 单次登录调试 CLI
    ├── auth/
    │   ├── internalAuth.ts    # X-Internal-Token 校验
    │   ├── deviceFlow.ts      # GitHub device code 与 token polling
    │   ├── HeadlessPlaywrightAuthStrategy.ts
    │   └── types.ts
    ├── clients/proxyClient.ts # 重试准备、token 成功/失败回写
    ├── db/                    # SQLite 连接、迁移、任务仓库、runtime settings repo
    ├── routes/                # tasks API 与 settings API
    └── tasks/                 # 队列、执行器、重试/删除、启动恢复、尝试日志
```

## 开发提示

- 入口排查顺序：`index.ts` → `server.ts` → `routes/tasksApi.ts` → `tasks/queue.ts` → `tasks/runner.ts` → `auth/deviceFlow.ts`/`HeadlessPlaywrightAuthStrategy.ts`。
- API 或数据结构变更要同步检查 `@ghcp/shared` contracts，以及调用方 proxy/console 的客户端代码。
- 新增 SSO provider 不能只改 Playwright 流程；还要扩展 `SsoType`、请求校验、配置、selector、前端/调用方传参。
- 队列是进程内的；当前未提供多实例分布式锁。共享同一个 SQLite 运行多个 login 实例需要额外设计。
- 调试失败优先看任务的 `logPath`；复杂页面问题可用 `AUTH_HEADLESS=false`，并在 Console Settings 中开启 debug logs 和 debug artifacts。
- `selectorOverrides` 只影响单个任务，适合临时适配页面变更；稳定规则建议放到环境变量。
- 文档只确认了当前代码已有能力；当前未提供 metrics 或 OpenAPI 描述。测试可运行 `npm --workspace @ghcp/login run test`。
