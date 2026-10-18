// The Instance's own pages. They run no script and load nothing from elsewhere: one stylesheet, allowed
// by its hash, and inline SVG. The look is an airport's departure board: graphite panels for the
// Instance's own frame (the top bar, the viewer's bar, the Shares board), signal yellow only as a fill
// under dark ink for the main action and focus, white or near-black ground, and the Shares listed in a
// timetable's column rhythm. Colours are OKLCH tokens that switch with the visitor's scheme through
// light-dark(); every text pair was checked for WCAG AA contrast on each of those surfaces.
import type { Language } from "./config";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** What a Share may do, in the viewer's iframe and as a top-level page. No allow-same-origin: issue #12. */
export const SHARE_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** How many Shares the Author's home lists, most recently updated first. */
export const HOME_SHARES = 50;

/** Why the token form refused a request. The page says it in the Instance's language. */
export type TokenError = "refused" | "too-large" | "bad-name";
export type EraseError = "refused" | "too-large" | "bad-share" | "no-share";
/** What the Author's home says above the board: a Share just erased, or why an erase was refused. */
export type HomeNote = { erased: string } | { error: EraseError } | { confirm: { slug: string; title: string } };

// Every string is HTML: a function's arguments are already escaped by its caller.
const en = {
  skip: "Skip to content",
  skipShare: "Skip to the Share",
  instance: "Instance",
  shares: "Shares",
  tokens: "Tokens",
  signedIn: "Signed in",
  homeOf: "htmlgate home",
  gated: "Gated",
  public: "Public",
  homeTitle: "Your Shares",
  counts: (n: number, p: number) => `${n} ${n === 1 ? "Share" : "Shares"} · ${p} public`,
  newToken: "New token",
  boardLabel: "Your Shares, most recently updated first",
  status: "Status",
  share: "Share",
  version: "Version",
  updated: "Updated",
  by: "By",
  truncated: (shown: number, total: number) => `Showing the ${shown} most recently updated of ${total}.`,
  listAll: "lists every Share.",
  empty: "No Shares yet",
  emptyLead: "Every Share published here starts gated. It opens only for the people on your Allowlist, after they sign in.",
  publishTitle: "Publish a Share",
  step1: (link: string) => `Create a token for the Publisher on the ${link} page.`,
  step2: "Sign the <code>htmlgate</code> CLI in to this Instance and paste the token:",
  step2Label: "Command to sign the CLI in to this Instance",
  step3: "Publish. The CLI prints the Share's link.",
  step3Label: "Command to publish a Share",
  publishExample: `htmlgate publish page.html --title "My page"`,
  whoTitle: "Who can open a Share",
  gatedMeans: "People on your Allowlist, after signing in. Every Share starts here, and a new Version never changes it.",
  publicMeans: "Anyone with its <code>/p/</code> link. Only an explicit call from a Publisher makes a Share public, and another gates it again.",
  requestsListed: "Every request is listed at",
  viewerTitle: "You're signed in",
  viewerLead: "Open a Share with the link its Author sent you. This Instance keeps no list of Shares, so there is nothing to browse here.",
  tokensTitle: "Tokens",
  tokensLead: "A token lets a Publisher create, change, delete and make public every Share on this Instance. Give each Publisher its own, and revoke one you no longer trust.",
  errors: {
    refused: "Refused: this change did not come from this Instance's own page.",
    "too-large": "That form is too large. Give the token a name of 1 to 64 characters.",
    "bad-name": "Give the token a name of 1 to 64 characters, without control characters.",
  } satisfies Record<TokenError, string>,
  created: (name: string) => `New token: ${name}`,
  copyNow: "Copy it now. It is not shown again.",
  createdHint: "Paste it into <code>htmlgate login</code>, or set it as <code>$HTMLGATE_TOKEN</code> together with <code>$HTMLGATE_URL</code>.",
  createTitle: "Create a token",
  name: "Name",
  namePlaceholder: "laptop",
  nameHint: "Name it after the Publisher that will use it.",
  create: "Create token",
  yours: "Your tokens",
  noTokens: "No tokens yet. Create one for each Publisher.",
  createdLabel: "Created",
  lastUsed: "Last used",
  state: "State",
  active: "Active",
  revoked: "Revoked",
  never: "never",
  revoke: "Revoke",
  revokeAsk: (name: string) => `Publishers using <strong>${name}</strong> stop working on their next request.`,
  revokeNamed: (name: string) => `Revoke ${name}`,
  versions: "Versions",
  versionOf: (n: number, latest: number) => `v${n} of ${latest}`,
  versionsLabel: (n: number, latest: number) => `Versions, showing v${n} of ${latest}`,
  latestTag: "(latest)",
  updatedAt: "Updated ",
  expiresAt: "Expires ",
  openTab: "Open in a new tab",
  older: (n: number, latest: number) => `You are viewing v${n}. The latest is v${latest}.`,
  showLatest: "Show the latest",
  notFound: "Not found",
  notFoundLead: "This Share does not exist, or you cannot open it.",
  signInRetry: "Sign in and try again",
  backToShares: "Back to your Shares",
  goHome: "Go to the home page",
  erase: "Erase",
  eraseAsk: (title: string) => `Erase <strong>${title}</strong> for good? Every Version and the Share itself are deleted, and its links stop working. This cannot be undone.`,
  eraseConfirm: "Erase for good",
  eraseCheck: "Erase this Share?",
  eraseStart: "Review and erase",
  keep: "Keep it",
  eraseTitle: "Erase a Share for good",
  eraseLead: "For a request to erase someone's data. Erasing deletes every Version and the Share's record, even for a Share already deleted, and cannot be undone. Deleting with the API or the CLI only hides a Share.",
  eraseField: "Share link or slug",
  eraseHint: "Paste the Share's link, or its 12-character slug.",
  erased: (slug: string) => `Erased <code>${slug}</code> for good: its Versions and its record are deleted.`,
  eraseErrors: {
    refused: "Refused: this change did not come from this Instance's own page.",
    "too-large": "That form is too large. Paste one Share's link or slug.",
    "bad-share": "Paste a Share's link, or its 12-character slug.",
    "no-share": "No Share with that link or slug on this Instance.",
  } satisfies Record<EraseError, string>,
};

