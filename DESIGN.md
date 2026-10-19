---
name: htmlgate
description: HTML behind a gate, in your own account. Every Share is a line on your board.
colors:
  ground: "oklch(100% 0 0)"
  ground-dark: "oklch(15.5% 0.008 255)"
  sunken: "oklch(97% 0.004 255)"
  sunken-dark: "oklch(19% 0.01 255)"
  ink: "oklch(21% 0.015 255)"
  ink-dark: "oklch(95% 0.005 255)"
  muted: "oklch(46% 0.015 255)"
  muted-dark: "oklch(74% 0.01 255)"
  rule: "oklch(90% 0.006 255)"
  rule-dark: "oklch(30% 0.01 255)"
  field: "oklch(55% 0.015 255)"
  field-dark: "oklch(62% 0.01 255)"
  board: "oklch(23% 0.012 255)"
  board-dark: "oklch(21.5% 0.012 255)"
  board-edge-dark: "oklch(34% 0.012 255)"
  board-ink: "oklch(96% 0.006 255)"
  board-dim: "oklch(76% 0.01 255)"
  board-rule: "oklch(33% 0.012 255)"
  cell: "oklch(27.5% 0.012 255)"
  signal: "oklch(86% 0.175 92)"
  signal-hover: "oklch(82% 0.17 88)"
  signal-ink: "oklch(21% 0.02 90)"
  public: "oklch(76% 0.16 55)"
  danger: "oklch(50% 0.19 27)"
  danger-dark: "oklch(72% 0.17 25)"
  danger-ink: "oklch(100% 0 0)"
  danger-ink-dark: "oklch(15% 0.02 27)"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "clamp(2.25rem, 1.1rem + 4.4vw, 4.5rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  headline:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "clamp(1.875rem, 1.3rem + 2.3vw, 3rem)"
    fontWeight: 800
    lineHeight: 1.06
    letterSpacing: "-0.03em"
  title-page:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "1.875rem"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.022em"
  title-card:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "1.1875rem"
    fontWeight: 750
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  title-section:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  body-landing:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  control:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "0.9375rem"
    fontWeight: 650
    lineHeight: 1.2
  label:
    fontFamily: 'system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "0.07em"
  mono:
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace'
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: '"tnum"'
rounded:
  flap: "2px"
  chip: "3px"
  control: "4px"
  panel: "6px"
spacing:
  gutter: "clamp(1rem, 4vw, 2rem)"
  gutter-landing: "clamp(1rem, 4vw, 2.5rem)"
  stack: "1.5rem"
  panel-pad: "1.2rem 1.35rem"
  row-pad: "0.75rem 1.2rem"
  row-pad-narrow: "0.9rem 1rem"
  section-landing: "clamp(4rem, 9vw, 7rem)"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0.45rem 1rem"
    height: "2.5rem"
  button-primary-hover:
    backgroundColor: "{colors.signal-hover}"
    textColor: "{colors.signal-ink}"
  button-primary-landing:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1.25rem"
    height: "3rem"
  button-quiet-landing:
    textColor: "{colors.board-ink}"
    rounded: "{rounded.control}"
    padding: "0.65rem 1.25rem"
    height: "3rem"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.danger-ink}"
    rounded: "{rounded.control}"
    padding: "0.45rem 1rem"
    height: "2.5rem"
  revoke-summary:
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "0.3rem 0.85rem"
    height: "2.25rem"
  input-text:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.45rem 0.75rem"
    height: "2.5rem"
  top-bar:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-ink}"
    padding: "0 clamp(1rem, 4vw, 2rem)"
    height: "3.5rem"
  chip-gated:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "0.12rem 0.5rem"
  chip-gated-on-board:
    textColor: "{colors.board-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "0.12rem 0.5rem"
  chip-public:
    backgroundColor: "{colors.public}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "0.12rem 0.5rem"
  board:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.panel}"
  board-row:
    textColor: "{colors.board-ink}"
    padding: "{spacing.row-pad}"
  flap-cell:
    backgroundColor: "{colors.cell}"
    textColor: "{colors.board-ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.flap}"
  panel:
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  panel-quiet:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  token-reveal:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  viewer-bar:
    backgroundColor: "{colors.board}"
    textColor: "{colors.board-ink}"
    padding: "0.4rem clamp(0.75rem, 3vw, 1.25rem)"
  older-notice:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    padding: "0.45rem clamp(0.75rem, 3vw, 1.25rem)"
