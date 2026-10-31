Simulated latency per call: 20 ms. Table sizes: shares 44, versions 48, tokens 1, trash 0, share_views 180.

| route | status | D1 waves (critical) | D1 calls (critical) | R2 waves (critical) | background calls |
|---|---|---|---|---|---|
| GET / (Author home) | 200 | 2 | 2 | 0 | 0 |
| GET / (Viewer) | 200 | 0 | 0 | 0 | 0 |
| GET /metrics | 200 | 2 | 2 | 0 | 0 |
| GET /tokens | 200 | 1 | 1 | 0 | 0 |
| GET /s/<slug> (Gated page) | 200 | 1 | 1 | 0 | 1 |
| GET /s/<slug>/raw (Gated body) | 200 | 1 | 1 | 1 | 0 |
| GET /p/<slug> (Public page) | 200 | 1 | 1 | 0 | 1 |
| GET /p/<slug>/raw (Public body) | 200 | 1 | 1 | 1 | 0 |
| GET /p/<missing> (not found) | 404 | 1 | 1 | 0 | 0 |
| GET /api/shares (list) | 200 | 4 | 4 | 0 | 0 |
| GET /api/shares/<slug> | 200 | 3 | 3 | 0 | 0 |
| GET /api/shares/<slug>/versions | 200 | 4 | 4 | 0 | 0 |
| POST /api/shares (publish html) | 201 | 5 | 5 | 1 | 1 |
| PUT /api/shares/<slug> (new Version) | 200 | 6 | 6 | 1 | 1 |
| PATCH /api/shares/<slug> | 200 | 5 | 5 | 0 | 1 |
| POST /api/shares/<slug>/visibility | 200 | 5 | 5 | 0 | 1 |

