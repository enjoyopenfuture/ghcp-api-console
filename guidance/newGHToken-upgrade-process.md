# 已部署环境迁移到 OpenCode OAuth 的一次性操作方案

## 1. 目的

旧版本 Proxy 保存 GitHub token，以及通过 `copilot_internal/v2/token` 换取的短期 Copilot token。新版本 Proxy 需要 OpenCode OAuth client 签发的 OAuth access token，当前通常以 `gho_` 开头。

旧 token 不能直接转换成 OpenCode OAuth token。每个 GitHub 用户都必须重新完成一次 Device Flow。本文提供两种一次性迁移方案：

1. **升级前批量生成 token，升级后立即导入。**
2. **备份并删除旧 Proxy SQLite，升级后按用户首次访问自动重新登录。**

本文基于以下已确认条件：

- `proxy_accounts.identity` 与 `proxy_accounts.sso_user` 始终相同；
- 使用 custom SSO；
- SSO 用户名和密码相同；
- `proxy_accounts.gh_login` 已正确保存 EMU GitHub login。

如果实际环境不满足这些条件，不要直接执行本文脚本。

---

## 2. 两种方案对比

| 项目 | 方案 1：升级前生成并导入 | 方案 2：删除 Proxy DB 后按需登录 |
|---|---|---|
| Proxy 账号映射 | 保留 | 全部删除后重建 |
| Proxy 请求统计 | 保留 | 全部丢失 |
| 用户升级后首次请求 | 大部分可立即使用 | 返回初始化状态，等待登录完成 |
| 登录压力 | 升级前顺序处理，可控 | 可能形成登录风暴 |
| 升级窗口 | Proxy 启动后需立即导入 CSV | 操作少，但恢复时间不可预测 |
| 明文 token 临时文件 | 有，需要严格保护 | 没有 |
| 回滚难度 | 较低 | 较高，必须依赖备份 |
| 推荐程度 | **推荐** | 仅在可接受数据丢失和登录风险时使用 |

---

## 3. 共同准备工作

### 3.1 使用新版本 Login CLI

生成 token 时必须使用包含 OpenCode OAuth 改造的新代码，但此时不需要升级正在运行的旧 Proxy。

在独立目录准备新版本代码：

```bash
git clone <repository-url> ghcp-api-console-opencode
cd ghcp-api-console-opencode
npm ci
npx playwright install --with-deps chromium
npm --workspace @ghcp/shared run build
npm --workspace @ghcp/login run build
```

单账号命令：

```bash
npm --silent --workspace @ghcp/login run login:copilot-oauth -- \
  --gh-login <gh-login> \
  --sso-user <sso-user> \
  --sso-password <sso-user> \
  --sso-type custom \
  --sso-url <sso-url>
```

命令约定：

- stdout 只输出 OAuth token；
- 进度和错误写入 stderr；
- 成功 token 当前通常以 `gho_` 开头；
- 单账号通常需要约一分钟；
- 不要使用旧版本 Login 命令，否则可能仍使用旧 OAuth client。

确认环境使用：

```text
GITHUB_OAUTH_CLIENT_ID=Ov23li8tweQw6odWQebz
```

或者不设置该变量，使用新代码中的默认 OpenCode client ID。

### 3.2 找到旧 Proxy 数据库

旧 Docker Compose 默认数据卷位置是：

```text
/var/lib/docker/volumes/
```

如果使用宿主机路径或其他部署方式，请找到真实的 `proxy.sqlite`。后续示例使用：

```bash
export OLD_PROXY_DB=/absolute/path/to/proxy.sqlite
```

不要在不确定路径时执行删除操作。

### 3.3 使用 SQLite backup

读取旧数据库前先创建一致性备份：

```bash
mkdir -p ./oauth-migration
chmod 700 ./oauth-migration
umask 077

sqlite3 "$OLD_PROXY_DB" \
  ".backup './oauth-migration/proxy-before-opencode.sqlite'"

export EXPORT_PROXY_DB="$PWD/oauth-migration/proxy-before-opencode.sqlite"
```

