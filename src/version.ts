/**
 * The release this Instance serves, shown in the footer of its own pages so an Operator can say what they run.
 * `test/version.test.ts` keeps it equal to `package.json` and to the version on every landing page, so a release
 * that forgets one of them fails the check gate instead of drifting.
 */
export const VERSION = "0.1.10";