| statement | plan |
|---|---|
| `SELECT d.slug, d.title, d.public, d.latest_version, d.updated_at, t.name AS changed_by_name, (SELECT COUNT(*) FROM shares WHERE author = ?1 AND deleted_at IS NU…` | SEARCH d USING INDEX shares_by_author (author=? AND deleted_at=?); SEARCH t USING INDEX sqlite_autoindex_tokens_1 (id=?) LEFT-JOIN; SCALAR SUBQUERY 1; SEARCH shares USING INDEX shares_by_author (author=? AND deleted_at=?); SCALAR SUBQUERY 2; SEARCH shares USING INDEX shares_by_author (author=? AND deleted_at=?); USE TEMP B-TREE FOR LAST TERM OF ORDER BY |
| `SELECT slug, SUM(views) AS total, SUM(CASE WHEN day >= ? THEN views ELSE 0 END) AS recent FROM share_views GROUP BY slug` | SCAN share_views |
| `SELECT id, name, created_at, last_used_at, revoked_at FROM tokens WHERE author = ? ORDER BY created_at DESC, id` | SCAN tokens; USE TEMP B-TREE FOR ORDER BY |
| `SELECT d.slug, d.title, d.description, d.public, d.latest_version, d.updated_at, d.expires_at, v.n, v.kind FROM shares d JOIN versions v ON v.slug = d.slug WHER…` | SEARCH d USING INDEX sqlite_autoindex_shares_1 (slug=?); SEARCH v USING INDEX sqlite_autoindex_versions_2 (slug=?) |
| `INSERT INTO share_views (slug, day, views) SELECT ?1, ?2, 1 WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?1 AND deleted_at IS NULL AND (expires_at IS NULL OR…` | SEARCH shares EXISTS USING INDEX sqlite_autoindex_shares_1 (slug=?) |
| `SELECT v.n, v.kind, v.body_key FROM shares d JOIN versions v ON v.slug = d.slug AND v.n = COALESCE(?, d.latest_version) WHERE d.slug = ? AND d.author = ? AND d.…` | SEARCH d USING INDEX sqlite_autoindex_shares_1 (slug=?); SEARCH v USING INDEX sqlite_autoindex_versions_2 (slug=? AND n=?) |
| `SELECT d.slug, d.title, d.description, d.public, d.latest_version, d.updated_at, d.expires_at, v.n, v.kind FROM shares d JOIN versions v ON v.slug = d.slug WHER…` | SEARCH d USING INDEX sqlite_autoindex_shares_1 (slug=?); SEARCH v USING INDEX sqlite_autoindex_versions_2 (slug=?) |
| `SELECT v.n, v.kind, v.body_key FROM shares d JOIN versions v ON v.slug = d.slug AND v.n = COALESCE(?, d.latest_version) WHERE d.slug = ? AND d.author = ? AND d.…` | SEARCH d USING INDEX sqlite_autoindex_shares_1 (slug=?); SEARCH v USING INDEX sqlite_autoindex_versions_2 (slug=? AND n=?) |
| `SELECT id, author, name FROM tokens WHERE digest = ? AND revoked_at IS NULL` | SEARCH tokens USING INDEX sqlite_autoindex_tokens_2 (digest=?) |
| `UPDATE tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)` | SEARCH tokens USING INDEX sqlite_autoindex_tokens_1 (id=?) |
| `SELECT COUNT(*) AS n FROM shares d WHERE d.author = ? AND d.deleted_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > CAST(unixepoch('subsec') * 1000 AS IN…` | SEARCH d USING INDEX shares_by_author (author=? AND deleted_at=?) |
| `SELECT d.slug, d.author, d.title, d.description, d.tags, d.public, d.latest_version, d.created_at, d.updated_at, d.changed_by, t.name AS changed_by_name, d.chan…` | SEARCH d USING INDEX shares_by_author (author=? AND deleted_at=?); SEARCH t USING INDEX sqlite_autoindex_tokens_1 (id=?) LEFT-JOIN; USE TEMP B-TREE FOR LAST TERM OF ORDER BY |
| `SELECT d.slug, d.author, d.title, d.description, d.tags, d.public, d.latest_version, d.created_at, d.updated_at, d.changed_by, t.name AS changed_by_name, d.chan…` | SEARCH d USING INDEX sqlite_autoindex_shares_1 (slug=?); SEARCH t USING INDEX sqlite_autoindex_tokens_1 (id=?) LEFT-JOIN |
| `SELECT v.n, v.kind, v.size, v.created_at, v.token_id, t.name AS token_name FROM versions v JOIN shares d ON d.slug = v.slug AND d.deleted_at IS NULL AND (d.expi…` | SEARCH d USING INDEX sqlite_autoindex_shares_1 (slug=?); SEARCH v USING INDEX sqlite_autoindex_versions_2 (slug=?); SEARCH t USING INDEX sqlite_autoindex_tokens_1 (id=?) LEFT-JOIN |
| `INSERT INTO trash (body_key, size, due_at) SELECT ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? WHERE (SELECT COALESCE(SUM(size), 0) FROM versions) + (S…` | SCAN CONSTANT ROW; SCALAR SUBQUERY 1; SCAN versions; SCALAR SUBQUERY 2; SCAN trash |
| `INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files) SELECT ?, 1, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM trash WHERE body_key…` | SEARCH trash EXISTS USING INDEX sqlite_autoindex_trash_1 (body_key=?) |
| `INSERT INTO shares (slug, author, title, description, tags, public, latest_version, created_at, updated_at, changed_by, changed_at, expires_at, expiry_set) SELE…` | SEARCH versions EXISTS USING COVERING INDEX sqlite_autoindex_versions_1 (body_key=?) |
| `DELETE FROM trash WHERE body_key = ? AND EXISTS (SELECT 1 FROM versions WHERE body_key = ?)` | SEARCH trash USING INDEX sqlite_autoindex_trash_1 (body_key=?); SCALAR SUBQUERY 1; SEARCH versions USING COVERING INDEX sqlite_autoindex_versions_1 (body_key=?) |
| `SELECT body_key, due_at FROM trash WHERE due_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER) ORDER BY due_at LIMIT ?` | SCAN trash; USE TEMP B-TREE FOR ORDER BY |
| `INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files) SELECT slug, latest_version + 1, ?, ?, ?, ?, ?, ? FROM shares WHERE slug = ? A…` | SEARCH shares USING INDEX sqlite_autoindex_shares_1 (slug=?); SEARCH trash EXISTS USING INDEX sqlite_autoindex_trash_1 (body_key=?) |
| `UPDATE shares SET latest_version = latest_version + 1, title = COALESCE(?, title), description = CASE WHEN ? = 1 THEN ? ELSE description END, tags = COALESCE(?,…` | SEARCH shares USING INDEX sqlite_autoindex_shares_1 (slug=?); SCALAR SUBQUERY 1; SEARCH versions USING COVERING INDEX sqlite_autoindex_versions_1 (body_key=?) |
| `INSERT INTO trash (body_key, size, due_at) SELECT body_key, size, ? FROM versions WHERE slug = ? AND n <= (SELECT latest_version FROM shares WHERE slug = ?) - 2…` | SEARCH versions USING INDEX sqlite_autoindex_versions_2 (slug=? AND n<?); SCALAR SUBQUERY 1; SEARCH shares USING INDEX sqlite_autoindex_shares_1 (slug=?) |
| `DELETE FROM versions WHERE slug = ? AND n <= (SELECT latest_version FROM shares WHERE slug = ?) - 20` | SEARCH versions USING COVERING INDEX sqlite_autoindex_versions_2 (slug=? AND n<?); SCALAR SUBQUERY 1; SEARCH shares USING INDEX sqlite_autoindex_shares_1 (slug=?) |
| `UPDATE shares SET title = COALESCE(?, title), description = CASE WHEN ? = 1 THEN ? ELSE description END, tags = COALESCE(?, tags), expires_at = CASE WHEN ? = 1 …` | SEARCH shares USING INDEX sqlite_autoindex_shares_1 (slug=?) |
| `UPDATE shares SET public = ?, changed_by = ?, changed_at = ? WHERE slug = ? AND author = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > CAST(u…` | SEARCH shares USING INDEX sqlite_autoindex_shares_1 (slug=?) |
