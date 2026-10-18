# Can Cloudflare Access gate a workers.dev Worker path by path?

Research note for ticket #3, feeding decision ticket #13 ("How do Viewers and Publishers sign in?"). It reports options and facts. It does not decide.

**Method.** Every claim comes from Cloudflare's own documentation, API reference or changelog, read as Markdown on 2026-10-05. The "last updated" date of each page is in the table at the end. Nothing was run against the Cloudflare API, `cf` or `wrangler`, so nothing here has been observed live. Where a claim rests on a single page, that page is cited next to it. All identifiers in examples are placeholders.

## 1. Answer

1. **Yes, on paper.** Access can gate one Instance's Worker on its `workers.dev` hostname, leave chosen path prefixes public, and leave the API prefix to the Worker's own bearer-token check. None of it was exercised live.
2. **Cleanest shape.** One Access application with a `worker` destination (covers `workers.dev`, Version/Preview/Deployment URLs, routes and custom domains), an Allow policy holding the Operator's allowlist, and `overrides` that make fixed path prefixes (for example `/api/*`) public. The `overrides` field is documented only in the API reference. The dashboard flow and prose docs describe a plain gate.
3. **Documented fallback for public paths.** A second self-hosted application on `<host>/<path>` with a Bypass policy. The more specific path wins and inherits nothing.
4. **The built-in dashboard switch is a normal Access application, not a special mode.** It offers "Previews only" or "All traffic" and two simple policy choices (Cloudflare account members, or an email domain). Anything richer (GitHub login, service tokens, paths) is edited in Zero Trust or sent through the API.
5. **What the Worker gets.** A signed JWT in `Cf-Access-Jwt-Assertion` and, for browsers, a `CF_Authorization` cookie. On Worker destinations it also gets `ctx.access`. The JWT carries `email` but no identity provider and no groups unless configured. The Worker must validate the JWT (signature, issuer, audience) itself.
6. **Sharpest limit: "public per Drop" is not something Access does on its own.** Access path rules are configuration, so a per-Drop public flag means either a fixed public URL prefix, an Access API call per Drop (an account-wide Access-write token inside the Instance, and an undocumented cap on overrides), or the Worker doing its own per-Drop gate after an Access login.
7. **Fail-open traps.** A hostname-only application leaves Version/Preview URLs public (they are on by default whenever `workers_dev` is on). Deleting the Worker-level application silently falls back to a broader rule or to nothing. An Allow policy containing Everyone, or Login Method = one-time PIN, opens the gate.
8. **Other limits.** `ctx.access` is not set for Workers using Static Assets. Worker-level Access returns 403 on WebSocket upgrades. Strict service-token mode is forced on for Zero Trust organizations created from today (2026-10-05).
9. **Free plan.** An account needs a Zero Trust organization first, and the dashboard asks for payment details even on the Free plan ("you will not be charged"). Each signed-in Viewer takes a seat. Cloudflare's marketing page says the Free plan is for "teams under 50 users"; the developer docs give no seat number.

## 2. Findings per ticket bullet

### 2.1 Turning Access on for workers.dev and Version/Preview URLs

**Three scopes exist.**
- One Worker: destination `worker` (production and previews) or `preview_worker` (previews only).
- All Workers in the account: `all_workers` or `all_preview_workers`.
- One hostname or path: a self-hosted application whose domain is the hostname or path.
- Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/

**What "protect one Worker" covers.** Cloudflare says it "automatically protects every domain associated with the Worker, including its routes, Custom Domains, `workers.dev` hostname, and previews". Hostname-based Access, by contrast, "protects only that exact URL". Source: same page.

**Dashboard, one Worker.** Workers & Pages, select the Worker, **Access** tab, **Protect this Worker behind Access**, choose **Previews only** or **All traffic**, pick a policy, optionally review session duration, **Apply Access**. Source: same page.

**Dashboard, all Workers.** Workers & Pages overview, **Protect all Workers** card, **Enable Access**, same choices. Source: same page.

**Older entry point.** An October 2025 changelog entry describes **Settings > Domains & Routes > Enable Cloudflare Access** on `workers.dev` and Preview URLs, then **Manage Cloudflare Access** to change the allowed emails. The current docs page shows the **Access** tab instead. Which is current is not stated. Source: https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/

