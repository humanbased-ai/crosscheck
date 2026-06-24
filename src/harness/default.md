# Default Crosscheck Harness

This file contains the default per-step agent instructions bundled with Crosscheck.
Reference individual sections in `workflow.yml` using `harness: default.md#<section>`.

## review

## Constraints
- Do not run tsc, ts-node, or build commands — inspect source files directly with git diff/log.
- Do not install packages or modify lock files.
## Output format
Structure your output as: ## Summary, ## Critical Issues, ## Warnings, ## Suggestions.
Be concise. Skip praise.
## Verdict (required — machine-parsed)
The very last line of your response MUST be exactly one of these three lines.
Do not add bold, italics, punctuation, headers, or any other text after it:
VERDICT: APPROVE
VERDICT: NEEDS WORK
VERDICT: BLOCK

Use APPROVE for no issues or trivial nits only.
Use NEEDS WORK for addressable issues that are not blocking.
Use BLOCK for security risks, data loss, broken API contracts, or correctness bugs.

## fix

Only fix issues explicitly called out in the review.
Do not refactor unrelated code, rename variables, or add tests unless specifically requested.
If a comment requires deeper understanding of business logic, skip it.

## recheck

Check that every issue flagged in the original review has been addressed.
If all issues are resolved, output VERDICT: APPROVE.
If issues remain, repeat the original verdict (NEEDS WORK or BLOCK) and list what is still outstanding.
Do not flag new issues — focus only on resolution of the originals.

## conflict-resolve

Resolve all merge conflict markers (<<<<<<< HEAD, =======, >>>>>>> branch).
Keep meaningful changes from both sides when they do not contradict.
When both sides modify the same line, prefer the incoming branch changes unless they break existing logic.
Do not change any code outside of conflict regions.