---

# Design System: htmlgate

## Overview

**Creative North Star: "Departures"**

htmlgate looks like airport wayfinding. Every Share is a line on your board, and the gate is the sign-in: only listed people board. Graphite board panels carry the Instance's own frame. Signal yellow marks the one way forward. The ground is white in light and near-black in dark. Type is a heavy, tight system sans, like signage. Mono is kept for the things a board would print on flaps: slugs, Versions, tokens, hosts and commands.

There are two surfaces. The Instance pages (`src/pages.ts`) are for operating: the Author finds what was published and manages tokens, and a Viewer reads one Share. The landing (`site/public`) is for persuading a developer to install. Both share one world. Their tokens live in two separate Workers and are kept in step by hand. See "Two surfaces, one world" in Do's and Don'ts for the known gaps.

### What each Instance page is for

Instance pages speak one language per Instance: English (`en`, the default) or pt-BR, set by the Operator as `language` in instance.json. Both string tables in `src/pages.ts` have the same type (`ptBR: typeof en`), so a string added to one must be added to the other. The landing is pt-BR at `/` and en-US at `/en/`.

- **Author home (`/`).** The page title "Your Shares", a counts line, and the yellow "New token" action with its arrow. Then the Shares board. Below it sit two notes: "Publish a Share" (three steps on a quiet panel) and "Who can open a Share" (the Gated and Public legend).
  - **Bounds.** The board lists the 50 most recently updated live Shares (`HOME_SHARES`). They are ordered by update time, newest first, then by slug. The counts line ("N Shares · P public") counts every live Share, not only the 50 shown.
  - **Truncation.** When there are more live Shares than rows, a hint under the board says "Showing the 50 most recently updated of N." and names `htmlgate list` as the command that lists every Share.
  - **Who sees it.** The Author only. The home gets a list only for the Author, and the list's presence picks the layout. A Viewer's home lists nothing.
  - **Fields.** Status (Gated or Public), the Share (title as a link, slug on flaps under it), Version (on flaps), Updated (the UTC hour and minute on flaps, the date under them) and By.
  - **By.** The token name of the last change of any kind to that Share: publish, a new Version, an edit to its title, description or tags, make public, or gate. Making a Share public or gated changes By but not Updated, so By can be newer than Updated. A cell is blank when the token no longer resolves.
  - **Mobile priority.** Below a 40rem board width the header row hides and each row stacks. State and Version share the first line. Then the Share. Then Updated. Then By. The hidden field labels become visible on that layout.
  - **Empty.** With no Shares, the board panel itself holds "No Shares yet", the gated-by-default lead and the three publish steps. The publish note below is dropped, since the steps are already the page.
- **Viewer home (`/`).** "You're signed in" and one lead: open a Share with the link its Author sent. No navigation, no list, nothing to browse. The top bar's navigation appears only for the Author.
- **Tokens (`/tokens`).** What a token can do, a refusal notice when the form was refused, the create form, and the list of tokens with a revoke confirm on each live one.
  - **One-time reveal.** After a token is created, the page shows it once in a graphite pass with a yellow top band: "Copy it now. It is not shown again." The value sits in a dashed yellow box and selects in one click. Only that one response ever carries it.
- **Share viewer (`/s/<slug>`, `/p/<slug>`).** A thin graphite bar over the Share: the mark, the title, the state chip, the update time, the Versions menu and "Open in a new tab". The Share fills the rest in a sandboxed iframe on a white light-scheme ground. The mark links home only on `/s/`, since a public link's visitor may not be signed in.
  - **Older-Version notice.** When the shown Version is not the latest, a yellow band under the bar says "You are viewing vN. The latest is vM." with a link to the latest.
