export type StoreBugVariant =
  | "none"
  | "expire-views-after-versions"
  | "count-view-without-live-guard"
  | "add-version-rechecks-live"
  | "claim-expired-reservation"
  | "empty-trash-ignores-due-at"
  | "due-now-same-ms-race";

export type RevokeBugVariant = "none" | "revoke-all-sessions-last";

export interface ModelBounds {
  maxClock: number;
  reservationTtl: number;
  storageLimit: number;
  keepVersions: number;
  cleanupBatch: number;
  maxUploads: number;
}

export const DEFAULT_BOUNDS: ModelBounds = {
  maxClock: 2,
  reservationTtl: 1,
  storageLimit: 2,
  keepVersions: 1,
  cleanupBatch: 1,
  maxUploads: 2,
};

interface ShareRecord {
  slug: string;
  latestVersion: number;
  deletedAt: number | null;
  expiresAt: number | null;
}

interface VersionRecord {
  slug: string;
  n: number;
  bodyKey: string;
}

interface TrashRecord {
  bodyKey: string;
  size: number;
  dueAt: number;
}

interface WriterState {
  phase: "idle" | "reserved" | "uploaded";
  op: "create" | "addVersion";
  slug: string;
  bodyKey: string;
}

interface EmptyTrashWorker {
  phase: "idle" | "selected" | "deletedR2";
  snapshot: { bodyKey: string; dueAt: number }[];
}

interface EraseBodiesWorker {
  phase: "idle" | "listed";
  slug: string;
  keys: string[];
}

interface StoreState {
  clock: number;
  nextBodyId: number;
  createdSlugs: Record<string, boolean>;
  shares: Record<string, ShareRecord>;
  versions: VersionRecord[];
  trash: Record<string, TrashRecord>;
  views: Record<string, number>;
  r2: Record<string, boolean>;
  writers: [WriterState, WriterState];
  emptyTrash: EmptyTrashWorker;
  eraseBodies: EraseBodiesWorker;
  foreignViewsDeleted: boolean;
}

export interface Violation {
  invariant: string;
  reason: string;
  trace: string[];
}

export interface CheckResult {
  model: string;
  variant: string;
  statesExplored: number;
  transitionsExplored: number;
  ok: boolean;
  violation?: Violation;
}

const SLUGS = ["S1", "S2"] as const;

function cloneStore(s: StoreState): StoreState {
  return {
    clock: s.clock,
    nextBodyId: s.nextBodyId,
    createdSlugs: { ...s.createdSlugs },
    shares: Object.fromEntries(Object.entries(s.shares).map(([k, v]) => [k, { ...v }])),
    versions: s.versions.map((v) => ({ ...v })),
    trash: Object.fromEntries(Object.entries(s.trash).map(([k, v]) => [k, { ...v }])),
    views: { ...s.views },
    r2: { ...s.r2 },
    writers: [{ ...s.writers[0] }, { ...s.writers[1] }],
    emptyTrash: { phase: s.emptyTrash.phase, snapshot: s.emptyTrash.snapshot.map((x) => ({ ...x })) },
    eraseBodies: { phase: s.eraseBodies.phase, slug: s.eraseBodies.slug, keys: [...s.eraseBodies.keys] },
    foreignViewsDeleted: s.foreignViewsDeleted,
  };
}

function canonicalKey(s: StoreState): string {
  const shares = Object.keys(s.shares)
    .sort()
    .map((k) => {
      const sh = s.shares[k]!;
      return `${k}:${sh.latestVersion}:${sh.deletedAt ?? "_"}:${sh.expiresAt ?? "_"}`;
    })
    .join(",");
  const versions = [...s.versions]
    .sort((a, b) => (a.slug === b.slug ? a.n - b.n : a.slug < b.slug ? -1 : 1))
    .map((v) => `${v.slug}#${v.n}=${v.bodyKey}`)
    .join(",");
  const trash = Object.keys(s.trash)
    .sort()
    .map((k) => `${k}@${s.trash[k]!.dueAt}`)
    .join(",");
  const views = Object.keys(s.views)
    .sort()
    .map((k) => `${k}=${s.views[k]}`)
    .join(",");
  const r2 = Object.keys(s.r2).sort().join(",");
  const writers = s.writers.map((w) => `${w.phase}:${w.op}:${w.slug}:${w.bodyKey}`).sort().join("|");
  const et = `${s.emptyTrash.phase}:${s.emptyTrash.snapshot.map((x) => `${x.bodyKey}@${x.dueAt}`).join(",")}`;
  const eb = `${s.eraseBodies.phase}:${s.eraseBodies.slug}:${s.eraseBodies.keys.join(",")}`;
  const cs = Object.keys(s.createdSlugs).sort().join(",");
  return `${s.clock}|${s.nextBodyId}|${cs}|${shares}|${versions}|${trash}|${views}|${r2}|${writers}|${et}|${eb}|${s.foreignViewsDeleted ? 1 : 0}`;
}

