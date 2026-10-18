# Serving untrusted Drop HTML next to a signed-in Viewer

Research for issue #5, "How do you serve untrusted HTML next to a signed-in session safely?". It feeds the decision ticket "Where is Drop HTML served from?" (#12). The owner decides. This note reports options and facts.

Read on 2026-10-05, from primary sources only. Versions read: Public Suffix List `2026-10-01_23-02-52_UTC`; HTML Standard and Fetch Standard (living, Fetch last updated 2026-09-21); CSP Level 3 working draft of 2026-09-16; Fetch Metadata working draft of 2026-09-21; the cookies draft `draft-ietf-httpbis-rfc6265bis` (expires 2027-04-03); MDN browser-compat-data 8.1.4; Cloudflare docs pages dated between 2026-05 and 2026-09; reference server `utsengar/the reference` at commit `ac00be7` (2026-08-23). Nothing was run: no reference code, no deploy, no Cloudflare API call.

## 1. Answer

Options that hold, strongest first. All three also need the common controls in section 3.0.

1. **Content on a second registrable domain** (the Operator's own custom domain). Every Drop is opaque (`Content-Security-Policy: sandbox`), the domain sets no cookies, and a gated Drop opens through a short-lived signed URL that the Instance issues to a signed-in Viewer. This is the GitHub, Google and Anthropic pattern. It costs the Operator a second domain.
2. **Content on a second Worker hostname in the same account**, which works on workers.dev, with the same controls as option 1. It separates origins but not sites.
3. **Same hostname**: `Content-Security-Policy: sandbox` on every Drop response, a sandboxed iframe, and a server that refuses cookie-authenticated requests unless they are `Sec-Fetch-Site: same-origin`. No setup, but it holds only while every Drop response carries the header and every check is right.

Not enough alone: an iframe `sandbox` attribute, which is what the reference does. MDN says sandboxing "is useless" if the Viewer can open the frame in a new tab. The reference's "raw" link does exactly that (`the reference/src/views/viewer.ts:228`), and its raw route sends no `sandbox` directive (`the reference/src/index.ts:745-746`).

The fact that most constrains the choice on workers.dev: `workers.dev` is a public suffix, so every hostname in one account (a second Worker, a version-URL alias) is a different origin but the same site as the Instance. SameSite and cookie partitioning cannot separate them. Only origin-level controls can: host-only cookies, an opaque origin, signed URLs, and refusing `Sec-Fetch-Site: same-site`.

Second constraint: the cookies draft computes a sandboxed document's "site for cookies" from its URL, so `Lax` and `Strict` cookies may still ride on credentialed requests from an opaque-origin Drop to its own Instance (browser behaviour not tested). Do not rely on SameSite. Check `Sec-Fetch-Site` and `Origin: null` on the server.

## 2. Findings

### 2.1 An iframe with `sandbox` and no `allow-same-origin`

**Origin.** The content gets a new opaque origin ([HTML Standard: determining the origin](https://html.spec.whatwg.org/multipage/document-sequences.html#determining-the-origin), first step: "If sandboxFlags has its sandboxed origin browsing context flag set, then return a new opaque origin"). An opaque origin serializes as `null` ([HTML Standard: origin, "serialization of an origin"](https://html.spec.whatwg.org/multipage/browsers.html)), so requests it makes carry `Origin: null` ([MDN: CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox), `allow-same-origin`).

**Storage.** The flag "prevents script from reading from or writing to the `document.cookie` IDL attribute, and blocks access to `localStorage`" ([HTML Standard: sandboxed origin flag](https://html.spec.whatwg.org/multipage/browsers.html#sandboxed-origin-browsing-context-flag)). `localStorage` and `sessionStorage` throw a `SecurityError` "if the Document's origin is an opaque origin" ([HTML Standard: Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)). Other storage APIs (IndexedDB, Cache, service workers) were not checked; see section 4.

**Network.** Nothing in the sandbox flags blocks `fetch`, XHR, `<img>`, WebSocket or nested iframes ([HTML Standard: sandboxing flags](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing-flag-set) lists the flags; none is a network flag). Which cookies those requests carry is section 2.3. A nested iframe inherits the embedder document's flags ([HTML Standard: "determine the creation sandboxing flags"](https://html.spec.whatwg.org/multipage/browsers.html), "the flags set on embedder's node document's active sandboxing flag set"), so a Drop cannot escape by nesting.

**Each token.** With an empty `sandbox` attribute everything below is blocked. Each token lifts one restriction ([MDN: iframe `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe); [HTML Standard: iframe `sandbox`](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)):

| Token | Effect | Browser support ([BCD](https://github.com/mdn/browser-compat-data)) |
| --- | --- | --- |
| `allow-scripts` | Scripts run. Popups still need `allow-popups`. | all, since the iframe attribute shipped |
| `allow-forms` | Forms submit. Without it a form renders, but submitting sends nothing. | all |
| `allow-modals` | `alert`, `confirm`, `print`, `prompt`, and the `beforeunload` event. `<dialog>` works regardless. | Chrome 46, Firefox 49, Safari 11.1 |
| `allow-popups` | `window.open` and `target="_blank"` work. Without it they "silently fail". | all |
| `allow-popups-to-escape-sandbox` | A popup, redirect or new tab opens without the sandbox flags. Without it they inherit the sandbox ([HTML Standard: "sandbox propagates to auxiliary browsing contexts"](https://html.spec.whatwg.org/multipage/browsers.html#sandbox-propagates-to-auxiliary-browsing-contexts-flag)). | Chrome 46, Firefox 49, Safari 11.1 |
| `allow-top-navigation` | The content can navigate the top-level page. | all |
| `allow-top-navigation-by-user-activation` | Same, only after a user gesture. The HTML Standard says that if both top-navigation tokens are present, only `allow-top-navigation` takes effect. | Chrome 58, Firefox 79, Safari 11.1 |
| `allow-top-navigation-to-custom-protocols` | Hands non-http navigations to other software. MDN: also switched on by `allow-popups` or `allow-top-navigation`. | Firefox 101, Safari 16; Chrome: not supported |
| `allow-downloads` | Downloads work, with or without a user click. | Chrome 83, Firefox 82, Safari 17 |
| `allow-same-origin` | The content keeps its real origin instead of an opaque one. | all |
| `allow-pointer-lock`, `allow-orientation-lock`, `allow-presentation` | Pointer Lock API, screen orientation lock, Presentation API. | orientation lock and presentation: not in Safari |
| `allow-storage-access-by-user-activation` | The document may request unpartitioned cookies through the Storage Access API. | Chrome 113, Firefox 65, Safari 11.1 |

**Top-level navigation, in plain terms.** Without an `allow-top-navigation*` token a sandboxed frame cannot navigate or close the top page. A sandboxed document can still navigate itself: the navigation flag blocks navigating contexts "other than the sandboxed browsing context itself" ([HTML Standard: sandboxed navigation flag](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing-flag-set)). So a Drop can always replace its own frame with a fake sign-in form or any other URL.

**The combination to avoid.** `allow-scripts` plus `allow-same-origin` on a same-origin frame lets the content remove the `sandbox` attribute and reload itself, "no more secure than not using the `sandbox` attribute at all" ([MDN: iframe `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), security notes; the HTML Standard carries the same warning).

**The caveat that matters here.** "Sandboxing is useless if the attacker can display content outside a sandboxed `iframe` — such as if the viewer opens the frame in a new tab. Such content should be also served from a _separate origin_ to limit potential damage" ([MDN: iframe `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)).

### 2.2 `Content-Security-Policy: sandbox` on the HTML response

**What it is.** The `sandbox` directive applies an HTML sandbox policy to the resource, "just as though it had been included in an iframe with a sandbox property". It takes the same tokens ([CSP Level 3, section 6.3.2](https://www.w3.org/TR/CSP3/#directive-sandbox)). It is ignored in a `Content-Security-Policy-Report-Only` header or a `<meta>` element (same section; [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox) says "not supported").

**A top-level navigation to the URL also gets an opaque origin.** Navigation computes `finalSandboxFlags` as the union of the navigable's own sandboxing flags and the response's CSP-derived sandboxing flags, then determines the document's origin from them, which gives "a new opaque origin" when the origin flag is set ([HTML Standard: create navigation params by fetching](https://html.spec.whatwg.org/multipage/browsing-the-web.html#create-navigation-params-by-fetching); [determining the origin](https://html.spec.whatwg.org/multipage/document-sequences.html#determining-the-origin)). This runs for any navigable, top-level included. MDN does not say outright that the directive applies to a directly opened document; it says the directive applies to "the requested resource", and that the `allow-top-navigation` values "only make sense for embedded documents" and have no effect on standalone ones ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)). The HTML Standard algorithm is the source for the opaque origin.

**Cookies on that navigation.** The browser sends the navigation request before it can see the response's CSP, because the flags are computed from the response in the algorithm above. So a Viewer who follows a direct link to the raw URL sends the Instance's ordinary cookies on that request. This is my reading of the algorithm's order, not a sentence in a spec. The sandbox protects what happens after the response arrives.

**Cookies on the document's subresource and `fetch` requests.** The document is opaque-origin, so the rules in section 2.3 apply unchanged: default `fetch` sends none, `credentials: "include"` and element loads (`<img>`, `<script>`, `<iframe>`) can send them.

**`frame-ancestors` does not stop direct navigation.** CSP3's frame-ancestors check says "If target is not a child navigable, return 'Allowed'" ([CSP Level 3, frame-ancestors navigation response check](https://www.w3.org/TR/CSP3/#frame-ancestors-navigation-response)). The header only controls framing. A direct top-level load always works. The `sandbox` directive is what makes that load safe.

**A sandboxed top-level Drop can still show anything.** It can render a fake sign-in page and, with `allow-forms`, submit it. The directive set also has `form-action`, `connect-src` and other directives that could block forms to other hosts and exfiltration ([CSP Level 3](https://www.w3.org/TR/CSP3/)). That blocks Drops that legitimately call other services, so it is an owner decision, not a default.

**Browser support.** Baseline "widely available", "available across browsers since November 2016" ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)). Chrome 25, Edge 14, Firefox 50, Safari 7, with the same versions on mobile ([BCD, `http/headers/Content-Security-Policy/sandbox`](https://github.com/mdn/browser-compat-data)).

**An attribute versus a header.** A script cannot remove a header. With the iframe attribute only, the framed load is sandboxed and the direct link is not. With the header, both are, because flags from the attribute and the response are unioned. Section 3 therefore uses the header as the control and treats the iframe attribute as additional.

### 2.3 Requests from an opaque-origin Drop to the Instance's hostname

Three layers decide whether the Viewer's cookie rides along. They disagree, which is why the server needs its own check.

**Layer 1: Fetch credentials mode.**

- `fetch(url)` with no options: the credentials mode defaults to `same-origin` ([Fetch Standard, `RequestInit`](https://fetch.spec.whatwg.org/#request-class)). A request is credentialed in that mode only when its response tainting is `basic`, which needs a same-origin request ([Fetch Standard, HTTP-network-or-cache fetch](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)). An opaque origin is not same-origin with the Instance, so no cookies are sent. The request carries `Origin: null`, because mode `cors` always appends `Origin` ([Fetch Standard, append a request `Origin` header](https://fetch.spec.whatwg.org/#append-a-request-origin-header)).
- `fetch(url, { credentials: "include" })`: cookies are included if the cookie rules allow. A "simple" request (safelisted method such as `POST`, safelisted content type, no custom headers) needs no preflight ([Fetch Standard](https://fetch.spec.whatwg.org/#http-fetch), the `use-CORS-preflight`/`unsafe-request` condition). So the request is sent and its side effects happen even if the response is never readable.
- `<img>`, `<script>`, `<link>` and similar elements without a `crossorigin` attribute: the request is `no-cors` with credentials mode `include` ([HTML Standard: create a potential-CORS request](https://html.spec.whatwg.org/multipage/urls-and-fetching.html#create-a-potential-cors-request)). GET only, response unreadable, cookies sent if the cookie rules allow.
- A form post (needs `allow-forms`) is a navigation. It carries cookies by the navigation rules, and `Origin: null` ([Fetch Standard, append a request `Origin` header](https://fetch.spec.whatwg.org/#append-a-request-origin-header)).

**Can the Drop read the response?** Only if the Instance lets it. The CORS check passes only when `Access-Control-Allow-Origin` equals the serialized request origin, which is the string `null`, and, for a credentialed request, `Access-Control-Allow-Credentials: true`; a `*` never works for a credentialed request ([Fetch Standard, CORS check](https://fetch.spec.whatwg.org/#concept-cors-check)). So the Instance must never send `Access-Control-Allow-Origin: null` or reflect `Origin`. A public response with `*` and no credentials is readable by anyone and exposes nothing.

**Layer 2: SameSite.** This is where it gets uncomfortable. The cookies draft defines a request's "site for cookies" by walking the document and its ancestors, and for each document it uses "the origin of item's URI if item's sandboxed origin browsing context flag is set" instead of its opaque origin ([RFC 6265bis, section 5.2.1](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-5.2.1)). So, per the draft, a sandboxed Drop framed by its own Instance has the same site as the Instance, its requests count as same-site, and `SameSite=Lax` and `SameSite=Strict` cookies are attached whenever Layer 1 allows credentials ([RFC 6265bis, section 4.1.2.7](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-4.1.2.7)). `SameSite` therefore does not stop an opaque-origin Drop on the Instance's own hostname. I did not test whether browsers implement this rule; see section 4.

**The Access cookie's attributes** (Cloudflare's own table, [Authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)):

| Cookie | HttpOnly | SameSite | Lifetime |
| --- | --- | --- | --- |
| `CF_Authorization` on the application domain | "Admin choice (Default: None)" | "Admin choice (Default: None)"; options None, Lax, Strict | policy session, else application session, else 24 hours |
| `CF_Authorization` on the team domain | Yes | None | global session, else application session, else 24 hours |
| `CF_AppSession` (CSRF token per application) | Yes | None | 24 hours |

The same page says "Strict" can cause `ERR_TOO_MANY_REDIRECTS`, and tells admins to use None or Lax. It does not mention a `Secure` attribute. The section on HttpOnly says "This flag is enabled by default", which conflicts with the table's "Default: None" (section 4). With the Default SameSite None the Access cookie is eligible for cross-site requests too, so a hostile page can have the browser send it.

**Consequence for the Worker.** Access checks the cookie at the edge before the Worker runs, and passes the application token to the Worker as `Cf-Access-Jwt-Assertion` ([Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/); [Workers: Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), "every request is checked before your Worker runs"). So a request that a hostile Drop caused the browser to send arrives looking like a signed-in Viewer's. This is my inference from those two pages. A valid Access identity does not prove the Viewer meant the request.

**Layer 3: what the server can check.**

- `Origin: null` on any `cors`-mode request or form post: refuse. A real Instance page sends its own origin, or no `Origin` on a plain GET.
- `Sec-Fetch-Site`: the value is computed as `same-origin` if the URL is same-origin with the request's origin, `same-site` if same site, else `cross-site` ([Fetch Metadata, "set the Sec-Fetch-Site header"](https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header)). An opaque origin is neither same-origin nor same-site with anything, so by the algorithm the value is `cross-site`. This is my reading of the algorithm, not a stated example. A sibling hostname on workers.dev sends `same-site`.
- `Sec-Fetch-Dest` and `Sec-Fetch-Mode`: `iframe` or `document` and `navigate` for the page loads. A script cannot forge them because `Sec-` names are forbidden request headers ([Fetch Metadata, section 4.2](https://www.w3.org/TR/fetch-metadata/#sec-prefix); [Fetch Standard, forbidden request-header name](https://fetch.spec.whatwg.org/#forbidden-request-header)).
- Support: Sec-Fetch-Site and -Mode in Chrome 76, Edge 79, Firefox 90, Safari 16.4; Sec-Fetch-Dest in Chrome 80 ([BCD](https://github.com/mdn/browser-compat-data)). A request with none of these headers comes from an older browser or a non-browser client, and the policy for that case is a choice.
- Never send CORS headers with credentials. Authenticate the Publisher API with a bearer token (as the reference does), which no browser attaches on its own.

### 2.4 A separate content origin

#### What a different hostname buys over an opaque origin

- An opaque origin is a flag on one document. If the flag is missing for any reason (a route that forgets the header, an error page, a redirect, an `allow-same-origin` added later), the Drop runs at the Instance's real origin with the Viewer's cookies. On a different hostname the same mistake lands the Drop on an origin that holds none of them. A cookie set without a `Domain` attribute is host-only and goes only to that exact host ([RFC 6265bis, section 5.7 storage model](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-5.7): "Set the cookie's host-only-flag to true").
- Google's engineers say the same: "placing some of the high-risk content in separate, isolated web origins... the 'sandboxed' files pose virtually no threat to the applications themselves, or to google.com authentication cookies" ([Google Security Blog, 2012](https://security.googleblog.com/2012/08/content-hosting-for-modern-web.html)).
- A real (non-opaque) origin gives every Drop on it a shared origin: shared `localStorage`, readable cross-Drop `fetch`. Keep Drops opaque with the `sandbox` header on the content origin too, or use one hostname per Drop. MCP Apps takes the other route: its sandbox proxy carries `allow-scripts` and `allow-same-origin`, which is safe only because host and sandbox "MUST have different origins" ([MCP Apps spec, "Sandbox proxy"](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)) and each View can get a dedicated origin (`_meta.ui.domain`, same file).

#### Is `workers.dev` a public suffix?

Yes. The Public Suffix List, version `2026-10-01_23-02-52_UTC`, under "Cloudflare, Inc." in the private-domains section, lists these entries one per line, plain, not wildcard ([public_suffix_list.dat](https://publicsuffix.org/list/public_suffix_list.dat)): `pages.dev`, `r2.dev`, `workers.dev`, `trycloudflare.com`, `cloudflare.app`. The registrable domain is therefore `<account-subdomain>.workers.dev` ([RFC 6265bis, definitions](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html): the registrable domain is "the domain's public suffix plus the label to its left"). Consequences:

1. A cookie with `Domain=workers.dev` is rejected, because a `Domain` equal to a public suffix is ignored unless it equals the request host ([RFC 6265bis, section 5.7](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-5.7)). A cookie with `Domain=<account-subdomain>.workers.dev` is accepted.
2. Two Workers in one account, `a.<account-subdomain>.workers.dev` and `b.<account-subdomain>.workers.dev`, are **same-site and cross-origin**. SameSite does not separate them, and `Sec-Fetch-Site` between them is `same-site`.
3. Host-only cookies are still not sent to the sibling. Cookies are not protected against writes from a sibling, though: a sibling "can set a cookie with a Domain attribute" of the shared domain and the other host "will be unable to distinguish this cookie from a cookie it set itself" ([RFC 6265bis, section 8.6](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-8.6)). The `__Host-` prefix blocks that for a cookie you name that way: it requires `Secure`, `Path=/` and no `Domain` ([section 4.1.3.2](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-4.1.3.2)). Cloudflare names its own cookie `CF_Authorization`, which cannot carry the prefix. Whether a sibling can plant or shadow it is not confirmed (section 4).
4. A genuinely separate site on workers.dev means another account subdomain, so another Cloudflare account. One Instance lives in one account (map Notes, "Each Operator deploys their own Instance"), so this is not available inside an Instance. This is inference, not a Cloudflare statement.
5. Other products are on the list as their own sites: `githubusercontent.com`, `github.io`, `claudeusercontent.com`, `frame.claudeusercontent.com`, `*.usercontent.goog` (same file). `oaiusercontent.com` is not on this version of the list.

#### How an Instance gets a second hostname on workers.dev

- **A second Worker.** "All Workers are assigned a `workers.dev` route... `<YOUR_WORKER_NAME>.<YOUR_SUBDOMAIN>.workers.dev`" ([Cloudflare: workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)). Each Worker has one such route, so a second hostname means a second Worker, deployed by the Operator's setup. Both Workers can bind the same storage; whether a service binding is simpler is a build question. Cloudflare Access can protect one Worker, a hostname, or all Workers; the rule for the most specific match wins: hostname or path rule, then Worker rule, then account rule ([Cloudflare: Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), "Understand Access hierarchy").
- **A version-URL alias.** `<alias>-<worker-name>.<subdomain>.workers.dev`, created with `wrangler versions upload --preview-alias <alias>`; "Aliases may only be created during version upload" ([Cloudflare: Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)). The same page lists the limits that make it a poor content origin:
  - It "uses that Worker version's existing configuration and resources", so the hostname reaches that uploaded version, not whatever is deployed later. The alias would need re-pointing on every release (the page does not say whether re-using an alias name moves it; section 4).
  - Not generated for Workers that implement a Durable Object.
  - "When enabled, Version URLs are publicly available."
  - No Workers Logs, `wrangler tail` or Logpush for these URLs.
  - Only the 1000 most recently deployed aliases are kept.
  - "Disabling your `workers.dev` route does not disable" version or preview URLs ([workers.dev page](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)), so the Operator has a second public surface to turn off.
- **Wildcards on workers.dev.** I found no documented way to get per-Drop hostnames on workers.dev.

#### How an Instance gets a second hostname on a custom domain

- A Worker can have several Custom Domains: "You can add multiple Custom Domains" ([Cloudflare: Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). One deployment can answer on `app.example.com` and `content.example.com` and branch on the `Host` header. A Custom Domain needs an active Cloudflare zone for that domain.
- Both names under one zone share a registrable domain, so they are same-site, as on workers.dev. Cross-site separation needs a second domain in a Cloudflare zone, the GitHub and Anthropic arrangement.
- Per-Drop hostnames: Routes accept `*.example.com/*` ([Cloudflare: Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)) with a proxied wildcard DNS record ([Cloudflare: wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)). Universal SSL covers the root and first-level subdomains only; deeper names "will not serve a valid certificate" ([Cloudflare: Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)). So `<id>.example-content.com` works under Universal SSL, `<id>.content.example.com` does not. What the extra certificate costs was not checked.
- The map's standing note applies: `wrangler deploy` replaces a Worker's custom domains, so check them before and after a deploy.

#### What a gated Drop needs so only the signed-in Viewer can load it from the other origin

Copying the Viewer's session cookie to the content origin "would defeat the purpose" ([Google Security Blog, 2012](https://security.googleblog.com/2012/08/content-hosting-for-modern-web.html)). The two products that publish how they do this use a secret in the URL:

- Google moves "the secret token used to confer access rights from the Cookie header to a value embedded in the URL", unique per document. It names the cost: "more ways to accidentally leak a capability-bearing URL than... cookies", mainly through the `Referer` header. For higher-risk documents it adds short-lived, document-specific cookies on specific subdomains; for lower-risk, user-bound or quickly expiring URLs (same post).
- GitHub's raw button on a private file produces a URL with "a cryptographically signed, time-limited token" that "works for anyone holding the URL until it expires" ([GitHub bug bounty: `*.githubusercontent.com`](https://bounty.github.com/targets/githubusercontent-com.html)).

For htmlgate that means: the Instance, after it has verified the Viewer, issues a URL with a short-lived token bound to the Drop, its version and an expiry. The content origin checks the token with a secret it shares with the Instance, sets no cookies, and sends `Referrer-Policy: no-referrer`. Binding the token to the Viewer's identity would stop a forwarded link, but it needs the Viewer's identity at the content origin, which is the problem the design avoids. Which of these to do is for #12.

Why not a cookie on the content origin: a cross-site iframe makes that cookie a third-party cookie. Cloudflare warns that private windows "may block third-party cookies, including `CF_Authorization`" ([Authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)). MDN's account of browser defaults: Firefox and Safari block or partition third-party cookies by default, and Chrome "doesn't block third-party cookies by default, only in Incognito mode" ([MDN: third-party cookies](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies)). Partitioned cookies (`Partitioned`, Chrome 114, Edge 114, Firefox 141, Safari 26.2 per [BCD](https://github.com/mdn/browser-compat-data)) key a cookie jar by top-level site, "a separate cookie jar per top-level site" ([MDN](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies)). That makes them usable for an embedded widget, but they do not share the Viewer's session with another site and they are not a tool for separating Drops. On workers.dev the sibling Worker is same-site, so a cookie there is not third-party by definition; whether Access's login redirect works inside an iframe was not found documented (section 4).

### 2.5 What the reference does and what it leaves open

All paths are in `the reference/src/`, at commit `ac00be7`.

**What it does.**

- The viewer page frames the Drop as `<iframe src="/p/<slug>/raw" sandbox="allow-scripts allow-forms allow-modals allow-downloads">` (`views/viewer.ts:245-249`). There is no `allow-same-origin`, so the frame is opaque. There is no `allow-popups` or `allow-top-navigation`.
- The raw route `/p/:slug/raw` (`index.ts:700-748`) serves the HTML from KV with `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: frame-ancestors 'self'; base-uri 'none'; form-action 'self' https:` (`index.ts:741-746`). Its own comment says the CSP is there to "block top-level navigation hijacking and disallow being framed by other origins". Per section 2.2, `frame-ancestors` does neither for a top-level load.
- `safety-net.ts` injects layout CSS and a viewport meta tag into every raw response. It has nothing to do with isolation (`safety-net.ts:26-33`, `index.ts:731`).
- Global headers (`index.ts:61-118`): HSTS, `nosniff`, a `Referrer-Policy`, a `Permissions-Policy`. No CORS anywhere, on purpose ("Disallowing browser cross-origin XHR is a feature", `index.ts:58-60`), which is what keeps the opaque-origin Drop from reading responses.
- The README states the intent: "Iframe sandbox + CSP `frame-ancestors 'self'` on `/p/:id/raw` to prevent UI redress / clickjacking from external sites" (`README.md:271-272`). The aim is clickjacking, not Viewer impersonation.

**What it leaves open.**

1. **The direct link.** The viewer bar has a "raw" link with `target="_blank"` (`views/viewer.ts:228`). The raw response carries no `sandbox` directive, so that tab runs the Drop at the app's real origin, with full same-origin access to everything the origin serves and to the cookies the browser sends there. This is the case MDN warns about.
2. **Why that is survivable in the reference but not for htmlgate.** The reference has no ambient Viewer session. Its API takes a bearer token (`auth.ts:134-135`), and its only cookie is a per-Drop passcode cookie `wu_<slug>`, `HttpOnly; Secure; SameSite=Lax; Path=/p/<slug>` (`index.ts:674`). Path is not a security boundary ([RFC 6265bis, section 8.6](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-8.6)), but the cookie only unlocks one Drop's own HTML. htmlgate adds a Viewer session cookie or `CF_Authorization`, which turns the same hole into impersonation.
3. **Referrer policy likely overwritten.** The raw route sets `no-referrer` (`index.ts:742`) but the global middleware sets `strict-origin-when-cross-origin` after the handler returns (`index.ts:61-70`). Reading the code, the later `set` wins. I did not run it.
4. **Forms.** `allow-forms` with `form-action 'self' https:` lets the Drop submit forms to the Instance and to any https host (`viewer.ts:248`, `index.ts:746`). That is both a phishing aid and a way to hit the Instance's own POST routes with `Origin: null`.
5. **No `connect-src` limit on the raw route.** A Drop can send data anywhere. For a gated Drop that is the Drop's own content leaving, not another Drop's.
6. **Caching.** Non-passcode Drops are served with `public, max-age=60, s-maxage=300` (`index.ts:736-738`). That is right for the reference's public Drops; every htmlgate Drop starts gated, so a shared cache must not hold them.
7. **No check on how the raw route is reached.** It does not look at `Sec-Fetch-Dest`, so direct loads and any other page's frame work as long as `frame-ancestors 'self'` allows the frame.

### 2.6 How other products isolate user-written HTML

- **GitHub.** Since 2014 user-generated content is served from `githubusercontent.com` instead of `github.com` subdomains, to "better isolate your content from potentially malicious content uploaded by other users" ([GitHub developer changes, 2014-04-25](https://developer.github.com/changes/2014-04-25-user-content-security/)). Today: "the domain separation **is** the security control", the domain is "served away from `github.com` precisely so that untrusted content cannot reach `github.com` cookies or session state", and a CSP is added on top as defense in depth. Private raw files are reached through "a cryptographically signed, time-limited token" ([GitHub bug bounty: `*.githubusercontent.com`](https://bounty.github.com/targets/githubusercontent-com.html)). Pattern: a separate registrable domain, on the PSL, with signed URLs for private content.
- **Google.** Risky content goes to separate origins, "most commonly `*.googleusercontent.com`", with "random or user-specific subdomains" when unrelated documents must be isolated from each other; private documents use per-document URL tokens, sometimes plus short-lived cookies, with the Referer leak named as the main risk ([Google Security Blog, 2012](https://security.googleblog.com/2012/08/content-hosting-for-modern-web.html)). The post is from 2012; I found no newer first-party version. Pattern: separate site, per-Drop hostnames where needed, capability URLs.
- **Anthropic.** "The viewer on claude.ai loads each artifact from a sandboxed `*.claudeusercontent.com` origin" ([Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts)). The artifact is a static page served under a strict CSP, whose `fetch` reach is "only the page's own origin" and Google Fonts (same page). `claudeusercontent.com` and `frame.claudeusercontent.com` are on the PSL (list above). Anthropic's docs do not publish the iframe `sandbox` tokens.
- **MCP Apps (Anthropic, OpenAI and others).** If the host is a web page it "MUST wrap the View ... through an intermediate Sandbox proxy", and "The Host and the Sandbox MUST have different origins". Example dedicated origins: `{hash}.claudemcpcontent.com` and `www-example-com.oaiusercontent.com` ([MCP Apps spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). The draft spec keeps "The Host and the Sandbox MUST have different origins" while it softens the proxy-ready and resource-ready notification steps from MUST to SHOULD ([draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx), "Sandbox proxy").
- **OpenAI.** Apps SDK widgets "run inside an isolated iframe with a strict Content Security Policy" with no nested frames by default ([OpenAI Apps SDK: Security and privacy](https://developers.openai.com/apps-sdk/guides/security-privacy)); the component origin defaults to `https://web-sandbox.oaiusercontent.com` and is "unique per plugin" for submissions ([OpenAI Apps SDK: Reference](https://developers.openai.com/apps-sdk/reference)).

All of them separate the origin first and add a CSP second. None relies on an iframe attribute alone.

## 3. Options for htmlgate

### 3.0 Controls common to every option

These come from the facts above and apply whichever option the owner picks.

1. **Header on every Drop response.** `Content-Security-Policy: sandbox allow-scripts` (plus only the tokens the owner decides to grant), with `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, and `frame-ancestors` naming the viewer page's origin. Cover HEAD, error pages and redirects. The `Report-Only` header and `<meta>` do not count (section 2.2).
2. **Own cookie hardening.** The Instance's own session cookie is `__Host-`prefixed, `Secure`, `HttpOnly`, `Path=/`, no `Domain`. This protects the cookie's integrity against a sibling (section 2.4); it does not stop a sandboxed same-site request from carrying it (section 2.3).
3. **A server check on cookie-authenticated and Access-authenticated requests.** Accept `Sec-Fetch-Site: same-origin`; accept `none` only for top-level GET navigations; refuse `same-site` and `cross-site`; refuse `Origin: null`. Never send `Access-Control-Allow-Origin: null`, reflect `Origin`, or send credentialed CORS headers. The policy for requests with no `Sec-Fetch-*` headers is for #12 to settle.
4. **The Publisher API uses bearer tokens**, which no browser attaches by itself.
5. **The same isolation applies to Public Drops.** A signed-in Viewer can open one too.

The shared test: a hostile fixture Drop that, from inside the served page, (a) reports `self.origin`, (b) reads `document.cookie` and `localStorage`, (c) calls `fetch` against an Instance API with and without `credentials: "include"` and tries to read the result, (d) fires an `<img>`, a form POST and a simple `fetch` POST at a state-changing Instance route, (e) tries `window.open`, `top.location` and `parent.document`, and (f) tries to fetch another Drop. Run in a real Chromium against the real entry point, with a signed-in Viewer, both inside the viewer's iframe and by loading the Drop URL as a top-level page. Expected: origin `"null"`, no cookie or storage access, no readable response, the state-changing route refused with 403 and the data unchanged. The control for each option is the same fixture with the protection removed, which must turn the test red (the map requires a header to be seen on a served response, with a control that fails without it).

### 3.1 Option A: same hostname, `sandbox` header plus iframe (the reference, with its missing header)

- **Protects against.** A Drop acting as the Viewer through cookie reads, same-origin reads of other Drops, or reads of the Instance's API responses, in the framed view and on a direct link.
- **Leaves.** Everything depends on the header and the server checks being right on every response. One miss puts the Drop at the Instance's origin with the Viewer's cookies. Credentialed `<img>`, simple `fetch` and form requests still carry the cookie, so the server's `Sec-Fetch-Site` and `Origin` checks are the only barrier for side effects. Phishing: a direct link shows the Instance's real hostname in the address bar above a Drop that can render a sign-in page (the highest-quality imitation of the four options). Top-level navigation: the Drop can navigate itself away. Direct link to the raw HTML: works, so the Viewer can be sent there. The Drop could be checked with `Sec-Fetch-Dest: iframe` to refuse direct loads, in Chrome 80+, Firefox 90+, Safari 16.4+ (section 2.3).
- **Costs the Operator.** Nothing. No second hostname, no extra secret, no extra deploy step.
- **Test and control.** The shared test in 3.0 against the Instance's own hostname. Add a header test on every Drop-returning route. Controls: serve the Drop without the `sandbox` directive and the fixture reads `document.cookie` and the API response; remove the `Sec-Fetch-Site` check and the form POST changes data.

### 3.2 Option B: a second Worker hostname in the same account (works on workers.dev)

- **Protects against.** Everything in Option A, plus the failure case: if a Drop response ever lacks the header, the Drop is on an origin that holds none of the Viewer's host-only cookies. The Instance Worker's session cookie and `CF_Authorization` are scoped to the Instance's hostname.
- **Leaves.** Same site as the Instance (section 2.4, consequence 2): SameSite gives no protection, a sibling can write cookies for the shared domain (cookie tossing) so the Instance's `__Host-` cookie is needed and `CF_Authorization` stays exposed to that, and a request from the content hostname to the Instance arrives as `Sec-Fetch-Site: same-site` and must be refused. The signed URL is a capability: anyone holding it can load the Drop until it expires, and it can leak through `Referer` (Google's named risk). Phishing: the address bar shows the content hostname, not the Instance's, which is easier to notice and still imitable. Top-level navigation: the Drop can navigate itself away. An Access redirect inside the iframe, if the content Worker were put behind Access, is not confirmed to work (section 4), so the content Worker should not depend on it.
- **Costs the Operator.** A second Worker and a shared secret between the two, both created by setup; a second public hostname to know about. The signed URL needs a short expiry and a refresh path. If the Operator puts account-level Access on all Workers, the content Worker needs its own bypass or the token check will never be reached (Cloudflare: Access hierarchy).
- **Test and control.** The shared test in 3.0, with the Drop loaded from the content hostname. Add: a content-origin response has no `Set-Cookie`; the request to the content hostname carries no Instance cookie; a token for Drop A returns the same refusal for Drop B, for an expired token and for a tampered one; the response has `Referrer-Policy: no-referrer`; a request from the content hostname to the Instance API is refused as `same-site`. Controls: set a cookie with `Domain=<account-subdomain>.workers.dev` from the content hostname and confirm the Instance's `__Host-` handling ignores it; with the `sandbox` header removed from the content origin, the fixture reads other Drops through its shared origin storage, so the test goes red.

### 3.3 Option C: custom domains, with content on a second registrable domain (optionally one hostname per Drop)

- **Protects against.** Everything in Option B, and it is cross-site as well: the browser's own site separation (SameSite, third-party cookie handling) applies between Instance and content, and no sibling can write cookies for the Instance's registrable domain. With one hostname per Drop (wildcard route), Drops cannot read each other even without the `sandbox` header (Google's "random or user-specific subdomains").
- **Leaves.** The same capability-URL leak risk, the same self-navigation and phishing, and a direct link that works for anyone with a live URL. Loading a cross-site iframe makes any cookie there third-party, so the design must not use cookies on the content domain (signed URLs only).
- **Costs the Operator.** Owning and putting a second domain on Cloudflare (plus the first, if the Instance has one); DNS changes, which the map says need the owner's OK for the first Instance; a wildcard record and a route for per-Drop hostnames; certificates for any deeper names than first-level (section 2.4); and the `wrangler deploy` custom-domain check.
- **Test and control.** The shared test in 3.0, with the Drop loaded from the second domain; the Option B token and cookie tests; and a test that the Viewer's cookies are absent from requests to the content domain. With per-Drop hostnames, add a fixture Drop that fetches another Drop's hostname and cannot read it with the `sandbox` header removed (control: same hostname for both Drops makes the read succeed).

### 3.4 Option D: the same Worker on a version-URL alias (a weak variant of B)

- **Protects against.** The same as B, from one deployment.
- **Leaves.** Everything B leaves, plus the alias points at one uploaded version; it is public; it has no logs; it does not exist for a Worker with a Durable Object; at most 1000 aliases are kept; and turning off `workers.dev` does not turn it off (section 2.4).
- **Costs the Operator.** Re-running `wrangler versions upload --preview-alias` on every release, which is fragile for a release process, and a constraint on the storage choice (no Durable Objects).
- **Test and control.** As B, plus a test that the alias serves the version that was just deployed (control: deploy without re-pointing the alias and the test fails).

## 4. Not confirmed

- **Whether browsers implement the cookies draft's sandboxed-site rule** (section 2.3, Layer 2). I read the draft only, which says a sandboxed document's "site for cookies" comes from its URL's origin. I did not run a browser or read web-platform-tests. Looked at: RFC 6265bis section 5.2.1. The designs above do not depend on the answer either way.
- **`CF_Authorization` HttpOnly default.** The cookie table says "Admin choice (Default: None)" while the HttpOnly section says "This flag is enabled by default". It was not settled. The `Secure` attribute is not mentioned. Looked at: [Authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/), page dated 2026-08-03. It does not change the designs: no option runs a Drop at the Instance's origin, and an opaque origin cannot read `document.cookie`.
- **Whether `CF_Authorization` is host-only on a workers.dev hostname**, and so whether a sibling Worker can shadow it with a `Domain=<account-subdomain>.workers.dev` cookie. Cloudflare says only that it is "stored as a cookie on the protected domain". Looked at: the same page and the Access-for-Workers page.
- **Whether an Access login redirect works inside an iframe** (framing of the team-domain login page, third-party cookie handling for the content hostname). Looked at: the Access, Authorization cookie and Workers Access pages; not documented there.
- **IndexedDB, Cache API and service workers under an opaque origin.** Only `document.cookie`, `localStorage` and `sessionStorage` were confirmed. Looked at: HTML Standard (sandboxing flags, Web Storage) and the W3C IndexedDB page, where I found no opaque-origin text.
- **Whether re-running `versions upload --preview-alias X` moves an existing alias** to the new version. The page says "The alias points at the version uploaded by that command" and that aliases "may only be created during version upload". Looked at: [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/).
- **Any wildcard or per-Drop hostname on workers.dev.** None found. Looked at: workers.dev and Version URLs pages.
- **The cost of a certificate for hostnames deeper than first-level**, and whether Custom Domains accept wildcards (the docs show wildcard Routes plus a proxied wildcard DNS record, not wildcard Custom Domains). Looked at: Custom Domains, Routes, Universal SSL limitations, wildcard DNS pages.
- **`Sec-Fetch-Site: cross-site` for opaque-origin requests.** I derived it from the algorithm in the Fetch Metadata draft; no spec example states it, and I ran no browser.
- **That the cookie-sending order is request first, CSP second** on a direct navigation to a `sandbox` response. Derived from the order of the navigation algorithm, not stated as a sentence.
- **Anthropic's and OpenAI's exact iframe `sandbox` tokens.** Their docs name the isolated origin and the CSP but not the attribute values. Looked at: Claude Code artifacts and network pages, OpenAI Apps SDK security and reference pages.
- **Browser third-party cookie defaults in 2026.** The MDN page was read as of 2026-10-05; I did not test a browser.
- **Reference behaviour.** Everything in section 2.5 is from reading source, including the `Referrer-Policy` overwrite. Nothing was run.
- **A sharper source for the 2012 Google post's current practice.** It is the only first-party Google write-up I found on this; its date is 2012.
