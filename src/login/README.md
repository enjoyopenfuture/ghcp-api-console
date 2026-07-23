# Login 服务

`src/login` 是内部登录服务，负责把“需要重新授权 Copilot OAuth 的账号”转换成可执行的登录任务：使用 OpenCode OAuth client 通过 GitHub Device Flow 获取一次性设备码，使用 Playwright 自动完成 GitHub/SSO 登录授权，拿到 OAuth token 后回写给 `proxy` 服务。它不提供面向终端用户的 UI，也不直接代理 Copilot 请求；账号与 token 的最终状态由 `proxy` 维护。

## 核心功能

- **登录任务队列**：`POST /api/tasks` 创建任务，内存队列按 `LOGIN_CONCURRENCY` 控制并发；任务元数据持久化到 SQLite。
- **任务状态管理**：状态包括 `pending`、`running`、`success`、`failed`、`cancelled`；支持列表、分页搜索、查看、取消、删除、重试。服务重启时会把未完成的 `pending/running` 标记为失败。
- **Device flow + Playwright 自动授权**：先请求 GitHub device code，再用 `playwright-extra` + stealth 插件打开验证页，处理 GitHub 账号选择、GitHub 登录、企业 SSO 中转、自定义 SSO 或 Azure SSO，最后轮询 access token。**这是最消耗资源的部分，单次登陆大约1分钟**。
- **账号级日志与调试产物**：每个 SSO 用户有独立日志文件；可开启 debug 日志、失败截图和 trace。
- **Token 回传 Proxy**：成功时调用 `proxy` 的 `/internal/accounts/:identity/copilot-oauth-token` 保存 token；失败时调用 `/internal/accounts/:identity/mark-copilot-oauth-failed` 标记失败。
- **单账号调试命令**：`login:copilot-oauth` 可跳过任务队列，直接登录并把原始 Copilot OAuth token 输出到 stdout。

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

当前 `@ghcp/login` 只提供 `start`、`build`、`typecheck`、`login:token` 脚本；未提供单独的 `start:dist` 或测试脚本。

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

| 变量 | 默认值 | 必填 | 用途 |
| --- | --- | --- | --- |
| `PORT` | `7003` | 否 | Login HTTP 端口。 |
| `DB_PATH` | `./data/login.sqlite` | 否 | SQLite 文件路径。 |
| `INTERNAL_API_TOKEN` | 空字符串 | **是** | `/api/*` 入站认证和调用 proxy 的 `X-Internal-Token`；必须与 proxy/console 使用同一值。未设置时内部 API 会拒绝访问。`.env.example` 已提供示例。 |
| `PROXY_BASE_URL` | `http://localhost:3000` | 视环境 | Token 成功/失败回写的 proxy 地址；`.env.example` 当前未提供。 |
| `LOGIN_CONCURRENCY` | `1` | 否 | 登录任务并发数，必须为正整数。 |
| `LOG_DIR` | `./logs/login` | 否 | 账号级登录日志目录。 |
| `GITHUB_OAUTH_CLIENT_ID` | `Ov23li8tweQw6odWQebz` | 否 | OpenCode GitHub Device Flow OAuth client id。 |
| `GITHUB_OAUTH_SCOPE` | `read:user` | 否 | GitHub Device Flow 请求 scope。 |
| `OPENCODE_VERSION` | `1.0.0` | 否 | 生成 `User-Agent: opencode/<version>`。 |
| `OPENCODE_USER_AGENT` | 当前未配置 | 否 | 显式覆盖完整 User-Agent；非空时优先于 `OPENCODE_VERSION`。 |
| `SSO_URL` | 当前未配置 | 否 | 预期 SSO 地址；任务里的 `ssoUrl` 可覆盖。 |
| `SSO_PROVIDER` | `custom` | 否 | `custom` 或 `azure`；队列任务实际按请求体 `ssoType` 选择 provider。 |
| `AZURE_STAY_SIGNED_IN` | `false` | 否 | Azure “保持登录”提示选择 Yes/No。 |
| `AUTH_HEADLESS` | `true` | 否 | Playwright 是否无头运行。 |
| `AUTH_TIMEOUT_MS` | `60000` | 否 | Playwright 默认超时，必须为正整数。 |
| `AUTH_DEBUG_LOGS` | `false` | 否 | 是否写入 debug 级账号日志。 |
| `AUTH_DEBUG_ARTIFACTS` | `false` | 否 | 登录失败时是否保存截图和 trace。 |
| `AUTH_DEBUG_ARTIFACT_DIR` | `.auth-debug` | 否 | 调试产物目录。 |
| `AUTH_*_SELECTOR` | 当前未配置 | 否 | 覆盖各登录步骤的 CSS selector，见下方说明。 |

支持的 selector 环境变量：

