-- Ask the Manual: database schema
CREATE EXTENSION IF NOT EXISTS vector;

-- A company using the service
CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- People who log in; each belongs to one company
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Login sessions (the cookie holds the session id)
CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);

-- One uploaded PDF
CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  file_hash   text NOT NULL,                       -- skip duplicate uploads
  page_count  int,
  status      text NOT NULL DEFAULT 'queued',      -- queued | processing | ready | failed
  progress    text,                                -- e.g. 'page 12/93'
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, file_hash)                    -- same file twice in one company = skip
);

-- Searchable pieces of a document
CREATE TABLE IF NOT EXISTS chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_start   int NOT NULL,                       -- PDF page number (counted from 1)
  page_end     int NOT NULL,
  chunk_type   text NOT NULL,                      -- text | table | figure
  section      text,                               -- heading the chunk belongs to
  language     text,                               -- en | nl | fr
  source       text NOT NULL,                      -- docling | ocr | vision
  content      text NOT NULL,
  embedding    vector(1024),                       -- BGE-M3 has 1024 dimensions
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

-- A chat thread (one technician, one topic)
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Each question and each answer
CREATE TABLE IF NOT EXISTS messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL,
  content          text NOT NULL,
  citations        jsonb,
  abstained        boolean,
  latency_ms       int,
  input_tokens     int,
  output_tokens    int,
  cost_usd         numeric(10,6),
  feedback         smallint,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Indexes: make searches fast
CREATE INDEX IF NOT EXISTS chunks_tenant_idx    ON chunks (tenant_id);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx       ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS documents_tenant_idx ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);