SQLite `.backup` 能正确处理 WAL 中已提交的数据，比直接复制正在运行的数据库文件安全。

### 3.4 检查账号假设

确认 identity 与 sso_user 完全相同：

```bash
sqlite3 -readonly "$EXPORT_PROXY_DB" "
  SELECT COUNT(*)
  FROM proxy_accounts
  WHERE identity <> sso_user;
"
```

预期结果：

```text
0
```

检查缺少 gh_login 的账号：

```bash
sqlite3 -readonly "$EXPORT_PROXY_DB" "
  SELECT identity
  FROM proxy_accounts
  WHERE gh_login IS NULL OR trim(gh_login) = '';
"
```

预期没有输出。存在缺失值时，应先修复账号映射或从批处理列表中排除。

---

## 4. 方案 1：升级前批量生成，升级后立即导入(推荐)

### 4.1 适用场景

推荐在以下条件下使用：

- 希望保留 Proxy 账号映射；
- 希望保留请求统计；
- 可以在升级前运行较长时间的批量登录；
- 可以安全保管一个短期存在的明文 token CSV；
- 希望把升级后的不可用时间缩短到几分钟。

### 4.2 导出旧 Proxy 用户

导出为 tab 分隔文件，避免 Bash 解析 CSV 引号：

```bash
sqlite3 -readonly -tabs "$EXPORT_PROXY_DB" "
  SELECT identity, sso_user, gh_login
  FROM proxy_accounts
  WHERE gh_login IS NOT NULL
    AND trim(gh_login) <> ''
  ORDER BY identity;
" > ./oauth-migration/proxy-users.tsv

chmod 600 ./oauth-migration/proxy-users.tsv
wc -l ./oauth-migration/proxy-users.tsv
```

字段顺序：

```text
identity<TAB>sso_user<TAB>gh_login
```

### 4.3 完整批量脚本

其核心逻辑是这个命令
```
    npm --workspace @ghcp/login run login:copilot-oauth -- \
      --gh-login <gh-login> \
      --sso-user <sso-user> \
      --sso-password <sso-password> \
      --sso-type custom \
      --sso-url <sso-url>
```


把以下内容保存为：

```text
oauth-migration/generate-opencode-tokens.sh
```

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

: "${REPO_ROOT:?Set REPO_ROOT to the new OpenCode-version repository}"
: "${SSO_URL:?Set SSO_URL to the custom SSO login URL}"

WORK_DIR="${WORK_DIR:-$PWD/oauth-migration}"
ACCOUNT_FILE="${ACCOUNT_FILE:-$WORK_DIR/proxy-users.tsv}"
TOKEN_CSV="${TOKEN_CSV:-$WORK_DIR/copilot-oauth-tokens.csv}"
FAILURE_FILE="${FAILURE_FILE:-$WORK_DIR/copilot-oauth-failures.tsv}"

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"

if [[ ! -f "$ACCOUNT_FILE" ]]; then
  echo "Account file not found: $ACCOUNT_FILE" >&2
  exit 1
fi

if [[ ! -f "$TOKEN_CSV" ]]; then
  printf 'name,copilotOauthToken\n' > "$TOKEN_CSV"
fi

touch "$FAILURE_FILE"
chmod 600 "$TOKEN_CSV" "$FAILURE_FILE"

total="$(wc -l < "$ACCOUNT_FILE" | tr -d ' ')"
current=0