**API.** `POST /accounts/{account_id}/access/apps` with `type: "self_hosted"`, a `destinations` array and inline `policies`. Cloudflare's example, with placeholders:

```json
{
  "type": "self_hosted",
  "name": "Access for <worker-name>",
  "destinations": [ { "type": "worker", "worker_id": "<worker-id>" } ],
  "policies": [
    { "decision": "allow", "include": [ { "email_domain": { "domain": "<domain>" } } ] }
  ]
}
```

Use `preview_worker` for previews only. Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/ and https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/

**Is the built-in switch all-or-nothing?** In two ways it is narrow, and in one way it is not.
- Narrow: the dialog scopes only by traffic type (previews, or production plus previews), never by path.
- Narrow: the dialog offers two policy options, "Cloudflare account" and "Email domain". Cloudflare says multiple identity providers, device posture, service tokens, complex ordering and custom login pages are edited in the Zero Trust application afterwards.
- Not narrow: the result is an ordinary Access application, so it can carry any policy and (per the API schema) path `overrides`.
- Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/

**Version, Preview and Deployment URLs.**
- All three are public by default. Source: https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/ and https://developers.cloudflare.com/workers/previews/
- When no explicit setting exists, Version URLs follow `workers_dev`: on if `workers_dev` is on. Source: https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
- Disabling the `workers.dev` route does not disable Version, Preview or Deployment URLs. Source: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Setting `preview_urls = false` disables them. If `preview_urls` is omitted, Wrangler leaves an existing setting unchanged. Source: https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
- Version URLs are not generated for Workers that implement a Durable Object. Source: same page.
- If `workers.dev` is disabled in the dashboard but `workers_dev = false` is missing from the Wrangler file, the next `wrangler deploy` re-enables it. Source: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/

**Worker-level limits.**
- WebSocket upgrades to a Worker protected by a Worker-level policy fail with 403. Cloudflare's workaround is a hostname-based application. Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Precedence when several rules match: hostname or path application first, then Worker-level, then account-level. Removing the more specific one "can reveal" the broader one. Source: same page.

**Reusable policies.** A December 2025 changelog entry says one-click Access creates reusable policies: a single account-wide "Cloudflare Workers Preview URLs" policy for previews, and a per-Worker `<worker-name> - Production` policy. Whether the August 2026 flow still behaves this way is not stated. Source: https://developers.cloudflare.com/changelog/post/2025-12-03-reusable-access-policies/

### 2.2 Path-scoped applications, Bypass, precedence

**Can a self-hosted application target a `workers.dev` hostname with a path?** The Workers page says yes: "you can protect `my-worker.example.workers.dev` ... or a single path such as `example.com/login` to make only part of your Worker private." Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/

The self-hosted application page lists as a prerequisite "an active domain on Cloudflare" and says domains in the dropdown "must belong to an active zone in your Cloudflare account". A `workers.dev` hostname is not a zone in the Operator's account. The two pages are not reconciled. See section 4. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/

**Overlap and precedence between applications.** The more specific path wins and nothing is inherited. Cloudflare's example: with rules for `dashboard.com/eng` and `dashboard.com/eng/exec`, the second applies to `/eng/exec` and "no rule is inherited" from the first. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/

**Wildcard rules that matter here.**
- `example.com/alpha/*` covers `/alpha/one` but **not** `/alpha` and not `example.com`.
- `example.com` or `example.com/*` covers every path.
- A wildcard in the middle of a path spans segments: `example.com/foo*/bar` covers `/food/stuff/bar`.
- At most one wildcard per path segment.
- Query strings are not supported in application paths. Ports are stripped.
- Source: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/

**Can a Bypass policy leave one prefix public while the rest is gated?** Yes, per the docs. Bypass "disables any Access enforcement for traffic that meets the defined rule criteria" and is "typically used to enable applications that require specific endpoints to be public". The docs' own example is an application on `test.example.com/admin/<your-url>` with Bypass for Everyone. Cautions on the same page:
- Bypass "does not enforce any Access security controls and requests are not logged".
- Bypass cannot use identity selectors such as email.
- Cloudflare suggests Service Auth instead when you want logging without a user login.
- Source: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/