const ptBR: typeof en = {
  skip: "Pular para o conteúdo",
  skipShare: "Pular para o Share",
  instance: "Instância",
  shares: "Shares",
  tokens: "Tokens",
  signedIn: "Conectado",
  homeOf: "Início do htmlgate",
  gated: "Fechado",
  public: "Público",
  homeTitle: "Seus Shares",
  counts: (n: number, p: number) => `${n} ${n === 1 ? "Share" : "Shares"} · ${p} ${p === 1 ? "público" : "públicos"}`,
  newToken: "Novo token",
  boardLabel: "Seus Shares, do atualizado mais recentemente ao mais antigo",
  status: "Situação",
  share: "Share",
  version: "Versão",
  updated: "Atualizado",
  by: "Por",
  truncated: (shown: number, total: number) => `Mostrando os ${shown} Shares atualizados mais recentemente, de ${total}.`,
  listAll: "lista todos os Shares.",
  empty: "Nenhum Share ainda",
  emptyLead: "Todo Share publicado aqui nasce fechado. Ele só abre para quem está na sua lista de acesso, depois de entrar.",
  publishTitle: "Publique um Share",
  step1: (link: string) => `Crie um token para o publicador na página ${link}.`,
  step2: "Conecte a CLI <code>htmlgate</code> a esta Instância e cole o token:",
  step2Label: "Comando para conectar a CLI a esta Instância",
  step3: "Publique. A CLI mostra o link do Share.",
  step3Label: "Comando para publicar um Share",
  publishExample: `htmlgate publish pagina.html --title "Minha página"`,
  whoTitle: "Quem pode abrir um Share",
  gatedMeans: "Quem está na sua lista de acesso, depois de entrar. Todo Share nasce assim, e uma nova Versão não muda isso.",
  publicMeans: "Qualquer pessoa com o link <code>/p/</code>. Só um pedido explícito de um publicador torna um Share público, e outro o fecha de novo.",
  requestsListed: "Todos os pedidos estão listados em",
  viewerTitle: "Você entrou",
  viewerLead: "Abra um Share pelo link que o autor mandou. Esta Instância não mostra uma lista de Shares, então não há nada para navegar aqui.",
  tokensTitle: "Tokens",
  tokensLead: "Um token deixa um publicador criar, mudar, apagar e tornar público qualquer Share desta Instância. Dê um token para cada publicador e revogue o que não for mais de confiança.",
  errors: {
    refused: "Recusado: este pedido não veio da página desta Instância.",
    "too-large": "Formulário grande demais. Dê ao token um nome de 1 a 64 caracteres.",
    "bad-name": "Dê ao token um nome de 1 a 64 caracteres, sem caracteres de controle.",
  } satisfies Record<TokenError, string>,
  created: (name: string) => `Novo token: ${name}`,
  copyNow: "Copie agora. Ele não aparece de novo.",
  createdHint: "Cole no <code>htmlgate login</code>, ou defina como <code>$HTMLGATE_TOKEN</code> junto com <code>$HTMLGATE_URL</code>.",
  createTitle: "Criar um token",
  name: "Nome",
  namePlaceholder: "notebook",
  nameHint: "Use o nome do publicador que vai usar o token.",
  create: "Criar token",
  yours: "Seus tokens",
  noTokens: "Nenhum token ainda. Crie um para cada publicador.",
  createdLabel: "Criado",
  lastUsed: "Último uso",
  state: "Situação",
  active: "Ativo",
  revoked: "Revogado",
  never: "nunca",
  revoke: "Revogar",
  revokeAsk: (name: string) => `Quem usa <strong>${name}</strong> para de funcionar no próximo pedido.`,
  revokeNamed: (name: string) => `Revogar ${name}`,
  versions: "Versões",
  versionOf: (n: number, latest: number) => `v${n} de ${latest}`,
  versionsLabel: (n: number, latest: number) => `Versões, mostrando a v${n} de ${latest}`,
  latestTag: "(mais recente)",
  updatedAt: "Atualizado em ",
  expiresAt: "Expira em ",
  openTab: "Abrir em nova aba",
  older: (n: number, latest: number) => `Você está vendo a v${n}. A mais recente é a v${latest}.`,
  showLatest: "Ver a mais recente",
  notFound: "Não encontrado",
  notFoundLead: "Este Share não existe, ou você não pode abri-lo.",
  signInRetry: "Entrar e tentar de novo",
  backToShares: "Voltar aos seus Shares",
  goHome: "Ir para o início",
  erase: "Eliminar",
  eraseAsk: (title: string) => `Eliminar <strong>${title}</strong> de vez? Todas as Versões e o próprio Share são apagados, e os links param de funcionar. Não dá para desfazer.`,
  eraseConfirm: "Eliminar de vez",
  eraseCheck: "Eliminar este Share?",
  eraseStart: "Revisar e eliminar",
  keep: "Manter",
  eraseTitle: "Eliminar um Share de vez",
  eraseLead: "Para um pedido de eliminação dos dados de alguém. Eliminar apaga todas as Versões e o registro do Share, mesmo de um Share já apagado, e não dá para desfazer. Apagar pela API ou pela CLI só esconde o Share.",
  eraseField: "Link ou slug do Share",
  eraseHint: "Cole o link do Share, ou o slug de 12 caracteres.",
  erased: (slug: string) => `<code>${slug}</code> eliminado de vez: as Versões e o registro foram apagados.`,
  eraseErrors: {
    refused: "Recusado: este pedido não veio da página desta Instância.",
    "too-large": "Formulário grande demais. Cole o link ou o slug de um Share.",
    "bad-share": "Cole o link de um Share, ou o slug de 12 caracteres.",
    "no-share": "Nenhum Share com esse link ou slug nesta Instância.",
  } satisfies Record<EraseError, string>,
};