while IFS=$'\t' read -r identity sso_user gh_login; do
  current=$((current + 1))

  if [[ -z "$identity" || -z "$sso_user" || -z "$gh_login" ]]; then
    printf '%s\t%s\n' "${identity:-<empty>}" \
      'missing identity, sso_user, or gh_login' >> "$FAILURE_FILE"
    continue
  fi

  if [[ "$identity" != "$sso_user" ]]; then
    printf '%s\t%s\n' "$identity" \
      "identity differs from sso_user: $sso_user" >> "$FAILURE_FILE"
    continue
  fi

  if [[ "$identity" == *','* || "$identity" == *$'\t'* || "$identity" == *$'\n'* ]]; then
    printf '%s\t%s\n' "$identity" \
      'identity contains an unsupported delimiter' >> "$FAILURE_FILE"
    continue
  fi

  if awk -F',' -v id="$identity" \
    'NR > 1 && $1 == id { found = 1 } END { exit !found }' \
    "$TOKEN_CSV"; then
    echo "[$current/$total] skip $identity: token already present" >&2
    continue
  fi

  echo "[$current/$total] authorizing $identity as $gh_login" >&2

  if ! token="$(
    cd "$REPO_ROOT"
    npm --silent --workspace @ghcp/login run login:copilot-oauth -- \
      --gh-login "$gh_login" \
      --sso-user "$sso_user" \
      --sso-password "$sso_user" \
      --sso-type custom \
      --sso-url "$SSO_URL"
  )"; then
    printf '%s\t%s\n' "$identity" \
      'login command failed; inspect stderr/account log' >> "$FAILURE_FILE"
    continue
  fi

  token="$(printf '%s' "$token" | tr -d '\r\n')"

  if [[ "$token" != gho_* ]]; then
    printf '%s\t%s\n' "$identity" \
      'command did not return an expected gho_ token' >> "$FAILURE_FILE"
    unset token
    continue
  fi

  printf '%s,%s\n' "$identity" "$token" >> "$TOKEN_CSV"
  unset token
  echo "[$current/$total] completed $identity" >&2
done < "$ACCOUNT_FILE"

success="$(
  awk 'END { print NR > 0 ? NR - 1 : 0 }' "$TOKEN_CSV"
)"
failures="$(wc -l < "$FAILURE_FILE" | tr -d ' ')"

echo "Completed: $success token(s), $failures failure row(s)." >&2
echo "Token CSV: $TOKEN_CSV" >&2
echo "Failures: $FAILURE_FILE" >&2
```

设置权限并执行：

```bash
chmod 700 ./oauth-migration/generate-opencode-tokens.sh

export REPO_ROOT=/absolute/path/to/ghcp-api-console-opencode
export SSO_URL=https://your-sso-host.example.com
export WORK_DIR=$PWD/oauth-migration

./oauth-migration/generate-opencode-tokens.sh
```

脚本默认顺序执行，不建议直接改成无限并发。

### 4.4 断点续跑

脚本会检查 `copilot-oauth-tokens.csv`：

- 已有 identity 会跳过；
- 登录失败会写入 `copilot-oauth-failures.tsv`；
- 重新运行脚本只处理尚未成功的账号。

失败文件不包含 token。

重新处理前可以清空失败记录：

```bash
: > ./oauth-migration/copilot-oauth-failures.tsv
```

不要删除已经生成的 token CSV，否则会重新授权所有账号。

### 4.5 升级前核对

```bash
old_count="$(
  sqlite3 -readonly "$EXPORT_PROXY_DB" \
    "SELECT COUNT(*) FROM proxy_accounts WHERE gh_login IS NOT NULL AND trim(gh_login) <> '';"
)"

token_count="$(
  awk 'END { print NR > 0 ? NR - 1 : 0 }' \
    ./oauth-migration/copilot-oauth-tokens.csv
)"

printf 'old accounts: %s\ngenerated tokens: %s\n' \
  "$old_count" "$token_count"
```

只有在：

```text
old accounts == generated tokens
```

且失败文件为空时，才建议开始升级。

### 4.6 升级项目

在正式仓库执行：

```bash
npm run build:deploy
docker compose up -d --build
```

新 Proxy 首次启动会：

- 保留 identity、sso_user、gh_login；
- 清除旧 GitHub token；
- 清除旧短期 Copilot token；
- 把已有账号 OAuth 状态设为 `missing`。

此时应尽快导入预先生成的 CSV。

### 4.7 通过 Console 导入

推荐使用 Console：

```text
Proxy Accounts
  -> Import Copilot OAuth tokens