- GitHub/device：`AUTH_DEVICE_CODE_INPUT_SELECTOR`、`AUTH_DEVICE_CODE_SUBMIT_SELECTOR`、`AUTH_GITHUB_LOGIN_INPUT_SELECTOR`、`AUTH_GITHUB_LOGIN_SUBMIT_SELECTOR`、`AUTH_GITHUB_SSO_SUBMIT_SELECTOR`、`AUTH_GITHUB_AUTHORIZE_SUBMIT_SELECTOR`
- 通用 SSO：`AUTH_SSO_USERNAME_INPUT_SELECTOR`、`AUTH_SSO_PASSWORD_INPUT_SELECTOR`、`AUTH_SSO_SUBMIT_SELECTOR`
- Azure SSO：`AUTH_AZURE_USERNAME_INPUT_SELECTOR`、`AUTH_AZURE_NEXT_SUBMIT_SELECTOR`、`AUTH_AZURE_PASSWORD_INPUT_SELECTOR`、`AUTH_AZURE_SIGN_IN_SUBMIT_SELECTOR`、`AUTH_AZURE_STAY_SIGNED_IN_YES_SELECTOR`、`AUTH_AZURE_STAY_SIGNED_IN_NO_SELECTOR`

本模块 `.env.example` 只保留 login 服务会读取的变量；不要加入 proxy/sso 专属配置，例如 `PROXY_API_KEY`、`SCIM_TOKEN`、`ENTERPRISE_SLUG`、`SP_ENTITY_ID`。

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
| `GET` | `/api/tasks?page=1&pageSize=25&q=keyword&status=failed` | 分页搜索，返回 `PageResponse<LoginTaskDto>`；`status` 只能是五种任务状态。 |
| `POST` | `/api/tasks` | 创建登录任务，返回 `202` 和初始 `LoginTaskDto`。 |
| `GET` | `/api/tasks/:id` | 查看单个任务；不存在返回 `404 task_not_found`。 |
| `POST` | `/api/tasks/:id/cancel` | 取消任务。待执行任务会从内存队列移除；运行中的浏览器流程当前未提供强制中断。 |
| `DELETE` | `/api/tasks/:id` | 删除已结束任务；`pending/running` 返回 `400 task_delete_not_allowed`。 |
| `POST` | `/api/tasks/:id/retry` | 用原任务的 `identity/ssoUser/ghLogin/ssoType` 重新入队，可在请求体提供新密码、`ssoUrl`、selector 覆盖。 |

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
| `status` | `pending/running/success/failed/cancelled`。 |
| `attempts` | 执行次数，进入 running 时递增。 |
| `failure_reason` | 失败或取消原因。 |
| `log_path` | 账号级日志文件路径。 |
| `created_at`、`started_at`、`finished_at` | ISO 时间。 |

索引：`idx_login_tasks_status_created_at(status, created_at)`。

### 主要领域对象

- `LoginQueue`：维护内存 `pending` 队列、`active` 集合和 `cancelled` 集合。
- `RuntimeTaskPayload`：`CreateLoginTaskRequest` 加上 `taskId`。
- `HeadlessPlaywrightAuthStrategy`：实现 `AuthStrategy.authorize(device)`。
- `DeviceCodeResponse`：GitHub device flow 返回的 `device_code/user_code/verification_uri/expires_in/interval`。
- `AccountLogger`：按 SSO 用户生成日志，字段会通过共享 redaction 规则隐藏 password/token/secret 等敏感值。

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
    ├── server.ts              # Express app、healthz、/api 挂载
    ├── config.ts              # 环境变量解析
    ├── debugToken.ts          # 单次登录调试 CLI
    ├── auth/
    │   ├── internalAuth.ts    # X-Internal-Token 校验
    │   ├── deviceFlow.ts      # GitHub device code 与 token polling
    │   ├── HeadlessPlaywrightAuthStrategy.ts
    │   └── types.ts
    ├── clients/proxyClient.ts # token 成功/失败回写 proxy
    ├── db/                    # SQLite 连接、迁移、任务仓库
    ├── routes/tasksApi.ts     # 任务 REST API
    └── tasks/                 # 队列、执行器、账号日志
```

## 开发提示

- 入口排查顺序：`index.ts` → `server.ts` → `routes/tasksApi.ts` → `tasks/queue.ts` → `tasks/runner.ts` → `auth/deviceFlow.ts`/`HeadlessPlaywrightAuthStrategy.ts`。
- API 或数据结构变更要同步检查 `@ghcp/shared` contracts，以及调用方 proxy/console 的客户端代码。
- 新增 SSO provider 不能只改 Playwright 流程；还要扩展 `SsoType`、请求校验、配置、selector、前端/调用方传参。
- 队列是进程内的；当前未提供多实例分布式锁。共享同一个 SQLite 运行多个 login 实例需要额外设计。
- 调试失败优先看任务的 `logPath`；复杂页面问题可用 `AUTH_HEADLESS=false`、`AUTH_DEBUG_LOGS=true`、`AUTH_DEBUG_ARTIFACTS=true`。
- `selectorOverrides` 只影响单个任务，适合临时适配页面变更；稳定规则建议放到环境变量。
- 文档只确认了当前代码已有能力；当前未提供 metrics、OpenAPI 描述或自动化测试脚本。