const STRINGS: Record<Language, typeof en> = { en, "pt-BR": ptBR };

const CSS = `
:root {
  color-scheme: light dark;
  --ground: light-dark(oklch(100% 0 0), oklch(15.5% .008 255));
  --sunken: light-dark(oklch(97% .004 255), oklch(19% .01 255));
  --ink: light-dark(oklch(21% .015 255), oklch(95% .005 255));
  --muted: light-dark(oklch(46% .015 255), oklch(74% .01 255));
  --rule: light-dark(oklch(90% .006 255), oklch(30% .01 255));
  --field: light-dark(oklch(55% .015 255), oklch(62% .01 255));
  --board: light-dark(oklch(23% .012 255), oklch(21.5% .012 255));
  --board-edge: light-dark(oklch(23% .012 255), oklch(34% .012 255));
  --board-ink: oklch(96% .006 255);
  --board-dim: oklch(76% .01 255);
  --board-rule: oklch(33% .012 255);
  --cell: oklch(27.5% .012 255);
  --hinge: oklch(17% .01 255);
  --signal: oklch(86% .175 92);
  --signal-hover: oklch(82% .17 88);
  --signal-ink: oklch(21% .02 90);
  --public: oklch(76% .16 55);
  --danger: light-dark(oklch(50% .19 27), oklch(72% .17 25));
  --danger-ink: light-dark(oklch(100% 0 0), oklch(15% .02 27));
  --focus-ground: light-dark(oklch(21% .015 255), oklch(86% .175 92));
  --focus: var(--focus-ground);
  --board-danger: oklch(72% .17 25);
  --radius: 4px;
  --sans: system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
}
@media (prefers-contrast: more) { :root { --rule: var(--field); --muted: var(--ink); --board-dim: var(--board-ink); --board-rule: var(--board-dim); } }
@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100dvh; background: var(--ground); color: var(--ink); font: 400 1rem/1.55 var(--sans); accent-color: var(--signal); caret-color: currentColor; }
::selection { background: var(--signal); color: var(--signal-ink); }
a { color: inherit; text-decoration-color: color-mix(in oklch, currentColor 50%, transparent); text-underline-offset: .22em; text-decoration-thickness: 1px; }
a:hover { text-decoration-color: currentColor; text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 2px; }
h1, h2 { text-wrap: balance; margin: 0; }
h1 { font-size: 1.875rem; line-height: 1.15; font-weight: 750; letter-spacing: -.022em; }
h2 { font-size: 1.0625rem; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; }
p { margin: 0; text-wrap: pretty; }
code, pre { font-family: var(--mono); font-size: .875em; }
:not(pre) > code { padding: .05em .3em; border-radius: 3px; background: var(--sunken); }
time { font-variant-numeric: tabular-nums; }
.skip { position: absolute; left: 1rem; top: -4rem; z-index: 3; padding: .5rem .85rem; background: var(--signal); color: var(--signal-ink); border-radius: var(--radius); font-weight: 650; text-decoration: none; }
/* Focused, the skip link takes its own row above the header, so it never covers the brand link (WCAG 2.5.8). */
.skip:focus { position: static; display: block; flex: none; width: fit-content; margin: .5rem 1rem; }
.lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.mark { display: block; width: 1.5rem; height: 1.5rem; flex: none; color: var(--signal); }

/* The Instance's frame: graphite in both themes, so it never reads as part of a Share. */
.top, .bar, .board, .pass, pre { --focus: var(--signal); }
.top { display: flex; align-items: center; gap: 1rem; min-height: 3.5rem; padding: 0 clamp(1rem, 4vw, 2rem); background: var(--board); color: var(--board-ink); border-bottom: 1px solid var(--board-edge); }
.brand { display: flex; align-items: center; gap: .55rem; min-height: 2.75rem; color: inherit; text-decoration: none; font-weight: 750; letter-spacing: -.01em; }
.host { font-family: var(--mono); font-size: .8125rem; color: var(--board-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.top nav { margin-left: auto; display: flex; align-items: center; gap: 1.25rem; align-self: stretch; }
.top nav + .who { margin-left: 0; }
.top nav a { display: flex; align-items: center; align-self: stretch; padding-top: 3px; border-bottom: 3px solid transparent; color: inherit; text-decoration: none; font-weight: 600; font-size: .9375rem; }
.top nav a:hover { border-bottom-color: var(--board-dim); }
.top nav a[aria-current] { border-bottom-color: var(--signal); }
.who { margin-left: auto; color: var(--board-dim); font-size: .875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
@media (max-width: 40rem) { .host, .who { display: none; } }

main.page { max-width: 64rem; margin: 0 auto; padding: 2.25rem clamp(1rem, 4vw, 2rem) 4rem; display: grid; gap: 1.5rem; }
.heading { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1rem 1.5rem; }
.lead { color: var(--muted); margin-top: .45rem; max-width: 62ch; font-variant-numeric: tabular-nums; }
.hint { color: var(--muted); font-size: .875rem; }

/* Controls: the main action is the yellow sign; danger is red and only on revoke. */
.button, button { font: inherit; font-weight: 650; font-size: .9375rem; display: inline-flex; align-items: center; justify-content: center; gap: .5rem; min-height: 2.5rem; padding: .45rem 1rem; border: 0; border-radius: var(--radius); background: var(--signal); color: var(--signal-ink); cursor: pointer; text-decoration: none; white-space: nowrap; }
.button:hover, button:hover { background: var(--signal-hover); }
.button svg { width: 1.05rem; height: 1.05rem; flex: none; }
button.danger { background: var(--danger); color: var(--danger-ink); }
button.danger:hover { background: var(--danger); filter: brightness(1.08); }
@media (prefers-reduced-motion: no-preference) {
  .button, button { transition: background-color .15s ease, translate .1s ease; }
  .button:active, button:active { translate: 0 1px; }
}
label { font-weight: 650; font-size: .9375rem; }
input[type=text] { font: inherit; width: 100%; min-height: 2.5rem; padding: .45rem .75rem; border: 1px solid var(--field); border-radius: var(--radius); background: var(--ground); color: var(--ink); }
input[type=text]::placeholder { color: var(--muted); opacity: 1; }
.create { display: grid; gap: .45rem; }
.create .row-input { display: flex; flex-wrap: wrap; gap: .6rem .75rem; }
.create input { flex: 1 1 14rem; width: auto; }

/* Panels on the ground */
.panel { border: 1px solid var(--rule); border-radius: 6px; padding: 1.2rem 1.35rem; display: grid; gap: .85rem; align-content: start; min-width: 0; }
.panel.quiet { background: var(--sunken); border-color: transparent; }
.notes { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); }
.steps { margin: 0; padding-left: 1.25rem; display: grid; gap: .8rem; }
.steps li { padding-left: .2rem; min-width: 0; }
.steps li::marker { font-weight: 750; }
pre { margin: .45rem 0 0; padding: .65rem .9rem; background: var(--board); color: var(--board-ink); border-radius: var(--radius); overflow-x: auto; line-height: 1.6; font-size: .8125rem; }
.legend { display: grid; gap: .9rem; margin: 0; }
.legend div { display: grid; gap: .35rem; justify-items: start; }
.legend dd { margin: 0; color: var(--muted); font-size: .9375rem; }

/* State: Gated is quiet with an arch, Public is a filled orange sign with a ring. */
.state { display: inline-flex; align-items: center; gap: .45rem; padding: .12rem .5rem; border: 1px solid currentColor; border-radius: 3px; font-size: .75rem; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; line-height: 1.45; white-space: nowrap; }
.state::before { content: ""; flex: none; width: .5rem; height: .6rem; border: 1.5px solid currentColor; border-bottom: 0; border-radius: .3rem .3rem 0 0; }
.state-public { background: var(--public); border-color: var(--public); color: var(--signal-ink); }
.state-public::before { height: .5rem; border-bottom: 1.5px solid currentColor; border-radius: 50%; }

/* Split-flap cells: one flap per character (1ch plus the letter-spacing), the hinge through the middle.
   The trailing letter-spacing would show a sliver of a next flap, so it is clipped and its space taken back. */
.flap {
  --ls: .3ch;
  display: inline-block; padding: .1em 0 .1em calc((var(--ls) - .1ch) / 2); margin-right: calc(-1 * (var(--ls) + .1ch) / 2);
  font-family: var(--mono); line-height: 1.5; letter-spacing: var(--ls); font-variant-numeric: tabular-nums;
  background:
    linear-gradient(transparent calc(50% - .5px), var(--hinge) calc(50% - .5px) calc(50% + .5px), transparent calc(50% + .5px)),
    repeating-linear-gradient(90deg, var(--cell) 0 calc(1ch + var(--ls) - .1ch), transparent 0 calc(1ch + var(--ls)));
  clip-path: inset(0 calc((var(--ls) + .1ch) / 2) 0 0);
}

/* The Shares board */
.board { background: var(--board); color: var(--board-ink); border: 1px solid var(--board-edge); border-radius: 6px; container-type: inline-size; }
.board-head, .row { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr) 4.5rem 10.5rem minmax(0, 8rem); gap: 0 1.1rem; align-items: center; padding: .75rem 1.2rem; }
.board-head { font-size: .75rem; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--board-dim); border-bottom: 1px solid var(--board-rule); }
.rows { list-style: none; margin: 0; padding: 0; }
.row + .row { border-top: 1px solid var(--board-rule); }
.c-share { display: grid; gap: .2rem; min-width: 0; }
.c-share a { justify-self: start; display: inline-flex; align-items: center; min-height: 1.5rem; min-width: 1.5rem; font-weight: 650; text-decoration: none; overflow-wrap: anywhere; }
.c-share a:hover { text-decoration: underline; }
.c-share .flap { font-size: .8125rem; color: var(--board-dim); justify-self: start; }
.c-ver .flap, .c-when .flap { font-size: .9375rem; color: var(--board-ink); }
.c-when time { display: inline-grid; gap: .1rem; justify-items: start; }
.c-when .date { font-size: .75rem; }
.c-when, .c-by { color: var(--board-dim); font-size: .875rem; min-width: 0; overflow-wrap: anywhere; }
.board .empty { padding: 1.4rem 1.35rem 1.6rem; display: grid; gap: .55rem; }
.board .empty > p { color: var(--board-dim); max-width: 60ch; }
.board .steps { margin-top: .5rem; }
.board pre { background: var(--cell); }
.board :not(pre) > code { background: var(--cell); }
@container (max-width: 40rem) {
  .board-head { display: none; }
  .row { grid-template-columns: auto auto; grid-template-areas: "state ver" "share share" "when when" "by by"; justify-content: space-between; gap: .45rem .75rem; padding: .9rem 1rem; }
  .c-state { grid-area: state; } .c-ver { grid-area: ver; justify-self: end; } .c-share { grid-area: share; } .c-when { grid-area: when; } .c-by { grid-area: by; }
  .row .lbl { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
}

/* Notices, and the new token, shown once */
.notice { border: 1px solid var(--rule); border-radius: 6px; padding: 1rem 1.15rem; display: grid; gap: .55rem; }
.notice.err { border-color: var(--danger); }
.notice.err strong { color: var(--danger); }
/* The home asks which Share a pasted link names before erasing it: the danger button, and a quiet way back. */
.notice .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem .75rem; }
.button.quiet { background: none; color: var(--ink); box-shadow: inset 0 0 0 1px var(--field); }
.button.quiet:hover { background: var(--sunken); }
.pass { background: var(--board); color: var(--board-ink); border: 1px solid var(--board-edge); border-radius: 6px; padding: 1.2rem 1.35rem; display: grid; gap: .65rem; border-top: 6px solid var(--signal); }
.pass .hint { color: var(--board-dim); }
.pass :not(pre) > code { background: var(--cell); }
#new-token { display: block; padding: .8rem 1rem; background: var(--cell); border: 1px dashed var(--signal); border-radius: var(--radius); font-size: 1rem; word-break: break-all; user-select: all; -webkit-user-select: all; cursor: text; }
@media (prefers-reduced-motion: no-preference) {
  .reveal { transition: opacity .3s ease, translate .3s cubic-bezier(.16, 1, .3, 1); }
  @starting-style { .reveal { opacity: 0; translate: 0 6px; } }
}

/* Tokens list: columns on wide screens, stacked fields on narrow ones */
.list { display: grid; gap: .6rem; container-type: inline-size; }
.list-head, .token { display: grid; grid-template-columns: minmax(0, 1fr) 11rem 11rem 11rem 6rem; gap: 0 1rem; align-items: start; }
.list-head { padding-bottom: .5rem; border-bottom: 1px solid var(--rule); font-size: .75rem; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
.tokens { list-style: none; margin: 0; padding: 0; }
.token { padding: .85rem 0; }
.token + .token { border-top: 1px solid var(--rule); }
.token.revoked { color: var(--muted); }
.t-name { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.t-name .id { display: block; font-family: var(--mono); font-size: .75rem; font-weight: 400; color: var(--muted); }
.t-created, .t-used, .t-state { font-size: .9375rem; }
.t-action { justify-self: end; }
.t-state time { display: block; }
.on { display: inline-flex; align-items: center; gap: .4rem; font-weight: 650; }
.on::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; }
@container (max-width: 44rem) {
  .list-head { display: none; }
  .token { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name action" "created created" "used used" "state state"; gap: .3rem 1rem; }
  .t-name { grid-area: name; } .t-created { grid-area: created; } .t-used { grid-area: used; } .t-state { grid-area: state; } .t-action { grid-area: action; }
  .token .lbl { position: static; width: auto; height: auto; overflow: visible; clip-path: none; color: var(--muted); }
}
details.confirm { position: relative; text-align: left; }
details.confirm summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; min-height: 2.25rem; padding: .3rem .85rem; border: 1px solid var(--danger); border-radius: var(--radius); color: var(--danger); font-weight: 650; font-size: .875rem; }
details.confirm summary::-webkit-details-marker { display: none; }
details.confirm[open] summary { background: var(--danger); color: var(--danger-ink); }
details.confirm .ask { position: absolute; right: 0; top: calc(100% + .4rem); z-index: 2; width: min(18rem, 80vw); padding: .9rem 1rem; display: grid; gap: .65rem; font-size: .875rem; background: var(--ground); color: var(--ink); border: 1px solid var(--rule); border-radius: 6px; box-shadow: 0 14px 30px -12px oklch(0% 0 0 / .35); }
p.empty { color: var(--muted); }

/* Viewer: a thin graphite frame over the Share, so the Share never passes for the Instance */
body.viewer { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem 1rem; padding: .4rem clamp(.75rem, 3vw, 1.25rem); background: var(--board); color: var(--board-ink); border-bottom: 1px solid var(--board-edge); }
.bar .title { display: flex; align-items: center; gap: .6rem; min-width: 0; flex: 1 1 18rem; }
.bar .brand { min-height: 2rem; }
.bar h1 { font-size: .9375rem; line-height: 1.35; font-weight: 650; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
@media (max-width: 40rem) { .bar h1 { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; } }
.bar .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .9rem; font-size: .8125rem; color: var(--board-dim); }
details.versions { position: relative; }
details.versions summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: .45rem; min-height: 1.75rem; padding: .1rem .55rem; border: 1px solid var(--board-rule); border-radius: var(--radius); color: var(--board-ink); font-family: var(--mono); font-size: .8125rem; }
details.versions summary::-webkit-details-marker { display: none; }
details.versions summary::after { content: ""; width: .38rem; height: .38rem; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; rotate: 45deg; translate: 0 -2px; }
details.versions[open] summary::after { rotate: 225deg; translate: 0 2px; }
details.versions ul { position: absolute; z-index: 2; right: 0; top: calc(100% + .35rem); margin: 0; padding: .3rem; list-style: none; min-width: 11rem; max-height: 60dvh; overflow: auto; background: var(--board); border: 1px solid var(--board-rule); border-radius: 6px; box-shadow: 0 12px 28px -10px oklch(0% 0 0 / .5); }
details.versions a { display: block; padding: .35rem .6rem; border-radius: 3px; color: var(--board-ink); text-decoration: none; font-family: var(--mono); font-size: .8125rem; }
details.versions a:hover { background: var(--cell); }
details.versions a[aria-current] { background: var(--signal); color: var(--signal-ink); font-weight: 700; }
.bar .open { display: inline-flex; align-items: center; min-height: 1.75rem; color: var(--board-ink); font-weight: 600; }
/* The Author's Erase on the graphite bar: sized like its neighbours; its question opens on the ground, kept on screen. */
.bar details.confirm summary { min-height: 1.75rem; padding: .1rem .6rem; font-size: .8125rem; border-color: var(--board-danger); color: var(--board-danger); }
.bar details.confirm[open] summary { background: var(--board-danger); color: oklch(15% .02 27); }
.bar details.confirm .ask { position: fixed; top: auto; right: clamp(.75rem, 3vw, 1.25rem); margin-top: .4rem; width: min(20rem, calc(100vw - 1.5rem)); max-height: max(8rem, calc(100dvh - 10rem)); overflow-y: auto; --focus: var(--focus-ground); }
.older { margin: 0; padding: .45rem clamp(.75rem, 3vw, 1.25rem); background: var(--signal); color: var(--signal-ink); font-size: .875rem; font-weight: 600; --focus: var(--signal-ink); }
.older a { font-weight: 750; }
iframe.share { flex: 1; width: 100%; border: 0; background: #ffffff; color-scheme: light; }

/* Not found: a sign on the ground */
main.center { min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem clamp(1rem, 4vw, 2rem); }
.lost { max-width: 28rem; display: grid; gap: 1rem; justify-items: start; }
.plate { display: grid; place-items: center; padding: .65rem; border: 1px solid var(--board-edge); border-radius: var(--radius); background: var(--board); }
.plate .mark { width: 2.5rem; height: 2.5rem; }
.lost h1 { font-size: 2.25rem; font-weight: 800; letter-spacing: -.028em; }
.lost p { color: var(--muted); }

@media (forced-colors: active) {
  .state, .panel, .notice, .pass, .board, .button, button, #new-token, details.confirm summary, details.versions summary { border: 1px solid CanvasText; }
  .flap { background: none; clip-path: none; margin-right: 0; }
}
`;

