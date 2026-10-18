// Pinned Vitest public reporter API; a structured assertion is different from a broken runner.
import { writeFileSync } from "node:fs";

const errors = (values = []) => values.map((e) => ({ name: e.name, message: e.message }));

export default class MutationReporter {
  onTestRunEnd(modules, unhandledErrors, reason) {
    const report = {
      reason, errors: errors(unhandledErrors),
      modules: modules.map((m) => ({
        name: m.relativeModuleId, state: m.state(), errors: errors(m.errors()),
        suites: [...m.children.allSuites()].map((s) => ({ name: s.fullName, state: s.state(), errors: errors(s.errors()) })),
        tests: [...m.children.allTests()].map((t) => {
          const result = t.result();
          return { name: t.fullName, state: result.state, errors: errors(result.errors) };
        }),
      })),
    };
    writeFileSync(process.env.HTMLGATE_MUTATION_REPORT, JSON.stringify(report));
  }
}

const object = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const validErrors = (v) => Array.isArray(v) && v.every((e) => object(e) && typeof e.name === "string" && typeof e.message === "string");

/** Fail closed on missing controls, runner errors, interruptions and incompatible reports. */
export function classifyMutation(report, status, signal, testFile, stderr = "") {
  // `failed` keeps the failing tests of a timeout or runtime failure, so the gate's log names what broke.
  const broken = (reason, failed = []) => ({ state: "BROKEN", reason, failed });
  if (signal || (status !== 0 && status !== 1)) return broken(`runner exit ${status}, signal ${signal ?? "none"}`);
  if (stderr.trim()) return broken(`runner stderr must be diagnosed: ${stderr.trim().slice(0, 1000)}`);
  if (!object(report) || !["passed", "failed"].includes(report.reason) || !validErrors(report.errors) || report.errors.length || !Array.isArray(report.modules) || report.modules.length !== 1) return broken("missing, interrupted or invalid report; or an unhandled error");
  const m = report.modules[0];
  if (!object(m) || m.name !== testFile || !["passed", "failed"].includes(m.state) || !validErrors(m.errors) || m.errors.length || !Array.isArray(m.suites) || !Array.isArray(m.tests) || !m.tests.length) return broken("missing test control or module/startup failure");
  if (m.suites.some((s) => !object(s) || !["passed", "failed"].includes(s.state) || !validErrors(s.errors) || s.errors.length)) return broken("suite/hook failure or an invalid control");
  if (m.tests.some((t) => !object(t) || typeof t.name !== "string" || !["passed", "failed"].includes(t.state) || !validErrors(t.errors))) return broken("invalid, skipped or pending test control");
  const failed = m.tests.filter((t) => t.state === "failed");
  if (failed.some((t) => !t.errors.length || t.errors.some((e) => e.name !== "AssertionError"))) return broken("test timeout or runtime failure, not an assertion", failed);
  if (m.tests.some((t) => t.state === "passed" && t.errors.length)) return broken("test required a retry");
  if (!failed.length && status === 0 && report.reason === "passed" && m.state === "passed") return { state: "MISSED", reason: "tests remained green", failed };
  if (failed.length && status === 1 && report.reason === "failed" && m.state === "failed") return { state: "CAUGHT", reason: "assertion failures", failed };
  return broken("runner exit and test report disagree");
}