- **Not found.** A small graphite plate with the mark, the heading and one line, then one way out. Not signed in, on a public link: "Sign in and try again". Behind the gate: a way home, "Back to your Shares" for the Author and "Go to the home page" for anyone else. The page never depends on whether a Share exists, nor on whether someone is on the Allowlist, so a deleted Share, one that never existed, and a refused visitor all look the same.

### Hard constraints

These are part of the system. A design that breaks one is wrong, however it looks.

- **No script.** No htmlgate page runs JavaScript. Only a Share's own HTML may, inside its sandboxed iframe. Menus and confirms are `<details>`. The token reveal selects with `user-select: all`.
- **Instance CSS is inline and allowed by its CSP hash.** One `<style>` block, the same bytes on every page. `default-src 'none'`. Nothing loads from elsewhere.
- **The landing has one same-origin stylesheet** (`/style.css`), the SVG favicon and self-hosted demonstration videos with JPEG posters. Its social preview reuses the existing branded poster; images and video load only from the landing's own origin.
- **System fonts only.** No font can load: there is no font source in the CSP and no `url()`. The sans and mono stacks are the only faces.
- **Inline SVG icons only.** The mark, the arrow and the no-entry sign are inline SVG with `currentColor` strokes. No icon fonts, raster icons or glyph characters as icons.
- **No `url()` in CSS.** Textures are gradients. The split-flap cells are gradients.
- **WCAG 2.2 AA in light and dark**, checked by axe on every page at desktop and phone width. Forced colors and `prefers-contrast: more` are handled.
- **24 px minimum targets.** The smallest link target is the Share title on the board (1.5rem). Controls are 1.75rem to 3rem tall.
- **No sideways scroll at 320 px.** Long titles, slugs and names wrap anywhere. Only a `<pre>` scrolls inside itself, and it is a focusable labelled region.

**Key Characteristics:**
- Graphite board panels for everything the Instance owns; white or near-black ground for everything else.
- Signal yellow as a fill under near-black ink for the main path, and as a line on graphite or as focus on the dark ground.
- Gated is quiet (outlined, arch). Public is loud (filled orange, ring).
- Split-flap cells for slugs and Versions: the board's signature.
- Heavy, tight system sans; mono only for what a board prints.
- No script, nothing from elsewhere, flat surfaces.

## Colors

A graphite and white field, with one signal yellow and one orange that means "anyone can open this". All tokens are OKLCH. The Instance and landing switch light and dark with `light-dark()`. Board tokens are the same in both schemes.

### Primary
- **Signal Yellow** (signal): the main action, the skip link, selection, the older-Version band, the current nav underline, the focus ring on graphite and on the Instance's dark ground, the mark on graphite, the reveal's top band and the landing's install section. Hover deepens to Signal Hover (signal-hover).
- **Signal Ink** (signal-ink): the near-black, faintly warm ink that sits on yellow and on orange. Nothing else sits on yellow.

### Secondary
- **Public Orange** (public): the Public chip's fill, always under Signal Ink. It is the only loud state.

### Tertiary
- **Revoke Red** (danger, danger-dark): destructive and refusal states only: the revoke and erase confirms, their buttons, and the refusal notices (the one error colour of an Operate surface). On the button, white ink in light (danger-ink) and near-black ink in dark (danger-ink-dark). On the graphite viewer bar, the Author's Erase always uses the light red (danger-dark, the board-danger token) in both schemes, so it reads on graphite; its question opens on the ground, kept on screen at any width.

### Neutral
- **Ground** (ground, ground-dark): pure white in light, cool near-black in dark. Not cream, not off-white.
- **Sunken** (sunken, sunken-dark): quiet panels and inline code on the ground.
- **Ink** (ink, ink-dark): body text and headings on the ground. Also the focus ring on the light ground.
- **Muted** (muted, muted-dark): leads, hints, legend text, revoked tokens.
- **Rule** (rule, rule-dark): hairlines between list rows and around panels. Decorative only, never the only edge of a control.
- **Field** (field, field-dark): the text input's border. This is the one border that must meet 3:1.
- **Board Graphite** (board, board-dark): the top bar, the viewer bar, the Shares board, the reveal pass, code blocks, the landing's header, hero and 404 plate. Its edge (board-edge-dark) shows only in dark, where graphite would otherwise sink into the ground.
- **Board Ink** (board-ink), **Board Dim** (board-dim), **Board Rule** (board-rule): text, secondary text and row rules on graphite.
- **Flap Cell** (cell): the split-flap cells, code on graphite, and hovered menu items.

