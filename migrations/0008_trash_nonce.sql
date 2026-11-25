-- Per-write nonce on trash rows so concurrent emptyTrash() workers can never delete a fresher
-- re-ledgered row from Store.dueNow() even in the same millisecond or under clock skew.
ALTER TABLE trash ADD COLUMN nonce TEXT NOT NULL DEFAULT '';