```

导入：

```text
oauth-migration/copilot-oauth-tokens.csv
```

Proxy 会逐个调用 Copilot `/models` 验证 token。

预期：

- success 数等于 CSV 数据行数；
- failed 为 0；
- Proxy Accounts 中账号状态变为 `valid`。

### 4.8 通过 Proxy API 导入

```bash
export NEW_PROXY_URL=http://127.0.0.1:3000
export TOKEN_CSV=$PWD/oauth-migration/copilot-oauth-tokens.csv

read -rsp 'INTERNAL_API_TOKEN: ' INTERNAL_API_TOKEN
echo

node -e '
  const fs = require("fs");
  const csvText = fs.readFileSync(process.argv[1], "utf8");
  process.stdout.write(JSON.stringify({ csvText }));
' "$TOKEN_CSV" |
curl --fail-with-body --silent --show-error \
  -X POST "$NEW_PROXY_URL/api/accounts/copilot-oauth-token/import" \
  -H "X-Internal-Token: $INTERNAL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @-

echo
unset INTERNAL_API_TOKEN
```

响应中的 `summary.total` 应等于 CSV 数据行数，`summary.failed` 应为 0。

### 4.9 清理敏感文件

确认所有账号已经是 `valid`，并完成必要备份后：

```bash
rm -f ./oauth-migration/copilot-oauth-tokens.csv
rm -f ./oauth-migration/copilot-oauth-failures.tsv
rm -f ./oauth-migration/proxy-users.tsv
```

注意：

- OAuth CSV 是明文 Bearer token 集合；
- 不要提交到 Git；
- 不要通过聊天、邮件或工单传输；
- 不要放在共享目录；
- 使用 SSD、快照或网络文件系统时，`shred` 不保证物理擦除；
- 应同时检查备份、终端录屏和自动同步目录。

`proxy-before-opencode.sqlite` 也包含旧敏感 token，应按安全备份策略保管或销毁。

---

## 5. 方案 2：备份并删除 Proxy SQLite，升级后按需登录（适合当前用户不多，或者不会同时使用的情况）

### 5.1 原理

如果保留旧 Proxy 数据库，新 migration 会保留账号记录并将状态设为 `missing`。已有账号首次访问只会得到：

```text
503 oauth_not_ready
```

不会自动创建 Login 任务。

如果升级前删除旧 Proxy SQLite，新版本看到空数据库。用户首次访问时 identity 不存在，会触发：

1. Proxy 根据 identity 调用 SSO ensure。
2. SSO 返回已存在的 SSO 用户。
3. Proxy 同步 EMU/GH login。
4. Proxy 创建新 account，状态为 `refreshing`。
5. Proxy 使用 `ssoUser` 作为默认密码创建 Login task。
6. Login 执行 OpenCode Device Flow。
7. 成功后账号状态变为 `valid`。

本方案成立的关键前提：

```text
identity == ssoUser == ssoPassword
```

### 5.2 必须接受的数据损失

删除 Proxy SQLite 会永久删除：

- 所有 Proxy account 记录；
- identity 到 ssoUser/ghLogin 的本地映射；
- 所有 Proxy request stats；
- 历史失败原因；
- token 和请求统计历史。

SSO、Login 和 Console 使用各自数据库，只删除 Proxy SQLite 不会删除这些服务的数据。

严禁执行：

```bash
docker compose down -v
```

该命令会删除 Proxy、SSO、Login、Console 的全部 named volumes，影响范围远超本方案。

### 5.3 备份

停止 Proxy：

```bash
docker compose stop proxy
```

对真实 Proxy 数据库执行：

```bash
sqlite3 "$OLD_PROXY_DB" \
  ".backup './oauth-migration/proxy-before-empty-db.sqlite'"