**Policy order inside one application.** Bypass and Service Auth run first (top to bottom), then Block and Allow (top to bottom). Once a user matches an Allow or Block policy, evaluation stops. So a Bypass-for-Everyone policy in the same application as an Allow policy makes the whole application public. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/

**Path overrides on a Worker destination (API reference only).** Each of `worker`, `preview_worker`, `all_workers`, `all_preview_workers` and `public` destinations accepts `overrides`: an array of `{ "behavior": "public", "path_pattern": "<pattern>" }`. The schema says each rule "can make a matching path public, bypassing Access authentication". `path_pattern` allows wildcards (one per segment, 512 characters at most) and, unlike a public destination's `uri`, "do not implicitly cover subpaths; to do that, use a wildcard". The schema also says the `public` and `preview_worker` destination types take precedence over `worker`, so separate applications can override the policy for "specific paths". I found `overrides` nowhere else: not in the prose docs, not in the Workers or Cloudflare One changelog feeds. Source: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/

Illustrative shape (assembled from the schema, not copied from an example):

```json
"destinations": [
  { "type": "worker", "worker_id": "<worker-id>",
    "overrides": [ { "behavior": "public", "path_pattern": "/api/*" } ] }
]
```

**Can the API path be left to the Worker's own bearer-token check?** Mechanically yes, by either route above: a Bypass application on `<host>/api/*`, or a `public` override for `/api/*`. The Worker then receives no Access identity on those requests and must authenticate the token itself. Cloudflare does not forbid this, and recommends Service Auth over Bypass when logging matters (see above). Service Auth is the in-Access alternative (section 2.4).

**Per-Drop public.** Access has no per-request or per-Drop switch. A Drop becoming public would have to appear as a path rule. Relevant limits: 500 applications per account, 50 domains per application, 1,000 rules per application. No cap on `overrides` per destination is documented. Source: https://developers.cloudflare.com/cloudflare-one/account-limits/

### 2.3 What the Worker receives, and requests that never passed Access

**Headers and cookie.** Every request that passes Access reaches the origin with an application token in the `Cf-Access-Jwt-Assertion` request header. Browser requests "will also pass the token as a `CF_Authorization` cookie". Cloudflare recommends validating the header, "since the cookie is not guaranteed to be passed". Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

**The `CF_Binding` cookie** (an optional setting) is "stripped at Cloudflare's network and never forwarded to the origin". Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/

**`ctx.access`.** When Access authenticated the request that directly invoked the Worker, `ctx.access` holds the identity. `await ctx.access.getIdentity()` returns the user's email, groups, device posture and more, and `ctx.access.aud` holds the audience tag. `ctx.access` "is `undefined` if Access did not authenticate the request". Limits:
- It is not propagated through Service Binding HTTP calls or RPC.
- Workers with Static Assets run behind an internal router Worker that does not pass `ctx.access` to the user Worker.
- The Cloudflare Vite plugin can add `assets` to the generated config even when your own config omits them.
- Sources: https://developers.cloudflare.com/workers/configuration/cloudflare-access/ and https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/

**Claims in the JWT (identity login).** `aud` (array), `email`, `exp`, `iat`, `nbf`, `iss`, `type` (`app` or `org`), `identity_nonce`, `sub`, `country`. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/

- **Identity provider.** The token has no `idp` claim. The `idp` object comes from the `get-identity` endpoint (below).
- **Groups.** Groups appear in the token only when configured as a custom SAML attribute or OIDC claim, and Access trims custom claims above about 1 KB. Cloudflare says not to base authorization on them.
- **Full identity.** Send the `CF_Authorization` cookie to `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/get-identity`. The fields include `email`, `idp`, `geo`, `user_uuid`, `account_id`, `iat`, `ip`, `service_token_id`, `service_token_status`.
- Same source as above for all three points.

**Signing keys.** `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` returns two public keys in JWK and PEM form. Access rotates by default every 6 weeks, and the previous key stays valid 7 days. Cloudflare says to match the token's `kid` against the listed keys, and not to hard-code a key or read `public_cert`. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