function isLive(sh: ShareRecord | undefined, clock: number): boolean {
  return sh !== undefined && sh.deletedAt === null && (sh.expiresAt === null || sh.expiresAt > clock);
}

function checkStoreInvariants(s: StoreState, bounds: ModelBounds): { invariant: string; reason: string } | null {
  if (s.foreignViewsDeleted) {
    return {
      invariant: "EXPIRE_BATCH_ISOLATION",
      reason: "Store.expire() deleted share_views for a Share outside the batch whose Versions were purged.",
    };
  }
  for (const v of s.versions) {
    if (!s.r2[v.bodyKey]) {
      return {
        invariant: "NO_DANGLING_VERSION_BODY",
        reason: `Version ${v.slug} v${v.n} points to R2 key ${v.bodyKey}, which is missing from R2.`,
      };
    }
    const sh = s.shares[v.slug];
    if (!sh || sh.latestVersion < v.n) {
      return {
        invariant: "SHARE_VERSION_CONSISTENCY",
        reason: `Version ${v.slug} v${v.n} exists, but shares.${v.slug} is ${sh ? `at latest_version=${sh.latestVersion}` : "missing"}.`,
      };
    }
  }
  for (const sh of Object.values(s.shares)) {
    const slugVersions = s.versions.filter((v) => v.slug === sh.slug);
    if (slugVersions.length === 0 && sh.deletedAt === null) {
      return {
        invariant: "SHARE_VERSION_CONSISTENCY",
        reason: `Live Share ${sh.slug} has zero rows in versions.`,
      };
    }
    if (slugVersions.length > 0 && !slugVersions.some((v) => v.n === sh.latestVersion)) {
      return {
        invariant: "SHARE_VERSION_CONSISTENCY",
        reason: `Share ${sh.slug} points to latest_version=${sh.latestVersion}, which is absent from versions.`,
      };
    }
    if (slugVersions.length === 0 && sh.deletedAt !== null && s.views[sh.slug] !== undefined) {
      return {
        invariant: "NO_ORPHAN_VIEWS_AFTER_PURGE_OR_ERASE",
        reason: `Purged expired Share ${sh.slug} still has ${s.views[sh.slug]} row(s) in share_views.`,
      };
    }
  }
  for (const slug of Object.keys(s.views)) {
    if (!s.shares[slug]) {
      return {
        invariant: "NO_ORPHAN_VIEWS_AFTER_PURGE_OR_ERASE",
        reason: `Erased Share ${slug} has an orphan row in share_views.`,
      };
    }
  }
  const activeReservations = Object.values(s.trash).filter((t) => t.dueAt > s.clock);
  if (s.versions.length + activeReservations.length > bounds.storageLimit) {
    return {
      invariant: "UNEXPIRED_STORAGE_CAP",
      reason: `Versions (${s.versions.length}) + unexpired reservations (${activeReservations.length}) exceed storageLimit (${bounds.storageLimit}).`,
    };
  }
  // Every R2 object whose upload was rejected/re-ledgered (and is not referenced by a Version or currently being uploaded/erased) must stay in trash until deleted from R2.
  const versionKeys = new Set(s.versions.map((v) => v.bodyKey));
  const inFlightWriterKeys = new Set(s.writers.filter((w) => w.phase !== "idle").map((w) => w.bodyKey));
  const inFlightEraseKeys = new Set(s.eraseBodies.phase === "listed" ? s.eraseBodies.keys : []);
  const inFlightEmptyKeys = new Set(s.emptyTrash.phase === "selected" ? s.emptyTrash.snapshot.map((x) => x.bodyKey) : []);
  for (const key of Object.keys(s.r2)) {
    if (!versionKeys.has(key) && !s.trash[key] && !inFlightWriterKeys.has(key) && !inFlightEraseKeys.has(key) && !inFlightEmptyKeys.has(key)) {
      // Only flag when the body was previously ledgered (not an upload that outlived its reservation before dueNow).
      // Wait: if emptyTrash deleted the trash row while a fresher dueNow row existed, the body is still in R2 without a trash row!
      return {
        invariant: "NO_LOST_RELEDGERED_TRASH",
        reason: `Unreferenced R2 object ${key} has no trash ledger row left for cleanup.`,
      };
    }
  }
  return null;
}

