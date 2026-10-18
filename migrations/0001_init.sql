-- One Author per Instance in 0.1, but every Drop and token records its Author.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,               -- 12 hex characters, shown to the Author
  author TEXT NOT NULL,
  name TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,       -- SHA-256 of the token, hex
  created_at INTEGER NOT NULL,       -- milliseconds since the epoch
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE drops (
  slug TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '{}',   -- JSON object, string to string
  public INTEGER NOT NULL DEFAULT 0,
  latest_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL,          -- token id of the last change of any kind
  changed_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX drops_by_author ON drops (author, deleted_at, updated_at DESC);

CREATE TABLE versions (
  slug TEXT NOT NULL,
  n INTEGER NOT NULL,
  body TEXT NOT NULL,
  size INTEGER NOT NULL,             -- bytes of UTF-8
  created_at INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  PRIMARY KEY (slug, n)
);
