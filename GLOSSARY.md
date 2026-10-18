# htmlgate

Agent-first HTML hosting that each operator runs in a cloud account they control. Agents publish HTML pages and static sites, and people read them behind a sign-in.

## Language

**Share**:
One published HTML page or Site with a stable URL.
_Avoid_: Page, paste, file, post, Drop (its name before 0.1)

**Version**:
One published body of a Share: a page (one HTML document) or a Site. A Share's URL shows its latest Version.
_Avoid_: Revision, edit, snapshot

**Site**:
A Version made of several files, published as a zip or a folder, that opens at its `index.html`.
_Avoid_: Bundle, archive, app

**Expiry**:
When a Share stops being reachable and its bodies are deleted for good: by default the Instance's number of days after its latest publish, or a date a Publisher set.
_Avoid_: TTL, retention, lifetime

**Erase**:
To delete a Share for good, at once: every Version, the Share's record and its bodies, whether or not it was deleted before. Only the Author can, signed in, on the Instance's own pages. Deleting only hides a Share.
_Avoid_: Purge, wipe, hard delete

**Ticket**:
A sealed, hour-long permission to read one Version of a Gated Site's files, issued to a person on the Allowlist after the Worker verified their sign-in.
_Avoid_: Signed URL, capability, session

**Tags**:
The key and value labels a Publisher puts on a Share so it can find that Share again.
_Avoid_: Metadata, labels, attributes

**Instance**:
One deployment of htmlgate, living in a single Host and serving its own Shares.
_Avoid_: Server, tenant, site, install

**Host**:
The cloud provider account an Instance lives in.
_Avoid_: Provider, cloud, backend

**Operator**:
The person who sets up and configures an Instance in a Host they control.
_Avoid_: Admin, owner, user

**Author**:
The person a Share belongs to.
_Avoid_: Owner, account, member, user

**Publisher**:
An agent or command-line client that creates and updates Shares on an Instance for one Author.
_Avoid_: Agent, client, uploader, user

**Token**:
The secret a Publisher sends on every request, issued to one Author.
_Avoid_: Key, API key, password

**Viewer**:
A person who opens a Share.
_Avoid_: Reader, visitor, user

**Allowlist**:
The people an Operator has named who may sign in to an Instance and open its Gated Shares.
_Avoid_: Whitelist, access list, members

**Gated Share**:
A Share that only a person on the Allowlist can open, after signing in. Every Share starts gated.
_Avoid_: Private share, locked share

**Public Share**:
A Share that anyone holding its URL can open without signing in.
_Avoid_: Open share, unlisted share

## On pt-BR pages

An Instance set to `"language": "pt-BR"` shows these words on its pages. The landing uses the same ones.

| Term | pt-BR |
|---|---|
| Share | Share |
| Version | Versão |
| Instance | Instância |
| Author | autor |
| Publisher | publicador |
| Token | token |
| Allowlist | lista de acesso |
| Gated | Fechado |
| Public | Público |
| Site | site |
| Expiry | expiração (on pages: "Expira em") |
| Erase | eliminar (on pages: "Eliminar de vez") |
| Ticket | tíquete |