function initialStoreState(): StoreState {
  return {
    clock: 0,
    nextBodyId: 1,
    createdSlugs: { S1: true, S2: true },
    shares: {
      S1: { slug: "S1", latestVersion: 1, deletedAt: null, expiresAt: 1 },
      S2: { slug: "S2", latestVersion: 1, deletedAt: null, expiresAt: 1 },
    },
    versions: [
      { slug: "S1", n: 1, bodyKey: "bodies/S1/k0" },
      { slug: "S2", n: 1, bodyKey: "bodies/S2/k0" },
    ],
    trash: {},
    views: { S1: 1, S2: 1 },
    r2: { "bodies/S1/k0": true, "bodies/S2/k0": true },
    writers: [
      { phase: "idle", op: "addVersion", slug: "", bodyKey: "" },
      { phase: "idle", op: "addVersion", slug: "", bodyKey: "" },
    ],
    emptyTrash: { phase: "idle", snapshot: [] },
    eraseBodies: { phase: "idle", slug: "", keys: [] },
    foreignViewsDeleted: false,
  };
}

function initialReservationRaceState(): StoreState {
  return {
    clock: 0,
    nextBodyId: 1,
    createdSlugs: { S1: true },
    shares: {
      S1: { slug: "S1", latestVersion: 1, deletedAt: null, expiresAt: 2 },
    },
    versions: [{ slug: "S1", n: 1, bodyKey: "bodies/S1/k0" }],
    trash: {},
    views: {},
    r2: { "bodies/S1/k0": true },
    writers: [
      { phase: "idle", op: "addVersion", slug: "", bodyKey: "" },
      { phase: "idle", op: "create", slug: "", bodyKey: "" },
    ],
    emptyTrash: { phase: "idle", snapshot: [] },
    eraseBodies: { phase: "idle", slug: "", keys: [] },
    foreignViewsDeleted: false,
  };
}

