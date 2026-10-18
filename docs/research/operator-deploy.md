# How can an Operator deploy an Instance in one step?

Research note for ticket #7, feeding decision ticket #15 ("How does an Operator set up, configure and update an Instance?"). It reports options and facts. It does not decide.

**Method.** Documentation, `--help` output and source reading only, on 2026-10-05. Nothing was deployed, no Cloudflare resource was created, no `cf` or `wrangler` command touched an account, and the reference code was not run. Every claim carries its source. Where a claim comes from reading Wrangler, `cf` or API-schema source rather than from a docs page, it says so, because the docs do not promise that behaviour. Source links are pinned to the commit current on 2026-10-05, so they keep working when `main` moves: `workers-sdk@c492d63` and `api-schemas@75c2f4f`. The "last updated" date of each docs page is in the table at the end. All identifiers in examples are placeholders. The sibling note on Access ([access-on-workers-dev](https://github.com/mneves75/htmlgate/blob/research/access-on-workers-dev/docs/research/access-on-workers-dev.md)) is not repeated; Access appears here only as a step a setup path must perform.

## 1. Answer

1. **Deploy to Cloudflare button:** 3 clicks to a running Instance, 2 to 5 more to gate it. It clones the repo into the Operator's GitHub or GitLab, provisions bindings and wires Workers Builds, but needs a public source repo and cannot do Access or a custom domain.
2. **A setup command we ship, run with the Operator's own API token:** 4 Operator steps, plus first-time Zero Trust onboarding and any GitHub OAuth app by hand. It can do everything including Access. It is the only path that can close the pre-gate window by ordering, which rests on the Workers API schema and was not exercised.
3. **Pre-gate window, every path:** a Worker goes live on workers.dev at its first deploy, with public Version URLs, before any Access application exists. Fallbacks that do not depend on the schema: ship `workers_dev = false` and `preview_urls = false`, or create hostname-based Access first with `preview_urls = false`.
4. **Wrangler's `wrangler login` token has no Access scope** (source, not docs). Creating the Access application needs an API token with `Access: Apps and Policies Write`, or `cf auth login`.
5. **Wrangler automatic provisioning is generally available** (4.113.0, 2026-07-21) and later deploys inherit the bindings. Renaming the Worker or a binding creates new, empty resources.
6. **`cf` and `cloudflare.config.ts` are beta** ("can change before the stable release"), beta.1 to beta.12 in a week. The button and Workers Builds read Wrangler config.
7. **Custom domains:** Wrangler touches them only when the config lists at least one, and then replaces the set (client source; server behaviour undocumented). Non-interactive runs such as Workers Builds also override DNS records and other Workers' hostnames. Ship no custom domain in the config.
8. **Updates have no one-click path.** Migrations must be additive, because a Worker rollback does not touch D1 (Time Travel covers 30 days).

## 2. Findings

### 2.1 The Deploy to Cloudflare button

**What it does.** Cloudflare "clones your source repository into the user's GitHub/GitLab account where they can continue development after deploying", lets the user change repo name, Worker name and resource names on one setup page, then "builds the application using Workers Builds and deploys it", provisioning and binding required resources. Source: [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/index.md).

**Clone, not fork. Public source required.** The docs use the word "clone" and never "fork". Whether the new repo is a GitHub fork, a template copy or a detached copy is not stated. The visibility of the created repo is not stated either. Source repositories must be public: "Repositories must be public in order for others to successfully use your Deploy to Cloudflare button". Only github.com and gitlab.com are supported, not self-hosted. Source: same page, "Limitations".

**Bindings it provisions.** Storage: KV, D1, R2, Hyperdrive, Vectorize, Secrets Store secrets. Compute: Durable Objects, Workers AI, Queues. Cloudflare reads the Wrangler configuration of the source repo, creates the resources, and "update[s] the Wrangler configuration where applicable" with the new ids. The source repo must carry default names, ids and other properties for each binding. Source: same page, "Automatic resource provisioning". Note that this list differs from Wrangler's own list (section 2.2); the docs do not explain the difference.

**Variables and secrets.** `vars` come from the Wrangler config. Secrets are declared by name in `.dev.vars.example` or `.env.example`. Both "will be presented to users in the dashboard as they deploy this template, allowing them to configure each value". An optional `cloudflare.bindings.<NAME>.description` in `package.json` supplies help text, with limited Markdown. Sources: same page; [changelog 2025-07-01](https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/). Not stated: whether the example value is prefilled as a default, whether an empty value is refused.

**Migrations and custom deploy commands.** If `package.json` has custom `build` and `deploy` scripts, Cloudflare detects them and pre-fills the build and deploy fields, which the user can edit. With no `deploy` script it uses `npx wrangler deploy`. For D1, the page's example runs `wrangler d1 migrations apply <BINDING> --remote` inside the `deploy` script before `wrangler deploy`, and says to use the binding name so a renamed database still works. Source: same page, "Best practices". The page does not say that resources exist before the build, but the example only works if they do. This is an inference.

**What it cannot do.** The documented resource list has no Access application, no Zero Trust setup and no custom domain. Only Workers applications are supported, not Pages. Monorepos are limited: a URL with a subdirectory must be fully self-contained, and Cloudflare treats the subdirectory as the root of the new repo. Source: same page.

**What the Operator owns afterwards.** A repo in their Git account, a Worker connected to it through Workers Builds (build on push to the production branch, preview builds on other branches), and the provisioned resources. Sources: [button page](https://developers.cloudflare.com/workers/platform/deploy-buttons/index.md); [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/index.md). Workers Builds uses an API token, auto-created with Workers Scripts Edit, Workers KV Edit, Workers R2 Edit, Account Settings Read, Workers Routes Edit on all zones, plus User Details and Memberships Read. "Currently, only user tokens are supported", so builds run as the Operator's own user. Source: [Build configuration, API token](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/index.md). The documented list has **no D1 Edit and no Access permission** (see section 4). The Worker name in the dashboard must match `name` in the config or "the build will fail". Source: Workers Builds page.

**While the source repo is private.** The button does not work for others. The owner's own Instance can be connected to a private repo through Workers Builds' Git integration, whose docs state no visibility rule ([Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/index.md)); that is a different path from the button.

### 2.2 Wrangler automatic resource provisioning

**Status: generally available.** It began as an open beta ([changelog 2025-10-24](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/), Wrangler 4.45.0). Wrangler 4.113.0 (2026-07-21) "dropped the 'Experimental:' prefix ... now that automatic provisioning is generally available" ([Wrangler CHANGELOG, 4.113.0](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/wrangler/CHANGELOG.md); release date from the npm registry record for `wrangler@4.113.0`). The current docs page no longer carries a beta label. Source: [Wrangler configuration, Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/index.md). Current Wrangler is 4.147.0 (2026-10-02).

**Which resources.** KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces and Queues, "when a binding has no id" (or, for R2, no bucket name). Same Wrangler page. Queues, Dispatch Namespaces and Flagship arrived in 4.113.0. Durable Object classes are not in this list; they come from `migrations` or `exports` in the config at deploy time.

**Names.** "Resources will be created with the name of your worker as the prefix" (same page). In source the name is `<worker>-<binding lowercased, underscores to dashes>` ([auto-provisioned-name.ts#L5-L9](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/wrangler/src/deployment-bundle/auto-provisioned-name.ts#L5-L9)). A `database_name` or `bucket_name` in the config is used instead.

**Where the ids live.** On `wrangler deploy`, ids "will be written back to your configuration file". From a dashboard or GitHub deploy, "resource IDs will only be accessible via the dashboard. Currently, these resource IDs will not be written back to your repository" (same page). Source detail: write-back happens only when the deploy is interactive, is skipped in CI, and is skipped for a `.toml` config that contains any `#` comment ([provision-bindings.ts#L1320-L1337](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/deploy/helpers/provision-bindings.ts#L1320-L1337), [patch-config.ts#L23-L27](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/workers-utils/src/config/patch-config.ts#L23-L27)). The project's own message says the ids are optional: "future deploys will continue to work even without IDs".

**Second deploy and other machines.** If the deployed Worker already has the binding, Wrangler inherits it instead of creating anything ([provision-bindings.ts#L109-L116](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/deploy/helpers/provision-bindings.ts#L109-L116), [#L152-L158](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/deploy/helpers/provision-bindings.ts#L152-L158)). It reads the deployed Worker's settings by script name ([#L1350-L1357](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/deploy/helpers/provision-bindings.ts#L1350-L1357)), so a second machine with an id-free config binds to the same resources. The 2025 announcement says the same: "resources will stay linked across future deploys even without adding the resource IDs to the config file", "especially useful for shared templates" (changelog 2025-10-24 above).

**What breaks inheritance (source inference).** Inheritance keys off the Worker name. A renamed Worker, a deleted Worker, or a renamed binding has nothing to inherit, so the next deploy creates a new empty resource. The old one keeps the data but is no longer bound. Remote D1 commands on a binding-only config resolve the database by that same default name ([CHANGELOG 4.102.0, 2026-06-18](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/wrangler/CHANGELOG.md)).

**First-deploy order for D1 (inference).** `d1 migrations apply --remote` looks the database up by name and needs it to exist. On a plain `wrangler deploy` of a fresh account, the database is created inside `deploy`, so migrations must run after the first deploy, or the Operator creates the database first. The button's order differs (section 2.1).

### 2.3 The `cf` CLI and `cloudflare.config.ts`

**Status: beta, with an explicit no-stability statement.** "`cf` is in beta. Commands, configuration, and Build Output can change before the stable release." ([Cloudflare CLI](https://developers.cloudflare.com/cf/index.md); [changelog 2026-09-28](https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/)). The config page repeats it for the file format: "Programmatic configuration with `cloudflare.config.ts` is in open beta. The configuration format can change before the stable release" ([Programmatic configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/index.md)). Release cadence from npm: beta.1 on 2026-09-25, beta.12 on 2026-10-02 (`npm view cf time`); the copy installed here, beta.5, is seven releases behind. The generated `wrangler.config.ts` for some projects "can change during the beta" ([Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/index.md)).

**What `cf deploy` does.** Builds, validates, uploads a Worker Version and deploys it. It "can provision missing resources for bindings that omit resource identifiers. It does not write provisioned identifiers back to `cloudflare.config.ts`." Options include `--secrets-file`, `--prebuilt`, `--dry-run`, `--mode`. Source: [Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/index.md); `cf deploy --help` on the installed beta.5 shows the same options.

**Gaps that matter to a setup path.** `cf` "cannot set a single secret yet" (use Wrangler, or `--secrets-file` on `cf deploy`) and cannot stream logs ([cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/index.md); [Wrangler to cf reference](https://developers.cloudflare.com/cf/wrangler/reference/index.md)). D1 migrations options move from the config to flags on `cf d1 migrations apply`, which takes a database id and applies to the remote database by default ([Migrate a Wrangler project](https://developers.cloudflare.com/cf/wrangler/migrate/index.md)). Loading the config needs Node.js 22.18 or later, and Bun is not supported ([Programmatic configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/index.md)). `cf` does not reuse the Wrangler login ([cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/index.md)).

**Interaction with the button and Workers Builds.** The button page says Cloudflare "will read the Wrangler configuration file of your source repo", so a `cloudflare.config.ts` project is outside the button as documented. The Workers Builds docs show Wrangler deploy commands only; the `cf` docs mention Workers Builds only as a source of the branch name ([Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/index.md)). Running `cf deploy` as a Workers Builds deploy command is not documented. In a Wrangler project, `cf dev`, `cf build` and `cf deploy` are documented as dangerous until `cf migrate` runs: they can rewrite `package.json` and write a new config that ignores the Wrangler one, without asking when there is no terminal ([cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/index.md)).

**One advantage.** Because the file is TypeScript, it "can use imports, functions, environment variables, and asynchronous values" ([Programmatic configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/index.md)), so Operator-specific values such as a custom domain could come from the environment instead of a committed edit. A Wrangler JSON or TOML file cannot.

**Wrangler by comparison.** Wrangler 4.147.0 is the current release line, with a `3.114.17` "legacy" tag still published (`npm view wrangler dist-tags`). The Deploy button, Workers Builds, automatic provisioning, `wrangler rollback` and the D1 tooling are all documented against Wrangler. For an open-source project aimed at strangers, the docs give two facts to weigh: Wrangler carries no beta label for these features, and `cf` carries an explicit may-change label with a release every day or two. The docs do not give a date for `cf` 1.0.

### 2.4 A setup command shipped by the project

**What it could automate with the Operator's own credentials.** Each step below is a public API call or a Wrangler command. Permission names are from each endpoint's `x-api-token-group` in the [OpenAPI schema](https://github.com/cloudflare/api-schemas/blob/75c2f4f7b86541b0f7759fc38d631eef224f785d/openapi.json) and the [permission list](https://developers.cloudflare.com/fundamentals/api/reference/permissions/index.md).

| Step | Call | Token permission |
| --- | --- | --- |
| Register the account's workers.dev subdomain if missing | `PUT /accounts/{id}/workers/subdomain` | Workers Scripts Write |
| Create the Worker object, which returns its immutable `id` | `POST /accounts/{id}/workers/workers` | Workers Scripts Write |
| Create the D1 database | `POST /accounts/{id}/d1/database` | D1 Write |
| Create a KV namespace, if used | `POST /accounts/{id}/storage/kv/namespaces` | Workers KV Storage Write |
| Upload code, set a secret | `PUT /workers/scripts/{name}`, `PUT /workers/scripts/{name}/secrets` (or `wrangler deploy`, `wrangler secret put`) | Workers Scripts Write |
| Run D1 migrations | `wrangler d1 migrations apply` | D1 Write |
| Attach a custom domain | `PUT /accounts/{id}/workers/domains` | Workers Scripts Write (the schema lists no zone permission; see section 4) |
| Create the Access application and Allow policy | `POST /accounts/{id}/access/apps`, `POST /accounts/{id}/access/policies` | Access: Apps and Policies Write |
| First-time Zero Trust organization, identity provider | `POST /accounts/{id}/access/organizations`, `POST /accounts/{id}/access/identity_providers` | Access: Organizations, Identity Providers, and Groups Write |

The Worker `id` answers an open item in the sibling Access note: the `worker_id` an Access `worker` destination needs. The Workers API object has an "Immutable ID of the Worker", a `subdomain.enabled` flag (default false in the schema) and `subdomain.previews_enabled`, and its create request requires only `name` ([openapi.json, `workers_Worker` and `POST /accounts/{account_id}/workers/workers`](https://github.com/cloudflare/api-schemas/blob/75c2f4f7b86541b0f7759fc38d631eef224f785d/openapi.json)). By the schema, a setup command can therefore create the Worker with workers.dev and preview URLs off, create the Access application with that id, then deploy. That the Access docs' `worker_id` is the same id is an inference from the schema, not a doc statement. It was not exercised.

**`wrangler login` against API token.** Wrangler's OAuth default scopes are the 29 entries in [core/scopes.ts](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/workers-auth/src/core/scopes.ts#L7-L52), which Wrangler imports ([wrangler/index.ts#L46-L51](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/workers-auth/src/wrangler/index.ts#L46-L51)). They include `workers:write`, `workers_scripts:write`, `workers_kv:write`, `d1:write`, `zone:read` and `pages:write`, and **no `access:*` scope**. The `cf` login requests a different, much larger list that includes `access:write`, `teams:write`, `dns_records:edit`, `zone:read` and `workers_scripts:write` ([cf/scopes.ts#L18-L19](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/workers-auth/src/cf/scopes.ts#L18-L19), default list at [#L529-L534](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/workers-auth/src/cf/scopes.ts#L529-L534)). Wrangler's flow can request other scopes with `--scopes`, and lists them with `--scopes-list` ([wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/index.md)); whether an Access scope can be added that way is not documented. So: Wrangler's default login cannot create an Access application; an API token can; `cf auth login` can in principle, and its Access scope names are not mapped to API permissions in the docs.

**How the reference scripts fail (examples to avoid).**

1. **`the reference/scripts/setup.mjs` crashes; it does not skip.** `patch()` calls `orig.includes(find)` (`the reference/scripts/setup.mjs:23-30`, the call at `:25`), but it is called with regular expressions (`the reference/scripts/setup.mjs:59-60`). `String.prototype.includes` throws a `TypeError` for a regular expression (checked with a one-line `node -e`, not the reference code), so the script stops after the D1 database and KV namespace were already created (`:35`, `:49`) and before anything is written. The placeholders `REPLACE_WITH_D1_ID` and `REPLACE_WITH_KV_ID` are also absent from `the reference/wrangler.toml` (the file holds real ids at `:40` and `:45` and an `account_id` at `:5`), so a "skip" branch would have been taken anyway. Lesson: a setup command must be idempotent, must not rely on placeholder text, and must not create resources it cannot then record.
2. **Two schema sources.** The script applies `schema.sql` (`:63-65`), while `wrangler.toml:46-49` and `package.json:13-16` use `migrations/`. `schema.sql` already holds the columns the migrations add (`schema.sql:11-12`, `:52` against `migrations/0001-github-oauth.sql:15-16` and `migrations/0002-drop-metadata.sql:14`), and a `schema.sql` database has no `d1_migrations` rows, so a later `migrations apply` replays `ALTER TABLE ... ADD COLUMN` into existing columns. The README documents both (`README.md:93-94`). Lesson: migrations should be the only schema source.
3. **Secret handling.** The pepper is passed through a shell `echo` (`:73`) and printed to the terminal (`:95`). Lesson: pipe secrets by stdin to the API, never print them.
4. **`the reference-cli` Access provisioning can fail open.** The "everyone" rule at `the reference-cli/src/cf/access.ts:53-55` is not reachable through `setup`, because `setup.ts:53-58` calls `provisionAccessApp` only when at least one include flag is set. The real fail-open is `access.ts:44-46`: an `--idp` value becomes `{login_method: {id}}`, which admits anyone who can sign in through that identity provider. With GitHub or one-time PIN that is effectively anyone. A second defect: if any Access application already covers the domain, `access.ts:37-39` returns `created: false` and `setup.ts:66-70` reports "Leaving it untouched", so a weak existing application is never repaired. The CLI targets Cloudflare Pages (`*.pages.dev`), not Workers. Lesson: the allowlist must be required input and a policy must refuse to be created without an `email` or `email_domain` rule.

### 2.5 Where Instance configuration can live

| Place | Survives a redeploy? | Notes |
| --- | --- | --- |
| Wrangler `vars` in the committed config | No: the config wins. "If you change your environment variables in the Cloudflare dashboard, Wrangler will override them the next time you deploy", unless `keep_vars = true` ([Wrangler configuration, Source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/index.md)) | Operator edits collide with upstream merges. The reference keeps its public URL and OAuth client id here (`the reference/wrangler.toml:26,32`). |
| Secrets | Yes: "Wrangler will not delete your secrets ... unless you run `wrangler secret delete`" (same section) | `secrets.required` makes `wrangler deploy` fail when a named secret is missing ([Secrets](https://developers.cloudflare.com/workers/configuration/secrets/index.md)). `--secrets-file` on deploy keeps secrets not in the file. `wrangler secret put` "creates a new version of the Worker and deploys it immediately". |
| A committed config file (`wrangler.jsonc`, `cloudflare.config.ts`) | Replaced by whatever the repo holds | Same as `vars` for Wrangler. `cloudflare.config.ts` can read environment variables at build time. Routes, `workers_dev` and `preview_urls` are config, so they follow it too (sections 2.6, 2.7). |
| A table in the Instance's own D1 database | Yes: a deploy does not touch D1 data | Needs bootstrap and a migration story, and an Operator tool to edit it. Covered by Time Travel. Not visible in the dashboard Variables page. |
| Cloudflare dashboard edits to settings that the config also sets | No, for variables and routes (above) | Docs advise against dashboard changes when using Wrangler. |

Build-time variables set in Workers Builds are visible only to the build, "Build variables will not be accessible at runtime" ([Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/index.md)). Access's team domain and AUD tag are identifiers, not secrets (sibling note).

### 2.6 workers.dev

**Hostname.** `<WORKER_NAME>.<ACCOUNT_SUBDOMAIN>.workers.dev`. "The `name` field in your Worker configuration is used as the subdomain for the deployed Worker." Source: [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/index.md).

**Account subdomain.** One per account, chosen and changed in the dashboard (Workers & Pages, "Change" next to "Your subdomain"). Source: same page. Wrangler can register it through `PUT /accounts/{id}/workers/subdomain` after prompting for a name, but only interactively: the confirmation falls back to "no", so a non-interactive deploy on an account with no subdomain stops with an error ([subdomain.ts#L113-L117](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/subdomain.ts#L113-L117), [#L310-L315](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/subdomain.ts#L310-L315)). What the button does for an account that has none is not documented.

**Worker name.** The Operator can pick it: in `name` (Wrangler config), and on the button's setup page ([button page](https://developers.cloudflare.com/workers/platform/deploy-buttons/index.md)). Limits for workers.dev: 63 characters or fewer, letters, digits and dashes, no leading or trailing dash (workers.dev page). With Workers Builds the dashboard name and the config `name` must match.

**On and off.** In config: `workers_dev = false`; in the dashboard: Settings, Domains & Routes, workers.dev, Disable. Details that matter:

- `workers_dev` "defaults to true when the configuration has no `route` or `routes`, and false otherwise" ([Wrangler configuration, inheritable keys](https://developers.cloudflare.com/workers/wrangler/configuration/index.md); same in source, [triggers/deploy.ts#L609-L610](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/deploy.ts#L609-L610)). Adding a custom domain to the config therefore turns workers.dev off on the next deploy unless `workers_dev = true` is written.
- Disabling it in the dashboard while the config omits the key is undone: "the `workers.dev` route will be re-enabled the next time you deploy" (workers.dev page).
- Disabling workers.dev "does not disable Version URLs, Preview URLs, or Deployment URLs" (workers.dev page). Version URLs have their own switch: `preview_urls` in config or Settings, Domains & Routes, Version URLs. "When enabled, Version URLs are publicly available." If neither is set, they follow `workers_dev` ([Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/index.md); [changelog 2025-10-23](https://developers.cloudflare.com/changelog/post/2025-10-23-preview-url-default-behavior/)). In Wrangler config, "If omitted, Wrangler does not change an existing setting" ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/index.md)).
- Every new version gets its own public Version URL when they are on, including each `wrangler deploy` ([Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/index.md)).
- Cloudflare calls a workers.dev site "intended for personal or hobby projects that aren't business-critical" (workers.dev page).

### 2.7 Custom domains

**Steps.** Needs an active Cloudflare zone and a Worker. In the dashboard: Workers & Pages, the Worker, Settings, Domains & Routes, Add, Custom Domain, enter the hostname, Add. Cloudflare creates the DNS record and an Advanced Certificate. The same can be done in config (`routes` with `custom_domain = true`) or the API. "You cannot create a Custom Domain on a hostname with an existing CNAME DNS record or on a zone you do not own." A www/apex pair needs two entries, because the match is exact. Source: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/index.md).

**Same account?** The Custom Domains page says "active Cloudflare zone" and "a zone you do not own" and never states the account rule outright. The Wrangler docs say the account id must be "the ID of the account associated with the zone/route you provide" ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/index.md)). Both imply the zone sits in the same account as the Worker. Not stated as a rule.

**What a redeploy does.** The docs state one rule: "If you change your routes in the dashboard, Wrangler will override them in the next deploy with the routes you have set in your Wrangler configuration file. To manage routes via the Cloudflare dashboard only, remove any `route` and `routes` keys ... Then add `workers_dev = false`" ([Source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/index.md#source-of-truth); [Deprecations](https://developers.cloudflare.com/workers/wrangler/deprecations/index.md)). The docs do not say what happens to a Custom Domain that is attached but not listed. The behaviour below is from Wrangler source, not from the docs, and server-side semantics are not visible in it:

- Custom domains are touched only if the config lists at least one `custom_domain` route: the publish call is guarded by `customDomainsOnly.length > 0` ([triggers/deploy.ts#L221](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/deploy.ts#L221)). A config with none leaves dashboard-attached domains alone.
- With one or more listed, Wrangler asks the API for a changeset with `replace_state=true`, whose type has a `removed` list ([publish-routes.ts#L38-L43](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/publish-routes.ts#L38-L43), [#L285](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/publish-routes.ts#L285)), then sends the listed domains to `PUT .../domains/records` ([#L384](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/publish-routes.ts#L384)). That matches what the owner saw: a domain not in the list is removed. Neither endpoint is in the public API schema, which has only per-domain `PUT /accounts/{id}/workers/domains` (attach) and `DELETE .../domains/{id}` (detach) ([openapi.json](https://github.com/cloudflare/api-schemas/blob/75c2f4f7b86541b0f7759fc38d631eef224f785d/openapi.json)).
- In a non-interactive run, which includes Workers Builds and CI, Wrangler sets `override_existing_origin` and `override_existing_dns_record` to true without asking ([publish-routes.ts#L345-L347](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/publish-routes.ts#L345-L347)). A hostname held by another Worker, or a conflicting DNS record, is taken over silently. In a terminal it asks first.
- Plain routes (not custom domains) are replaced as a set: "PUT will delete previous routes on this script" ([publish-routes.ts#L108](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/publish-routes.ts#L108)), only when the config lists routes ([triggers/deploy.ts#L197](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/deploy-helpers/src/triggers/deploy.ts#L197)).
- A named environment that does not set `routes` inherits the top-level custom domains and reassigns them to the environment's Worker; Wrangler 4.98.0 added a warning ([CHANGELOG](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/wrangler/CHANGELOG.md)).

**How to avoid losing a domain.**

1. Ship a config with no `custom_domain` route and no `routes`. Operator domains are then attached in the dashboard, with the public API or by the setup command, and no deploy touches them (source inference above). Set `workers_dev` explicitly, because the docs' "dashboard only" recipe says `workers_dev = false`, which also turns workers.dev off.
2. If an Operator wants the domain in config, they must list every domain there, in their own repo, and merge upstream without taking the upstream copy of the routes.
3. Check before and after, as the map's constraint says: the Worker's Domains & Routes page, or the `references.domains` list on the Worker object in the API ([openapi.json, `workers_Worker`](https://github.com/cloudflare/api-schemas/blob/75c2f4f7b86541b0f7759fc38d631eef224f785d/openapi.json)).
4. `cloudflare.config.ts` offers `worker.domains` and the docs' conversion table maps `custom_domain` routes to it ([Wrangler to cf reference](https://developers.cloudflare.com/cf/wrangler/reference/index.md)). Whether `cf deploy` replaces or merges the set is not documented.

A custom domain does not carry the Viewer's workers.dev Access session. Cookies are per hostname and the Access application must cover the new hostname (sibling note, section 2.7). That makes a custom domain a gate decision, not only a DNS one.

### 2.8 Updating a deployed Instance

**Options and how each applies migrations**

| Path | How the Operator takes a release | Migrations |
| --- | --- | --- |
| Re-run the button | The docs describe first-time creation only (clone, configure, build, deploy). Nothing documents it as an update. Likely creates a second repo and Worker; not confirmed. | The button's deploy script would run them on that new Worker. |
| Merge upstream into the button-made repo; Workers Builds deploys | Add an `upstream` remote, merge, push to the production branch. Workers Builds builds and deploys on push ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/index.md)). There is no GitHub "Sync fork", because the docs say clone. Deploy Hooks start a build of the same branch from a URL; they do not pull upstream ([changelog 2026-04-01](https://developers.cloudflare.com/changelog/post/2026-04-01-deploy-hooks/)). | In the repo's `deploy` script before `wrangler deploy` (button page). |
| Re-run a setup command from a new release | `git pull` or `npx <pkg>@<version> setup`, which runs the same idempotent steps. | The command runs `wrangler d1 migrations apply` first, then deploys. |
| A published npm package consumed by a thin Operator project | Bump the version, run the deploy command. | Migrations ship in the package; the command applies them before deploy. |

**How D1 migrations behave.** `wrangler d1 migrations apply` applies the unapplied files in order and records them in the `d1_migrations` table. It asks for confirmation interactively, skips the prompt in CI, and "a backup will be captured" after applying. "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied." Sources: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/index.md); [Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/index.md). So a failed step leaves the database at the last good migration, not half-applied inside one file.

**Rollback.** `wrangler rollback` or the dashboard rolls to any of the 100 most recent versions and creates a new deployment ([Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). "Resources connected to your Worker will not be changed during a rollback. Errors could occur if using code for a prior version if the structure of data has changed." A rollback is refused if a Durable Object class lifecycle change happened in between, or if a bound KV namespace, R2 bucket or queue no longer exists. Versions do not track storage state: "State changes for associated storage resources such as KV, R2, Durable Objects, and D1 are not tracked with versions" ([Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)). To undo a data change, D1 Time Travel restores to any minute in the last 30 days; it "is always on" and works on databases with `version: production` ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/index.md)).

**Design consequences the docs support.** Migrate before deploy, so new data structure exists when new code runs. Keep each migration additive (new column, new table) so the previous Worker version still runs against the new schema, which is the only case where a code rollback is safe. Never rename the Worker or a binding in an update.

**Failed or half-applied update.** Two cases are clear from sequencing: a failing migration in the `deploy` script stops before `wrangler deploy`, so the old code stays live on a database at the last good migration. A failing `wrangler deploy` after migrations succeed leaves old code on the new schema. What Workers Builds records, retries or reverts after a failed deploy command is not described in the pages read. Production builds create a version, and promote it only "if the build is configured to deploy" ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/index.md)).

## 3. Options for htmlgate

**The pre-gate window applies to every path, and is the main design fact.** Four things combine. (1) A Worker goes live on workers.dev at its first deploy, because `workers_dev` defaults to true with no routes. (2) Version URLs follow the same default and are public, and a hostname-based Access application on `<name>.<sub>.workers.dev` does not cover them. (3) A `worker` Access destination needs a `worker_id`, which an ordinary deploy creates only at the first upload. (4) The button and Workers Builds deploy without any Access step. Documented ways to close the window:

- **Create the Worker object first** (`POST /workers/workers`, `subdomain.enabled: false` per the schema), create the Access application with its `id`, then deploy. Setup-command only. Schema-based, not exercised.
- **Ship the config dark:** `workers_dev = false` and `preview_urls = false` in the committed config, so the first deploy is unreachable. The Operator creates Access, then edits the config in their own repo to turn workers.dev on. Works with the button. Whether anything stays reachable (Deployment URLs) with both off is not confirmed (section 4).
- **Hostname-based Access first.** The workers.dev hostname is known before the first deploy (Worker name plus account subdomain), so a self-hosted Access application on it needs no `worker_id`. It protects "only that exact URL", so `preview_urls = false` must also be set ([Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/index.md)). Whether Access accepts an application for a hostname with no Worker yet is not confirmed.
- **`all_workers` Access scope**, "protect every existing and newly created Worker", set before the first deploy ([Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/index.md)). Needs Zero Trust and an application beforehand, and gates every other Worker in the account: a heavy-handed choice for an account the Operator shares.
- **Fail closed in code.** The Worker returns an error for every Drop until it can validate an Access JWT, and `secrets.required` makes `wrangler deploy` fail while a declared secret is unset. This turns a missing gate into a refused deploy or an empty Instance rather than public Drops. `secrets.required` enforces only that a secret exists, not that the Access application exists.

### Option 1. Button, default config

Steps (3 to reach a running Instance, then 2 to 5 for the gate):

1. Open the button link; sign in to Cloudflare and authorise GitHub or GitLab.
2. On the setup page, choose repo name, Worker name and resource names; fill in the declared secrets.
3. Select Deploy. Workers Builds builds, D1 and other bindings are provisioned, the `deploy` script migrates, and the Instance answers on workers.dev.
4. If Zero Trust was never enabled: Zero Trust, team name, plan, payment details.
5. Worker, Access tab, "Protect this Worker behind Access", All traffic, pick a policy with the allowlist.
6. Optional: register a GitHub OAuth app and add it as an identity provider (client id and secret by hand).
7. Optional custom domain: dashboard, or a config edit in the Operator's repo.

Automated: repo, build, bindings, migrations, deploy. By hand: steps 4 to 7 (about 5 clicks plus first-time onboarding). While the repo is private: **does not work for others** (public required); the owner can use the same steps from their own private repo through Workers Builds. **Window: open** between steps 3 and 5. What can go wrong: Workers Builds token documented without D1 Edit; no way to prefill the allowlist; the Operator's Access policy is whatever the dashboard offers (Cloudflare account members or an email domain), so GitHub login and path overrides need extra edits (sibling note); an update is a manual merge.

### Option 2. Button, config that ships dark

As Option 1, with `workers_dev = false` and `preview_urls = false` in the repo's config and the Worker failing closed in code.

1. Open the button link; sign in and authorise.
2. Setup page: names and secrets.
3. Select Deploy. The Instance exists but nothing reaches it.
4. Zero Trust onboarding if first time.
5. Worker, Access tab, protect with All traffic and the allowlist.
6. In their own repo, set `workers_dev = true` (and `preview_urls = true` if wanted), commit. Workers Builds redeploys.

6 steps, one a repo edit. Closes the window if section 4's open question about Deployment URLs resolves in our favour. What can go wrong: an Operator who forgets step 6 sees nothing and may think the deploy failed; adding a custom domain later flips `workers_dev` unless it is written; the config diverges from upstream, so every update merges around those two lines. Private-repo behaviour as Option 1.

### Option 3. Setup command with the Operator's own token

1. Create an API token (Workers Scripts Write, D1 Write, Workers KV Storage Write if KV, Access: Apps and Policies Write, and for first-time Zero Trust Access: Organizations, Identity Providers, and Groups Write), or sign in with `cf auth login`.
2. Get the code: `git clone` then `npm install`, or `npx <pkg> setup`. Needs repo or package access.
3. Run `setup`. It asks for the Worker name and **requires** an allowlist (no default), then: registers the workers.dev subdomain if absent, creates the Worker with workers.dev off, creates D1, applies migrations, generates and sets secrets without printing them, creates the Access application and policy, deploys, switches workers.dev on, prints the URL, and lists custom domains before and after.
4. Open the URL and sign in.

4 steps, plus first-time Zero Trust and a GitHub OAuth app if that sign-in is wanted. **Window: closed by ordering** (schema-based). Works while the repo is private for anyone with access. Update: `git pull`, rerun `setup` (idempotent) or `npm run deploy`. What can go wrong: a token with wide Access rights lives on the Operator's machine; `wrangler deploy` may not adopt a Worker created through the Workers API (not confirmed); the command must never replicate the reference's mistakes in section 2.4; the Operator must be able to do first-time Zero Trust by hand, because payment details are required in the dashboard flow (sibling note, section 2.6).

### Option 4. Published package, thin Operator project

1. `npm create <pkg>@latest my-instance` writes a small project: an id-free config, a pinned dependency on the package that holds the Worker and migrations.
2. Create an API token (as Option 3) or sign in.
3. `npx <pkg> setup` (as Option 3 step 3).
4. Open the URL and sign in.

4 steps. Update: `npm update`, then `npx <pkg> deploy`, which migrates first. Instance configuration lives only in the Operator's project, so there is nothing to merge. **Window: closed** as Option 3. While the repo is private: the package must be reachable (a private registry, or a tarball), so strangers cannot use it until 0.1 publishes. What can go wrong: a published package is supply-chain trust for every Operator; the Wrangler `main` pointing into `node_modules` is not covered by the docs I read (not confirmed); `cf` could replace Wrangler underneath later, but not yet (section 2.3).

## 4. Not confirmed

- **Repo created by the button.** Visibility (public or private), fork or detached copy, and whether it keeps any link to the source: not stated. Looked at: the button page, the Git integration pages, the Cloudflare changelog. The deploy page itself sits behind a bot challenge.
- **Secrets on the button.** Whether the value in `.dev.vars.example` is prefilled, and whether an empty value is refused. Looked at: the button page and the 2025-07-01 changelog.
- **Re-running the button as an update.** Not described. Looked at: the button page.
- **Order of provisioning against the build on the button.** The page's own D1 example only works if the database exists before `deploy`; no page states it.
- **Workers Builds token and D1.** The documented auto-created token has no D1 Edit, no Access permission, yet the button page recommends migrations in the deploy script and Wrangler's provisioning needs D1 permission. Either the documented list is out of date or the first deploy can fail. Looked at: [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/index.md), [permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/index.md). This could break Option 1 on a first deploy.
- **Two pages that read differently, neither decides the answer.** (a) The button page says ids are written to the new repo's config; the Wrangler page says dashboard and GitHub deploys do not write them back. (b) The button page says to migrate by binding name; the D1 page prefers the database name. Neither stops the work: binding inheritance keeps redeploys on the same resources either way, and both were recorded rather than escalated.
- **Anything still reachable with `workers_dev = false` and `preview_urls = false`.** The workers.dev page says disabling workers.dev "does not disable Version URLs, Preview URLs, or Deployment URLs"; the 2025-10-23 changelog says Version URLs default to follow `workers_dev`. "Deployment URLs" are not defined on the pages read.
- **Custom-domain removal on the server side.** The `domains/changeset` and `domains/records` endpoints are not in the public API schema and no docs page describes them. The "removed unlisted domains" behaviour is inferred from the client source and the owner's observation.
- **Permissions to attach a custom domain.** The schema lists only Workers Scripts Write for `PUT /workers/domains`; whether the zone needs DNS Write or Zone Read is not stated. A Wrangler changelog entry says custom-domain-only deploys no longer need `Zone > Workers Routes > Read` (Wrangler 4.143.1 line, [CHANGELOG](https://github.com/cloudflare/workers-sdk/blob/c492d6312152cedbf93f0b5bbcadcab5e01af9e7/packages/wrangler/CHANGELOG.md)).
- **Access scope in OAuth.** Which Cloudflare permission the `cf` login scope `access:write` maps to, and whether `wrangler login --scopes` can request it. Looked at: scope files, Wrangler login docs.
- **Worker created through `POST /workers/workers`.** Whether `wrangler deploy` then adopts it, whether the Access `worker_id` is the same id as the Worker object's, and whether a create request honours `subdomain.enabled: false`. Schema only; nothing was called.
- **`cf deploy` as a Workers Builds deploy command**, and `cf deploy` custom-domain replacement semantics. Not documented.
- **Package `main` inside `node_modules` for Wrangler.** Not covered by the pages read.
- **Failed deploy in Workers Builds.** What is recorded, retried or reverted. Not described.
- **Free-plan limits for D1 databases per account** during first deploy. A Wrangler changelog line mentions a database-count error; the number was not read.

## Sources and "last updated" dates

Docs pages read as Markdown on 2026-10-05. Dates are the "Last updated" line each page shows.

| Page | Last updated |
| --- | --- |
| [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/index.md) | Jul 22, 2026 |
| [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/index.md) | Oct 5, 2026 |
| [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/index.md) | Oct 1, 2026 |
| [Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/index.md) | Oct 1, 2026 |
| [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/index.md) | Sep 22, 2026 |
| [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/index.md) | Sep 22, 2026 |
| [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/index.md) | Sep 22, 2026 |
| [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/index.md) | Sep 29, 2026 |
| [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/index.md) | Jul 3, 2026 |
| [Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) | Sep 22, 2026 |
| [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) | Jul 15, 2026 |
| [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/index.md) | Jun 8, 2026 |
| [Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/index.md) | Apr 23, 2026 |
| [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/index.md) | Apr 21, 2026 |
| [Wrangler deprecations](https://developers.cloudflare.com/workers/wrangler/deprecations/index.md) | Apr 28, 2026 |
| [Wrangler general commands (login)](https://developers.cloudflare.com/workers/wrangler/commands/general/index.md) | Sep 2, 2026 |
| [Cloudflare CLI](https://developers.cloudflare.com/cf/index.md) | Sep 29, 2026 |
| [cf for Wrangler users](https://developers.cloudflare.com/cf/wrangler/index.md) | Sep 30, 2026 |
| [Migrate a Wrangler project](https://developers.cloudflare.com/cf/wrangler/migrate/index.md) | Sep 29, 2026 |
| [Wrangler to cf reference](https://developers.cloudflare.com/cf/wrangler/reference/index.md) | Sep 29, 2026 |
| [Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/index.md) | Sep 30, 2026 |
| [Programmatic configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/index.md) | Sep 29, 2026 |
| [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/index.md) | Aug 18, 2026 |
| [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/index.md) | Oct 1, 2026 |
| Changelog posts: [2025-07-01](https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/), [2025-10-23](https://developers.cloudflare.com/changelog/post/2025-10-23-preview-url-default-behavior/), [2025-10-24](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/), [2026-04-01](https://developers.cloudflare.com/changelog/post/2026-04-01-deploy-hooks/), [2026-09-28](https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/) | dated in the URL |

Repositories, read at the pinned commits named in the Method (the `cf` CLI's own scope list lives in the `workers-sdk` repository): [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/tree/c492d6312152cedbf93f0b5bbcadcab5e01af9e7) (Wrangler 4.147.0), [cloudflare/api-schemas](https://github.com/cloudflare/api-schemas/tree/75c2f4f7b86541b0f7759fc38d631eef224f785d). Release dates from the npm registry (`npm view wrangler time`, `npm view cf time`). The reference repositories are cited as `the reference/...:line` and `the reference-cli/...:line`.
