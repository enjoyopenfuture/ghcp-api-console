-- Requires an account with CREATE DATABASE (and GRANT) privileges, e.g. root.
CREATE DATABASE IF NOT EXISTS ghcp_proxy
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE ghcp_proxy;

-- 如果库已经建好了，请从下面的表创建开始。
CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS proxy_accounts (
  identity VARCHAR(255) COLLATE utf8mb4_bin PRIMARY KEY,
  sso_user VARCHAR(255) NOT NULL,
  gh_login VARCHAR(255),
  copilot_oauth_token TEXT COLLATE utf8mb4_bin,
  copilot_oauth_status VARCHAR(32) NOT NULL DEFAULT 'missing',
  copilot_oauth_updated_at DATETIME(3),
  copilot_oauth_attempt_id CHAR(36) COLLATE ascii_bin,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_proxy_accounts_sso_user (sso_user),
  INDEX idx_proxy_accounts_updated_at (updated_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS proxy_request_stats (
  id VARCHAR(64) COLLATE ascii_bin PRIMARY KEY,
  identity VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  gh_login VARCHAR(255),
  requested_at DATETIME(3) NOT NULL,
  path VARCHAR(128) NOT NULL,
  model VARCHAR(255),
  success TINYINT(1) NOT NULL,
  failure_reason TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_tokens BIGINT,
  cache_input_tokens BIGINT,
  cache_write_tokens BIGINT,
  INDEX idx_proxy_request_stats_identity_time (identity, requested_at DESC, id DESC),
  INDEX idx_proxy_request_stats_time (requested_at DESC, id DESC)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS proxy_identity_initializations (
  identity VARCHAR(255) COLLATE utf8mb4_bin PRIMARY KEY,
  claim_id CHAR(36) COLLATE ascii_bin NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_proxy_identity_initializations_lease (lease_expires_at)
) ENGINE=InnoDB;
