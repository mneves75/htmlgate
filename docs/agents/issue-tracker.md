# Issue tracker

The tracker is GitHub Issues on `mneves75/htmlgate`, driven with `gh`. Refer to an issue by its title, with the link inside the title.

## Wayfinding operations

- **Map:** the one issue labelled `wayfinder:map` (issue #1).
- **Ticket:** a sub-issue of the map with one label: `wayfinder:research`, `wayfinder:grilling`, `wayfinder:prototype` or `wayfinder:task`. Its body is a `## Question` section.
- **Claim:** assign the ticket to yourself before any work. An open, unassigned ticket is unclaimed.
- **Blocking:** GitHub's native "blocked by" dependency, so the frontier shows in the GitHub UI.
- **Frontier:** the open sub-issues with no assignee and no open blocker.
- **Resolution:** post the answer as a comment, close the ticket, then add one line under the map's "Decisions so far". One session edits the map body at a time: read it, change it, write it back in one step.
- **Research notes:** `docs/research/<slug>.md`, written on a `research/<slug>` branch and merged into `main` when the ticket is resolved, then the branch is deleted. Link the note on `main` from the ticket's resolution comment. Tickets resolved before 2026-10-09 link their `research/<slug>` branches; those notes were merged into `main` on 2026-10-09, so read them there.

The sub-issue and dependency calls take the issue's database `id`, not its number.

```sh
R=mneves75/htmlgate

# Add a ticket, attach it to the map, and wire a blocker
gh issue create -R $R --title "<question>" --label wayfinder:grilling --body-file body.md
id=$(gh api repos/$R/issues/<n> --jq .id)
gh api -X POST repos/$R/issues/1/sub_issues -F sub_issue_id=$id
gh api -X POST repos/$R/issues/<n>/dependencies/blocked_by -F issue_id=<id of the blocker>

# Claim
gh issue edit <n> -R $R --add-assignee @me

# Frontier
gh api "repos/$R/issues/1/sub_issues?per_page=100" --jq '.[]
  | select(.state=="open" and (.assignees|length)==0
           and (.issue_dependencies_summary.blocked_by // 0)==0)
  | "#\(.number) \(.title)"'

# What blocks a ticket
gh api repos/$R/issues/<n>/dependencies/blocked_by --jq '.[] | "#\(.number) \(.state) \(.title)"'

# Resolve
gh issue comment <n> -R $R --body-file answer.md
gh issue close <n> -R $R
```

## Research branches

Create the worktree by hand. The harness's own worktree isolation resolves HEAD from the parent `PROJETOS` directory, which is a separate, commitless Git repo, and fails here.

```sh
git worktree add .scratch/wt/<slug> -b research/<slug> main
# write docs/research/<slug>.md there, commit, then:
git -C .scratch/wt/<slug> push -u origin research/<slug>
git worktree remove .scratch/wt/<slug>
# when the ticket is resolved: merge research/<slug> into main, push main, then delete the branch locally and on origin
```
