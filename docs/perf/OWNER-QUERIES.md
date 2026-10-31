# Queries for the owner to run

This session's Cloudflare login (Wrangler OAuth) has `account (read)` and `workers (write)` only: no Account
Analytics Read, no D1 and no Billing. Each block below is read-only. Paste the output (aggregates only, no
row-level data) into `docs/perf/raw/owner-<name>.json`, or send it back in the conversation.

`<ACCOUNT_ID>`, `<DB_NAME>` and the Worker names come from `.instance/production.json`, which is not on this
checkout. Field names were checked against developers.cloudflare.com on 2026-10-31 (see PLAN.md, Sources).

## 1. Billable Usage, last two billing cycles

Dashboard: Manage Account → Billing → Billable Usage. Note, per product (Workers requests, Workers CPU ms,
D1 rows read, D1 rows written, D1 storage, R2 Class A/B and storage, Workers Logs), the quantity and the
amount for each cycle.

## 2. D1 top queries (7 days)

Needs a token with Account Analytics Read, or the dashboard login:

```sh
pnpm exec wrangler d1 insights <DB_NAME> --time-period=7d --sort-by=reads --limit=20 --json > docs/perf/raw/owner-d1-reads.json
pnpm exec wrangler d1 insights <DB_NAME> --time-period=7d --sort-by=count --limit=20 --json > docs/perf/raw/owner-d1-count.json
pnpm exec wrangler d1 insights <DB_NAME> --time-period=7d --sort-by=time  --limit=20 --json > docs/perf/raw/owner-d1-time.json
pnpm exec wrangler d1 insights <DB_NAME> --time-period=7d --sort-by=writes --limit=20 --json > docs/perf/raw/owner-d1-writes.json
```

`wrangler d1 insights` is experimental. `queryEfficiency` is rows returned / rows read.

Also, read-only, for the database's region and size:

```sh
pnpm exec wrangler d1 info <DB_NAME> --json
```

## 3. Worker invocations, 7 days (GraphQL, https://api.cloudflare.com/client/v4/graphql)

```graphql
query ($accountTag: string, $start: string, $end: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 100
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
        max { cpuTime wallTime }
        dimensions { scriptName status }
      }
    }
  }
}
```

`max { cpuTime wallTime }` was not in the tutorial's example; if the schema refuses it, drop the line and read
the maximum CPU time from the Worker's Metrics tab instead (it is what `limits.cpu_ms` would be set from).

## 4. D1 totals, 7 days (GraphQL)

```graphql
query ($accountTag: string, $start: Date, $end: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
        sum { readQueries writeQueries rowsRead rowsWritten }
        quantiles { queryBatchTimeMsP90 }
        dimensions { date databaseId }
      }
    }
  }
}
```

## 5. Observability volume

Dashboard: Workers & Pages → each Worker (the Instance and `htmlgate-site`) → Observability: events per day for
the last 7 days. Pooled Observability pricing starts on 2026-12-01 (PLAN.md, Sources).

## 6. Web Analytics (RUM)

Dashboard: Analytics & Logs → Web Analytics: is a site configured for htmlgate.com? The landing's CSP
(`default-src 'none'`) would block the beacon script, so RUM by script injection cannot work today without a
CSP change, which is a behaviour change for the owner to decide.
