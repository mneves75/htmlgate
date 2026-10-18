ALTER TABLE drops RENAME TO shares;
DROP INDEX drops_by_author;
DROP INDEX drops_by_expiry;
CREATE INDEX shares_by_author ON shares (author, deleted_at, updated_at DESC);
CREATE INDEX shares_by_expiry ON shares (expires_at, slug) WHERE expires_at IS NOT NULL;
