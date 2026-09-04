# GHCP API Learning

这个项目探索一种把 **GitHub Copilot 后端能力作为“API”提供 LLM 服务** 的方案：对调用方暴露 OpenAI / Anthropic / Responses 兼容接口，对内自动管理 GitHub Enterprise Managed User(EMU)、SSO 登录、OpenCode Copilot OAuth 凭据和后台运维。

> 重要：GitHub Copilot 当前并不提供面向第三方服务端集成的公开裸 API。本项目依赖 Copilot 内部接口，适合学习、验证和自维护部署；用于生产前必须自行评估合规、稳定性和运维风险。

> proxy 参考repo https://github.com/hooyao/copilot-bridge
> 获得 GitHub Copilot Token的部分参考了 OpenCode 项目

> 管理员的配置手册: ([guidance/guidance.md](./guidance/guidance.md))
> 网络配置的说明: ([guidance/network-deployment.md](./guidance/network-deployment.md))

## 背景

开源社区已经有不少项目可以把 Copilot 包装成 API 来用，例如 LiteLLM、ccswitch、copilot2api 等。这些方案通常适合**单个开发者本地使用**：本地代理读取一个 GitHub/Copilot 登录态，再把请求转发到 Copilot 后端。

当要集中给大量最终用户提供 GHCP API 服务时，单人本地代理模式会遇到几个问题：

1. **账号合规问题**：合规使用 GHCP 不应共享账号，理想状态是一个 GitHub 账号对应一个最终用户。
2. **账号规模问题**：最终用户量大时，需要批量获得对应数量的 GitHub 账号，并能持续管理这些账号。
3. **自动登录问题**：即使账号已经创建，GitHub 账号的 MFA/device flow 会阻碍无人值守、批量化登录。

## 本项目思路

本项目通过 **GitHub Enterprise Managed User + 自定义 SSO + 自动化登录 + API Proxy** 组合解决上述问题：

- 使用自定义 SSO/SAML IdP 结合 GitHub EMU，通过 SCIM 批量创建和同步 GitHub 账号，避免手工注册大量普通 GitHub 账号。
- 使用 OpenCode OAuth client 发起 GitHub Device Flow，并由 Playwright 自动完成 GitHub/SSO 登录。
- 通过 Proxy 统一维护 `identity -> ssoUser -> ghLogin -> token` 映射，并对外提供兼容 API。
- 支持验证后批量导入 OpenCode Copilot OAuth token，也支持后台控制台查看账号、请求统计、上游错误诊断、登录任务、AI Credits 和 Copilot seat 状态。
- 在 Proxy 层包含 Claude Code / Anthropic Messages 相关兼容优化。

整体调用链：

```text
Client
  -> proxy compatible API
  -> proxy 按 X-User-Identity 找账号
  -> 首次使用时 proxy 调 sso 确保用户并同步 EMU
  -> proxy 调 login 创建自动登录任务
  -> login 完成 GitHub device flow + SSO 登录
  -> login 把 Copilot OAuth token 回写 proxy
  -> proxy 直接以 Bearer token 调用 Copilot API
```

`sso` 和 `login` 没有直接服务间调度关系；它们都由 `proxy` 或 `console` 通过内部 API 协调。

## 模块概览

| 模块 | 职责 |
| --- | --- |
| `src/proxy` | 对外 API 网关；鉴权、identity 映射、Copilot OAuth 管理、请求转发和统计。 |
| `src/sso` | 自定义 SAML IdP；SSO 用户、EMU/SCIM、Copilot seat、AI Credits 用量。 |
| `src/login` | OpenCode OAuth Device Flow + Playwright 自动登录；成功后回写 Copilot OAuth token。 |
| `src/console` | Web 管理控制台；统一操作 proxy/sso/login 管理 API。 |
| `src/packages/shared` | 跨服务共享 DTO、HTTP client、logger、错误结构和工具。 |

更详细的代码结构和接口说明见 [`src/README.md`](./src/README.md)。

## 使用前提

部署前需要准备：