sqlite3 -readonly ./oauth-migration/proxy-before-empty-db.sqlite \
  "PRAGMA integrity_check;"
```

预期：

```text
ok
```

### 5.4 只删除 Proxy 数据库文件

如果数据库是宿主机路径，先输出并人工确认路径：

```bash
printf 'Deleting only Proxy DB files:\n%s\n%s\n%s\n' \
  "$OLD_PROXY_DB" "${OLD_PROXY_DB}-wal" "${OLD_PROXY_DB}-shm"
```

确认无误后：

```bash
rm -f "$OLD_PROXY_DB"
rm -f "${OLD_PROXY_DB}-wal"
rm -f "${OLD_PROXY_DB}-shm"
```

如果使用 Docker Compose 的 `proxy-data` volume：

```bash
docker compose run --rm --no-deps \
  --entrypoint sh proxy \
  -c 'rm -f /data/proxy.sqlite /data/proxy.sqlite-wal /data/proxy.sqlite-shm'
```

不要删除 `/data` 目录，不要删除整个 volume。

### 5.5 升级并启动

```bash
npm run build:deploy
docker compose up -d --build
```

新 Proxy 会创建空的新版数据库。

### 5.6 首次访问表现

每个用户第一次请求可能收到：

```text
202 account_initializing
```

登录任务执行期间仍可能继续收到 202。完成 Device Flow 后，后续请求恢复正常。

客户端必须能够重试；如果客户端把第一次 202 当成永久失败，用户需要手动重新发起请求。

### 5.7 方案 2 的主要风险

#### 风险 1：集中登录风暴

如果升级后大量客户端同时恢复：

- 每个新 identity 都会创建登录任务；
- 每个任务启动一个 Chromium；
- 每个任务约一分钟；
- GitHub Device Flow、GitHub 登录和企业 SSO 同时承压；
- 可能触发 rate limit、验证码、MFA、账号保护或 SSO 限流；
- Login 容器可能耗尽 CPU、内存或临时磁盘。

#### 风险 2：登录队列只在内存中

Login 的待执行 payload 保存在单进程内存队列。服务重启时：

- pending/running 数据库记录会被标记为 failed；
- 内存中的密码和任务 payload 无法恢复；
- 尚未完成的用户必须重新触发或由管理员重试。

#### 风险 3：默认密码假设

对于已经存在的 SSO 用户，Proxy 无法从密码哈希还原真实密码，只能回退使用：

```text
ssoPassword = ssoUser
```

任何修改过密码的账号都会登录失败。

#### 风险 4：重复执行 SCIM/seat 同步

空 Proxy DB 下，首次初始化会重新执行 SSO ensure 和 EMU sync，可能产生：

- SCIM 查询/更新流量；
- Copilot seat assign 请求；
- GitHub Enterprise API 压力；
- 单个外部步骤失败导致整体初始化失败。

#### 风险 5：不可恢复的数据历史

即使用户重新登录成功，旧 request stats 和 Proxy 账号历史也不会自动恢复，只能从备份数据库离线查询。

### 5.8 不建议直接增加多个 Login Docker 节点

当前 Login 不支持做横向扩展的分布式队列。

#### 多节点共享同一个 SQLite

SQLite WAL 能处理部分并发写入，但业务语义不安全：

- 每个节点都有独立内存 pending queue；
- 每个节点只知道自己内存中的任务 payload；
- 任一 Login 节点启动都会把共享数据库中全部 pending/running 任务标记为 failed；
- 一个节点可能把另一个节点正在执行的任务标记失败；
- cancel、retry 和 active 状态没有分布式锁或任务 claim。

因此不能仅让多个 Login 容器共享 `login-data` volume。

#### 每个节点使用独立 SQLite

虽然不会直接争用数据库，但仍有以下问题：

- 任务列表分散；
- Console 只能通过一个 `LOGIN_BASE_URL` 查看任务；
- 负载均衡后的查询、取消和重试可能落到错误节点；
- 日志和任务状态不能统一管理；
- 没有集中调度和 sticky routing 设计。

因此当前版本也不建议用独立 SQLite 简单复制 Login 容器。

#### 推荐做法

优先保留单个 Login 节点，谨慎提高环境变量的值：

```text
LOGIN_CONCURRENCY
```

建议从 `2` 开始，根据以下指标逐步调整：

- Login 容器 CPU；
- 内存；
- 同时运行的 Chromium 数；
- 单账号成功率；
- GitHub/SSO rate limit；
- 验证码和 MFA 频率；
- 平均任务耗时。

不要在没有压测的情况下直接设置很高的并发。

### 5.9 控制恢复节奏

不要让全部客户端在同一时间恢复。可选措施：

1. 分批通知用户重新连接。
2. 在网关层分批开放 identity。
3. 管理员按批次主动请求 `/v1/models`，触发账号初始化。
4. 每批等待 Login 队列基本清空后再继续。
5. 观察 Login task success/failed 和容器资源。

触发请求示例：

```bash
curl --fail-with-body \
  "$PROXY_URL/v1/models" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "X-User-Identity: <identity>"
