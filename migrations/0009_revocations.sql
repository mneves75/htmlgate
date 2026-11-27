-- The time of the last revoke-all, on D1's clock. A token can only be minted by an Access sign-in issued after it.
CREATE TABLE IF NOT EXISTS revocations (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL);
