// One axe audit for every page test: WCAG 2.x A and AA rules, through agent-browser.

/**
 * The audit's violations, given a runner for `agent-browser a11y` with its arguments. Anything but a
 * successful report whose count matches its list throws, so a broken audit can never pass as clean.
 */
export async function axeViolations(a11y: (...args: string[]) => Promise<string>): Promise<{ id: string; nodes: string[] }[]> {
  let out: string;
  try {
    out = await a11y("a11y", "--json", "--tags", "wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa");
  } catch (e) {
    // The audit may exit non-zero with its report still on stdout.
    out = String((e as { stdout?: unknown }).stdout ?? "");
  }
  let report: unknown;
  try {
    report = JSON.parse(out);
  } catch {
    throw new Error(`axe audit gave no report: ${out.slice(0, 200)}`);
  }
  const data = (report as { success?: unknown; data?: { violations?: unknown; counts?: { violations?: unknown } } }).data;
  const list = data?.violations;
  if ((report as { success?: unknown }).success !== true || !Array.isArray(list) || data?.counts?.violations !== list.length) {
    throw new Error(`axe audit failed or is malformed: ${out.slice(0, 200)}`);
  }
  return list.map((v: { id: string; nodes?: { target: unknown }[] }) => ({ id: v.id, nodes: (v.nodes ?? []).map((n) => JSON.stringify(n.target)) }));
}
