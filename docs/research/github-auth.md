# How can a self-deployed Instance sign people in with GitHub?

Research note for issue #4. It feeds the decision ticket #13 ("How do Viewers and Publishers sign in?"), which the owner decides. This note reports options and facts and does not pick one.

Checked on 2026-10-05 against the live documentation. Vocabulary follows `GLOSSARY.md` (Drop, Instance, Host, Operator, Publisher, Viewer). The reference server is `utsengar/the reference` at commit `ac00be7`; it has no LICENSE file, so this note describes its behaviour and copies none of its code.

## Answer

There are four distinct ways to put GitHub in front of an Instance:

1. **Cloudflare Access with GitHub as its login method.** The Operator registers one OAuth App on GitHub whose callback is the Operator's Access team domain, pastes its client id and secret into Access, then adds an Access application and policy. The GitHub app is per Cloudflare account, not per Instance. The Worker sees an Access token carrying the person's email and a Cloudflare user id, not their GitHub id or login. Org and team rules live in the Access policy.
2. **The Worker runs the GitHub web flow itself with an app the Operator registers.** One registration (OAuth App or GitHub App), a callback on the Instance's own hostname, and a client secret stored on the Instance. GitHub's token exchange requires the client secret, and the docs say PKCE does not replace it.
3. **The Worker runs GitHub's device flow with an app the Operator registers.** Same registration, plus a checkbox. The Instance holds only a public client id, no secret and no callback. It fits "approve a Publisher token" well and "a Viewer in a browser" badly.
4. **One app registered by the project, device flow only, client id baked into the code.** The Operator registers nothing on GitHub. But every Instance in the world shares one limit of 50 code submissions per hour, one suspension switch, and a consent screen that names the project and not the Operator. The web flow cannot be shared at all (it needs a secret, and callbacks are per hostname).

Sharpest limits:
- Any GitHub account can sign in with GitHub unless the Instance or Access restricts it. A missing allowlist is the main way every option fails open.
- Allowlist by the numeric GitHub id, not the login. The docs say logins change.
- A token with no scope is enough to read `id` and `login`. The reference asks for `read:user`, which is more than needed.
- Org and team checks need `read:org` (OAuth App) or the "Members" organization permission (GitHub App). Organizations with OAuth App access restrictions, which are on by default for new organizations, hide their private resources from unapproved OAuth Apps. Private membership is invisible to a public-members check.
- A GitHub App can be registered for the Operator in about two clicks with the manifest flow (the Instance gets the client id and secret back). The documented manifest fields do not include "enable device flow".

## 1. GitHub as a login method inside Cloudflare Access

**What the Operator registers and enters.** Source: [Cloudflare Access, GitHub identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/) (page last updated 2026-04-30).
- On GitHub: a new OAuth App. Homepage URL is `https://<team-name>.cloudflareaccess.com`. Authorization callback URL is `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`. Note the Client ID and generate a client secret.
- In Cloudflare: Zero Trust, Integrations, Identity providers, add GitHub, enter the Client ID as "App ID" and the client secret, save, then "Finish setup" opens a GitHub page where the Operator authorizes the grants Access asks for.
- The callback is the account's team domain, so one GitHub app serves every Instance in that Cloudflare account. It is not a per-Instance setup step.
- The page says "You do not need to have a GitHub organization to use the integration."

**Permissions Access asks GitHub for.** The page lists "Organizations and teams (read-only)" and "Email addresses (read-only)". Mapping these to the `read:org` and `user:email` scopes is my inference from [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), which describes `read:org` as "Read-only access to organization membership, organization projects, and team membership" and `user:email` as read access to email addresses. The Cloudflare page does not name the scopes.

**What identity reaches the Worker.** Source: [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) (page last updated 2026-06-25).
- The `Cf-Access-Jwt-Assertion` header carries a JWT with `email` ("verified by the identity provider"), `sub`, `country`, `aud`, `iss`, `exp` and an `identity_nonce`. `sub` is "unique to an email address per account" and changes if the user is removed and re-added. It is a Cloudflare id, not the GitHub numeric id.
- The JWT has no GitHub login, no GitHub numeric id and no organizations or teams. The docs say IdP groups appear in the token only when a custom SAML attribute or OIDC claim named `groups` is configured, and GitHub is configured as neither.
- The full identity is at `/cdn-cgi/access/get-identity` (called with the `CF_Authorization` cookie). It returns `email`, `idp` ("Data from your identity provider"), `user_uuid`, and more. The docs do not say what `idp` holds for GitHub (see section 7).
- The Worker must validate the JWT signature against `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` and check `aud` against the application's AUD tag: [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). So the Instance needs two non-secret values: the team domain and the AUD tag.

