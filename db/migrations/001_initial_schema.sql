-- 001_initial_schema.sql
-- Core tables for 2ndbrain (spec section 17)
-- Excludes embedding tables (created dynamically when EMBEDDING_PROVIDER is set)

-- 17.1 Conversation & Logging

CREATE TABLE conversation_messages (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id  TEXT,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  metadata    JSONB
);

CREATE TABLE system_logs (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level       TEXT NOT NULL DEFAULT 'info',
  source      TEXT,
  content     TEXT NOT NULL
);

-- 17.2 Attachments

CREATE TABLE attachments (
  id                SERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_id        INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  telegram_file_id  TEXT,
  mime_type         TEXT,
  file_path         TEXT NOT NULL,
  file_size         INTEGER
);

-- 17.3 Knowledge Graph

CREATE TABLE knowledge_nodes (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name        TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE knowledge_edges (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_id   INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  UNIQUE(source_id, target_id, name)
);

-- 17.4 Project Management

CREATE TABLE projects (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name        TEXT NOT NULL
);

CREATE TABLE specifications (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES specifications(id) ON DELETE SET NULL,
  note        TEXT NOT NULL
);

CREATE TABLE issues (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  parent_id   INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  note        TEXT NOT NULL,
  completed   BOOLEAN NOT NULL DEFAULT FALSE
);

-- 17.5 Journal

CREATE TABLE journal (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note        TEXT NOT NULL
);