### Contrast pairs

Measured WCAG 2 ratios. Every text pair clears 4.5:1; the field border clears 3:1.

| Surface | Pair | Ratio |
|---|---|---|
| Light ground | Ink on white | 17.7 |
| Light ground | Muted on white | 7.1 |
| Light ground | Field border on white | 4.85 |
| Light ground | Danger on white | 6.6 |
| Dark ground | Ink on dark | 16.9 |
| Dark ground | Muted on dark | 8.5 |
| Dark ground | Yellow focus ring on dark | 12.7 |
| Graphite board | Board ink on board | 15.0 |
| Graphite board | Board dim on board | 7.9 |
| Graphite board | Orange on board | 7.5 |
| Graphite board | Yellow on board | 11.0 |
| Graphite board | Board dim on flap cell | 6.9 |
| Yellow sign | Near-black on yellow | 11.6 |
| Orange sign | Near-black on orange | 7.9 |

Orange never appears as text on white: Public is always the filled orange chip under near-black ink.

### Named Rules

**The Signal Rule.** Yellow is a fill under Signal Ink anywhere, a line or stroke on graphite, or the Instance's focus ring on the dark ground. It is never text, and never a line on white. It marks the one way forward on a screen, not decoration.

**The Graphite Frame Rule.** Whatever the Instance owns is graphite in both schemes: the top bar, the viewer bar, the board, the reveal. The frame sits outside the Share's sandboxed iframe, so a Share cannot restyle, cover or remove it.

**The Loud Public Rule.** Gated is the default and stays quiet. Public is the exception and is the only orange on the page.

## Typography

**Display Font:** the system sans (`system-ui`, then Segoe UI Variable, Segoe UI, Roboto, Helvetica Neue)
**Body Font:** the same system sans
**Label/Mono Font:** the system mono (`ui-monospace`, then SF Mono, Cascadia Code, JetBrains Mono, Menlo, Consolas)

**Character:** Signage. Heavy weights (700 to 800) with tight negative tracking for headings, plain 400 body, and small tracked uppercase for column headers and chips. Mono is the board's printed matter. The system face is a constraint, not a preference: no font can load.

### Hierarchy
- **Display** (800, clamp 2.25rem to 4.5rem, 1.02): the landing's hero headline only.
- **Headline** (800, clamp 1.875rem to 3rem, 1.06): landing section headings.
- **Title, page** (750, 1.875rem, 1.15): the Instance page heading ("Your Shares", "Tokens"). Not found uses a larger 2.25rem at 800.
- **Title, card** (750, 1.1875rem, 1.3): landing step and directory headings.
- **Title, section** (700, 1.0625rem, 1.3): Instance panel and section headings.
- **Body** (400, 1rem, 1.55): Instance text. Leads are muted and stop at 62ch.
- **Body, landing** (400, 1.0625rem, 1.6): landing text. Section leads and prose step up to 1.125rem.
- **Control** (650, 0.9375rem, 1.2): buttons, nav links and form labels. Sentence case, never uppercase. The landing's buttons step up to 750 and 1rem.
- **Label** (700 to 750, 0.75rem, 0.07em, uppercase): the board's column headers, the token list's headers and the state chips. Nowhere else.
- **Mono** (400, 0.75rem to 0.9375rem): slugs, Versions, token values and ids, the Instance host, commands and code.

Times use tabular figures. On the Instance they are sans (`2026-10-09 14:02 UTC`). On the landing's example board they are mono.

### Named Rules

**The Printed Matter Rule.** Mono is for what a board would print: slugs, Versions, tokens, ids, hosts and commands. Titles, names and prose are always sans.