1. **GitHub Enterprise 订阅**，并启用 Enterprise Managed Users(EMU)。
2. **GitHub Copilot 可用授权**，并准备可管理 Copilot seat / AI Credits 的 GitHub PAT。
3. **GitHub Enterprise SAML SSO 配置权限**，可以把企业 SAML SSO 指向本项目的 `sso` 服务或你自己的 SSO/IdP。
4. **GitHub SCIM token**，用于 `sso` 服务批量创建、更新、暂停、删除 EMU 用户。
5. **SAML IdP 签名证书和私钥**。本项目提供 `scripts/gen-certs.sh` 生成开发证书；生产环境应使用你维护的证书。
6. **Docker / Docker Compose** 用于容器化部署；本地开发还需要 Node.js 22 和 npm。

## 配置模型：`.env` 与 Settings

项目有两类互不覆盖的配置：

| 配置来源 | 保存位置 | 适合内容 | 生效方式 |
| --- | --- | --- | --- |
| 环境变量 / `.env` | 进程环境；不写入业务数据库 | 端口、服务地址、密钥、数据库/日志/证书路径、认证 header、浏览器静态选项 | 启动时读取，修改后需要重启对应服务。 |
| Console **Settings** | `sso.sqlite` 或 `login.sqlite` | 管理员需要在线调整的限额、并发、超时、重试和调试开关 | 保存后持久化并在当前服务实例立即应用，无需重启。 |

根目录 `.env` 只用于 Docker Compose 的变量插值；只有 `docker-compose.yml` 的 `environment`、`ports`、`volumes` 中明确引用的变量才会传入容器。`src/<service>/.env` 面向单独运行该 workspace 的场景。显式注入的进程环境变量优先于 `.env`，两者都没有时才使用代码默认值。

敏感值和部署拓扑只放环境变量，不放 Settings，例如 `API_KEY`、`INTERNAL_API_TOKEN`、`SESSION_SECRET`、GitHub/SCIM token、数据库路径和服务 URL。当前运行时 Settings 没有同名环境变量，因此不存在覆盖优先级；升级首次创建 settings 表时使用代码默认值，不从旧环境变量导入。

SSO runtime settings：

| Setting | 默认值 | 合法范围 | 作用 |
| --- | ---: | --- | --- |
| `maxSsoUsers` | `null` | `null` 或 `1..1000000` | SSO 用户总量上限；`null` 表示不限。 |
| `userPrefix` | `user` | 规范化后必须包含字母或数字，最长 32 字符 | identity 无法生成用户名或发生最终 fallback 时使用。 |
| `emailDomain` | `customsso.com` | 合法域名 | 新用户未显式提供 email 时使用 `<ssoUser>@<domain>`。 |
| `bulkSyncConcurrency` | `3` | `1..20` | `sync_emu` 批处理并发；其他破坏性批处理仍串行。 |
| `scimRequestDelayMs` | `250` | `0..60000` | 同一 SSO 进程内 SCIM 请求之间的最小间隔。 |
| `scimMaxRetries` | `3` | `0..10` | SCIM 可重试响应/网络错误的最大重试次数。 |
| `scimRetryBaseDelayMs` | `1000` | `0..60000` | SCIM 指数退避基础延迟；`Retry-After` 可覆盖等待时间。 |

Login runtime settings：

| Setting | 默认值 | 合法范围 | 作用 |
| --- | ---: | --- | --- |
| `concurrency` | `1` | `1..20` | 当前 Login 进程同时运行的任务数；调高后立即排队，调低不会中断已运行任务。 |
| `authTimeoutMs` | `60000` | `5000..600000` | 新启动 Device Flow/Playwright 任务的认证超时。 |
| `authDebugLogs` | `false` | boolean | 为新启动任务写入详细账号日志。 |
| `authDebugArtifacts` | `false` | boolean | 为新启动任务保存截图和 trace 等调试产物。 |

`REQUEST_STATS_PER_ACCOUNT_LIMIT` 和 `PROXY_ERROR_DIAGNOSTICS_*` 仍是 Proxy 环境变量，不属于 runtime Settings；前者控制每个 identity 保留的请求统计条数，后者控制上游失败现场的启用、目录、脱敏和文件轮转。Login task 历史目前没有自动保留条数/天数配置，终态任务会一直保留，直到通过 Console 或 API 手动删除。

## 快速启动（Docker Compose）

1. 复制并修改环境变量：

```bash
cp .env.example .env
```

至少需要替换：

