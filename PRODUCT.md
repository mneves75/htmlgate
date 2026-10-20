# Product

<!-- impeccable:product-schema 1 -->

Facts below come from README.md, GLOSSARY.md, docs/operator.md and the code. Lines marked
(inferred) were not confirmed by the owner in an interview. On 2026-10-09 the owner chose the
Departures direction, a Shares list on the Author's home, and a per-Instance page language.

## Platform

web

## Users

- **Author / Operator**: one technical person who runs an Instance in their own Cloudflare
  account and works with coding agents every day. They visit the Instance to create or revoke
  Publisher tokens and to find what their agents published.
- **Viewer**: a person on the Allowlist who opens a Share from a link someone sent, often on a
  phone, after signing in with Cloudflare Access. They want the Share, not the chrome. (inferred:
  phone and chat-app links)
- **Landing visitor**: a developer deciding whether to install htmlgate, reading pt-BR first
  (htmlgate.com) or English (/en/).

## Product Purpose

An agent publishes one self-contained HTML document (a Share) with one command and gets a stable
link. The link opens only for people on the Operator's Allowlist after they sign in, unless that
one Share is made public. Success: the Author sends a link instead of a screenshot, and only the
right people can open it.

## Positioning

HTML behind a gate, in your own account: private by default, public only by an explicit call,
and nobody else holds the credentials. Free; the Cloudflare bill is the Operator's.

## Operating Context

The `htmlgate` CLI and agents publish; people only read. The Instance's pages are home (the
Author's 50 most recently updated Shares; a Viewer's home lists nothing), tokens, the Share viewer
and not-found. A Share keeps its latest 20 Versions at one URL. Viewers arrive
from chat links; the Author arrives from a terminal.

## Capabilities and Constraints

- Instance pages run no script and load nothing from elsewhere: one stylesheet allowed by its
  CSP hash, inline SVG, system fonts. Every response is `no-store`, except the card image at `/og.jpg`, which a crawler must be able to cache.
- Landing pages run no script: one same-origin stylesheet, the SVG favicon and self-hosted
  demonstration videos with JPEG posters. The social preview reuses a poster. No web fonts or
  `url()` in CSS.
- Every page passes axe WCAG 2.2 AA in light and dark, never scrolls sideways at 320 px, and
  loads under 50 ms at p95 locally.
- Share HTML runs in a sandboxed iframe (opaque origin). The viewer cannot style or read it.
- Vocabulary is fixed by GLOSSARY.md: Share, Version, Instance, Author, Publisher, Token,
  Viewer, Allowlist, Gated Share, Public Share.
- Instance pages speak one language per Instance, set by the Operator (`language` in
  instance.json: `en`, the default, or `pt-BR`). The landing is pt-BR at `/` and en-US at `/en/`.

## Brand Commitments

- Name: htmlgate. Mark: an arched gate over a threshold (`MARK` in src/pages.ts, favicon.svg).
- Voice on the landing: direct, informal pt-BR, no hype, no invented proof, no em dashes.
  Enforced by test/reviewer-landing.test.ts.
- Not affiliated with any upstream service.

## Evidence on Hand

No users, testimonials, customers, logos or benchmarks exist before 0.1, and none may be shown.
Real facts that can be shown: the CLI commands, the limits (2 MiB, 20 Versions, 5 GB), the
security model, Node 26, the MIT licence.

## Product Principles

1. Private by default: the safe state is the starting state, and the page says which state a
   Share is in.
2. The Share is the point: chrome around it stays thin and quiet.
3. Say what is true: every number and command on a page matches the code.
4. No script and nothing from elsewhere: the pages stay fast and auditable.

## Accessibility & Inclusion

WCAG 2.2 AA in light and dark, forced-colors and prefers-contrast support, keyboard access with
visible focus, reduced motion respected.
