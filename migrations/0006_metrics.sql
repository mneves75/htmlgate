-- The counted pages of one site, as the last `pnpm run metrics:sync` recorded them. One row, replaced whole:
-- the numbers live in Workers Analytics Engine, which a Worker can write and cannot read, so a sync command reads
-- them and the Instance only renders what was synced. `payload` is a JSON array of {page, views, last_seen}.
CREATE TABLE metrics_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  origin TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