| 变量 | 说明 |
| --- | --- |
| `API_KEY` | 调用 `proxy` 裸 API 时使用的 Bearer token。 |
| `INTERNAL_API_TOKEN` | `proxy`、`sso`、`login`、`console` 内部通信共享密钥。 |
| `SESSION_SECRET` | `sso` / `console` cookie session 签名密钥。 |
| `SSO_PUBLIC_BASE_URL` | `sso` 服务对 GitHub 可访问的公网地址。 |
| `SP_ENTITY_ID` / `SP_ACS_URL` | GitHub Enterprise SAML SP 配置。 |
| `ENTERPRISE_SLUG` / `ENTERPRISE_SHORTCODE` | GitHub Enterprise 标识和 EMU login 后缀。 |
| `SCIM_BASE_URL` / `SCIM_TOKEN` | GitHub Enterprise SCIM API 地址和 token。 |
| `GITHUB_COPILOT_SEAT_PAT` | 管理 Copilot seat / AI Credits 的 GitHub PAT。 |
| `SSO_DEFAULT_USER_PASSWORD` | 新建 SSO 用户的默认密码；为空时使用用户名。该值不会进入运行时设置数据库。 |

根目录 `.env` 也包含 proxy 的公共 API 和 OpenCode 认证/header 配置。Docker Compose 默认使用 `CLAUDE_CODE_OPTIMIZED=true` 启动 proxy，作为 Claude Code / Anthropic Messages 兼容优化和 `/v1/messages/count_tokens` 的默认模式；单个请求可用 `X-Claude-Code-Optimized: true|false` 覆盖，无需重启服务。

| 变量 | 说明 |
| --- | --- |
| `STORAGE_DRIVER` | Proxy 存储模式：默认 `sqlite`，多 Proxy Pod 使用 `mysql`。 |
| `DB_PATH` | `sqlite` 模式的数据库路径；该模式只支持一个 Proxy 实例。 |
| `MYSQL_URL` | `mysql` 模式必填，指向所有 Proxy Pod 共享的外部 MySQL 8 数据库。 |
| `MYSQL_CONNECTION_LIMIT` / `MYSQL_SSL_*` | 每个 Proxy Pod 的连接池上限与 MySQL TLS 配置。 |
| `IDENTITY_HEADER` | 调用方身份 header 名称和是否必填；默认 `X-User-Identity` 必填。 |
| `IDENTITY_HEADER_REQUIRED` | 调用方身份 header 是否必填；默认 `true`。如果设置为 false，则 Identity header 可选。identity header 为空时，默认使用匿名身份。当前匿名用户为 `default` |
| `CLAUDE_CODE_OPTIMIZED` | Proxy 的默认 Claude Code 优化模式；代码默认 `false`，Compose 默认和根模板均为 `true`。 |
| `REQUEST_STATS_PER_ACCOUNT_LIMIT` | 每个 identity 保留的请求统计数；代码、Compose fallback 和环境变量示例均默认为 `2`。 |
| `PROXY_ERROR_DIAGNOSTICS_ENABLED` | 是否保存 Copilot 上游失败现场；默认 `true`。 |
| `PROXY_ERROR_DIAGNOSTICS_DIR` | 人类可读诊断日志目录；Compose 默认 `/data/error-diagnostics`，位于 `proxy-data` volume。 |
| `PROXY_ERROR_DIAGNOSTICS_REDACT` | 是否脱敏诊断中的敏感 headers 和 JSON 字段；默认 `false`，即保留原始凭据和请求内容。 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB` / `PROXY_ERROR_DIAGNOSTICS_MAX_FILES` | 轮转上限；默认每文件 `50 MB`、保留 `5` 个文件。 |
| `PROXY_ERROR_DIAGNOSTICS_SHARED` / `PROXY_INSTANCE_ID` | 多 Proxy Pod 使用 RWX 诊断卷时启用；每个 Pod 使用独立实例目录，管理接口聚合读取。 |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_SCOPE` | Login 使用的 OpenCode OAuth client 和 Device Flow scope。 |
| `OPENCODE_VERSION` / `OPENCODE_USER_AGENT` | Login 与 Proxy 请求使用的 OpenCode User-Agent；显式 User-Agent 优先。 |
| `COPILOT_API_BASE_URL` | Copilot API 地址；GitHub.com 默认 `https://api.githubcopilot.com`。 |
| `GITHUB_API_BASE_URL` | SSO 调用 GitHub Copilot seat 和 AI Credits API 的根地址，默认 `https://api.github.com`。 |
| `GITHUB_API_VERSION` | Copilot 请求的 `X-GitHub-Api-Version`，默认 `2026-06-01`。 |
| `LOGIN_SSO_URL` / `LOGIN_SSO_PROVIDER` | Login 自动化使用的默认 SSO 登录 URL 和 provider；任务参数可覆盖 provider/URL。 |
| `AUTH_HEADLESS` | Login Playwright 是否无头运行，默认 `true`。 |
| `LOG_LEVEL` | 所有服务的结构化日志等级：`debug`、`info`、`warn`、`error`。 |
| `PROXY_PORT` / `SSO_PORT` / `LOGIN_PORT` / `CONSOLE_PORT` | Compose 暴露到宿主机的端口，不会改变容器内服务端口。 |

