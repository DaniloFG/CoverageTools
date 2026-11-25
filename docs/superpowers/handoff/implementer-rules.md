# Implementer rules (apply to every task of this plan)

Work from: /home/user/CoverageTools (git branch `ccr-6b5ce01f-w5bun8`; commit there, do NOT push, do NOT switch branches).

## Before you begin
If anything about the requirements, approach, dependencies or assumptions is unclear, ask now by reporting NEEDS_CONTEXT with the specific question. Otherwise proceed.

## Your job
1. Implement exactly what the task brief specifies — follow its steps in order (TDD: failing test first, see it fail, implement, see it pass).
2. Verify the implementation works by running the commands the brief names.
3. Commit your work (commit messages in English, `feat:`/`test:`/`docs:`/`chore:` style; end each message with the two trailer lines below).
4. Self-review, then report.

Commit trailer: if your own session instructions give attribution lines for commits, use those. Otherwise use exactly:
```
Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018B44VGshNnEyVK1oSDLDVq
```
Never put a model identifier anywhere else in the repository.

While iterating, run the focused test for what you are changing; run the full relevant suite once before committing. Test output must be pristine (no stray warnings).

The task brief is written in Portuguese; all code, comments, identifiers, user-facing strings, README and CHANGELOG text are in English.

## Environment facts
- Node 22, npm, yarn 1.22, Python 3.13 (with venv), .NET SDK 8 (`dotnet`), `xvfb-run` are installed. npm, PyPI and NuGet registries are reachable. VS Code can be downloaded (update.code.visualstudio.com). Other internet hosts are blocked — do not rely on them.
- Outbound HTTPS goes through a proxy; if a tool fails TLS or gets a 403 from the proxy, read /root/.ccr/README.md. Never disable TLS verification.
- You run as root: Electron/VS Code must be launched with `--no-sandbox`.
- Use the scratch directory /tmp/claude-0/-home-user-CoverageTools/3e700167-63a6-579c-9697-26c6587d1bc3/scratchpad for throwaway files, never the repository.
- `.superpowers/` is git-ignored scratch for the process; do not commit it.

## You do not dispatch subagents
Do all of this task's work yourself. Never spawn a subagent to implement part of the task, and never spawn a reviewer. Review is the controller's job after you report.

## Code organization
- Follow the file structure in the shared context. Each file has one clear responsibility.
- If a file grows well beyond the plan's intent, stop and report DONE_WITH_CONCERNS rather than restructuring on your own.
- Do not restructure code outside your task.

## When you are in over your head
Stop and report BLOCKED or NEEDS_CONTEXT when the task needs an architectural decision with several valid approaches, when you cannot find clarity in the code provided, or when the brief tells you to stop and warn the user. Describe what you tried and what you need. Bad work is worse than no work.

## Self-review before reporting
Completeness (everything in the brief, edge cases), quality (clear names, clean code), discipline (YAGNI, only what was requested), testing (tests verify real behavior, pristine output). Fix what you find before reporting.

## After review findings
If the review finds issues you will be resumed with them. Fix them, re-run the covering tests, and append a fix report to your report file (what changed, tests run, command, output). Then reply with the same short status contract.

## Report
Write the full report to the report file named in your dispatch:
- what you implemented (or attempted, if blocked)
- what you tested and the results
- TDD evidence: RED (command, failing output, why expected) and GREEN (command, passing output)
- files changed
- self-review findings, issues, concerns, and any deviation from the brief with its reason

Then reply with ONLY (under 15 lines):
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- commits created (short SHA + subject)
- one-line test summary
- concerns, if any
- the report file path
If BLOCKED or NEEDS_CONTEXT, put the specifics in that final message.

## Another agent may be working in this checkout at the same time
- Stage and commit ONLY the files your task creates or modifies: `git add <explicit paths>` — never `git add -A`, `git add .` or `git commit -a`.
- Never run `git stash`, `git reset`, `git checkout -- <path>`, `git clean` or anything else that changes files you do not own.
- If `git commit` fails because of a lock, wait a few seconds and retry.
- If lint, type-check or a full test run fails ONLY in files you did not touch, that is the other agent's work in progress: do not fix or delete them; verify your own files with focused commands and mention it in your report.
- The other agent's commits may land between yours; that is expected.