function nextStoreTransitions(s: StoreState, bounds: ModelBounds, bug: StoreBugVariant): [string, StoreState][] {
  const out: [string, StoreState][] = [];
  const usedBytes = () => s.versions.length + Object.keys(s.trash).length;

  // 1. Clock advances (models D1 unixepoch('subsec') moving forward)
  if (s.clock < bounds.maxClock) {
    const n = cloneStore(s);
    n.clock += 1;
    out.push([`clockTick -> t=${n.clock}`, n]);
  }

  // 2. Store.putBody step 1 (reserve in trash if ROOM holds) and step 2 (R2 put) and Store.commit
  for (let wi = 0; wi < 2; wi++) {
    const w = s.writers[wi]!;
    if (w.phase === "idle" && s.nextBodyId <= bounds.maxUploads) {
      for (const slug of SLUGS) {
        const op: "create" | "addVersion" = s.shares[slug] ? "addVersion" : "create";
        if (op === "create" && s.createdSlugs[slug]) continue;
        if (usedBytes() + 1 <= bounds.storageLimit) {
          const n = cloneStore(s);
          if (op === "create") n.createdSlugs[slug] = true;
          const key = `bodies/${slug}/k${n.nextBodyId++}`;
          n.trash[key] = { bodyKey: key, size: 1, dueAt: n.clock + bounds.reservationTtl };
          n.writers[wi] = { phase: "reserved", op, slug, bodyKey: key };
          out.push([`W${wi + 1}: Store.putBody reserve(${op}, ${slug}, ${key}, due=${n.clock + bounds.reservationTtl})`, n]);
        }
      }
    } else if (w.phase === "reserved") {
      // R2 put succeeds
      const nOk = cloneStore(s);
      nOk.r2[w.bodyKey] = true;
      nOk.writers[wi]!.phase = "uploaded";
      out.push([`W${wi + 1}: R2.put(${w.bodyKey}) succeeds`, nOk]);

      // R2 put fails -> Store.dueNow
      const nFail = cloneStore(s);
      const prevFail = nFail.trash[w.bodyKey];
      const nextFailDue = bug !== "due-now-same-ms-race" && prevFail && prevFail.dueAt === nFail.clock ? nFail.clock + 1 : nFail.clock;
      nFail.trash[w.bodyKey] = { bodyKey: w.bodyKey, size: 1, dueAt: nextFailDue };
      nFail.writers[wi] = { phase: "idle", op: "addVersion", slug: "", bodyKey: "" };
      out.push([`W${wi + 1}: R2.put(${w.bodyKey}) fails -> Store.dueNow(${w.bodyKey}, due=${nextFailDue})`, nFail]);
    } else if (w.phase === "uploaded") {
      // Store.commit D1 batch (optionally with mid-batch clock advance for addVersion)
      const clockSteps = w.op === "addVersion" && s.clock < bounds.maxClock ? [0, 1] : [0];
      for (const midDelta of clockSteps) {
        const n = cloneStore(s);
        const resRow = n.trash[w.bodyKey];
        const reserved = bug === "claim-expired-reservation" ? resRow !== undefined : resRow !== undefined && resRow.dueAt > n.clock;
        let inserted = false;
        if (w.op === "create") {
          if (reserved && !n.shares[w.slug]) {
            n.versions.push({ slug: w.slug, n: 1, bodyKey: w.bodyKey });
            n.shares[w.slug] = { slug: w.slug, latestVersion: 1, deletedAt: null, expiresAt: n.clock + 2 };
            delete n.trash[w.bodyKey];
            inserted = true;
          }
        } else {
          const sh = n.shares[w.slug];
          if (reserved && isLive(sh, n.clock)) {
            const nextV = sh!.latestVersion + 1;
            n.versions.push({ slug: w.slug, n: nextV, bodyKey: w.bodyKey });
            inserted = true;
            if (midDelta > 0) n.clock += midDelta;
            const stmt2Allowed = bug === "add-version-rechecks-live" ? isLive(sh, n.clock) : true;
            if (stmt2Allowed) {
              sh!.latestVersion = nextV;
              // Prune versions outside KEEP_VERSIONS
              const kept: VersionRecord[] = [];
              for (const v of n.versions) {
                if (v.slug === w.slug && v.n <= sh!.latestVersion - bounds.keepVersions) {
                  n.trash[v.bodyKey] = { bodyKey: v.bodyKey, size: 1, dueAt: n.clock };
                } else {
                  kept.push(v);
                }
              }
              n.versions = kept;
            }
            delete n.trash[w.bodyKey];
          }
        }
        if (!inserted) {
          // Store.dueNow(key, cost)
          const prev = n.trash[w.bodyKey];
          const nextDue = bug !== "due-now-same-ms-race" && prev && prev.dueAt === n.clock ? n.clock + 1 : n.clock;
          n.trash[w.bodyKey] = { bodyKey: w.bodyKey, size: 1, dueAt: nextDue };
        }
        n.writers[wi] = { phase: "idle", op: "addVersion", slug: "", bodyKey: "" };
        const suffix = midDelta > 0 ? " [mid-batch clock tick]" : "";
        out.push([`W${wi + 1}: Store.commit(${w.op}, ${w.slug}, ${w.bodyKey})${suffix} -> ${inserted ? "written" : "gone+dueNow"}`, n]);
      }
    }
  }

  // 3. Store.emptyTrash (3 non-atomic steps: SELECT due -> R2.delete -> DELETE FROM trash)
  if (s.emptyTrash.phase === "idle") {
    const due = Object.values(s.trash)
      .filter((t) => t.dueAt <= s.clock)
      .sort((a, b) => (a.dueAt !== b.dueAt ? a.dueAt - b.dueAt : a.bodyKey < b.bodyKey ? -1 : 1))
      .slice(0, bounds.cleanupBatch);
    if (due.length > 0) {
      const n = cloneStore(s);
      n.emptyTrash = { phase: "selected", snapshot: due.map((t) => ({ bodyKey: t.bodyKey, dueAt: t.dueAt })) };
      out.push([`Store.emptyTrash SELECT due [${due.map((d) => `${d.bodyKey}@${d.dueAt}`).join(",")}]`, n]);
    }
  } else if (s.emptyTrash.phase === "selected") {
    const n = cloneStore(s);
    for (const row of n.emptyTrash.snapshot) delete n.r2[row.bodyKey];
    n.emptyTrash.phase = "deletedR2";
    out.push([`Store.emptyTrash R2.delete [${n.emptyTrash.snapshot.map((d) => d.bodyKey).join(",")}]`, n]);
  } else if (s.emptyTrash.phase === "deletedR2") {
    const n = cloneStore(s);
    for (const row of n.emptyTrash.snapshot) {
      const cur = n.trash[row.bodyKey];
      if (!cur) continue;
      if (bug === "empty-trash-ignores-due-at" || cur.dueAt === row.dueAt) {
        delete n.trash[row.bodyKey];
      }
    }
    n.emptyTrash = { phase: "idle", snapshot: [] };
    out.push([`Store.emptyTrash DELETE FROM trash`, n]);
  }

  // 4. Store.expire(now) — atomic D1 batch
  const selectDueSlugs = (st: StoreState) =>
    Object.values(st.shares)
      .filter((sh) => sh.expiresAt !== null && sh.expiresAt <= st.clock && st.versions.some((v) => v.slug === sh.slug))
      .sort((a, b) => (a.expiresAt! !== b.expiresAt! ? a.expiresAt! - b.expiresAt! : a.slug < b.slug ? -1 : 1))
      .slice(0, bounds.cleanupBatch)
      .map((sh) => sh.slug);

  if (selectDueSlugs(s).length > 0) {
    const n = cloneStore(s);
    const batch1 = new Set(selectDueSlugs(n));
    for (const v of n.versions) {
      if (batch1.has(v.slug)) n.trash[v.bodyKey] = { bodyKey: v.bodyKey, size: 1, dueAt: n.clock };
    }
    for (const slug of batch1) {
      const sh = n.shares[slug]!;
      sh.deletedAt = sh.deletedAt ?? sh.expiresAt;
    }
    if (bug === "expire-views-after-versions") {
      n.versions = n.versions.filter((v) => !batch1.has(v.slug));
      const batch2 = new Set(selectDueSlugs(n));
      for (const slug of batch2) {
        if (n.views[slug] !== undefined) {
          delete n.views[slug];
          if (!batch1.has(slug)) n.foreignViewsDeleted = true;
        }
      }
    } else {
      for (const slug of batch1) delete n.views[slug];
      n.versions = n.versions.filter((v) => !batch1.has(v.slug));
    }
    out.push([`Store.expire(t=${n.clock}) purged [${[...batch1].join(",")}]`, n]);
  }

  // 5. Store.countView(slug)
  for (const slug of SLUGS) {
    const sh = s.shares[slug];
    if (bug === "count-view-without-live-guard") {
      if (s.views[slug] === undefined) {
        const n = cloneStore(s);
        n.views[slug] = 1;
        out.push([`Store.countView(${slug}) [no live guard]`, n]);
      }
    } else if (isLive(sh, s.clock) && s.views[slug] === undefined) {
      const n = cloneStore(s);
      n.views[slug] = 1;
      out.push([`Store.countView(${slug})`, n]);
    }
  }

  // 6. Store.eraseShare + async Store.eraseBodies
  if (s.eraseBodies.phase === "idle") {
    for (const slug of Object.keys(s.shares).sort()) {
      const n = cloneStore(s);
      const keys = n.versions.filter((v) => v.slug === slug).map((v) => v.bodyKey);
      for (const key of keys) n.trash[key] = { bodyKey: key, size: 1, dueAt: n.clock };
      n.versions = n.versions.filter((v) => v.slug !== slug);
      delete n.views[slug];
      delete n.shares[slug];
      n.eraseBodies = { phase: "listed", slug, keys: [...new Set([...keys, ...Object.keys(n.r2).filter((k) => k.startsWith(`bodies/${slug}/`))])] };
      out.push([`Store.eraseShare(${slug})`, n]);
    }
  } else if (s.eraseBodies.phase === "listed") {
    const n = cloneStore(s);
    const { slug, keys } = n.eraseBodies;
    for (const key of keys) {
      if (!n.trash[key]) n.trash[key] = { bodyKey: key, size: 1, dueAt: n.clock };
    }
    for (const key of keys) delete n.r2[key];
    for (const key of keys) delete n.trash[key];
    n.eraseBodies = { phase: "idle", slug: "", keys: [] };
    out.push([`Store.eraseBodies(${slug}, [${keys.join(",")}])`, n]);
  }

  return out;
}

