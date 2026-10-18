-- Expiry (plan 008) and sites (plan 009). Nothing already stored changes meaning: existing Drops get no
-- date, so they never expire until a Publisher sets one, and existing Versions are pages.
ALTER TABLE drops ADD COLUMN expires_at INTEGER;                       -- milliseconds since the epoch; NULL never
ALTER TABLE drops ADD COLUMN expiry_set INTEGER NOT NULL DEFAULT 0;    -- 1 when a Publisher chose the date
-- A Drop already published keeps "never" as if a Publisher had chosen it, so its next publish does not start the default.
UPDATE drops SET expiry_set = 1;
CREATE INDEX drops_by_expiry ON drops (expires_at, slug) WHERE expires_at IS NOT NULL;

ALTER TABLE versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'site'));
-- A site's files: a JSON object from path to [offset, compressed size, size, method] in the Version's zip.
ALTER TABLE versions ADD COLUMN files TEXT;