**Policy selectors that can use GitHub.** Source: [Access policies, selectors](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#cloudflare-access-selectors) (updated 2026-10-01) and the [Access applications API reference](https://developers.cloudflare.com/api/node/resources/zero_trust/subresources/access/subresources/applications/).
- "Identity provider group": the page says it "only displays if you use Microsoft Entra ID, GitHub, Google, Okta, or an IdP that provisions groups with SCIM".
- The API has a rule type `github-organization` with `identity_provider_id`, `name` (the organization) and optional `team`. It "Requires a Github identity provider." The selector table on the policies page does not list a separate "GitHub organization" selector, so how the dashboard labels it is not confirmed.
- "Login Methods" matches the IdP used at login. "Emails" and "Emails ending in" work on the identity's email.
- The selector table marks IdP group, Login Methods and Emails as "Checked at login" and not "Checked continuously". So removing someone from the organization takes effect at their next login, not mid-session.

**Limits.**
- Users who join the required organization after a failed login "remain blocked" until they revoke the app's access in GitHub and log in again ([GitHub IdP page](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/)).
- With GitHub as the only login method and no organization, team or email rule, any GitHub account passes the login step. A policy must name who is allowed. This matches the map's standing rule that an Access policy fails closed.
- An organization with OAuth App access restrictions would affect the Operator's own Access OAuth App the same way it affects any OAuth App (section 2). I did not find a Cloudflare page that says so, so this is inference.
- Whether Access can sit in front of a `workers.dev` Worker, and path by path, is ticket #3's question and not covered here.

## 2. The Worker running GitHub OAuth itself: OAuth App

**Registering.** Source: [Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
- An OAuth App can be registered under a personal account or an organization the person administers. One owner can have up to 100.
- Fields: name, homepage URL, optional description, "up to 10 callback URLs", and an "Enable Device Flow" checkbox. "Expire user access tokens" is on by default.
- The client secret is generated on the app's settings page and is required for the web flow.

**Web flow.** Source: [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow).
- Authorize: `GET https://github.com/login/oauth/authorize` with `client_id`, `redirect_uri` ("strongly recommended"), `scope`, `state` ("An unguessable random string"), `code_challenge` and `code_challenge_method` (both "strongly recommended"; only `S256`), `allow_signup`, `login`, `prompt`.
- Exchange: `POST https://github.com/login/oauth/access_token` with `client_id`, **`client_secret` (marked "Required")**, `code`, `redirect_uri`, `code_verifier`. The code expires after 10 minutes.
- The page tells apps to re-check the user's identity with the new token on every sign-in, because a user can switch accounts during authorization.

**Is a client secret required even with PKCE?** The docs say yes. The exchange table marks `client_secret` "Required" and treats `code_verifier` as "Strongly recommended" ([same page](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github)). The changelog explains why: "GitHub is not requiring PKCE for any authentication flow at this time, as GitHub does not distinguish between public and confidential clients" ([PKCE support, 2025-07-14](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)). PKCE support today covers the web flow for both OAuth Apps and GitHub Apps, `S256` only, and it is recommended, not enforced. The device flow does not use PKCE. I did not test whether the endpoint would accept a PKCE-only exchange; the docs say the secret is required, so plan on holding one.

**Device flow.** Source: [Authorizing OAuth apps, device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
- It must be enabled in the app's settings first; otherwise the error is `device_flow_disabled`.
- No client secret: "The `client_secret` is not needed for the device flow."
- `POST https://github.com/login/device/code` with `client_id` (and optional `scope`) returns `device_code` (40 characters), `user_code` (8 characters with a hyphen), `verification_uri` (`https://github.com/login/device`), `expires_in` (default 900 seconds) and `interval` (5 in the example).
- Poll `POST https://github.com/login/oauth/access_token` with `client_id`, `device_code` and `grant_type=urn:ietf:params:oauth:grant-type:device_code`, no faster than `interval`. `slow_down` adds 5 seconds to the interval. `authorization_pending` means keep polling. `expired_token` means start over. `access_denied` means the user cancelled and the code is dead. The behaviour follows [RFC 8628 section 3.5](https://www.rfc-editor.org/rfc/rfc8628#section-3.5), which also says to stop polling on any other error.
- Limit: "50 submissions in an hour per application" when users submit codes in the browser ([Rate limits for the device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#rate-limits-for-the-device-flow)).

**Callback URL rules.** Source: [Authorizing OAuth apps, redirect URLs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls) and the changelog [Multiple redirect URIs and token refresh for OAuth apps](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/) (2026-08-14).
- Up to 10 callback URLs per app, for OAuth Apps and for GitHub Apps ([GitHub Apps callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)).
- With wildcard matching off, `redirect_uri` "must exactly match the callback URL". With it on, "the redirect URL's host (excluding subdomains) and port must exactly match", and the path must be a subdirectory of the callback path. So any subdomain and any deeper path matches.
- Wildcard matching is set per callback URL. "Apps that had a single callback URL enabled prior to August 3, 2026 have wildcard matching enabled", and GitHub recommends turning it off when not needed. Whether apps created after that date default to off is not stated.
- The changelog dated 2026-08-14 announces the setting; the docs sentence cites 2026-08-03 as the cutover. These are different events (the feature announcement and the legacy-default date), not a contradiction.
- GitHub's own warning: wildcard matching "allows an attacker to send authorization codes to any subdomain or subdirectory of the callback URL". The changelog adds it "can be abused if the site being redirected to does not have strong control over its routes (e.g., if it hosts user content)". Drops are untrusted HTML, so an Instance should use an exact-match callback on a path no Drop can occupy. This ties to tickets #5 and #12.
- What this means for per-Instance hostnames: wildcard matching covers subdomains of a registered host, and `<name>.<subdomain>.workers.dev` hosts of different Operators are not subdomains of each other. Ten callbacks cannot cover an open-ended set of Operators. A single app can serve one Operator's few hostnames, not all Operators.
- Loopback `redirect_uri` values may use any port ([same page](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#loopback-redirect-urls)). That is for desktop clients and does not help a Worker.

**Tokens.** A new app issues expiring tokens: access token 8 hours, refresh token 6 months ([Expiring access tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#expiring-access-tokens)). For sign-in the Instance reads the identity once and can drop the token. There are two minor limits: ten tokens per user, app and scope combination, and "ten tokens created per hour", after which GitHub shows a re-authorization prompt ([Creating multiple tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#creating-multiple-tokens-for-oauth-apps)).

## 3. The same with a GitHub App acting on behalf of a user

Sources: [Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps), [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

- **Preference.** "In general, GitHub Apps are preferred over OAuth apps." The exception is enterprise-level resources.
- **Permissions, not scopes.** A user access token "does not use scopes. Instead, it uses fine-grained permissions", and "only has permissions that both the user and the app have". The token response's `scope` is always an empty string.
- **Identity needs no permission.** `GET /user` "does not require any permissions" for GitHub App user access tokens ([Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)).
- **Token lifetime.** User access tokens expire after 8 hours and carry a refresh token valid for 6 months by default. The registration form has an "Expire user authorization tokens" checkbox and GitHub "strongly recommends" leaving it on.
- **Device flow.** Supported. The registration form has "Enable Device Flow", and the flow is the same as for OAuth Apps. The callback URL "will be ignored" when the app uses device flow.
- **Web flow.** Still needs `client_secret` ("Required") at exchange; PKCE parameters are "Strongly recommended".
- **Installation.** "An app does not need to be installed in order for a user to authorize the app" ([Authenticating on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)). Installation matters only for what the app may do with repositories and organization data.
- **Webhooks.** An app that is used only for sign-in can deselect "Active" and skip the webhook URL.
- **Visibility.** A public GitHub App can be authorized by "any user on GitHub". A private one "can only be installed on the account that owns the app. Only members of the organization that owns it can authorize it" ([Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)). So an organization-owned private GitHub App is a membership gate with no API call. What a private app owned by a personal account allows is not stated (section 7).
- **Organization policies.** "GitHub Apps aren't subject to organization application policies", unlike OAuth Apps (Differences page).
- **Enterprise SSO.** For organizations on SAML SSO, the user may need an active SAML session before authorizing (user access token page).
- **Manifest flow.** [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest): the Instance serves a button that POSTs a JSON manifest to `https://github.com/settings/apps/new` (or the organization equivalent). The manifest can set `callback_urls` (up to 10), `public`, `default_permissions`, `hook_attributes.active` and `request_oauth_on_install`. The person only names the app and confirms. GitHub redirects back with a temporary `code`, and the Instance exchanges it within an hour at `POST /app-manifests/{code}/conversions`. The response includes `client_id`, `client_secret`, `webhook_secret`, `pem` and `id` ([Create a GitHub App from a manifest](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest)). That endpoint is called with the code and no token ("does not work with" any token type), and "422 ... the endpoint has been spammed" is its rate limit. **The documented manifest parameters do not include a device-flow switch, the token-expiry setting or the wildcard setting**, so an Operator might still need one visit to the app's settings for those. There is no equivalent manifest flow for OAuth Apps in the docs I read.

## 4. Could all Instances share one app registered by the project?

**What works without a secret: the device flow only.** A project-owned app (OAuth App or GitHub App) with device flow enabled has a public client id that can sit in the code. The web flow cannot be shared:
- It needs the client secret, and GitHub says "Never include your app's client secret in client-side code or in code that runs on a user device" ([Rate limits, OAuth apps](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-oauth-apps)). Shipping the secret in open code lets anyone mint tokens for people who authorized the app.
- Callback URLs are per hostname, at most 10 per app (section 2). A shared web-flow app would need a central relay on a fixed hostname, which the map rules out ("There is no central service").

**What a stranger can do with the client id.** The client id is public by design and RFC 8628 section 5.6 treats such clients as "public clients ... susceptible to impersonation" ([RFC 8628 §5.6](https://www.rfc-editor.org/rfc/rfc8628#section-5.6)). Consequences:
- Anyone can start device flows with the project's client id from any program. The consent screen shows the project's app name and developer contact ([Authorizing OAuth apps, for users](https://docs.github.com/en/apps/oauth-apps/using-oauth-apps/authorizing-oauth-apps)), so a hostile tool can borrow the project's name. I could not confirm the exact wording GitHub shows for a no-scope request.
- Remote phishing: an attacker starts a flow, sends the `user_code` to a target and the target approves it at `github.com/login/device`. The attacker's client then holds a token for the target. [RFC 8628 §5.4](https://www.rfc-editor.org/rfc/rfc8628#section-5.4) says this cannot be fully prevented and recommends making the user confirm they hold the device. GitHub's code-entry page cannot show which Instance asked, so any confirmation has to happen on the Instance side.
- The Instance cannot verify "this token came from our app" after the fact. `GET /user` works for a token from any app the user authorized. The Instance is safe only if it requests the device code itself and polls with its own `device_code`, so the token comes straight from GitHub in reply to its own request. Letting a Publisher hand over a GitHub token is a confused-deputy risk and is not one of the options below. The "Check a token" endpoint is documented for the owning app ([OAuth authorizations REST API](https://docs.github.com/en/rest/apps/oauth-applications#check-a-token)); whether it requires the client secret is not stated on the page I read.
- It may burn the shared quota: the hourly limit counts code "submissions" per application. Whether failed submissions count is not stated, so a deliberate denial of service against the quota is plausible and unconfirmed.

**Shared limits.**
- 50 code submissions per hour per application, across every Instance and every person ([device flow rate limits](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#rate-limits-for-the-device-flow)).
- "No more than 2,000 OAuth access token requests per hour are allowed for GitHub Apps and OAuth apps" ([secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits)). The sentence does not say whether the count is per app or per user, so treat it as shared until shown otherwise.
- API calls made with a user's token count against that user's 5,000 per hour, not against the app ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-authenticated-users)). So a shared app does not share an API budget.

**If GitHub suspends the project's app.** For OAuth Apps "suspended (due to reported abuse, spam, or a mis-use of the API)", the web flow redirects with `error=application_suspended` and the fix is to contact GitHub Support ([Troubleshooting authorization request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors#application-suspended)). The docs do not describe the device-flow error for a suspended app. Inference: every Instance loses GitHub sign-in at once, no Operator can fix it, and recovery would mean a new client id shipped in a release that every Operator then has to take.

**Compared with every Operator registering their own.** A per-Operator app has its own 50-per-hour limit, its own suspension risk, a consent screen that names the Operator, and holds a secret that never leaves their account. It costs each Operator one registration (OAuth App: one form and one secret; GitHub App: two clicks with the manifest flow). A middle path is a client id the Operator can override. That keeps zero-setup as the default and removes the shared failure as a permanent dependency.

## 5. Restricting who may sign in

Everything here runs in the Instance after it has the person's identity, except the Access policy rules in section 1.

**By GitHub login or id (allowlist).**
- Read `id` and `login` from `GET /user` ([Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)). A token "without scopes still authenticates as the token's owner" and gets the public user response, whose required fields include `login` and `id`.
- The docs call the numeric id "durable" and say the login "can change over time" ([Get a user using their ID](https://docs.github.com/en/rest/users/users#get-a-user-using-their-id)). Store ids. Let the Operator type logins and have the Instance resolve them to ids once, at setup, with `GET /users/{username}` ([Get a user](https://docs.github.com/en/rest/users/users#get-a-user)).
- An empty allowlist must mean "nobody", not "everybody" (map standing constraint).

**By organization membership.**

| Call | What it needs | Notes |
|---|---|---|
| `GET /user/memberships/orgs/{org}` with the person's own token | GitHub App user token: "Members" organization permission (read). OAuth App: the docs name `read:org` for "organization membership" but the endpoint page lists no scope (inference) | 200 returns `state` (`active` or `pending`) and `role`. 404 if not affiliated. 403 if the org has blocked the GitHub App. See the pitfall below |
| `GET /orgs/{org}/members/{username}` | GitHub App user or installation token with "Members" read; or an OAuth token | "publicly or privately". 204 member, 404 not a member, 302 if the requester is not an org member |
| `GET /orgs/{org}/public_members/{username}` | none for public data | Sees only members who made their membership public. A private member gets 404 |
| `GET /user/orgs` | OAuth App: `user` or `read:org`. GitHub App user token: no permission | The page says "Requests using a fine-grained access token will receive a 200 Success response with an empty list", which is ambiguous for GitHub App tokens |

Sources: [Organization members REST API](https://docs.github.com/en/rest/orgs/members), [List organizations for the authenticated user](https://docs.github.com/en/rest/orgs/orgs#list-organizations-for-the-authenticated-user), [Discovering resources for a user](https://docs.github.com/en/rest/guides/discovering-resources-for-a-user) (which tells apps to avoid the public-only listing because "it only returns the user's public organization memberships").

- **Pitfall that fails open.** `GET /user/memberships/orgs/{org}` returns active or pending members. A check that accepts any 200 would let a person who was only invited in. Require `state == "active"`.
- Any non-200 answer (403, 404, network error) must deny.
- A fourth route avoids the person's own token: a GitHub App owned or installed by the organization, with the Instance holding its private key and minting an installation token that has "Members" read. It sees private members. It costs the org owner an installation step and the Instance a private key.

**By team membership.** `GET /orgs/{org}/teams/{team_slug}/memberships/{username}` ([Get team membership for a user](https://docs.github.com/en/rest/teams/members#get-team-membership-for-a-user)).
- "Team members will include the members of child teams." "The team must be visible to the authenticated user." The response carries `state` and `role`. A 404 means no membership.
- GitHub App user, installation and fine-grained tokens need the "Members" organization permission (read). `GET /user/teams` needs `user`, `repo` or `read:org` for OAuth App tokens and no permission for GitHub App user tokens ([List teams for the authenticated user](https://docs.github.com/en/rest/teams/teams#list-teams-for-the-authenticated-user)).
- Check `state == "active"` here too.

**What breaks.**
- *Private membership:* the public-members calls report a private member as "not a member". Use the person's own token with a membership scope or permission, or an installation token.
- *OAuth App access restrictions:* "When OAuth app access restrictions are enabled, organization members and outside collaborators cannot authorize OAuth app access to organization resources", unapproved OAuth Apps lose "API access to private organization resources", and the setting is on by default for new organizations ([About OAuth app access restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions)). The exact response of a membership call under restriction (404 or 403 or an empty list) is not documented, so deny on any failure and show a message that points at the org owner. Two ways out: applications owned by the organization "are automatically given access" (so the Operator can register the OAuth App under the organization), or the owner approves the app. GitHub Apps "aren't subject to organization application policies" but still need the permission and, per the docs, an org owner's approval where organization permissions are requested ([Differences page](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)).
- *Enterprise SAML SSO:* the person may need an active SAML session first (GitHub App user token page).
- *Scopes can be reduced by the person:* "users can edit their scopes, effectively granting your application less access than you originally requested" ([Scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#requested-scopes-and-granted-scopes)). Read the granted scopes from the token response and deny if `read:org` is missing when the Instance gates by organization.
- *Stale membership:* the Instance decides at sign-in. After that, removal from the organization applies only when the session ends, unless the Instance rechecks. Access has the same limit (section 1).

## 6. The minimum scope for a stable identity

- **OAuth App:** request no scope. "Grants read-only access to public information (including user profile info...)" ([Scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)), and `GET /user` returns the public user response with `login` and `id`. `read:user` is only needed for the private user response, which has fields such as `total_private_repos` and `two_factor_authentication` ([Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)). Caveat from the web-flow table: when `scope` is omitted, a returning user who earlier granted scopes gets a token with those scopes. For this app that stays "none" unless the Instance requests more.
- **GitHub App:** request no permissions. `GET /user` needs none.
- **Add only for gating:** `read:org` (OAuth App) or "Members" read (GitHub App) when the Instance checks organization or team membership. Never `user:email` or `repo`.
- **Reference comparison:** the reference asks for `read:user` (`the reference/src/github-oauth.ts:108`) while its page says "We only read your public username and id" (`the reference/src/views/verify.ts:82-83`). A no-scope request would match the page's promise.

## What the the reference reference does

Commit `ac00be7`. Files: `the reference/src/github-oauth.ts`, `the reference/src/auth.ts`, `the reference/src/views/verify.ts`.

- **Flow.** The Publisher calls `POST /auth/start` and gets a human code, a verification URL, a `poll_token` and a 10-minute lifetime with a 2-second poll interval (`the reference/src/auth.ts:7-8,40-62`). The human opens `/verify?code=...`, which links to `/auth/github/start?code=...` (`the reference/src/views/verify.ts:68-71`). It redirects to GitHub's web flow with `scope=read:user` and `allow_signup=true` (`the reference/src/github-oauth.ts:104-111`). The callback exchanges the code with the client secret (`:214-219,280-313`), reads `/user` (`:220-222,315-333`) and mints an API token for the Publisher (`:258-260`). The Publisher polls `GET /auth/poll`, which hands the token over once (`the reference/src/auth.ts:113-124`).
- **Scopes.** `read:user`, no PKCE.
- **State handling.** `state` is the agent-printed verification code (`:109`, read back at `:117`). It is not an unguessable value and not tied to the browser by a cookie. The callback checks only that the code is pending and unexpired (`:151-188`). Anyone who learns or is sent a pending code can complete the flow, so whoever signs in becomes the identity attached to that Publisher's token. This has the shape RFC 8628 section 5.4 warns about. In the reference the stakes are one low-privilege account per GitHub identity. In htmlgate, where an allowlisted person may approve, the stakes are higher.
- **What it stores.** The GitHub id and login (`the reference/schema.sql:11-12`) with a unique index on the id (`:17-18`), the API token's hash, peppered (`the reference/src/github-oauth.ts:259`), and the plaintext API token in the `verifications` row until the Publisher's poll claims it (`:262-266`; `the reference/src/auth.ts:113-119`). The GitHub access token is discarded after `/user` (`:220-222`).
- **Setup shape.** One app, registered by the the reference author: the client id sits in `wrangler.toml` (`:27-32`), the secret is set with `wrangler secret put` (`:35`), and the callback is fixed to `https://the reference.dev/auth/github/callback` (`:31`). There is no per-Operator registration and no allowlist: any GitHub account can obtain a token. That is the opposite of private by default.
- **Test stub.** `GITHUB_CLIENT_ID === "dev-mock"` skips GitHub (`:24-28,94-102`). Any equivalent in htmlgate must be unreachable in a deployed Instance, or it is a fail-open sign-in.

## 7. Options for htmlgate

All four options need an allowlist or Access rule. Without one, "sign in with GitHub" admits every GitHub account.

### Option A: Access in front, GitHub as its login method

- **Viewer:** the Instance's hostname sits behind an Access application. Access sends the person to GitHub, then passes the Worker a signed JWT with email and a Cloudflare `sub`. The Worker validates the JWT on every request and checks the email (and any group data) it needs. The Worker never calls GitHub.
- **Publisher approval:** the approval page sits behind Access. The human opens the link the Publisher printed, signs in through Access, and the Worker approves the code. The Publisher's own API calls (bearer token) need a path that bypasses interactive login, which is ticket #3's subject.
- **Operator steps (6):** register an OAuth App on GitHub (name, homepage, callback); generate a secret; add GitHub as an identity provider in Zero Trust (2 fields) and authorize; create an Access application for the Instance hostname; add an Allow policy with a GitHub organization or team rule, or an email list; copy the team domain and the AUD tag into the Instance's config. Steps 1 to 3 happen once per Cloudflare account. Steps 4 to 6 are per Instance.
- **Secrets the Instance holds:** none for GitHub. Access holds the GitHub secret. The Instance holds only the non-secret team domain and AUD tag.
- **What can go wrong:**
  - **Fails open:** a policy with only "Login Methods = GitHub", or an "Everyone" rule, admits all GitHub accounts. A Worker that trusts `Cf-Access-Jwt-Assertion` without validating the signature and `aud`, or that is reachable on a second hostname the Access application does not cover, is also open.
  - The Worker cannot key on the GitHub id, only the email and Cloudflare `sub` (unless `get-identity`'s `idp` holds more; not confirmed). Email-based allowlists inherit whatever email GitHub returns.
  - Organization removal applies at next login, not continuously.
  - Needs Zero Trust in the Operator's account.

### Option B: Worker-owned web flow, Operator's own app

- **Viewer:** the Instance redirects to GitHub with a random `state` and a PKCE challenge stored in a short-lived cookie, then handles the callback, checks `state`, exchanges the code with the secret, reads `/user` with no scope, applies the allowlist (ids or organization or team), and sets its own session cookie.
- **Publisher approval:** an approval page on the Instance, behind the same sign-in. A signed-in allowlisted person who opens the Publisher's link approves it. The approval step must show the Publisher's label and require the person to type or confirm the code the Publisher printed, which answers RFC 8628 section 5.4.
- **Operator steps, OAuth App (4):** register the app with the callback set to one exact URL on the Instance's hostname; generate a secret; store the secret and client id on the Instance; set the allowlist. Turn wildcard matching off. With a **GitHub App and the manifest flow (about 2 clicks):** open the Instance's setup page, press the button, confirm on GitHub; the Instance receives and stores `client_id`, `client_secret` and `pem`. The Operator then still sets the allowlist.
- **Secrets the Instance holds:** the GitHub client secret, and a key to sign session cookies. A GitHub App from a manifest also yields a private key and a webhook secret the Instance does not need and should discard.
- **What can go wrong:**
  - **Fails open:** an empty allowlist that means "anyone". A first-visitor setup page (the manifest route) that is not locked to the Operator would let the first visitor register their own app into a fresh Instance. A missing `state` check (the reference's weakness).
  - Wildcard matching left on, with Drops under the same host.
  - Organization checks that accept a `pending` state or treat an error as "allowed".
  - Organization OAuth App restrictions hiding private membership.
  - The session cookie sits on the same origin as untrusted Drop HTML unless Drops are served elsewhere (ticket #12).
  - Two Instances cannot share one app unless the Operator registers every callback (10 at most).

### Option C: Device flow driven by the Instance, Operator's own app

- **Viewer:** not a good fit. The Viewer's browser would show a code and the Viewer would type it at GitHub, while the Instance polls. It works with no callback and no secret, but it has no browser-bound `state` and fits RFC 8628 section 5.4 phishing. Pair this option with Option A or B for Viewers.
- **Publisher approval:** the Publisher asks the Instance to start. The Instance calls `/login/device/code` with the Operator's client id and returns the `user_code` and URL to the Publisher, which shows them to the human. The human enters the code at GitHub. The Instance polls (one GitHub poll per Publisher poll, respecting `interval` and `slow_down`), reads `/user`, applies the allowlist and mints the Publisher token. The token comes from GitHub in reply to the Instance's own request, so there is no confused-deputy gap.
- **Operator steps (3):** register an OAuth App or GitHub App and tick "Enable Device Flow" (the callback URL is ignored by a GitHub App that uses device flow); put the client id in the Instance's config; set the allowlist. A GitHub App registered through the manifest flow cuts the first step to two clicks, but the manifest docs list no device-flow field, so one visit to the app's settings may still be needed.
- **Secrets the Instance holds:** none for GitHub. The client id is public.
- **What can go wrong:**
  - **Fails open:** an empty allowlist. Also: an attacker can start a flow with a label such as "your CLI", send the human a code, and the human's approval then binds the attacker's Publisher to an allowlisted identity. Add an Instance-side confirmation: after GitHub returns, hold the approval until an allowlisted person confirms a Publisher label and short code on an Instance page.
  - Polling must respect `interval`; excess polling returns `slow_down`.
  - Code lifetime 900 seconds, then a new flow.
  - The Instance needs a polling mechanism that survives a Worker request (a Publisher-driven poll endpoint is simplest).

### Option D: One project app, device flow, client id baked in

- **Viewer:** same limits as Option C.
- **Publisher approval:** same as Option C, with the project's client id.
- **Operator steps (1):** set the allowlist. Zero GitHub registrations.
- **Secrets the Instance holds:** none.
- **What can go wrong:**
  - **Fails open:** an empty allowlist. The same remote-phishing shape as Option C, and the consent screen a victim sees carries the project's name, which a hostile tool can reuse because the client id is public.
  - 50 code submissions per hour across all Instances. Past that, Publishers on every Instance cannot be approved.
  - Suspension of the project's app breaks every Instance together.
  - The consent screen names the project, not the Operator, so a Viewer cannot tell which Instance they are authorizing.
  - The project becomes a GitHub app owner with abuse-report exposure and a standing duty to keep the registration alive.
- **A softer variant:** ship the project's client id as the default and let the Operator override it with their own (Option C). Then zero-setup works at first and a suspended or throttled project app is something an Operator can route around.

### Summary

| | GitHub registrations per Operator | Secrets on the Instance | Viewer sign-in | Publisher approval | Main way it fails open |
|---|---|---|---|---|---|
| A. Access + GitHub IdP | 1 per Cloudflare account (OAuth App) | none | yes, via Access | page behind Access | permissive policy, unvalidated JWT |
| B. Worker web flow | 1 per Instance (or manifest: 2 clicks) | client secret, session key | yes | page behind sign-in | empty allowlist, unlocked setup route, missing `state` |
| C. Worker device flow, own app | 1 per Instance | none | poor fit | yes | empty allowlist, phished code |
| D. Shared project app, device flow | 0 | none | poor fit | yes | empty allowlist, phished code, shared quota and suspension |

A rejected shape: the Publisher presents a GitHub token (for example from the GitHub CLI) and the Instance checks it with `GET /user`. It needs no registration, but the Instance would see a broadly scoped token and could not tell which app minted it, so any app the person once authorized could impersonate them at the Instance. I do not recommend it.

## 8. Not confirmed

- **What Access's `get-identity` `idp` object holds for GitHub.** Looked at: the [GitHub IdP page](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/), [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), and the [policies page](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/). They name `idp` but never describe it for GitHub, so I cannot say whether login, numeric id, organizations or teams appear, or in what format group values are written. A test login against a real Access application would settle it, and I did not run one by constraint.
- **Which email Access takes from GitHub** and what it does when the account has no verified email.
- **How the dashboard labels the GitHub organization rule.** The API has `github-organization` with `name` and optional `team`; the selector table lists "Identity provider group" and no separate GitHub selector.
- **Whether OAuth App access restrictions block the Operator's own Access OAuth App**, and what error a restricted organization returns for a membership call (404, 403 or an empty list). The restrictions page says unapproved OAuth Apps lose "API access to private organization resources" but does not list the membership endpoints.
- **OAuth App endpoint scopes.** The REST pages for `GET /user/memberships/orgs/{org}`, `GET /orgs/{org}/members/{username}` and team membership give permissions for GitHub App and fine-grained tokens, and no OAuth scope. The `read:org` mapping comes from the Scopes page description.
- **Whether a GitHub App user token without installation sees private organizations** through `GET /user/orgs`, `GET /user/memberships/orgs/{org}` and `GET /user/teams`, and whether the "empty list for fine-grained tokens" note on `GET /user/orgs` applies to GitHub App user tokens. Looked at: the [Organizations REST page](https://docs.github.com/en/rest/orgs/orgs) and the Members page. The docs say a user token has "only permissions that both the user and the app have" and "can only access resources that both the user and app can access", which suggests the organization must have installed the app for the "Members" permission to apply. Not shown directly.
- **Whether apps created today have wildcard matching on or off by default.** The docs only describe the legacy default for single-callback apps created before 2026-08-03.
- **Whether GitHub accepts a PKCE-only token exchange without `client_secret`.** The docs say the secret is required; I did not test.
- **Whether the manifest flow can enable device flow.** The documented manifest parameters have no such field, and the docs say nothing about a later toggle through the API.
- **What a private GitHub App owned by a personal account allows.** The docs describe the organization-owned case ("Only members of the organization that owns it can authorize it") and say a private app "can only be installed on the account that owns the app". The personal-account authorization case is not spelled out.
- **What the consent screen shows for a no-scope request** and whether it shows the Instance's hostname in any form. The docs describe "the app's developer contact information and a list of the specific data that's being requested".
- **How the 50-per-hour device-code limit counts** (failed submissions, repeated codes) and whether the 2,000-per-hour token-request limit is per app or per user.
- **The device-flow error for a suspended app.** Only the web-flow `application_suspended` error is documented.
- **Whether the "Check a token" endpoint needs the client secret.** The page says "Authentication works differently with this particular endpoint" and does not say how in the text I read.
- **Whether `GET /orgs/{org}/members/{username}` returns 302 or 404 when the Viewer's OAuth token lacks the organization's approval.** Only the membership-based redirect is documented.