export function checkStoreModel(bug: StoreBugVariant = "none", bounds: ModelBounds = DEFAULT_BOUNDS): CheckResult {
  const roots: [string, StoreState][] = [
    ["init(two-expiring-shares)", initialStoreState()],
    ["init(reservation-and-race)", initialReservationRaceState()],
  ];
  const visited = new Set<string>();
  const queue: { state: StoreState; trace: string[] }[] = [];
  for (const [label, st] of roots) {
    visited.add(canonicalKey(st));
    queue.push({ state: st, trace: [label] });
  }
  let statesExplored = 0;
  let transitionsExplored = 0;
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++]!;
    statesExplored++;
    const bad = checkStoreInvariants(cur.state, bounds);
    if (bad) {
      return {
        model: "StoreLifecycle",
        variant: bug,
        statesExplored,
        transitionsExplored,
        ok: false,
        violation: { ...bad, trace: cur.trace },
      };
    }
    for (const [action, next] of nextStoreTransitions(cur.state, bounds, bug)) {
      transitionsExplored++;
      const key = canonicalKey(next);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: next, trace: [...cur.trace, action] });
      }
    }
  }
  return { model: "StoreLifecycle", variant: bug, statesExplored, transitionsExplored, ok: true };
}

interface RevokeState {
  step: number;
  sessionLive: boolean;
  tokensLive: number;
  ticketLive: boolean;
  attackerMintedAfterTokensRevoked: boolean;
}

