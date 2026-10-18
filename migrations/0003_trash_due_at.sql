-- trash.queued_at also marks when an in-flight upload's reservation expires, so it is renamed for what it is in
-- both cases: the time from which the body may be deleted. A rename keeps every row.
ALTER TABLE trash RENAME COLUMN queued_at TO due_at;