各服务完整环境变量表见 [`src/proxy/README.md`](./src/proxy/README.md)、[`src/sso/README.md`](./src/sso/README.md)、[`src/login/README.md`](./src/login/README.md) 和 [`src/console/README.md`](./src/console/README.md)。升级后请在 Console **Settings** 页面确认 SSO/Login 的持久化设置值。

> **升级提示**：首次用新版本打开旧 `proxy.sqlite` 时会保留 identity、SSO/GH login 映射和请求统计，但会不可逆清除旧 VS Code/GitHub token 与短期 Copilot token。升级前先备份数据库，升级后在 Console 逐账号重新授权，或导入通过 OpenCode OAuth client 获取的新 token。

已有 Proxy SQLite 数据迁移到 MySQL 时，使用 [`upgrade/sqlite-to-mysql`](./upgrade/sqlite-to-mysql/README.md) 的显式迁移工具；Proxy 启动不会自动跨数据库搬迁数据。

2. 准备 SAML 证书：

```bash
bash scripts/gen-certs.sh
```

默认会生成到 `./certs`。如果使用自己的证书，请把 `idp-cert.pem` 和 `idp-key.pem` 放到 `.env` 中 `SSO_CERT_DIR` 指向的目录。

3. 启动服务：

```bash
npm run compose:up
```

4. 检查健康状态：

```bash
npm run validate:health
```

5. 打开控制台：

```text
http://localhost:7004
```

### 可选：本地 MySQL 8

生产部署的 `docker-compose.yml` 只接收外部 `MYSQL_URL`，不会强制创建 MySQL。需要本地验证时，可用独立 Compose 文件启动测试数据库：

```bash
npm run mysql:test:up
```

在宿主机运行 Proxy 或集成测试时使用：

```bash
MYSQL_TEST_URL='mysql://ghcp_proxy:ghcp_proxy_local@127.0.0.1:3306/ghcp_proxy' npm run test:mysql
```

其中 `MYSQL_TEST_URL` 是仅对本次命令生效的环境变量，`npm run test:mysql` 会读取它来连接测试数据库。连接串采用常见的 MySQL URI 格式：

```text
mysql://<用户名>:<密码>@<主机>:<端口>/<数据库名>
```

本例中，`mysql://` 是固定的协议前缀；`ghcp_proxy` 是用户名；`ghcp_proxy_local` 是密码；`127.0.0.1` 表示宿主机本机；`3306` 是 MySQL 默认端口；最后的 `ghcp_proxy` 是数据库名。格式固定，但这些字段需按实际配置修改；用户名或密码含特殊字符时需要进行 URL 编码。

需要让完整 Compose 栈连接这个 MySQL 时，在 `.env` 设置：

```dotenv
STORAGE_DRIVER=mysql
MYSQL_URL=mysql://ghcp_proxy:ghcp_proxy_local@mysql:3306/ghcp_proxy
```

