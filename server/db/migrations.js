import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './pool.js';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_JSON_PATH = path.resolve(__dirname, '..', 'data', 'workflows.json');

/**
 * Ordered schema migrations.
 *
 * Append-only: never edit an applied migration, add a new one. Each runs once
 * and is recorded in `schema_migrations`, so a deployment converges to the same
 * schema regardless of which version it started from.
 */
const MIGRATIONS = [
  {
    id: '001_create_owners',
    statements: [
      `CREATE TABLE IF NOT EXISTS owners (
         id           VARCHAR(64)  NOT NULL,
         created_at   DATETIME(3)  NOT NULL,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '002_create_workflows',
    statements: [
      // `name` is unique PER OWNER, not globally, so two operators can each
      // have a workflow called "Lead follow-up".
      //
      // `version` powers optimistic locking: an update must state the version it
      // read, so a concurrent edit is reported instead of silently overwritten.
      `CREATE TABLE IF NOT EXISTS workflows (
         id            CHAR(36)     NOT NULL,
         owner_id      VARCHAR(64)  NOT NULL,
         name          VARCHAR(255) NOT NULL,
         nodes         JSON         NOT NULL,
         edges         JSON         NOT NULL,
         initial_state JSON         NULL,
         metadata      JSON         NULL,
         version       INT UNSIGNED NOT NULL DEFAULT 1,
         created_at    DATETIME(3)  NOT NULL,
         updated_at    DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_workflows_owner_name (owner_id, name),
         KEY idx_workflows_owner_updated (owner_id, updated_at),
         CONSTRAINT fk_workflows_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '003_create_tool_credentials',
    statements: [
      // OAuth tokens for connected tools, one row per owner per tool.
      //
      // The browser used to hold these in localStorage in plain text. They live
      // here now, and both token columns are AES-256-GCM ciphertext (see
      // `credentialCrypto.js`) so a database dump does not contain usable Google
      // credentials. The columns are TEXT because the encrypted envelope is
      // several times longer than the token and Google does not bound token
      // length.
      `CREATE TABLE IF NOT EXISTS tool_credentials (
         owner_id           VARCHAR(64)  NOT NULL,
         tool_id            VARCHAR(64)  NOT NULL,
         provider           VARCHAR(32)  NOT NULL,
         access_token_enc   TEXT         NOT NULL,
         refresh_token_enc  TEXT         NULL,
         expires_at         DATETIME(3)  NULL,
         scopes             JSON         NOT NULL,
         connected_at       DATETIME(3)  NOT NULL,
         updated_at         DATETIME(3)  NOT NULL,
         PRIMARY KEY (owner_id, tool_id),
         CONSTRAINT fk_tool_credentials_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '004_create_workflow_runs',
    statements: [
      // One row per execution. Run history used to live as a 20-entry JSON array
      // nested in workflows.metadata — write-only (nothing read it) and lossy
      // (only status/provider/timestamp). It moves here so a run is a first-class
      // record the operator can list and inspect: how long it took, how many
      // nodes ran, how many failed, and why.
      //
      // The FK is ON DELETE CASCADE so deleting a workflow drops its run history,
      // and `owner_id` is denormalised onto the row so runs can be listed and
      // access-checked without a join. `workflow_name` is captured at run time so
      // a renamed or deleted-and-recreated workflow's old runs still read sensibly.
      `CREATE TABLE IF NOT EXISTS workflow_runs (
         id             CHAR(36)     NOT NULL,
         workflow_id    CHAR(36)     NOT NULL,
         owner_id       VARCHAR(64)  NOT NULL,
         workflow_name  VARCHAR(255) NOT NULL,
         status         VARCHAR(20)  NOT NULL,
         provider       VARCHAR(120) NULL,
         model          VARCHAR(120) NULL,
         duration_ms    INT UNSIGNED NULL,
         node_count     INT UNSIGNED NULL,
         failure_count  INT UNSIGNED NULL,
         failure_kind   VARCHAR(40)  NULL,
         error          VARCHAR(500) NULL,
         started_at     DATETIME(3)  NULL,
         finished_at    DATETIME(3)  NULL,
         created_at     DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         KEY idx_workflow_runs_workflow (workflow_id, created_at),
         KEY idx_workflow_runs_owner (owner_id, created_at),
         CONSTRAINT fk_workflow_runs_workflow
           FOREIGN KEY (workflow_id) REFERENCES workflows (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '005_create_users',
    statements: [
      // The real identity record. The app began single-operator: `owners` was a
      // bare FK anchor and the only "identity" was a shared password whose
      // subject was hard-coded to 'operator'. This adds accounts WITHOUT
      // disturbing the tenancy model — `owner_id` stays the data-scoping key on
      // every existing table, and a user simply owns one `owners` row. So no
      // existing query changes; a user's workflows/credentials/runs are already
      // scoped by owner_id.
      //
      // `role` is the single authorization axis (user|admin). `status` allows
      // suspending an account without deleting its data. Email is unique and the
      // login handle. `password_hash` is scrypt (see server/auth/password.js),
      // never plaintext.
      `CREATE TABLE IF NOT EXISTS users (
         id                       CHAR(36)     NOT NULL,
         owner_id                 VARCHAR(64)  NOT NULL,
         email                    VARCHAR(255) NOT NULL,
         password_hash            TEXT         NOT NULL,
         role                     VARCHAR(16)  NOT NULL DEFAULT 'user',
         status                   VARCHAR(16)  NOT NULL DEFAULT 'active',
         email_verified           TINYINT(1)   NOT NULL DEFAULT 0,
         email_verification_token VARCHAR(128) NULL,
         created_at               DATETIME(3)  NOT NULL,
         updated_at               DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_users_email (email),
         UNIQUE KEY uq_users_owner (owner_id),
         KEY idx_users_role (role),
         CONSTRAINT fk_users_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '006_create_billing',
    statements: [
      // A user's credit wallet: three balances tracked separately so deduction
      // priority (subscription -> bonus -> purchased) and reset rules (only
      // subscription resets on the billing cycle) can be enforced. Balances are
      // BIGINT credits, never floats. `used_this_month` is a running counter for
      // the dashboard, reset with the subscription. The authoritative history is
      // the immutable ledger below; these columns are the fast-read cache, always
      // updated in the same transaction as a ledger row.
      `CREATE TABLE IF NOT EXISTS credit_wallets (
         owner_id             VARCHAR(64)  NOT NULL,
         subscription_credits BIGINT       NOT NULL DEFAULT 0,
         bonus_credits        BIGINT       NOT NULL DEFAULT 0,
         purchased_credits    BIGINT       NOT NULL DEFAULT 0,
         used_this_month      BIGINT       NOT NULL DEFAULT 0,
         lifetime_used        BIGINT       NOT NULL DEFAULT 0,
         created_at           DATETIME(3)  NOT NULL,
         updated_at           DATETIME(3)  NOT NULL,
         PRIMARY KEY (owner_id),
         CONSTRAINT fk_credit_wallets_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // Immutable credit ledger. Every balance change writes exactly one row
      // with balance_before/after, so the wallet is auditable and reconstructable
      // and a transaction can never simply disappear. Rows are append-only — the
      // app never UPDATEs or DELETEs here.
      `CREATE TABLE IF NOT EXISTS credit_transactions (
         id                          CHAR(36)     NOT NULL,
         owner_id                    VARCHAR(64)  NOT NULL,
         transaction_type            VARCHAR(32)  NOT NULL,
         credits                     BIGINT       NOT NULL,
         balance_before              BIGINT       NOT NULL,
         balance_after               BIGINT       NOT NULL,
         subscription_credits_change BIGINT       NOT NULL DEFAULT 0,
         purchased_credits_change    BIGINT       NOT NULL DEFAULT 0,
         bonus_credits_change        BIGINT       NOT NULL DEFAULT 0,
         provider                    VARCHAR(32)  NULL,
         model                       VARCHAR(120) NULL,
         input_tokens                BIGINT       NULL,
         cached_input_tokens         BIGINT       NULL,
         output_tokens               BIGINT       NULL,
         reasoning_tokens            BIGINT       NULL,
         provider_cost_usd_micros    BIGINT       NULL,
         customer_cost_credits       BIGINT       NULL,
         ai_request_id               VARCHAR(191) NULL,
         payment_id                  CHAR(36)     NULL,
         subscription_id             CHAR(36)     NULL,
         description                 VARCHAR(500) NULL,
         metadata                    JSON         NULL,
         created_at                  DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         KEY idx_credit_tx_owner_created (owner_id, created_at),
         KEY idx_credit_tx_type (transaction_type),
         CONSTRAINT fk_credit_tx_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // Configurable subscription plans. Prices in paise (BIGINT), credits in
      // BIGINT. `features`/`model_access`/`request_limits` are JSON so the shape
      // can grow without a migration. Not hard-coded: seeded as rows in 007.
      `CREATE TABLE IF NOT EXISTS subscription_plans (
         id               CHAR(36)     NOT NULL,
         code             VARCHAR(40)  NOT NULL,
         display_name     VARCHAR(120) NOT NULL,
         price_paise      BIGINT       NOT NULL DEFAULT 0,
         billing_cycle    VARCHAR(16)  NOT NULL DEFAULT 'monthly',
         included_credits BIGINT       NOT NULL DEFAULT 0,
         features         JSON         NULL,
         model_access     JSON         NULL,
         request_limits   JSON         NULL,
         enabled          TINYINT(1)   NOT NULL DEFAULT 1,
         sort_order       INT          NOT NULL DEFAULT 0,
         created_at       DATETIME(3)  NOT NULL,
         updated_at       DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_plans_code (code)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // A user's subscription. Historical rows are never deleted — a status
      // change (cancel/expire) is an UPDATE, and a plan switch keeps the record.
      `CREATE TABLE IF NOT EXISTS subscriptions (
         id                     CHAR(36)     NOT NULL,
         owner_id               VARCHAR(64)  NOT NULL,
         plan_id                CHAR(36)     NOT NULL,
         status                 VARCHAR(16)  NOT NULL DEFAULT 'active',
         billing_cycle          VARCHAR(16)  NOT NULL DEFAULT 'monthly',
         price_paise            BIGINT       NOT NULL DEFAULT 0,
         included_credits       BIGINT       NOT NULL DEFAULT 0,
         gateway_subscription_id VARCHAR(191) NULL,
         current_period_start   DATETIME(3)  NULL,
         current_period_end     DATETIME(3)  NULL,
         next_billing_at        DATETIME(3)  NULL,
         cancel_at_period_end   TINYINT(1)   NOT NULL DEFAULT 0,
         created_at             DATETIME(3)  NOT NULL,
         updated_at             DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         KEY idx_subscriptions_owner (owner_id, created_at),
         CONSTRAINT fk_subscriptions_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE,
         CONSTRAINT fk_subscriptions_plan
           FOREIGN KEY (plan_id) REFERENCES subscription_plans (id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // Top-up packages. Configurable price/credits/bonus/active. Seeded in 007.
      `CREATE TABLE IF NOT EXISTS credit_packages (
         id             CHAR(36)     NOT NULL,
         code           VARCHAR(40)  NOT NULL,
         display_name   VARCHAR(120) NOT NULL,
         price_paise    BIGINT       NOT NULL,
         credits        BIGINT       NOT NULL,
         bonus_credits  BIGINT       NOT NULL DEFAULT 0,
         enabled        TINYINT(1)   NOT NULL DEFAULT 1,
         expires_days   INT          NULL,
         sort_order     INT          NOT NULL DEFAULT 0,
         created_at     DATETIME(3)  NOT NULL,
         updated_at     DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_packages_code (code)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // Payment records. `gateway_payment_id` is UNIQUE so the same gateway
      // event cannot create two payments — the first line of idempotency
      // defence. Amounts in paise.
      `CREATE TABLE IF NOT EXISTS payments (
         id                   CHAR(36)     NOT NULL,
         owner_id             VARCHAR(64)  NOT NULL,
         payment_gateway      VARCHAR(32)  NOT NULL,
         gateway_order_id     VARCHAR(191) NULL,
         gateway_payment_id   VARCHAR(191) NULL,
         type                 VARCHAR(16)  NOT NULL,
         amount_paise         BIGINT       NOT NULL,
         currency             VARCHAR(8)   NOT NULL DEFAULT 'INR',
         credits_purchased    BIGINT       NULL,
         subscription_plan_id CHAR(36)     NULL,
         package_id           CHAR(36)     NULL,
         coupon_id            CHAR(36)     NULL,
         status               VARCHAR(24)  NOT NULL DEFAULT 'PENDING',
         failure_reason       VARCHAR(500) NULL,
         metadata             JSON         NULL,
         created_at           DATETIME(3)  NOT NULL,
         paid_at              DATETIME(3)  NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_payments_gateway_payment (gateway_payment_id),
         KEY idx_payments_owner_created (owner_id, created_at),
         KEY idx_payments_order (gateway_order_id),
         CONSTRAINT fk_payments_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // The admin-configurable AI rate card. Prices are micro-USD per 1M tokens
      // (integer). markup_multiplier is stored ×10 (so 2.5 -> 25) and
      // provider_fee_bps is basis points (so 5.5% -> 550) — both integers, so
      // the credit formula is pure integer math. billing_exchange_rate is
      // paise per USD (₹100 -> 10000). Admin edits here change NEW requests only;
      // ai_usage snapshots the values used at request time.
      `CREATE TABLE IF NOT EXISTS ai_model_rates (
         id                              CHAR(36)     NOT NULL,
         provider                        VARCHAR(32)  NOT NULL,
         model_id                        VARCHAR(120) NOT NULL,
         display_name                    VARCHAR(120) NOT NULL,
         input_price_per_1m_micros       BIGINT       NOT NULL DEFAULT 0,
         cached_input_price_per_1m_micros BIGINT      NOT NULL DEFAULT 0,
         output_price_per_1m_micros      BIGINT       NOT NULL DEFAULT 0,
         reasoning_price_per_1m_micros   BIGINT       NOT NULL DEFAULT 0,
         provider_fee_bps                INT          NOT NULL DEFAULT 0,
         markup_multiplier_x10           INT          NOT NULL DEFAULT 25,
         billing_exchange_rate_paise_usd INT          NOT NULL DEFAULT 10000,
         minimum_credit_charge           BIGINT       NOT NULL DEFAULT 1,
         maximum_output_tokens           INT          NULL,
         enabled                         TINYINT(1)   NOT NULL DEFAULT 1,
         free_plan_allowed               TINYINT(1)   NOT NULL DEFAULT 0,
         starter_plan_allowed            TINYINT(1)   NOT NULL DEFAULT 1,
         pro_plan_allowed                TINYINT(1)   NOT NULL DEFAULT 1,
         business_plan_allowed           TINYINT(1)   NOT NULL DEFAULT 1,
         created_at                      DATETIME(3)  NOT NULL,
         updated_at                      DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_rates_provider_model (provider, model_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // Per-request AI usage. Snapshots the exact rate + markup + exchange rate
      // used, so historical charges never change when the rate card is edited
      // later. request_id is UNIQUE so one AI call can be billed at most once.
      `CREATE TABLE IF NOT EXISTS ai_usage (
         id                              CHAR(36)     NOT NULL,
         request_id                      VARCHAR(191) NOT NULL,
         owner_id                        VARCHAR(64)  NOT NULL,
         provider                        VARCHAR(32)  NOT NULL,
         model                           VARCHAR(120) NOT NULL,
         input_tokens                    BIGINT       NOT NULL DEFAULT 0,
         cached_input_tokens             BIGINT       NOT NULL DEFAULT 0,
         output_tokens                   BIGINT       NOT NULL DEFAULT 0,
         reasoning_tokens                BIGINT       NOT NULL DEFAULT 0,
         provider_cost_usd_micros        BIGINT       NOT NULL DEFAULT 0,
         provider_fee_bps                INT          NOT NULL DEFAULT 0,
         markup_multiplier_x10           INT          NOT NULL DEFAULT 25,
         billing_exchange_rate_paise_usd INT          NOT NULL DEFAULT 10000,
         credits_charged                 BIGINT       NOT NULL DEFAULT 0,
         status                          VARCHAR(24)  NOT NULL DEFAULT 'completed',
         error_code                      VARCHAR(64)  NULL,
         created_at                      DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_ai_usage_request (request_id),
         KEY idx_ai_usage_owner_created (owner_id, created_at),
         KEY idx_ai_usage_model (model),
         CONSTRAINT fk_ai_usage_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // Credit reservations for the RESERVE -> EXECUTE -> RECONCILE flow.
      // request_id is UNIQUE so a retried request reuses its reservation rather
      // than double-reserving. expires_at lets a sweeper release abandoned holds.
      `CREATE TABLE IF NOT EXISTS credit_reservations (
         id               CHAR(36)     NOT NULL,
         owner_id         VARCHAR(64)  NOT NULL,
         request_id       VARCHAR(191) NOT NULL,
         reserved_credits BIGINT       NOT NULL,
         status           VARCHAR(16)  NOT NULL DEFAULT 'RESERVED',
         expires_at       DATETIME(3)  NOT NULL,
         created_at       DATETIME(3)  NOT NULL,
         updated_at       DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_reservations_request (request_id),
         KEY idx_reservations_owner_status (owner_id, status),
         KEY idx_reservations_expires (status, expires_at),
         CONSTRAINT fk_reservations_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      // Coupons and their redemptions. Amounts are integers (percent as bps for
      // percentage coupons, paise for fixed, credits for bonus). Redemptions are
      // a separate table so per-user and total redemption caps are enforceable
      // with a unique key and a count.
      `CREATE TABLE IF NOT EXISTS coupons (
         id                   CHAR(36)     NOT NULL,
         code                 VARCHAR(64)  NOT NULL,
         coupon_type          VARCHAR(24)  NOT NULL,
         percent_bps          INT          NULL,
         fixed_discount_paise BIGINT       NULL,
         bonus_credits        BIGINT       NULL,
         applies_to           VARCHAR(24)  NOT NULL DEFAULT 'all',
         plan_id              CHAR(36)     NULL,
         package_id           CHAR(36)     NULL,
         first_payment_only   TINYINT(1)   NOT NULL DEFAULT 0,
         max_redemptions      INT          NULL,
         per_user_limit       INT          NOT NULL DEFAULT 1,
         redeemed_count       INT          NOT NULL DEFAULT 0,
         starts_at            DATETIME(3)  NULL,
         ends_at              DATETIME(3)  NULL,
         enabled              TINYINT(1)   NOT NULL DEFAULT 1,
         created_at           DATETIME(3)  NOT NULL,
         updated_at           DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_coupons_code (code)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS coupon_redemptions (
         id          CHAR(36)     NOT NULL,
         coupon_id   CHAR(36)     NOT NULL,
         owner_id    VARCHAR(64)  NOT NULL,
         payment_id  CHAR(36)     NULL,
         created_at  DATETIME(3)  NOT NULL,
         PRIMARY KEY (id),
         UNIQUE KEY uq_redemption_coupon_owner (coupon_id, owner_id),
         KEY idx_redemptions_owner (owner_id),
         CONSTRAINT fk_redemptions_coupon
           FOREIGN KEY (coupon_id) REFERENCES coupons (id)
           ON DELETE CASCADE,
         CONSTRAINT fk_redemptions_owner
           FOREIGN KEY (owner_id) REFERENCES owners (id)
           ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    ],
  },
  {
    id: '007_seed_billing_defaults',
    statements: [
      // The four default plans, as ROWS not code. Prices in paise, credits in
      // BIGINT. INSERT IGNORE keyed on the unique `code` makes this idempotent
      // and non-destructive: editing a plan later in the admin UI is never
      // overwritten by a re-run. features/model_access/request_limits are JSON.
      `INSERT IGNORE INTO subscription_plans
         (id, code, display_name, price_paise, billing_cycle, included_credits,
          features, model_access, request_limits, enabled, sort_order, created_at, updated_at)
       VALUES
         (UUID(), 'free', 'Free', 0, 'monthly', 1000,
          JSON_ARRAY('Basic AI models','Limited requests','No API access'),
          JSON_OBJECT('tier','basic'), JSON_OBJECT('perDay',50), 1, 0, NOW(3), NOW(3)),
         (UUID(), 'starter', 'Starter', 29900, 'monthly', 32000,
          JSON_ARRAY('More AI models','Standard request limits','AI usage history','Credit top-ups'),
          JSON_OBJECT('tier','standard'), JSON_OBJECT('perDay',500), 1, 1, NOW(3), NOW(3)),
         (UUID(), 'pro', 'Pro', 79900, 'monthly', 90000,
          JSON_ARRAY('All supported AI models','Higher request limits','Priority processing','API access','Full usage analytics'),
          JSON_OBJECT('tier','all'), JSON_OBJECT('perDay',5000), 1, 2, NOW(3), NOW(3)),
         (UUID(), 'business', 'Business', 199900, 'monthly', 240000,
          JSON_ARRAY('All models','Highest limits','API access','Advanced usage analytics','Priority processing'),
          JSON_OBJECT('tier','all'), JSON_OBJECT('perDay',50000), 1, 3, NOW(3), NOW(3))`,

      // The five default top-up packages. Prices in paise, credits + bonus in
      // BIGINT. The ₹249/₹499/etc. bonus is folded into `credits` per the brief
      // (₹99->10,000; ₹249->25,500; ₹499->52,500; ₹999->110,000; ₹2,499->300,000).
      `INSERT IGNORE INTO credit_packages
         (id, code, display_name, price_paise, credits, bonus_credits, enabled, sort_order, created_at, updated_at)
       VALUES
         (UUID(), 'pack_99',   '10,000 credits',  9900,   10000,  0, 1, 0, NOW(3), NOW(3)),
         (UUID(), 'pack_249',  '25,500 credits',  24900,  25000,  500, 1, 1, NOW(3), NOW(3)),
         (UUID(), 'pack_499',  '52,500 credits',  49900,  50000,  2500, 1, 2, NOW(3), NOW(3)),
         (UUID(), 'pack_999',  '110,000 credits', 99900,  100000, 10000, 1, 3, NOW(3), NOW(3)),
         (UUID(), 'pack_2499', '300,000 credits', 249900, 275000, 25000, 1, 4, NOW(3), NOW(3))`,

      // Starter rate-card rows for the models the app ships with. Prices are
      // micro-USD per 1M tokens (e.g. $0.15/1M -> 150000). markup ×10 = 25 (2.5×);
      // exchange 10000 paise/USD (₹100). OpenRouter carries the 550 bps (5.5%)
      // platform fee; direct providers carry 0. Ollama is local/free (all-zero
      // prices -> 0 provider cost -> minimum_credit_charge floor of 0). Admin can
      // edit any of these later; a re-run never overwrites an edited row.
      `INSERT IGNORE INTO ai_model_rates
         (id, provider, model_id, display_name,
          input_price_per_1m_micros, cached_input_price_per_1m_micros,
          output_price_per_1m_micros, reasoning_price_per_1m_micros,
          provider_fee_bps, markup_multiplier_x10, billing_exchange_rate_paise_usd,
          minimum_credit_charge, maximum_output_tokens, enabled,
          free_plan_allowed, starter_plan_allowed, pro_plan_allowed, business_plan_allowed,
          created_at, updated_at)
       VALUES
         (UUID(), 'openrouter', 'openai/gpt-oss-120b', 'GPT OSS 120B',
          100000, 0, 300000, 0, 550, 25, 10000, 1, 8192, 1, 0, 1, 1, 1, NOW(3), NOW(3)),
         (UUID(), 'gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash',
          75000, 0, 300000, 0, 0, 25, 10000, 1, 8192, 1, 1, 1, 1, 1, NOW(3), NOW(3)),
         (UUID(), 'openai', 'gpt-4o-mini', 'GPT-4o mini',
          150000, 75000, 600000, 0, 0, 25, 10000, 1, 8192, 1, 0, 1, 1, 1, NOW(3), NOW(3)),
         (UUID(), 'ollama', 'deepseek-r1:8b', 'DeepSeek R1 8B (local)',
          0, 0, 0, 0, 0, 25, 10000, 0, 8192, 1, 1, 1, 1, 1, NOW(3), NOW(3))`,
    ],
  },
];

/** Ensure the bookkeeping table exists before anything else. */
async function ensureMigrationsTable(connection) {
  await connection.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         VARCHAR(191) NOT NULL,
       applied_at DATETIME(3)  NOT NULL,
       PRIMARY KEY (id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  );
}

/**
 * Apply any migrations that have not run yet.
 * @returns the ids that were applied during this call.
 */
export async function runMigrations() {
  const pool = getPool();
  await ensureMigrationsTable(pool);

  const [appliedRows] = await pool.query('SELECT id FROM schema_migrations');
  const applied = new Set(appliedRows.map((row) => row.id));
  const justApplied = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    // DDL in MySQL is not transactional, so each migration is recorded
    // immediately after its statements succeed. Statements are written to be
    // idempotent (IF NOT EXISTS) so a partial failure can be retried safely.
    for (const statement of migration.statements) {
      await pool.query(statement);
    }
    await pool.query('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
      migration.id,
      new Date(),
    ]);

    justApplied.push(migration.id);
    logger.info({ migration: migration.id }, 'applied database migration');
  }

  return justApplied;
}

/**
 * One-time import of the legacy `server/data/workflows.json` file.
 *
 * The old store was a single JSON array keyed by name, rewritten in full on every
 * save. Rows are inserted with `INSERT IGNORE` so re-running this never clobbers
 * anything already in the database, and the source file is left untouched so the
 * operator can verify before deleting it.
 *
 * @returns {Promise<{ imported: number, skipped: number, source: string|null }>}
 */
export async function importLegacyWorkflows({ ownerId, filePath = LEGACY_JSON_PATH } = {}) {
  if (!ownerId) throw new Error('importLegacyWorkflows requires an ownerId');

  if (!fs.existsSync(filePath)) {
    return { imported: 0, skipped: 0, source: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.warn({ err, filePath }, 'legacy workflow file is not valid JSON; skipping import');
    return { imported: 0, skipped: 0, source: filePath };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { imported: 0, skipped: 0, source: filePath };
  }

  const pool = getPool();
  await pool.query(
    'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
    [ownerId, new Date()],
  );

  let imported = 0;
  let skipped = 0;

  for (const entry of parsed) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      skipped += 1;
      continue;
    }

    const now = new Date();
    const savedAt = entry.savedAt ? new Date(entry.savedAt) : now;
    const createdAt = Number.isNaN(savedAt.getTime()) ? now : savedAt;

    const [result] = await pool.query(
      `INSERT IGNORE INTO workflows
         (id, owner_id, name, nodes, edges, initial_state, metadata, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        ownerId,
        name.slice(0, 255),
        JSON.stringify(Array.isArray(entry.nodes) ? entry.nodes : []),
        JSON.stringify(Array.isArray(entry.edges) ? entry.edges : []),
        entry.initialState ? JSON.stringify(entry.initialState) : null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        1,
        createdAt,
        createdAt,
      ],
    );

    if (result.affectedRows === 1) imported += 1;
    else skipped += 1;
  }

  if (imported > 0 || skipped > 0) {
    logger.info(
      { imported, skipped, source: filePath },
      'legacy workflow import finished (source file left in place)',
    );
  }

  return { imported, skipped, source: filePath };
}

/** Migration ids, for tests and diagnostics. */
export const MIGRATION_IDS = MIGRATIONS.map((m) => m.id);
