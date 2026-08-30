#!/usr/bin/env bash
set -euo pipefail

base_proxy="${PROXY_URL:-http://localhost:3000}"
base_sso="${SSO_URL:-http://localhost:7001}"
base_login="${LOGIN_URL:-http://localhost:7003}"
base_console="${CONSOLE_URL:-http://localhost:7004}"

curl -fsS "$base_proxy/readyz" >/dev/null
curl -fsS "$base_sso/healthz" >/dev/null
curl -fsS "$base_login/healthz" >/dev/null
curl -fsS "$base_console/healthz" >/dev/null

echo "All service health checks passed."