export function checkRevokeAllModel(bug: RevokeBugVariant = "none"): CheckResult {
  const order = bug === "revoke-all-sessions-last"
    ? (["account", "tokens", "ticketKey", "sessions"] as const)
    : (["account", "sessions", "tokens", "ticketKey"] as const);

  const init: RevokeState = {
    step: 0,
    sessionLive: true,
    tokensLive: 1,
    ticketLive: true,
    attackerMintedAfterTokensRevoked: false,
  };
  const keyOf = (s: RevokeState) => `${s.step}|${s.sessionLive ? 1 : 0}|${s.tokensLive}|${s.ticketLive ? 1 : 0}|${s.attackerMintedAfterTokensRevoked ? 1 : 0}`;
  const visited = new Set<string>([keyOf(init)]);
  const queue: { state: RevokeState; trace: string[] }[] = [{ state: init, trace: ["init(compromised-device: session=live, tokens=1, ticket=live)"] }];
  let statesExplored = 0;
  let transitionsExplored = 0;
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++]!;
    const s = cur.state;
    statesExplored++;
    if (s.step === order.length && (s.sessionLive || s.tokensLive > 0 || s.ticketLive)) {
      return {
        model: "RevokeAllContainment",
        variant: bug,
        statesExplored,
        transitionsExplored,
        ok: false,
        violation: {
          invariant: "CONTAINMENT_NO_POST_REVOKE_CREDENTIAL",
          reason: `revokeAll finished, but attacker still holds session=${s.sessionLive}, liveTokens=${s.tokensLive}, ticket=${s.ticketLive}.`,
          trace: cur.trace,
        },
      };
    }

    const nexts: [string, RevokeState][] = [];
    if (s.step < order.length) {
      const action = order[s.step]!;
      const n = { ...s, step: s.step + 1 };
      if (action === "sessions") n.sessionLive = false;
      if (action === "tokens") n.tokensLive = 0;
      if (action === "ticketKey") n.ticketLive = false;
      nexts.push([`revokeAll step ${s.step + 1}: ${action}`, n]);
    }
    if (s.sessionLive && s.tokensLive < 2) {
      const n = {
        ...s,
        tokensLive: s.tokensLive + 1,
        attackerMintedAfterTokensRevoked: s.attackerMintedAfterTokensRevoked || s.tokensLive === 0,
      };
      nexts.push([`Attacker uses live Access session -> POST /tokens (liveTokens=${n.tokensLive})`, n]);
    }

    for (const [label, n] of nexts) {
      transitionsExplored++;
      const k = keyOf(n);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push({ state: n, trace: [...cur.trace, label] });
      }
    }
  }
  return { model: "RevokeAllContainment", variant: bug, statesExplored, transitionsExplored, ok: true };
}
