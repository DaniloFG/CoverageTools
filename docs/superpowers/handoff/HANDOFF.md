# Handoff — finishing Coverage Tools (temporary; delete this folder before the branch is finished)

Branch `ccr-6b5ce01f-w5bun8`, PR #1. Process: superpowers:subagent-driven-development
(plan `docs/superpowers/plans/2026-11-24-coverage-tools.md`, design
`docs/superpowers/specs/2026-11-24-coverage-tools-design.md`).
`progress.md` here is the authoritative ledger (every ruling, deferred minor and the
"final review attention list"). `implementer-rules.md`, `reviewer-rules.md`,
`shared-context.md` are the prompts' shared parts (paths inside them refer to the old
container; recreate the git-ignored workspace `.superpowers/sdd/2026-11-24-coverage-tools/`
from this folder).

User (pt-BR; reply in Portuguese): wants no intermediate reports, only a notice when
EVERYTHING is finished. Implementers/reviewers: Opus subagents, at most 3 in parallel.
Hard requirements: extremely lightweight; generic/agnostic rules; English-only README with
real screenshots; CHANGELOG planned/in progress/done; .vsix published exactly like
DaniloFG/GitTools (publisher DaniloFG, `release/coverage-tools-<version>.vsix`).

## State
- Tasks 1–18, 21, 23A: complete and reviewed.
- T19 (fix round dd14038, 59d5079, 29eaafe), T20 (4684258, 0f62e74 + follow-up commit(s)),
  T22 (f68b2c5, 40835f1, 6cb03d0, 3bfc4a3, 8037d34 + later commits): implemented, NOT yet reviewed.
  See STATUS section at the bottom for what each agent reported last.

## Remaining
1. One combined review of the T19 fix round + T20 (incl. follow-up); fix loop.
2. Review T22 (packaging, manifest, CI matrix ubuntu/windows/macos, publish workflow,
   README/CHANGELOG 0.1.0 dated 2026-11-25, screenshots regenerated last).
3. Final whole-branch review (skill's `references/final-review.md`), with the attention
   list and deferred minors from the ledger; one fix wave.
4. CI green on every job and OS (build matrix, ui, e2e, perf 13/13, package).
5. Update PR #1 body; delete `docs/superpowers/handoff/`; superpowers:finishing-a-development-branch.
6. Tell the user it is finished, including: per-run history detail dropped for lightness;
   TypeScript-under-c8 limitation; the `VSCE_PAT` repository secret must be set
   (`OVSX_PAT` optional); publishing happens on merge to main. Do not tag, do not merge.

## Environment needs (new container)
apt: dotnet-sdk-8.0, python3-venv, xvfb and Electron libs; `npm ci`;
`node scripts/setup-samples.mjs`. VS Code download hosts must be allowed
(update.code.visualstudio.com, vscode.download.prss.microsoft.com) — personal
environment "coveragetools" has them. Running as root: Electron needs `--no-sandbox`.

## STATUS at handoff
All implementers have finished and committed; the tree is clean. See the last section
of `progress.md` ("Handoff point") for the commits awaiting review and the open concerns.