然后同时加载两个 Compose 文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.mysql.yml up -d --build --wait
```

多 Pod/Kubernetes 部署必须使用 `mysql`，并让每个 Proxy Pod 使用同一 `MYSQL_URL`。错误诊断如需在 Console 中全局可见，应给所有 Proxy Pod 挂载同一个 RWX PVC，设置 `PROXY_ERROR_DIAGNOSTICS_SHARED=true`，并通过 Downward API 把 Pod 名注入 `PROXY_INSTANCE_ID`。本次横向扩展仅覆盖 Proxy；仍使用 SQLite/文件状态的 SSO、Login 和 Console 必须保持单副本。

首次访问会创建本地控制台管理员。之后可以在控制台管理 SSO 用户、EMU 同步、Proxy 账号、登录任务、Copilot OAuth 重授权/导入、请求统计和 Error Diagnostics；管理员可在 **Settings** 修改自己的 Console 密码。

> **SSO 改密与自动登录**：SSO 只保存密码哈希，不能把修改后的任意密码提供给 Login。若新密码不是当前 `SSO_DEFAULT_USER_PASSWORD` 或该用户的 `ssoUser`，后续自动初始化无法取得密码；请在 Console 的 **Reauthorize Copilot OAuth** 中手动输入新密码。Login 仅使用该次请求提供的密码执行任务，不会把密码保存到任务历史。

## 调用 API

设置API_KEY环境变量
```
export API_KEY=change-me-proxy-api-key
```

`proxy` 默认监听 `3000`，公共接口需要：

```http
Authorization: Bearer <API_KEY>
X-User-Identity: <your-user-identity>
Content-Type: application/json
X-Claude-Code-Optimized: true|false  # 可选；覆盖 CLAUDE_CODE_OPTIMIZED 默认值
```

示例：

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Claude-Code-Optimized: false" \
  -H "X-Cache: false" \
  -H "X-User-Identity: alice"
```

首次请求某个 identity 时，如果账号和 token 还没准备好，`proxy` 可能返回 `202 account_initializing`。等待后台 SSO/EMU 同步和登录任务完成后再重试。

成功启动且 identity 对应账号可用后，可以调用 Anthropic Messages 系列接口：

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6",
    "max_tokens": 256,
    "messages": [
      {
        "role": "user",
        "content": "用一句话介绍 GitHub Copilot。"
      }
    ]
  }'
```

```bash
curl http://localhost:3000/v1/messages/count_tokens \
  -H "x-api-key: $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [
      {
        "role": "user",
        "content": "统计这句话的输入 token。"
      }
    ]
  }'
```

也可以调用 OpenAI Responses 形状接口：

```bash
curl http://localhost:3000/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "input": "用一句话说明 GitHub Copilot 的用途。"
  }'
```

`model` 需要替换为支持目标 API path 的模型。默认 `CLAUDE_CODE_OPTIMIZED=true` 时，`GET /v1/models` 面向 Claude Code 只返回支持 `/v1/messages` 的模型，并保持 Copilot 原始模型名，例如 `claude-opus-4.8`；如果某次请求需要完整 Copilot/OpenAI 风格模型列表，传 `X-Claude-Code-Optimized: false`。`/responses` 示例中的 `gpt-5-mini` 需要替换为账号可用且支持 `/responses` 的 Copilot 模型。如果你在 `.env` 里改了 `IDENTITY_HEADER`，示例里的 `X-User-Identity` 也要同步替换。

Claude Code 可以通过 settings 文件接入本地 proxy，例如 `~/.claude/settings.json` ：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "<API_KEY>",
    "ANTHROPIC_CUSTOM_HEADERS": "X-User-Identity: alice",
    "ANTHROPIC_MODEL": "<claude-model-from-v1-models>",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

如果使用项目内 `.claude/settings.local.json`，不要提交包含 `ANTHROPIC_AUTH_TOKEN` 的文件。

## 本地开发

```bash
npm install
npm run build:deploy
npm run typecheck:deploy
```

单独启动服务：

```bash
npm run start:sso
npm run start:login
npm run start:proxy
npm --workspace @ghcp/console run build
npm run start:console
```

## 必须知道的限制

- Copilot 后端不是正式公开的裸 API，一些模型能力、参数、流式格式或模型可见性可能与 OpenAI/Anthropic 官方 API 不完全一致。
- Copilot 内部 API 可能被 GitHub 产品组调整，生产使用可能受到兼容性影响。
- 本项目是开源自维护方案，不提供托管 SLA；部署、密钥、账号、合规、日志和安全策略需要使用方自行负责。
- 账号和 token 涉及敏感权限，不能提交 `.env`、SQLite 数据库、日志、Playwright trace、Copilot OAuth token 或 SSO 密码。
- 错误诊断默认不脱敏，会保存原始入站请求、实际 Copilot 请求、Authorization/API Key、用户 prompt、工具内容和上游响应；必须像 token 数据库一样限制 `proxy-data` 和 Console 管理员访问。
- EMU、SAML、SCIM、Copilot seat 配置依赖 GitHub Enterprise 管理权限；没有这些前提无法完整跑通批量账号和自动登录流程。
