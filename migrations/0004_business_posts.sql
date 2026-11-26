-- Add business_posts table for business updates/posts
CREATE TABLE IF NOT EXISTS business_posts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_posts_biz_created ON business_posts(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_posts_user ON business_posts(user_id);