**The Column Header Rule.** Uppercase tracked labels belong to column headers and state chips, the way a departure board labels its columns. Never put one above a heading as a kicker.

## Layout

Instance pages are one centered column, at most 64rem wide, with a fluid gutter (gutter) and 1.5rem between blocks (stack). The top bar runs full width. The page heading sits on one line with its action, and wraps the action under it when narrow. Notes under the board flow into as many 22rem-minimum columns as fit.

The Shares board is a timetable. Its columns are fixed for Status (7.5rem), Version (4.5rem) and Updated (10.5rem), with the Share taking the rest and By capped at 8rem. It is a container: below 40rem of its own width, rows stack in the mobile priority order above. The token list does the same below 44rem: name and action on the first line, then created, last used and state.

The viewer is a full-height column: bar, optional older-Version band, then the iframe filling what is left. The page itself never scrolls.

The landing is a 76rem wrap with a wider fluid gutter (gutter-landing). Sections get more space above than below (section-landing on top) and are separated by rules, with every other one on the sunken ground. The hero is a full-bleed graphite band: headline at top left, the yellow install action, one publish command, then a wide example board. "How it works" is a route line of three stops, vertical on phones and horizontal from 60rem. Other breakpoints: 30rem (the example board shares its time column), 36rem, 44rem (section links leave the header) and 52rem (two-column directory). The costs are one labelled list with htmlgate itself on the first row (R$ 0, open source), not a price sign; the features are ruled rows without icon tiles.

**The 320 Rule.** At 320 px nothing scrolls sideways. Text wraps anywhere before it overflows; only code regions scroll, inside themselves.

## Elevation & Depth

Flat. Depth comes from the graphite and white contrast, not shadow. Panels are outlined (rule) or sunken; boards are graphite with a dark-mode edge. The only shadows sit under the two floating menus: the revoke confirm (`0 14px 30px -12px oklch(0% 0 0 / .35)`) and the Versions menu (`0 12px 28px -10px oklch(0% 0 0 / .5)`).

**The Flat Board Rule.** Surfaces never lift. A shadow appears only under something that floats over content, and only a soft one.

## Shapes

Small, square-ish corners, like enamel signs. Split-flap cells round at 2px, chips and inline code at 3px, controls, code blocks and the landing's signs at 4px, Instance panels, boards and menus at 6px. The only round shapes are the Public chip's ring, the Active dot and the landing's route stops.

State chips carry a drawn glyph in CSS: an arch (open bottom, rounded top) for Gated and a full ring for Public. These echo the mark: an arched gate over a threshold.

## Components

### Buttons
- **Shape:** gently squared (control).
- **Primary:** the yellow sign. Signal Ink, weight 650 (750 on the landing), with the wayfinding arrow when it moves you on. Instance 2.5rem tall; landing 3rem with a 2px border.
- **Hover / Focus:** hover deepens to signal-hover; on the landing the arrow slides 3px. On the Instance, press moves 1px down. All motion is gated by reduced motion. Focus is a 2px ring 2px out: ink on the light ground, yellow on the dark ground and on graphite, Signal Ink on yellow.
- **Quiet (landing):** transparent, outlined at 60% of the ground's own ink.
- **Danger:** red fill, only inside the revoke confirm. On the landing's yellow install band, buttons turn graphite.

### Chips
- **Gated:** outlined in the current ink, arch glyph, uppercase label. Quiet on white and on graphite.
- **Public:** filled orange, Signal Ink, ring glyph. The same chip on every surface.

### Cards / Containers
- **Panel:** 1px rule outline, 6px corners, panel-pad. The quiet panel is sunken with no border.
- **Board:** graphite, 6px corners, a dark-mode edge.
- **Reveal pass:** graphite with a 6px yellow top band; the token in a dashed yellow box on a flap cell.
- **Notice:** rule outline; the error notice is outlined red with red strong text.

### Inputs / Fields
- **Style:** 1px field border, ground fill, 4px corners, 2.5rem tall. Placeholder in muted.
- **Focus:** the shared 2px ring.

