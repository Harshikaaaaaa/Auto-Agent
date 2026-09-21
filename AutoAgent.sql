-- AutoAgent database export
--
-- Schema for all tables + seed/reference data (subscription plans, credit
-- packages, the AI rate card, and the applied-migrations bookkeeping).
-- Contains NO user, payment, credential, wallet, or settings data.
--
-- Load into a fresh MySQL to bootstrap the app:
--   mysql -u root -p < AutoAgent.sql
--
-- The app also creates this exact schema automatically on boot when
-- DB_AUTO_MIGRATE=true (see server/db/migrations.js); this file is provided
-- for a manual/seed setup or inspection.

CREATE DATABASE IF NOT EXISTS `autoagent` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */;
USE `autoagent`;


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
DROP TABLE IF EXISTS `ai_model_rates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_model_rates` (
  `id` char(36) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `model_id` varchar(120) NOT NULL,
  `display_name` varchar(120) NOT NULL,
  `input_price_per_1m_micros` bigint NOT NULL DEFAULT '0',
  `cached_input_price_per_1m_micros` bigint NOT NULL DEFAULT '0',
  `output_price_per_1m_micros` bigint NOT NULL DEFAULT '0',
  `reasoning_price_per_1m_micros` bigint NOT NULL DEFAULT '0',
  `provider_fee_bps` int NOT NULL DEFAULT '0',
  `markup_multiplier_x10` int NOT NULL DEFAULT '25',
  `billing_exchange_rate_paise_usd` int NOT NULL DEFAULT '10000',
  `minimum_credit_charge` bigint NOT NULL DEFAULT '1',
  `maximum_output_tokens` int DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `free_plan_allowed` tinyint(1) NOT NULL DEFAULT '0',
  `starter_plan_allowed` tinyint(1) NOT NULL DEFAULT '1',
  `pro_plan_allowed` tinyint(1) NOT NULL DEFAULT '1',
  `business_plan_allowed` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rates_provider_model` (`provider`,`model_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ai_usage`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_usage` (
  `id` char(36) NOT NULL,
  `request_id` varchar(191) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `model` varchar(120) NOT NULL,
  `input_tokens` bigint NOT NULL DEFAULT '0',
  `cached_input_tokens` bigint NOT NULL DEFAULT '0',
  `output_tokens` bigint NOT NULL DEFAULT '0',
  `reasoning_tokens` bigint NOT NULL DEFAULT '0',
  `provider_cost_usd_micros` bigint NOT NULL DEFAULT '0',
  `provider_fee_bps` int NOT NULL DEFAULT '0',
  `markup_multiplier_x10` int NOT NULL DEFAULT '25',
  `billing_exchange_rate_paise_usd` int NOT NULL DEFAULT '10000',
  `credits_charged` bigint NOT NULL DEFAULT '0',
  `status` varchar(24) NOT NULL DEFAULT 'completed',
  `error_code` varchar(64) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_usage_request` (`request_id`),
  KEY `idx_ai_usage_owner_created` (`owner_id`,`created_at`),
  KEY `idx_ai_usage_model` (`model`),
  CONSTRAINT `fk_ai_usage_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `app_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_settings` (
  `setting_key` varchar(64) NOT NULL,
  `value_enc` text NOT NULL,
  `updated_by` varchar(64) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `coupon_redemptions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `coupon_redemptions` (
  `id` char(36) NOT NULL,
  `coupon_id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `payment_id` char(36) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_redemption_coupon_owner` (`coupon_id`,`owner_id`),
  KEY `idx_redemptions_owner` (`owner_id`),
  CONSTRAINT `fk_redemptions_coupon` FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_redemptions_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `coupons`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `coupons` (
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `coupon_type` varchar(24) NOT NULL,
  `percent_bps` int DEFAULT NULL,
  `fixed_discount_paise` bigint DEFAULT NULL,
  `bonus_credits` bigint DEFAULT NULL,
  `applies_to` varchar(24) NOT NULL DEFAULT 'all',
  `plan_id` char(36) DEFAULT NULL,
  `package_id` char(36) DEFAULT NULL,
  `first_payment_only` tinyint(1) NOT NULL DEFAULT '0',
  `max_redemptions` int DEFAULT NULL,
  `per_user_limit` int NOT NULL DEFAULT '1',
  `redeemed_count` int NOT NULL DEFAULT '0',
  `starts_at` datetime(3) DEFAULT NULL,
  `ends_at` datetime(3) DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coupons_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `credit_packages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `credit_packages` (
  `id` char(36) NOT NULL,
  `code` varchar(40) NOT NULL,
  `display_name` varchar(120) NOT NULL,
  `price_paise` bigint NOT NULL,
  `credits` bigint NOT NULL,
  `bonus_credits` bigint NOT NULL DEFAULT '0',
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `expires_days` int DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_packages_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `credit_reservations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `credit_reservations` (
  `id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `request_id` varchar(191) NOT NULL,
  `reserved_credits` bigint NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'RESERVED',
  `expires_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reservations_request` (`request_id`),
  KEY `idx_reservations_owner_status` (`owner_id`,`status`),
  KEY `idx_reservations_expires` (`status`,`expires_at`),
  CONSTRAINT `fk_reservations_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `credit_transactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `credit_transactions` (
  `id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `transaction_type` varchar(32) NOT NULL,
  `credits` bigint NOT NULL,
  `balance_before` bigint NOT NULL,
  `balance_after` bigint NOT NULL,
  `subscription_credits_change` bigint NOT NULL DEFAULT '0',
  `purchased_credits_change` bigint NOT NULL DEFAULT '0',
  `bonus_credits_change` bigint NOT NULL DEFAULT '0',
  `provider` varchar(32) DEFAULT NULL,
  `model` varchar(120) DEFAULT NULL,
  `input_tokens` bigint DEFAULT NULL,
  `cached_input_tokens` bigint DEFAULT NULL,
  `output_tokens` bigint DEFAULT NULL,
  `reasoning_tokens` bigint DEFAULT NULL,
  `provider_cost_usd_micros` bigint DEFAULT NULL,
  `customer_cost_credits` bigint DEFAULT NULL,
  `ai_request_id` varchar(191) DEFAULT NULL,
  `payment_id` char(36) DEFAULT NULL,
  `subscription_id` char(36) DEFAULT NULL,
  `description` varchar(500) DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_credit_tx_owner_created` (`owner_id`,`created_at`),
  KEY `idx_credit_tx_type` (`transaction_type`),
  CONSTRAINT `fk_credit_tx_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `credit_wallets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `credit_wallets` (
  `owner_id` varchar(64) NOT NULL,
  `subscription_credits` bigint NOT NULL DEFAULT '0',
  `bonus_credits` bigint NOT NULL DEFAULT '0',
  `purchased_credits` bigint NOT NULL DEFAULT '0',
  `used_this_month` bigint NOT NULL DEFAULT '0',
  `lifetime_used` bigint NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`owner_id`),
  CONSTRAINT `fk_credit_wallets_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `owners`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `owners` (
  `id` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `payments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payments` (
  `id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `payment_gateway` varchar(32) NOT NULL,
  `gateway_order_id` varchar(191) DEFAULT NULL,
  `gateway_payment_id` varchar(191) DEFAULT NULL,
  `type` varchar(16) NOT NULL,
  `amount_paise` bigint NOT NULL,
  `currency` varchar(8) NOT NULL DEFAULT 'INR',
  `credits_purchased` bigint DEFAULT NULL,
  `subscription_plan_id` char(36) DEFAULT NULL,
  `package_id` char(36) DEFAULT NULL,
  `coupon_id` char(36) DEFAULT NULL,
  `status` varchar(24) NOT NULL DEFAULT 'PENDING',
  `failure_reason` varchar(500) DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `paid_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_gateway_payment` (`gateway_payment_id`),
  KEY `idx_payments_owner_created` (`owner_id`,`created_at`),
  KEY `idx_payments_order` (`gateway_order_id`),
  CONSTRAINT `fk_payments_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `schema_migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_migrations` (
  `id` varchar(191) NOT NULL,
  `applied_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `subscription_plans`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `subscription_plans` (
  `id` char(36) NOT NULL,
  `code` varchar(40) NOT NULL,
  `display_name` varchar(120) NOT NULL,
  `price_paise` bigint NOT NULL DEFAULT '0',
  `billing_cycle` varchar(16) NOT NULL DEFAULT 'monthly',
  `included_credits` bigint NOT NULL DEFAULT '0',
  `features` json DEFAULT NULL,
  `model_access` json DEFAULT NULL,
  `request_limits` json DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_plans_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `subscriptions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `subscriptions` (
  `id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `plan_id` char(36) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `billing_cycle` varchar(16) NOT NULL DEFAULT 'monthly',
  `price_paise` bigint NOT NULL DEFAULT '0',
  `included_credits` bigint NOT NULL DEFAULT '0',
  `gateway_subscription_id` varchar(191) DEFAULT NULL,
  `current_period_start` datetime(3) DEFAULT NULL,
  `current_period_end` datetime(3) DEFAULT NULL,
  `next_billing_at` datetime(3) DEFAULT NULL,
  `cancel_at_period_end` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_subscriptions_owner` (`owner_id`,`created_at`),
  KEY `fk_subscriptions_plan` (`plan_id`),
  CONSTRAINT `fk_subscriptions_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_subscriptions_plan` FOREIGN KEY (`plan_id`) REFERENCES `subscription_plans` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tool_credentials`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tool_credentials` (
  `owner_id` varchar(64) NOT NULL,
  `tool_id` varchar(64) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `access_token_enc` text NOT NULL,
  `refresh_token_enc` text,
  `expires_at` datetime(3) DEFAULT NULL,
  `scopes` json NOT NULL,
  `connected_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`owner_id`,`tool_id`),
  CONSTRAINT `fk_tool_credentials_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password_hash` text NOT NULL,
  `role` varchar(16) NOT NULL DEFAULT 'user',
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `email_verified` tinyint(1) NOT NULL DEFAULT '0',
  `email_verification_token` varchar(128) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_owner` (`owner_id`),
  KEY `idx_users_role` (`role`),
  CONSTRAINT `fk_users_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `workflow_runs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `workflow_runs` (
  `id` char(36) NOT NULL,
  `workflow_id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `workflow_name` varchar(255) NOT NULL,
  `status` varchar(20) NOT NULL,
  `provider` varchar(120) DEFAULT NULL,
  `model` varchar(120) DEFAULT NULL,
  `duration_ms` int unsigned DEFAULT NULL,
  `node_count` int unsigned DEFAULT NULL,
  `failure_count` int unsigned DEFAULT NULL,
  `failure_kind` varchar(40) DEFAULT NULL,
  `error` varchar(500) DEFAULT NULL,
  `started_at` datetime(3) DEFAULT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_workflow_runs_workflow` (`workflow_id`,`created_at`),
  KEY `idx_workflow_runs_owner` (`owner_id`,`created_at`),
  CONSTRAINT `fk_workflow_runs_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `workflows`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `workflows` (
  `id` char(36) NOT NULL,
  `owner_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `nodes` json NOT NULL,
  `edges` json NOT NULL,
  `initial_state` json DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `version` int unsigned NOT NULL DEFAULT '1',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_workflows_owner_name` (`owner_id`,`name`),
  KEY `idx_workflows_owner_updated` (`owner_id`,`updated_at`),
  CONSTRAINT `fk_workflows_owner` FOREIGN KEY (`owner_id`) REFERENCES `owners` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;


-- ============================================================
-- Seed / reference data (safe to ship): plans, packages, rates,
-- and the applied-migrations bookkeeping. No user, payment,
-- credential, or settings data is included.
-- ============================================================


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

LOCK TABLES `subscription_plans` WRITE;
/*!40000 ALTER TABLE `subscription_plans` DISABLE KEYS */;
INSERT INTO `subscription_plans` VALUES ('2e68bb68-b556-11f1-9741-4ee37b987cb8','free','Free',0,'monthly',1000,'[\"Basic AI models\", \"Limited requests\", \"No API access\"]','{\"tier\": \"basic\"}','{\"perDay\": 50}',1,0,'2026-09-21 00:48:37.562','2026-09-21 00:48:37.562'),('2e68be3d-b556-11f1-9741-4ee37b987cb8','starter','Starter',29900,'monthly',32000,'[\"More AI models\", \"Standard request limits\", \"AI usage history\", \"Credit top-ups\"]','{\"tier\": \"standard\"}','{\"perDay\": 500}',1,1,'2026-09-21 00:48:37.562','2026-09-21 00:48:37.562'),('2e68bf1e-b556-11f1-9741-4ee37b987cb8','pro','Pro',79900,'monthly',90000,'[\"All supported AI models\", \"Higher request limits\", \"Priority processing\", \"API access\", \"Full usage analytics\"]','{\"tier\": \"all\"}','{\"perDay\": 5000}',1,2,'2026-09-21 00:48:37.562','2026-09-21 00:48:37.562'),('2e68bf9e-b556-11f1-9741-4ee37b987cb8','business','Business',199900,'monthly',240000,'[\"All models\", \"Highest limits\", \"API access\", \"Advanced usage analytics\", \"Priority processing\"]','{\"tier\": \"all\"}','{\"perDay\": 50000}',1,3,'2026-09-21 00:48:37.562','2026-09-21 00:48:37.562');
/*!40000 ALTER TABLE `subscription_plans` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `credit_packages` WRITE;
/*!40000 ALTER TABLE `credit_packages` DISABLE KEYS */;
INSERT INTO `credit_packages` VALUES ('2e68fde4-b556-11f1-9741-4ee37b987cb8','pack_99','10,000 credits',9900,10000,0,1,NULL,0,'2026-09-21 00:48:37.564','2026-09-21 00:48:37.564'),('2e68fea4-b556-11f1-9741-4ee37b987cb8','pack_249','25,500 credits',24900,25000,500,1,NULL,1,'2026-09-21 00:48:37.564','2026-09-21 00:48:37.564'),('2e68ff36-b556-11f1-9741-4ee37b987cb8','pack_499','52,500 credits',49900,50000,2500,1,NULL,2,'2026-09-21 00:48:37.564','2026-09-21 00:48:37.564'),('2e68ff7a-b556-11f1-9741-4ee37b987cb8','pack_999','110,000 credits',99900,100000,10000,1,NULL,3,'2026-09-21 00:48:37.564','2026-09-21 00:48:37.564'),('2e68ffb3-b556-11f1-9741-4ee37b987cb8','pack_2499','300,000 credits',249900,275000,25000,1,NULL,4,'2026-09-21 00:48:37.564','2026-09-21 00:48:37.564');
/*!40000 ALTER TABLE `credit_packages` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `ai_model_rates` WRITE;
/*!40000 ALTER TABLE `ai_model_rates` DISABLE KEYS */;
INSERT INTO `ai_model_rates` VALUES ('2e692a07-b556-11f1-9741-4ee37b987cb8','openrouter','openai/gpt-oss-120b','GPT OSS 120B',100000,0,300000,0,550,25,10000,1,8192,1,0,1,1,1,'2026-09-21 00:48:37.565','2026-09-21 00:48:37.565'),('2e692b11-b556-11f1-9741-4ee37b987cb8','gemini','gemini-3.5-flash','Gemini 3.5 Flash',75000,0,300000,0,0,25,10000,1,8192,1,1,1,1,1,'2026-09-21 00:48:37.565','2026-09-21 00:48:37.565'),('2e692bca-b556-11f1-9741-4ee37b987cb8','openai','gpt-4o-mini','GPT-4o mini',150000,75000,600000,0,0,25,10000,1,8192,1,0,1,1,1,'2026-09-21 00:48:37.565','2026-09-21 00:48:37.565'),('2e692c27-b556-11f1-9741-4ee37b987cb8','ollama','deepseek-r1:8b','DeepSeek R1 8B (local)',0,0,0,0,0,25,10000,0,8192,1,1,1,1,1,'2026-09-21 00:48:37.565','2026-09-21 00:48:37.565');
/*!40000 ALTER TABLE `ai_model_rates` ENABLE KEYS */;
UNLOCK TABLES;

LOCK TABLES `schema_migrations` WRITE;
/*!40000 ALTER TABLE `schema_migrations` DISABLE KEYS */;
INSERT INTO `schema_migrations` VALUES ('001_create_owners','2026-09-18 05:18:45.327'),('002_create_workflows','2026-09-18 05:18:45.336'),('003_create_tool_credentials','2026-09-18 05:18:45.343'),('004_create_workflow_runs','2026-09-18 05:18:45.352'),('005_create_users','2026-09-21 00:48:37.479'),('006_create_billing','2026-09-21 00:48:37.560'),('007_seed_billing_defaults','2026-09-21 00:48:37.566'),('008_create_app_settings','2026-09-21 15:21:48.669');
/*!40000 ALTER TABLE `schema_migrations` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