**AUD tag.** Each application has its own. Find it under Zero Trust, Access controls, Applications, **Configure**, **Additional settings**, **Application Audience (AUD) Tag**. It "will never change unless you delete or recreate the Access application". The create-application API response also has an `aud` field. Sources: the validating-json page above and the API reference page in 2.1. If an Instance has more than one Access application (for example a Worker-level one and a path one), each has its own AUD. The docs' sample checks one. Accepting several is my inference, not a documented pattern.

**Cloudflare's recommended Worker validation** (condensed from the docs; `jose`, remote JWKS, issuer and audience both checked). Variables: `POLICY_AUD` is the AUD tag and `TEAM_DOMAIN` is `https://<team-name>.cloudflareaccess.com`.

```js
import { jwtVerify, createRemoteJWKSet } from "jose";
const token = request.headers.get("cf-access-jwt-assertion");
if (!env.POLICY_AUD || !token) return new Response("Forbidden", { status: 403 });
const JWKS = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
const { payload } = await jwtVerify(token, JWKS, { issuer: env.TEAM_DOMAIN, audience: env.POLICY_AUD });
// payload.email is the verified Viewer
```

Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ (the same code appears in https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/). Cloudflare also says: "Validation of the header alone is not sufficient — the JWT and signature must be confirmed to avoid identity spoofing" (https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

**What a Worker sees when the request did not pass Access.** No `Cf-Access-Jwt-Assertion` header and `ctx.access === undefined`. Nothing stops a client from sending a forged header on a path Access does not cover, so the Worker must verify the signature, not just read the header. The sample code returns 403 for a missing token; the changelog's example returns 401. Sources: https://developers.cloudflare.com/workers/configuration/cloudflare-access/ and https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/

**Is such a request possible on workers.dev?** Yes, in at least these cases, all from the docs above:
- A path made public on purpose (Bypass application or `public` override).
- Version, Preview and Deployment URLs when the Access application covers only the main hostname, or when `preview_urls` is not disabled.
- Any other hostname the same Worker answers on (route, custom domain) when only a `workers.dev` hostname application exists.
- After the application is deleted or disabled, falling back to a broader application or to nothing.
- The Workers page says "every request is checked before your Worker runs" for a covered hostname, so a covered request cannot skip Access. I found no page that says the `workers.dev` route itself can skip it.

**Local testing.** `wrangler dev` accepts an `access.dev` block (an `aud` and an optional `identity`) to simulate `ctx.access`. Remove the block to simulate an unauthenticated request. Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/

### 2.4 Service tokens for non-browser clients (a Publisher)

- **Create.** Dashboard: Zero Trust, Access controls, Service credentials, Service Tokens, **Create Service Token**. API: `POST /accounts/{account_id}/access/service_tokens` with `{"name": "...", "duration": "8760h"}`. The permission is `Access: Service Tokens Write`. The `client_secret` is shown once. New secrets use the format `cfast_...` (from 2026-08-26). Source: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- **Present it.** Two request headers, `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Alternatively, an application can read both from a single header (`read_service_tokens_from_header`, for example `Authorization`) whose value is a JSON object with `cf-access-client-id` and `cf-access-client-secret`. Using `Authorization` would collide with a Worker-owned bearer token on the same path. Source: same page, and the API reference in 2.1.
- **The policy must be Service Auth** (API `decision: "non_identity"`), with the selector Service Token or Any Access Service Token. With any other action Access "will prompt for an identity provider login". Sources: same service-tokens page; https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- **What the Worker sees.** The same `Cf-Access-Jwt-Assertion` header. Its payload has `type: "app"`, `aud`, `exp`, `iss`, `iat`, `common_name` (the service token's Client ID) and an empty `sub`. There is no `email`. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- **Strict mode.** Zero Trust organizations created on or after 2026-10-05 have strict service-token authentication on and cannot turn it off. With it: failures return 401 or 403 instead of a 302 redirect, only Service Auth policies authorize a request carrying service-token headers (Allow policies and any `CF_Authorization` cookie are ignored), and no cookie is returned. Existing organizations can opt in. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ and https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/
- **401 instead of a login redirect.** The application field `service_auth_401_redirect` "returns a 401 status code when the request is blocked by a Service Auth policy". Source: the API reference in 2.1.
- **Lifecycle.** Fixed duration, refreshable. Secret rotation with a grace period of 1 hour to 30 days. Tokens can be disabled and re-enabled. An optional org setting disables or deletes tokens unused for 30 to 365 days, but not tokens directly referenced by a policy rule. A limit of 50 service tokens per account. Sources: the service-tokens page; https://developers.cloudflare.com/cloudflare-one/account-limits/
- **Seats.** Cloudflare says service tokens "allow access to applications without consuming seats". Source: https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/

### 2.5 API calls and token permissions

All paths are under `https://api.cloudflare.com/client/v4`. The permission names are as the reference lists them. I did not call any endpoint.

| Purpose | Call | Permission |
| --- | --- | --- |
| Create the Zero Trust organization | `POST /accounts/{account_id}/access/organizations` | `Access: Organizations, Identity Providers, and Groups Write` |
| Add an identity provider | `POST /accounts/{account_id}/access/identity_providers` | same |
| Create an Access application | `POST /accounts/{account_id}/access/apps` | `Access: Apps and Policies Write` |
| Create a reusable policy | `POST /accounts/{account_id}/access/policies` | `Access: Apps and Policies Write` |
| Create a service token | `POST /accounts/{account_id}/access/service_tokens` | `Access: Service Tokens Write` |
| Update an application | `PUT /accounts/{account_id}/access/apps/{app_id}` | `Access: Apps and Policies Write` |
| Turn on strict service tokens | `PATCH /accounts/{account_id}/access/organizations` | not stated on the page |

Sources: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/, https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/, https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/create/, https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

**Application body (relevant fields).**
- `type` is `"self_hosted"`.
- `destinations` is an array of `{uri}` (public hostname with optional path, wildcards allowed), `{type: "worker", worker_id, overrides}`, `{type: "preview_worker", ...}`, `{type: "all_workers", overrides}` or `{type: "all_preview_workers", overrides}`.
- `policies` is an array whose items are inline policy objects, links `{id, precedence}` to reusable policies, or bare policy UUIDs, "in ascending order of precedence". "Reusable and inline policies are mutually exclusive".
- Other useful fields: `allowed_idps`, `auto_redirect_to_identity`, `session_duration` (for example `"24h"`; default 24 hours per the cookie page), `service_auth_401_redirect`, `read_service_tokens_from_header`.
- The schema marks `domain` as required for the self-hosted type, while Cloudflare's Worker examples send only `destinations`. This is not reconciled in the docs.

**Policy body.** `decision` (`allow`, `deny`, `non_identity`, `bypass`), `include` (OR), and optional `exclude` (NOT) and `require` (AND). Include rule shapes in the schema: `{"email": {"email": "..."}}`, `{"email_domain": {"domain": "..."}}`, `{"everyone": {}}`, `{"github-organization": {"identity_provider_id", "name", "team"}}`, `{"any_valid_service_token": {}}`, `{"service_token": {"token_id": "..."}}`. A Bypass-for-everyone policy uses `{"everyone": {}}`. Source: the policy-create API reference above, and https://developers.cloudflare.com/workers/configuration/cloudflare-access/ (Bypass example).

**Identity providers by API.** One-time PIN is `{"type": "onetimepin", "config": {}}`. GitHub is `{"type": "github", "config": {"client_id": "...", "client_secret": "..."}}` and needs an OAuth app registered on GitHub with the callback `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`. Cloudflare as IdP is `{"type": "cloudflare", "config": {"restrict_to_account_members": true}}`. Sources: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/, https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/, https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/

**Worker ID.** The `worker_id` is described only as "the ID of the Cloudflare Worker". The docs do not say which endpoint returns it. See section 4.

### 2.6 Free-plan limits and first-time setup

**Seats.**
- A user takes one seat on their first Access authentication event (any login to an application), and keeps it until removed. Once the seats are used, "additional users who attempt to log in are blocked". Optional seat expiration (1 month to 1 year) frees seats. Source: https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/
- The Free plan is "$0 forever", "best for teams under 50 users or enterprise proof-of-concept tests". This comes from Cloudflare's own marketing page, which is outside the docs set. Source: https://www.cloudflare.com/sase/products/access/
- The developer docs I read give no Free-plan seat number. See section 4.
- Public paths (Bypass) and service tokens do not consume seats (the seat-management page names both as ways to avoid seat use).

**Application and object limits (account defaults).** 500 applications, 50 domains per application, 1,000 rules per application, 50 service tokens, 50 identity providers, 500 reusable policies, 1,000 email addresses per rule. The page says defaults "may be increased on Enterprise accounts" and does not list a separate Free figure for these. Source: https://developers.cloudflare.com/cloudflare-one/account-limits/

**Login methods.**
- A new organization gets the Cloudflare identity provider automatically, with "Restrict to account members" on. When you add it manually, that option defaults to off, and then any Cloudflare user can authenticate, subject to your policies.
- One-time PIN is no longer added automatically. You can add it at any time.
- GitHub works without a GitHub organization. You register an OAuth app and paste its client ID and secret.
- Generic OIDC and SAML are supported.
- A selector "Cloudflare Account Member" matches membership in a Cloudflare account.
- The docs I read state no Free-plan restriction on identity provider types. Not confirmed.
- Sources: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/, .../one-time-pin/, .../github/, .../cloudflare/, and https://developers.cloudflare.com/cloudflare-one/access-controls/policies/

**An account that has never enabled Zero Trust.**
1. Cloudflare account, with two-factor authentication recommended.
2. In the dashboard, select **Zero Trust**.
3. Pick a **team name**. The docs call it "a unique, internal identifier" and say it becomes the subdomain of the App Launcher; the sign-in host is `<team-name>.cloudflareaccess.com`.
4. "Complete your onboarding by selecting a subscription plan and entering your payment details. If you chose the Zero Trust Free plan, this step is still needed but you will not be charged."
5. The organization is then created with the Cloudflare identity provider as the default login method.
- Source: https://developers.cloudflare.com/cloudflare-one/setup/. The Workers Access page also tells you to finish Zero Trust setup first: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- So a payment method is required in the dashboard flow. An API route to create the organization exists (table in 2.5). The docs do not say whether it skips the plan and payment step.

### 2.7 What changes on a custom domain

- **Prerequisite.** A Custom Domain needs an active Cloudflare zone. Cloudflare creates the DNS record and a certificate. Source: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- **Two ways to gate it.** Hostname-based Access on the custom domain, or Worker-level Access that already covers it. Source: same page and https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- **Hostname-based applications.** The self-hosted flow expects the domain to come from an active zone in the account. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- **Cookie per hostname.** The `CF_Authorization` application cookie is set on the protected domain. A Viewer who signed in on the `workers.dev` hostname gets a separate cookie on the custom domain. A multi-domain application can issue cookies for each domain (setting "Eager redirect cookie"). Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
- **Same JWT.** Issuer is still the team domain. The AUD tag is that of whichever application matched. Source: the validating-json and application-token pages.
- **Account-wide deny by default.** An account can block every hostname that has no Access application (error 1050), with per-hostname exemptions. It matters for a custom domain in a zone the Operator owns. Whether it also covers `workers.dev` hostnames is not stated. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/
- **Not supported on an Access-protected application domain:** Automatic Platform Optimization, Zaraz, Google tag gateway. Source: the self-hosted application page.
- **Cloudflare's own advice.** The `workers.dev` subdomain is treated as a Free website "intended for personal or hobby projects that aren't business-critical", and Cloudflare recommends a route or custom domain for production Workers. Source: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- **Name length.** A Worker name used on `workers.dev` is limited to 63 characters, letters, digits and dashes. Same source.

## 3. Options for htmlgate

All four keep the Operator's allowlist in an Access Allow policy. None of them decides who may sign in with GitHub. That is ticket #13.

### Option 1. One Worker-level application, fixed public prefixes by `overrides`

**Shape.** The Operator (or the setup tool) creates a `worker` application with an Allow policy for the allowlist and `overrides` that make `/api/*` and `/p/*` public. The Worker validates the Access JWT on every other path and checks its own bearer token on `/api/*`. A Drop is gated when served from the gated prefix. Making it public means serving it also from `/p/<id>`.

**Operator configures.** The allowlist, the identity provider, and `POLICY_AUD` plus `TEAM_DOMAIN` as Worker variables. Also `preview_urls = false`, or the Worker-level destination (so previews are covered too). A token with `Access: Apps and Policies Write` for the setup step only.

**Can go wrong.**
- **Fails open** if `overrides` is wrong. A broad pattern (`/p*` instead of `/p/*`, or a wildcard spanning segments) exposes more than intended.
- **Fails open** if the application is deleted. The fallback is the account-level application or nothing.
- **Fails open** if the allowlist is built from Everyone or Login Method = one-time PIN, or if the Cloudflare IdP is added without "Restrict to account members".
- `overrides` is documented only in the API reference (section 4).
- A public Drop has a different URL from its gated one, which strains "one stable URL per Drop".
- Static Assets would hide `ctx.access`, so the Worker must use the JWT.

### Option 2. Access gates only a sign-in path, the Worker enforces per Drop

**Shape.** Access gates `/auth/*` (a path application or override pair). The Worker validates the Access JWT there, then sets its own signed session cookie. Drop paths are public as far as Access is concerned. The Worker checks the session for gated Drops and serves public Drops to anyone. The URL never changes when a Drop becomes public.

**Operator configures.** The same Access setup plus a signing secret for the session cookie.

**Can go wrong.**
- **Fails open in the Worker, with Access no longer a backstop.** A bug in the per-Drop check, or a missing check on one route, serves gated Drops to the world.
- Revoking someone from the Access allowlist does not end their Worker session until it expires or is re-checked. The map says to resolve identity on every request. A session cookie checked on every request satisfies that only if the allowlist is also consulted.
- The Operator ends up with two session systems.
- Bypass requests are not logged by Access (section 2.2), so Access logs show nothing for Drop traffic.

### Option 3. Per-Drop Access rules through the Access API

**Shape.** Everything is gated by a Worker-level application. Making a Drop public adds a path rule for that Drop (an override entry, or a `public` application); making it private removes the rule.

**Operator configures.** An API token with `Access: Apps and Policies Write` stored as a Worker secret, the application ID, and the Worker ID.

**Can go wrong.**
- The token can change **every** Access application in the account, not only this Instance's (the reference lists the permission with no resource scoping). That is a large privilege inside a Worker that serves untrusted HTML.
- **Fails open** if an unpublish call fails or is slow. The Drop stays public.
- Limits to check: 500 applications per account, and no documented cap or propagation time for `overrides`.
- The rule list must be kept in sync with the Drop database, with drift in either direction.
- Concurrent updates to one application can overwrite each other (a `PUT` replaces the body, per the service-tokens page example).

### Option 4. Two Workers: a gated Instance Worker and a public Worker

**Shape.** The Instance Worker has Worker-level Access with the API on a public override. Public Drops are copied to a second Worker that has no Access and its own `workers.dev` hostname.

**Operator configures.** Two Workers, shared storage bindings, and both hostnames.

**Can go wrong.**
- It does not meet "one hostname", and a Drop's URL changes when it becomes public.
- **Fails open** if the public Worker's copy is not removed on unpublish.
- Doubles the Version/Preview URL surface to lock down.

### Cross-cutting fail-open checklist

- Disable or gate Version, Preview and Deployment URLs. Check them after every deploy.
- Never let the setup tool create an Allow policy from an empty allowlist (matches the map's standing constraint).
- Worker code must reject a request with no valid JWT instead of treating the header as proof, and must check `iss` and `aud`.
- A Bypass or public rule is unlogged. Keep the list short and test it with the wildcard rules in 2.2.
- Drops are publisher-authored HTML, and the Access cookie lives on the same hostname. The cookie page lists `HttpOnly` as "Admin choice (Default: None)" in a table and "enabled by default" in the text. Verify it before serving Drop scripts from the same origin. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/

## 4. Not confirmed

1. **`overrides` semantics.** Only the API reference describes it. I searched the Workers and Cloudflare One docs (`llms-full.txt`) and both changelog feeds for `overrides` and `path_pattern` and found no prose, example, dashboard step or changelog entry. Unknown: a cap on entries, how fast a change takes effect, whether `ctx.access` or a JWT is present on an overridden path, and whether those requests are logged.
2. **A `workers.dev` hostname in a self-hosted application.** The Workers page (Aug 18, 2026) says it works. The self-hosted page (Apr 17, 2026) says domains must come from an active zone. Not reconciled, never tried. It does not decide the Answer, because the `worker` destination does not depend on it.
3. **Where `worker_id` comes from.** The Access docs do not say. Cloudflare's Workers programmatic-deploy example prints `worker.id` after `client.workers.beta.workers.create(...)`, which suggests the Workers API returns it. Whether a Workers permission is also needed is not stated. Looked at: the Access API reference, the Workers Access page, the Workers `llms-full.txt`.
4. **`ctx.access` for hostname-based applications.** The Workers page says it is set "when Cloudflare Access authenticates a request that directly invokes your Worker". It never says whether that holds for a hostname or path application, as opposed to a Worker destination. The changelog and the Workers Access page link to `/workers/runtime-apis/context/#access`, but the Context page (updated Sep 28, 2026) has no Access section. Also not stated: whether `getIdentity()` makes a network call.
5. **Service-token headers at the Worker.** The docs say the `CF_Binding` cookie is stripped, but not whether `CF-Access-Client-Id` and `CF-Access-Client-Secret` are forwarded to the origin.
6. **Free-plan seat number.** The developer docs give none. The marketing page says "under 50 users". Whether the cap is 50 inclusive, and whether the Free plan limits identity provider types, is not stated. Looked at: seat-management, account-limits, FAQ, identity-provider pages, the plans page (loads its table dynamically).
7. **Organization creation by API and payment.** Whether `POST .../access/organizations` skips the plan and payment step the dashboard requires.
8. **"Block traffic to all domains in this account".** Whether it applies to `workers.dev` hostnames.
9. **Current Worker-level flow.** Whether the August 2026 flow creates the reusable policies described in the December 2025 changelog, and whether the old **Settings > Domains & Routes** entry still exists.
10. **Cookie `HttpOnly` default.** The cookie page contradicts itself (section 3, last bullet).
11. **Propagation time.** How quickly an allowlist change, a revoked user or a deleted application takes effect on a live request.
12. **Everything is documentation-only.** No request was sent to Cloudflare, so every behavior above is as documented, not as observed.

## Sources and "last updated" dates

| Page | Last updated (as shown) |
| --- | --- |
| https://developers.cloudflare.com/workers/configuration/cloudflare-access/ | Aug 18, 2026 |
| https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ | Sep 22, 2026 |
| https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/ | Sep 22, 2026 |
| https://developers.cloudflare.com/workers/previews/ | Sep 24, 2026 |
| https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ | Sep 29, 2026 |
| https://developers.cloudflare.com/workers/runtime-apis/context/ | Sep 28, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ | Oct 1, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ | Apr 17, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ | Apr 17, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/ | Aug 3, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ | May 6, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ | Jun 25, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ | Oct 2, 2026 |
| https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection/ | Apr 21, 2026 |
| https://developers.cloudflare.com/cloudflare-one/account-limits/ | Sep 4, 2026 |
| https://developers.cloudflare.com/cloudflare-one/setup/ | Apr 17, 2026 |
| https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/ | May 1, 2026 |
| https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/ | Jun 19, 2026 |
| https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/ | Aug 31, 2026 |
| https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/ | Apr 30, 2026 |
| https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/ | Jun 19, 2026 |
| https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/ | no date shown (API reference) |
| https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/ | no date shown (API reference) |
| https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/create/ | no date shown (API reference) |
| https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/ | Aug 14, 2026 |
| https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/ | Oct 2, 2026 |
| https://developers.cloudflare.com/changelog/post/2025-12-03-reusable-access-policies/ | Dec 4, 2025 |
| https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/ | Oct 3, 2025 |
| https://www.cloudflare.com/sase/products/access/ (Cloudflare marketing page, outside the docs set) | no date shown |