```

第一次返回 202 是预期行为。不要对同一 identity 高频重试。

---

## 6. 方案选择建议

### 优先选择方案 1

适用于：

- 账号数量可控；
- 可以在升级前运行数小时的顺序登录；
- 希望保留 Proxy 数据和统计；
- 希望升级后立即恢复；
- 能安全保管临时 OAuth CSV。

### 谨慎选择方案 2

仅当：

- 可以接受全部 Proxy request stats 丢失；
- identity、ssoUser、密码确实相同；
- 用户能够重试首次请求；
- 可以分批恢复流量；
- Login 单节点有足够资源；
- 已创建并验证完整 Proxy DB 备份。

方案 2 操作更简单，但运行风险明显高于方案 1。

---

## 7. 回滚

建议先测试好新的 Proxy，确认可以导入 CSV 或按需登录成功后再做生产环境的切换。

### 7.1 方案 1

升级失败时：

1. 停止新服务。
2. 恢复旧应用版本。
3. 恢复 `proxy-before-opencode.sqlite`。
4. 恢复对应部署配置。
5. 启动旧 Proxy。

预生成的 OpenCode OAuth CSV 与旧 Proxy 无关，可以保留到重试升级时使用，但必须按 Bearer secret 保护。

### 7.2 方案 2

升级或批量登录失败时：

1. 停止新 Proxy。
2. 删除新建的空或部分恢复 Proxy DB。
3. 从 `proxy-before-empty-db.sqlite` 恢复旧数据库。
4. 恢复旧应用版本。
5. 启动旧 Proxy。

恢复前应保留新 DB 的诊断副本，否则会丢失失败任务关联信息。

---

## 8. 最终检查清单

### 方案 1

- [ ] 使用新 OpenCode Login CLI。
- [ ] 创建旧 Proxy DB 一致性备份。
- [ ] identity 与 sso_user 差异数量为 0。
- [ ] 所有账号都有 gh_login。
- [ ] token 数量等于旧账号数量。
- [ ] 所有 token 以预期的 `gho_` 开头。
- [ ] failure 文件为空。
- [ ] 新 Proxy 启动后立即导入 CSV。
- [ ] import failed 为 0。
- [ ] 所有账号状态为 valid。
- [ ] 安全清理 token CSV。

### 方案 2

- [ ] 接受 Proxy 账号映射和 request stats 丢失。
- [ ] 已验证 Proxy DB 备份。
- [ ] 只删除 Proxy SQLite/WAL/SHM。
- [ ] 未执行 `docker compose down -v`。
- [ ] 确认所有 SSO 用户密码仍等于用户名。
- [ ] 单 Login 节点配置合理并发。
- [ ] 用户或管理员分批触发初始化。
- [ ] 持续观察 Login task、GitHub/SSO 限流和容器资源。
- [ ] 准备好从备份回滚。