export interface PageResult {
  body: string;
  csp: string;
}

// The stylesheet is allowed by its hash, so a page is the same bytes every time it is served:
// two refused requests can never be told apart by a nonce.
let cssHash: Promise<string> | undefined;
function styleHash(): Promise<string> {
  cssHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(CSS))
    .then((d) => btoa(String.fromCharCode(...new Uint8Array(d))));
  return cssHash;
}

/** The htmlgate mark: an arched gate over a threshold. A single geometric figure, drawn inline. */
const MARK = `<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5.5 20.5V10a6.5 6.5 0 0 1 13 0v10.5"/><path d="M3 20.5h18"/><path d="M12 12.5v4"/></svg>`;
/** The wayfinding arrow on the main action. */
const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 12h15"/><path d="m13 6 6 6-6 6"/></svg>`;

async function layout(lang: Language, title: string, body: string, opts: { bodyClass?: string; frames?: boolean; sandbox?: boolean } = {}): Promise<PageResult> {
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body${opts.bodyClass ? ` class="${opts.bodyClass}"` : ""}>
${body}
</body>
</html>`;
  const csp = [
    "default-src 'none'",
    opts.sandbox ? "sandbox" : "",
    `style-src 'sha256-${await styleHash()}'`,
    opts.frames ? "frame-src 'self'" : "",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].filter(Boolean).join("; ");
  return { body: html, csp };
}

/** Who is looking at one of the Instance's own pages. */
export interface Visitor {
  email: string;
  isAuthor: boolean;
  /** The Instance's own origin, for instructions that name it. */
  origin: string;
  lang: Language;
}

/** The Author's home list: the most recently updated Shares and the counts over all of them. */
export interface HomeList {
  total: number;
  publicTotal: number;
  shares: { slug: string; title: string; public: number; latest_version: number; updated_at: number; changed_by_name: string | null }[];
}

function header(v: Visitor, current: "home" | "tokens"): string {
  const t = STRINGS[v.lang];
  const here = (page: typeof current) => (page === current ? ' aria-current="page"' : "");
  return `<header class="top">
<a class="brand" href="/">${MARK}<span>htmlgate</span></a>
<span class="host">${escapeHtml(new URL(v.origin).host)}</span>
${v.isAuthor ? `<nav aria-label="${t.instance}">\n<a href="/"${here("home")}>${t.shares}</a>\n<a href="/tokens"${here("tokens")}>${t.tokens}</a>\n</nav>` : ""}
<span class="who" title="${t.signedIn}">${escapeHtml(v.email)}</span>
</header>`;
}

const skip = (lang: Language) => `<a class="skip" href="#main">${STRINGS[lang].skip}</a>`;

const iso = (ms: number) => new Date(ms).toISOString();
const when = (ms: number) => iso(ms).replace("T", " ").slice(0, 16) + " UTC";
const timeTag = (ms: number, prefix = "") => `<time datetime="${iso(ms)}">${prefix}${when(ms)}</time>`;
/** A board time: the hour on flaps, as a departure board prints it, and the date under it. */
const boardTime = (ms: number) => `<time datetime="${iso(ms)}"><span class="flap">${iso(ms).slice(11, 16)}</span> <span class="date">${iso(ms).slice(0, 10)} UTC</span></time>`;
const state = (lang: Language, isPublic: boolean) =>
  isPublic ? `<span class="state state-public">${STRINGS[lang].public}</span>` : `<span class="state state-gated">${STRINGS[lang].gated}</span>`;

/**
 * The one not-found page. On a public link it may offer sign-in (`signInPath`); behind the gate it offers a
 * way home (`home`), labelled for the Author. It never depends on whether a Share exists, nor on whether
 * someone is on the Allowlist.
 */
export function notFoundPage(lang: Language, opts: { signInPath?: string; home?: "author" | "viewer" } = {}): Promise<PageResult> {
  const t = STRINGS[lang];
  const { signInPath, home } = opts;
  return layout(lang, t.notFound, `${skip(lang)}
<main id="main" class="center">
<div class="lost">
<div class="plate">${MARK}</div>
<h1>${t.notFound}</h1>
<p>${t.notFoundLead}</p>
${signInPath ? `<a class="button" href="${escapeHtml(signInPath)}">${t.signInRetry}${ARROW}</a>` : ""}${home ? `<a class="button" href="/">${home === "author" ? t.backToShares : t.goHome}${ARROW}</a>` : ""}
</div>
</main>`, { sandbox: true });
}

/**
 * The home page. `list` is given for the Author only, and its presence picks the layout: a Viewer's home
 * lists nothing, so a list reaching a Viewer would show (and the tests would see it) rather than hide.
 */
export function homePage(v: Visitor, list: HomeList | null, note?: HomeNote): Promise<PageResult> {
  const t = STRINGS[v.lang];
  if (!list) {
    return layout(v.lang, "htmlgate", `${skip(v.lang)}
${header(v, "home")}
<main id="main" class="page">
<div>
<h1>${t.viewerTitle}</h1>
<p class="lead">${t.viewerLead}</p>
</div>
</main>`);
  }
  const rows = list.shares.map((d) => `<li class="row">
<span class="c-state">${state(v.lang, d.public === 1)}</span>
<span class="c-share"><a href="/s/${d.slug}">${escapeHtml(d.title)}</a><span class="flap">${d.slug}</span></span>
<span class="c-ver"><span class="lbl">${t.version} </span><span class="flap">v${d.latest_version}</span></span>
<span class="c-when"><span class="lbl">${t.updated} </span>${boardTime(d.updated_at)}</span>
<span class="c-by">${d.changed_by_name === null ? "" : `<span class="lbl">${t.by} </span>${escapeHtml(d.changed_by_name)}`}</span>
</li>`).join("\n");
  const board = rows
    ? `<div class="board">
<div class="board-head" aria-hidden="true"><span>${t.status}</span><span>${t.share}</span><span>${t.version}</span><span>${t.updated}</span><span>${t.by}</span></div>
<ol class="rows" aria-label="${t.boardLabel}">
${rows}
</ol>
</div>${list.total > list.shares.length ? `\n<p class="hint">${t.truncated(list.shares.length, list.total)} <code>htmlgate list</code> ${t.listAll}</p>` : ""}`
    : "";
  const config = `htmlgate login ${v.origin}`;
  const steps = `<ol class="steps">
<li>${t.step1(`<a href="/tokens">${t.tokens}</a>`)}</li>
<li>${t.step2}<pre tabindex="0" role="region" aria-label="${t.step2Label}"><code>${escapeHtml(config)}</code></pre></li>
<li>${t.step3}<pre tabindex="0" role="region" aria-label="${t.step3Label}"><code>${escapeHtml(t.publishExample)}</code></pre></li>
</ol>`;
  // With no Shares yet, the publish steps are the page; afterwards they sit beside the legend as a note.
  const lead = board || `<section class="board" aria-labelledby="publish"><div class="empty">
<h2 id="publish">${t.empty}</h2>
<p>${t.emptyLead}</p>
${steps}
</div></section>`;
  return layout(v.lang, `${t.homeTitle} · htmlgate`, `${skip(v.lang)}
${header(v, "home")}
<main id="main" class="page">
<div class="heading">
<div>
<h1>${t.homeTitle}</h1>
<p class="lead">${t.counts(list.total, list.publicTotal)}</p>
</div>
<a class="button" href="/tokens">${t.newToken}${ARROW}</a>
</div>
${note === undefined ? "" : "erased" in note
    ? `<div class="notice" role="status"><p>${t.erased(escapeHtml(note.erased))}</p></div>\n`
    : "confirm" in note
      ? `<section class="notice err" aria-labelledby="erase-check">
<h2 id="erase-check">${t.eraseCheck}</h2>
<p>${t.eraseAsk(escapeHtml(note.confirm.title))} <code>${escapeHtml(note.confirm.slug)}</code></p>
<form method="post" action="/erase" class="actions"><input type="hidden" name="share" value="${escapeHtml(note.confirm.slug)}"><input type="hidden" name="confirm" value="1"><button class="danger" type="submit">${t.eraseConfirm}</button><a class="button quiet" href="/">${t.keep}</a></form>
</section>\n`
      : `<div class="notice err" role="alert"><p><strong>${t.eraseErrors[note.error]}</strong></p></div>\n`}${lead}
<div class="notes">
${board ? `<section class="panel quiet" aria-labelledby="publish">
<h2 id="publish">${t.publishTitle}</h2>
${steps}
</section>
` : ""}<section class="panel" aria-labelledby="sharing">
<h2 id="sharing">${t.whoTitle}</h2>
<dl class="legend">
<div><dt>${state(v.lang, false)}</dt><dd>${t.gatedMeans}</dd></div>
<div><dt>${state(v.lang, true)}</dt><dd>${t.publicMeans}</dd></div>
</dl>
<p class="hint">${t.requestsListed} <a href="/api/onboard">/api/onboard</a>.</p>
</section>
<section class="panel" aria-labelledby="erase">
<h2 id="erase">${t.eraseTitle}</h2>
<p>${t.eraseLead}</p>
<form method="post" action="/erase" class="create">
<label for="erase-share">${t.eraseField}</label>
<div class="row-input"><input id="erase-share" name="share" type="text" required maxlength="512" autocomplete="off" spellcheck="false" aria-describedby="erase-hint"><button class="danger" type="submit">${t.eraseStart}</button></div>
<span id="erase-hint" class="hint">${t.eraseHint}</span>
</form>
</section>
</div>
</main>`);
}

export function tokensPage(
  v: Visitor,
  tokens: { id: string; name: string; created_at: number; last_used_at: number | null; revoked_at: number | null }[],
  created?: { name: string; token: string },
  error?: TokenError,
): Promise<PageResult> {
  const t = STRINGS[v.lang];
  const items = tokens.map((k) => {
    const name = escapeHtml(k.name);
    const live = k.revoked_at === null;
    const action = live
      ? `<details class="confirm" data-token-name="${name}">
<summary>${t.revoke}</summary>
<div class="ask">
<p>${t.revokeAsk(name)}</p>
<form method="post" action="/tokens/${k.id}/revoke"><button class="danger" type="submit" aria-label="${t.revokeNamed(name)}">${t.revokeNamed(name)}</button></form>
</div>
</details>`
      : "";
    return `<li class="token${live ? "" : " revoked"}">
<span class="t-name">${name}<span class="id">${k.id}</span></span>
<span class="t-created"><span class="lbl">${t.createdLabel} </span>${timeTag(k.created_at)}</span>
<span class="t-used"><span class="lbl">${t.lastUsed} </span>${k.last_used_at === null ? t.never : timeTag(k.last_used_at)}</span>
<span class="t-state">${live ? `<span class="on">${t.active}</span>` : `${t.revoked} ${timeTag(k.revoked_at!)}`}</span>
<span class="t-action">${action}</span>
</li>`;
  }).join("\n");
  return layout(v.lang, `${t.tokensTitle} · htmlgate`, `${skip(v.lang)}
${header(v, "tokens")}
<main id="main" class="page">
<div>
<h1>${t.tokensTitle}</h1>
<p class="lead">${t.tokensLead}</p>
</div>
${error ? `<div class="notice err" role="alert"><p><strong>${t.errors[error]}</strong></p></div>` : ""}
${created ? `<div class="pass reveal" role="status">
<h2>${t.created(escapeHtml(created.name))}</h2>
<p>${t.copyNow}</p>
<code id="new-token">${created.token}</code>
<p class="hint">${t.createdHint}</p>
</div>` : ""}
<section class="panel" aria-labelledby="create">
<h2 id="create">${t.createTitle}</h2>
<form method="post" action="/tokens" class="create">
<label for="name">${t.name}</label>
<div class="row-input"><input id="name" name="name" type="text" required maxlength="64" placeholder="${t.namePlaceholder}" aria-describedby="name-hint"><button type="submit">${t.create}</button></div>
<span id="name-hint" class="hint">${t.nameHint}</span>
</form>
</section>
<section class="list" aria-labelledby="yours">
<h2 id="yours">${t.yours}</h2>
${items
    ? `<div class="list-head" aria-hidden="true"><span>${t.name}</span><span>${t.createdLabel}</span><span>${t.lastUsed}</span><span>${t.state}</span><span></span></div>
<ul class="tokens">
${items}
</ul>`
    : `<p class="empty">${t.noTokens}</p>`}
</section>
</main>`);
}

/** `frame`: where the shown Version opens when it is a site (its files' URL); a page opens from its raw URL. */
export function viewerPage(lang: Language, d: { slug: string; title: string; public: number; updated_at: number; expires_at: number | null }, prefix: "s" | "p", shown: number,
  versions: number[], latest: number, frame?: string, erase = false): Promise<PageResult> {
  const t = STRINGS[lang];
  const latestHref = `/${prefix}/${d.slug}`;
  const items = versions.map((n) => {
    const href = n === latest ? latestHref : `/${prefix}/${d.slug}?v=${n}`;
    const label = n === latest ? `v${n} ${t.latestTag}` : `v${n}`;
    return `<li><a href="${href}"${n === shown ? ' aria-current="page"' : ""}>${label}</a></li>`;
  }).join("");
  const raw = `/${prefix}/${d.slug}/raw?v=${shown}`;
  // The mark links home only behind the gate; on a public link the visitor may not be signed in.
  const mark = prefix === "s" ? `<a class="brand" href="/" aria-label="${t.homeOf}">${MARK}</a>` : MARK;
  return layout(lang, d.title, `<a class="skip" href="#share">${t.skipShare}</a>
<header class="bar">
<div class="title">${mark}<h1>${escapeHtml(d.title)}</h1>${state(lang, d.public === 1)}</div>
<div class="meta">
${timeTag(d.updated_at, t.updatedAt)}
${d.expires_at === null ? "" : timeTag(d.expires_at, t.expiresAt)}
<details class="versions">
<summary aria-label="${t.versionsLabel(shown, latest)}">${t.versionOf(shown, latest)}</summary>
<nav aria-label="${t.versions}"><ul>${items}</ul></nav>
</details>
<a class="open" href="${raw}" target="_blank" rel="noopener">${t.openTab}</a>
${erase ? `<details class="confirm">
<summary>${t.erase}</summary>
<div class="ask">
<p>${t.eraseAsk(escapeHtml(d.title))}</p>
<form method="post" action="/erase"><input type="hidden" name="share" value="${d.slug}"><input type="hidden" name="confirm" value="1"><button class="danger" type="submit">${t.eraseConfirm}</button></form>
</div>
</details>
` : ""}</div>
</header>
${shown === latest ? "" : `<p class="older" role="status">${t.older(shown, latest)} <a href="${latestHref}">${t.showLatest}</a></p>\n`}<iframe class="share" sandbox="${SHARE_SANDBOX}" src="${escapeHtml(frame ?? raw)}" id="share" title="${escapeHtml(d.title)}"></iframe>`, { bodyClass: "viewer", frames: true });
}
