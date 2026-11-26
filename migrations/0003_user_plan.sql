-- Migration 0003: User plan status for Premium-only additional businesses
-- Do not execute automatically; apply to Cloudflare D1 when ready:
--   wrangler d1 execute procinity --remote --file=migrations/0003_user_plan.sql

ALTER TABLE users ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0;
