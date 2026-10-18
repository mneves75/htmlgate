-- Drop bodies move to R2 (issue #14, revised 2026-10-06). D1 keeps metadata and the key of each body.
-- The old table is renamed, not dropped, so no stored data is deleted; the Operator may drop it later.
ALTER TABLE versions RENAME TO versions_d1_legacy;

CREATE TABLE versions (
  slug TEXT NOT NULL,
  n INTEGER NOT NULL,
  body_key TEXT NOT NULL UNIQUE,     -- R2 object key, unique per upload and never reused
  size INTEGER NOT NULL,             -- bytes of UTF-8
  created_at INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  PRIMARY KEY (slug, n)
);

-- Bodies whose Versions left the window. Rows are queued in the same transaction that drops the
-- Version, and removed only after the object is deleted, so a failed delete is retried later.
CREATE TABLE trash (
  body_key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  queued_at INTEGER NOT NULL
);
