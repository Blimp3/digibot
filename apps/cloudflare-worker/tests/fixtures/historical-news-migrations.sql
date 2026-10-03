-- Minimal stand-in for tables that the retired 0003-0007 migrations left in
-- the same D1 database. Migration 0008 and later must leave them untouched.
PRAGMA foreign_keys = ON;

CREATE TABLE news_sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE news_outbox (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES news_sources(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_news_outbox_pending ON news_outbox(state, created_at);