### Navigation
- **Top bar:** graphite, 3.5rem. Mark in yellow, wordmark at 750, host in mono and board dim. Author links at 600 stretch to the bar's height; hover shows a dim 3px underline, the current page a yellow one. Host and email hide below 40rem. A Viewer sees no links.
- **Landing header:** sticky graphite, 4rem. Section links hide below 44rem. "Sign in" is outlined in board dim.

### Split-flap cell (signature)
Each character sits on its own flap: a repeating cell-colored block one character plus the letter spacing wide, with a 1px dark hinge line through the middle. Used for slugs and Versions on the board and in the landing's hero. It is the board's deliberate signature, not decoration: it says "this is a departure line" at a glance, and it is the only texture in the system. Forced colors share the texture.

### Share viewer bar
A thin graphite strip, wrapping to two lines on phones, with the title clamped to two lines. The Versions menu is a `<details>` with a mono summary ("v3 of 7") and a graphite list; the current Version is yellow. The older-Version notice is a full-width yellow band directly under it.

### Release line
The version an Operator is running, in mono at 0.75rem: a footer under every Instance page, and a chip in the viewer bar's meta so it never overlays the Share. The landing carries the same number in its footer, in mono at 0.8125rem next to the wordmark. One line, muted, never an action.

### Metrics report
`/metrics` is a data table on the light ground, not a board: the Share's title with its slug under it in mono at 0.75rem and muted (never the board's dark flap cells, which need the graphite surface to be legible), then 30 days and all time right-aligned under their headings in tabular figures, then the way in. A zero is a real number in a quieter tone, so the column never reads as broken; phones drop the all-time column and keep the 30-day count beside the button.

### Revoke confirm
An outlined red summary. Open, it fills red and drops a ground-colored popover naming who stops working, with the red button inside.

## Do's and Don'ts

### Do:
- **Do** put everything the Instance owns on graphite, in both schemes.
- **Do** keep yellow for the one way forward: the main action, focus on graphite and on the dark ground, the older-Version band, the reveal's band.
- **Do** put Signal Ink, and only Signal Ink, on yellow and on orange.
- **Do** show every Share's state with the chip: Gated quiet with an arch, Public filled orange with a ring.
- **Do** print slugs and Versions on split-flap cells.
- **Do** add every Instance string to both `en` and `ptBR`; their types must match.
- **Do** keep each new text pair at 4.5:1 or more on every surface it can land on, in light and dark.
- **Do** keep targets at 24 px or more and check every page at 320 px.
- **Do** change a shared token in both `src/pages.ts` and `site/public/style.css` in the same change.

### Don't:
- **Don't** add script, web fonts, icon fonts or `url()` to any page. Keep Instance pages free of external assets; the landing's demonstration videos, posters and social-preview image stay self-hosted.
- **Don't** use yellow as text, or as a line on the white or near-black ground.
- **Don't** use red outside destructive and refusal states.
- **Don't** make Gated loud or Public quiet.
- **Don't** put an uppercase label above a heading. Uppercase belongs to column headers and chips.
- **Don't** number sections. The landing's numbered stops are steps on a route line, and only there.
- **Don't** add shadows to panels or boards, and no hard offset shadows anywhere.
- **Don't** use cream or off-white grounds, pill-shaped buttons or gradients other than the flap texture.
- **Don't** use mono for titles, names or prose.

### Two surfaces, one world

The Instance and the landing are separate Workers, so each carries its own copy of the tokens. The copies use the same names and values (`--ground`, `--sunken`, `--ink`, `--muted`, `--rule`, `--board`, `--board-edge`, `--board-ink`, `--board-dim`, `--board-rule`, `--cell`, `--hinge`, `--signal`, `--signal-hover`, `--signal-ink`, `--public`, `--focus`) and the same split-flap rule. Change a token in `src/pages.ts` and `site/public/style.css` together. The landing also keeps `--accent` (the signal yellow), which its browser tests read to prove the stylesheet applied under its CSP. Panels round at 6px, and controls and signs at 4px, on both.
