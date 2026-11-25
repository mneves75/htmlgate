WITH clock(now_ms) AS (
  SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
), version_totals AS (
  SELECT COUNT(*) AS version_count,
         COALESCE(SUM(MAX(size + LENGTH(CAST(COALESCE(files, '') AS BLOB)), 20 * 1024)), 0) AS version_bytes
  FROM versions
), trash_totals AS (
  SELECT COUNT(*) AS trash_count,
         COALESCE(SUM(MAX(size, 20 * 1024)), 0) AS trash_bytes,
         COUNT(*) FILTER (WHERE due_at <= now_ms) AS due_trash_count,
         MIN(due_at) FILTER (WHERE due_at <= now_ms) AS oldest_due_trash_at_ms
  FROM trash CROSS JOIN clock
), expired_shares AS (
  SELECT expires_at, deleted_at,
         EXISTS (SELECT 1 FROM versions WHERE versions.slug = shares.slug) AS has_versions
  FROM shares CROSS JOIN clock
  WHERE expires_at <= now_ms
     OR (deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM versions WHERE versions.slug = shares.slug))
), expiry_totals AS (
  SELECT COUNT(*) AS retained_expired_share_count,
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL AND NOT has_versions) AS expired_tombstone_count,
         COUNT(*) FILTER (WHERE has_versions) AS due_expired_share_count,
         MIN(expires_at) FILTER (WHERE has_versions) AS oldest_due_expired_share_at_ms
  FROM expired_shares
)
SELECT now_ms AS measured_at_ms, version_bytes + trash_bytes AS tracked_bytes,
       version_count, version_bytes, trash_count, trash_bytes,
       due_trash_count, oldest_due_trash_at_ms,
       retained_expired_share_count, expired_tombstone_count,
       due_expired_share_count, oldest_due_expired_share_at_ms
FROM clock CROSS JOIN version_totals CROSS JOIN trash_totals CROSS JOIN expiry_totals;
