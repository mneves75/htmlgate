-- How often a Share's page was opened, one row per Share and UTC day. Server-side counting of a request the browser
-- already sends: no cookie, no script, no visitor, address or identifier, so a count says how often, never by whom.
-- Erasing a Share erases its counts in the same batch; the hourly cleanup drops them with an expired Share's bodies.
CREATE TABLE share_views (
  slug TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (slug, day)
) WITHOUT ROWID;

-- 0.1.5 counted the landing's pages instead; those numbers live in Workers Analytics Engine, not here.
DROP TABLE IF EXISTS metrics_snapshot;
