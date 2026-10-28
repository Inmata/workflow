# workflow

[简体中文](README.md) | English

workflow is a set of cross-agent rules for project collaboration and knowledge upkeep. It covers three things: **who does what** (the split of work and boundaries between Lead, Worker and Reviewer), **how a task ends** (task phases and resumable state), and **how experience accumulates** (short notes kept on disk, a bounded background review, and recall of relevant lessons).

**Lead, Worker and Reviewer are responsibilities. A role is not tied to a client or a model.** Claude Code can act as Lead, Worker or Reviewer; Codex, OpenCode, Pi and others are assigned the same way, based on current permissions and actual capabilities. The roles the user has confirmed, the tools available and the needs of the task decide who does what.

The detailed method documents under `docs/` are written in Simplified Chinese. This README is the English entry point.

## Roles and host support

All roles share the same [common method](docs/workflow.md) and [role guides](docs/roles/lead.md). The same kind of agent can implement and review in separate, independent sessions.

Automatic hook integration currently supports the hosts below. Both can act as Lead, receive project context, submit task signals and handle knowledge disposition:

| Host | Install flag | User config | Adapter notes |
| --- | --- | --- | --- |
| Claude Code | `--agent claude` | `~/.claude/settings.json` | [Claude Code](docs/adapters/claude.md) |
| Codex / Codeg Codex ACP | `--agent codex` | `~/.codex/hooks.json` | [Codeg ACP](docs/adapters/codeg.md) |

`--agent` selects the host adapter for hooks. It does not assign a collaboration role. OpenCode, Pi and similar agents can join through a host's existing delegation tools, with the role set by the work package. Their native hook integration is not implemented yet, so the same automatic wrap-up is not guaranteed when they run on their own.

Runtime: Windows + Node.js 24+, ESM, no third-party runtime dependencies. Optional background learning runs through Windows Task Scheduler and an existing Codex or Claude CLI, and uses your existing account quota. Installing does not enable it.

## Getting started

If you only want to know what to do after installing, follow the four steps below. Run every command from the root of this repository.

### Step 1: Install on this machine

Install for the host you actually use. Either entry works, and you can install both.

**Claude Code:**

```powershell
node bin/workflow.mjs install --agent claude
node bin/workflow.mjs doctor --agent claude
```

**Codex / Codeg Codex ACP:**

```powershell
node bin/workflow.mjs install --agent codex
node bin/workflow.mjs doctor --agent codex
```

If you only use Claude Code, only the Claude adapter is needed.

When Claude Code runs as Lead inside Codeg in auto mode, the classifier may block delegation. Allow `mcp__codeg-mcp__delegate_to_agent`, `mcp__codeg-mcp__get_delegation_status`, `mcp__codeg-mcp__cancel_delegation` and `mcp__codeg-mcp__check_user_feedback` in the permission settings, or use a mode that asks each time (see [Codeg handoff](docs/adapters/codeg.md#接续)).

`install` does four things: it copies the current source into a release copy named by its digest (`releases/<version>-<digest>`), points the fixed `current` entry at that copy, registers this plugin's events in the host config (`hooks.json` for Codex, `settings.json` for Claude), and records the install transaction. Hook commands only contain the `current` path, so the path stays the same across upgrades and host trust is only needed once. Old copies are kept for rollback. Running it again checks where `current` actually points: a missing, dangling or misdirected own entry is repaired by rebuilding or repointing that link without rewriting the host config or creating a new release copy; a directory or outward link substituted by the user is left untouched and reported as a `conflict` with its path. Both hosts share one `current`, so a repeat install only repairs its own entry: if `current` already points at another installed host's valid registered snapshot, it is left alone and a `conflict` asks you to upgrade both hosts together. It does **not** write host trust, change projects or commit to Git.

`doctor` reports four separate things:

| Field | Meaning |
| --- | --- |
| `registration` | Whether the host config contains this plugin's definition |
| `discovery` / `trust` | Whether the host discovered and trusts the current definition (`unknown` when the plugin cannot check; this is normal) |
| `execution` | Whether a real callback event has been received |
| `integrity` | Whether the release copy matches the install record file by file |

After installing or upgrading, check the workflow entries under the host's `/hooks`. If Codex / Codeg shows `modified`, confirm trust again as the host prompts. In Claude Code, check the loaded hooks and handle any confirmation the host shows. Then open a new session and watch for the callback. The plugin never writes trust records for you.

### Step 2: Onboard a project

```powershell
node bin/workflow.mjs project onboard --root "D:/your-project"
```

`onboard` checks core onboarding and optional background review separately. Host installation and version, the directory and Git identity, and whether `AGENTS.md` contains a copied or leftover managed block are core checks: all must pass before anything is written. If any fails, nothing is written, and all problems are listed at once with copyable fix commands. The background review executor is only checked for capabilities (no model call); its preflight problems are reported separately and do not block core onboarding unless you ask to enable it. If the executor lacks a dedicated config, you get a warning and the command to register one. Add `--enable-learning` to enable background review at the same time (it really calls the model and consumes quota, so it needs your consent; an agent may run it when the current session's permissions allow, otherwise run it in your own terminal). Add `--skip-learning` if you don't plan to enable it. When you explicitly request learning, the core and learning results are reported separately, and a learning failure is never reported as full success: if core onboarding succeeds but the explicit learning request does not fully take effect, the result is `status: partial` with exit code 1; without `--enable-learning`, preflight problems are only reported and the exit code stays 0. Re-onboarding a project that already has learning enabled keeps its switch and scheduled task, and a failed preflight only reports the result of that attempt.

Once the checks pass, it inserts a short managed block into `AGENTS.md` at the project root, creates the local binding and runs the first alignment scan. Without `--enable-learning`, it finishes by listing the full command to enable background review. It keeps your existing AGENTS text, does not require a README, spec or plan, and does not create an empty LESSONS file.

After onboarding, open a **new session in that project** in Claude Code or Codex with the adapter installed. Only then does the plugin provide context. One local directory shares one project binding, so switching between the two hosts needs no second onboarding. Several sessions can work on the same project at once. Concurrent edits to the same file are reported as conflicts by fingerprint checks and never overwrite each other.

In the first session, Lead runs a [project alignment](docs/alignment.md): a read-only scan of the project's documents and toolchain that writes the authoritative sources, acceptance commands, project conventions and differences from workflow defaults into `docs/WORKFLOW-ALIGNMENT.md`. When the project's practice differs from the workflow default, Lead **asks you about each difference** and does not pick a side on its own. Outdated documents or structural problems are only reported; once you approve, Lead fixes them in the same turn. After that, session start and each user turn only stat the index, and update incrementally when files change. The whole project is not rescanned.

Alignment can also be triggered by hand:

```powershell
node bin/workflow.mjs project align scan --root "D:/your-project"
node bin/workflow.mjs project align status --root "D:/your-project"
```

### Step 3: Work normally in a new session

No commands to remember. Make a request in the Claude Code main session and Claude Code acts as Lead; in a Codex main session, Codex acts as Lead. Lead follows the confirmed role assignments and routes each task by size:

| Your request | Usual handling |
| --- | --- |
| Check status, push a given commit, fast-forward pull | Lead does it directly, zero Workers / zero Reviewers, declared operation-only |
| Single text edit, low-risk small change | Lead may do it directly |
| Real code fix, key behavior | A Worker implements, then an independent Reviewer reviews |
| Needs your decision | Structured questions are marked waiting-user automatically (text questions are declared first); no guessing ahead |
| You interrupted | State is saved only; it does not quietly continue next time you come back |

Write operations happen only when you explicitly ask. The plugin never adds, commits, pushes or publishes automatically, and never changes version numbers for you.

### Step 4: Wrap-up and lessons

When there is a clear correction, a failure cause or a verification result, Lead saves a short note; with nothing new, it simply delivers. Stop does not demand an extra retrospective, and no turn has to report "no new lessons". Notes are written to local disk first and survive across sessions.

With background learning enabled, notes are reviewed in batches based on the note threshold, maximum wait and check frequency you set. Maximum run time, runs per day, batch size, model and reasoning effort are all configurable. Formal lessons live in `.workflow/knowledge/`, each recording maturity, importance, status, scope and evidence. A new counterexample immediately stops an old lesson from being recalled by default. Current project facts stay in the existing README, spec and other authoritative documents.

Configuration, commands and file layout are in [project learning](docs/learning.md). Enabling background review, switching executors and troubleshooting are in the [background review handbook](docs/background-review.md). For the first real run, follow the [cross-machine acceptance handoff](docs/acceptance.md).

## A complete example

Suppose you use Claude Code as Lead and project `D:/my-app` has a login timeout bug:

1. You install with `--agent claude`, run `project onboard --root "D:/my-app"`, and open a new Claude Code session in that directory.
2. You say "login times out after 30 seconds, please find and fix it".
3. Claude Code, as Lead, reads the project's existing documents, decides this is a real code fix, and sends a Worker through an available, authorized delegation tool to change the implementation and test it.
4. The Worker returns the diff and test results, and Lead sends an independent Reviewer for a read-only review.
5. If the Reviewer has comments, they go back to the same Worker for a targeted fix; otherwise Lead integrates and runs the needed regression tests.
6. Lead updates the project facts this task touched, saves a short note when there is reusable evidence, and tells you what changed, how it was verified and what is left.
7. The task ends (task-end). You never send a signal by hand.

With Codex as Lead the flow is the same; install with `--agent codex`. The agent types for Worker and Reviewer follow the current assignment. When a required delegation entry is missing, Lead reports it as blocked and does not treat a handoff text as a launched agent. If you only want a status check, steps 3 to 5 are skipped and Lead answers directly.

## When you need to run commands yourself

Rarely in daily use. These are maintenance actions:

| Purpose | Command |
| --- | --- |
| Claude install / trust / callback status | `node bin/workflow.mjs doctor --agent claude` |
| Codex install / trust / callback status | `node bin/workflow.mjs doctor --agent codex` |
| Onboard a project (checks, then one step) | `node bin/workflow.mjs project onboard --root "<project>"` |
| Disable a project | `node bin/workflow.mjs project disable --root "<project>"` |
| Fully unbind (scheduled task, managed block, local records) | `node bin/workflow.mjs project remove --root "<project>"` |
| Check the background review executor (no project needed) | `node bin/workflow.mjs learning doctor --global` |
| Project alignment scan | `node bin/workflow.mjs project align scan --root "<project>"` |
| Check whether alignment is stale | `node bin/workflow.mjs project align status --root "<project>"` |
| Show role context | `node bin/workflow.mjs context --role lead --project "<project>"` |
| Remove the Codex registration | `node bin/workflow.mjs uninstall --agent codex` |
| Remove the Claude registration | `node bin/workflow.mjs uninstall --agent claude` |

`disable` only disables one project and removes the managed block only if it was not hand-edited. `remove` also deletes the scheduled task, local state records and the data directory; the alignment file and `.workflow/` in the project are listed but not deleted. `uninstall` only removes this plugin's own handlers from that host; other plugins, release copies, project files and lessons are all kept.

None of the three commands rolls back work already done. What each one deletes and keeps:

| Content | `disable` | `remove` | `uninstall` |
| --- | --- | --- | --- |
| Project files changed by tasks, Git commits | Kept | Kept | Kept |
| Formal lessons (`.workflow/knowledge/` in the project) | Kept | Kept | Kept |
| Alignment file (`docs/WORKFLOW-ALIGNMENT.md`), `.spec/` | Kept | Kept | Kept |
| `AGENTS.md` managed block | Removed if not hand-edited | Removed if not hand-edited | Kept |
| Local materials not yet reviewed (`inbox/` in the data directory) | Kept | **Deleted** | Kept |
| Local binding, recorded decisions, learning switch, scheduled task | Disabled, records kept | Deleted | Kept |
| Host hook registration | Kept | Kept | This plugin's handlers removed |

Unreviewed materials live only on this machine, not in the project. To keep them, wait for the background review to process them, or use `disable` instead. The plugin never runs `git revert`, `git reset` or restores files; undo a task's changes with Git yourself.

## Upgrading

Upgrading does not change project files, and leaves the bindings, alignment documents, notes and lessons of onboarded projects alone. Run it once on each computer, after finishing any task in progress (install refuses to upgrade while a task is active). The commands below assume this repository is at `D:\git-repo\workflow`; replace the path if yours differs.

1. Pull the new version:

```powershell
cd D:\git-repo\workflow
git pull
```

The plugin has no runtime dependencies, so `npm install` is not needed.

2. Run `install` again for each host you installed. If you only installed one, run only that command:

```powershell
cd D:\git-repo\workflow
node bin/workflow.mjs install --agent claude
node bin/workflow.mjs install --agent codex
```

It computes the new release digest, copies to a new digest-named copy, and switches the `current` entry to it only after the integrity check passes. The hook command strings do not change, so the host usually does not need to trust them again. Old copies are left untouched. Both hosts can share the same release copy and entry, but each install command only updates the registration of the selected host. With an active task or an unrecognized transaction, the upgrade is refused with the reason; try again after the task ends.

3. Check status:

```powershell
node bin/workflow.mjs doctor --agent claude
node bin/workflow.mjs doctor --agent codex
```

`integrity` should be `verified` and `version` should be the new version. Then check the workflow entries under the host's `/hooks`. If Codex / Codeg shows `modified`, confirm trust as prompted, then open a new session and watch for the first callback.

Onboarded projects do not need `onboard` again. The background review scheduled task also runs through the `current` entry, so it uses the new version after the upgrade and does not need to be recreated. If a project on another computer has not been onboarded yet, onboard it as in [Step 2](#step-2-onboard-a-project) after upgrading.

### Realigning after an upgrade

The alignment protocol ships with the plugin. The `alignmentGuide` injected by the hook points to `docs/alignment.md` under the `current` entry, so new sessions read the new protocol after an upgrade without re-onboarding. The new protocol only affects later alignment work. Existing alignment documents are not rewritten automatically, and sessions only update them incrementally when source files change.

To rework the alignment document under the new protocol, open a new session in the project and tell Lead "重新对齐" (realign). It runs a full scan as described in [project alignment](docs/alignment.md), rebuilds the index with the new rules and updates the alignment file. Recorded decisions stay in the local records, so you don't need to delete the alignment document first. If the alignment file contains text you wrote by hand, remind Lead to keep it.

### Re-onboarding a project after an upgrade

Re-onboarding is only needed in two cases: the new version changed the text of the `AGENTS.md` managed block (the release notes say so), or you want the new version's onboarding checks to go over the project. Finish the plugin upgrade above first, otherwise the checks report a host version mismatch:

```powershell
cd D:\git-repo\workflow
node bin/workflow.mjs project onboard --root "D:/your-project"
```

Re-onboarding:

- runs all checks again; if any fails, nothing is written and the problems are listed with fix commands;
- replaces the `AGENTS.md` managed block in place with the new version's text, leaving the rest of the file untouched;
- rescans the alignment index and records the file list with the new scan rules;
- keeps the project ID, the background review switch, the scheduled task registration, and decided and pending alignment records. If learning is already enabled, it no longer suggests enabling it, and `--enable-learning` is not needed.

It does **not** rewrite `docs/WORKFLOW-ALIGNMENT.md`, and does not touch the notes and lessons in `.workflow/`.

Re-onboarding does not make Lead redo the alignment. Ask for a realign separately, as in the previous section, when you want one.

If the managed block was hand-edited, the checks report `AGENTS`. Delete everything from `<!-- workflow:begin -->` to `<!-- workflow:end -->` (including both lines) as prompted and retry. If the project directory was moved or the Git repository was recreated, the checks report `IDENTITY`. Run `project remove` first as prompted, then onboard. `remove` clears the local learning switch, scheduled task and decision records; the alignment document and `.workflow/` in the project are kept.

Before 0.4.2, re-onboarding lost the learning switch, scheduled task registration and alignment decisions. If another computer is still on an older version, upgrade it before re-onboarding.

Changes in each version are listed in GitHub Releases.

## How the concepts relate

- **Lead**: sets scope and acceptance, dispatches work, integrates, handles knowledge disposition. Does simple tasks itself.
- **Worker**: implements and self-tests within the given allowed paths; does not dispatch further work.
- **Reviewer**: read-only review, never changes code; three levels: Diff, Deep, Escalated.
- **AGENTS.md**: only a short pointer to the project's existing documents, not the full content.
- **Project alignment**: in the first session, the differences between project documents and workflow defaults are written to a fixed file; you decide each real difference, and the file is updated incrementally when the index goes stale.
- **Knowledge transactions**: a snapshot is saved before writing, failures leave a pending item, and your hand edits are never overwritten.
- **Task signals**: task-start / phase / task-end are driven by hooks and session identity; normal use never builds them by hand.
- **spec**: `.spec/<id>/spec.md` records how a feature behaves now and its acceptance criteria, covering only what is already implemented. A plan (such as a version plan under `docs/plans/`) records what you intend to change; the two are not mixed.

### How plans and specs work together

Still two steps: write the plan, you review it and say "go", implementation starts. Specs are not reviewed separately; they are part of the plan.

1. Writing the plan: propose the route (`lead-direct` or `delegated`); when splitting work or adding independent review, list at once how many work packages there are, each package's scope, dependencies and channels. Reuse clear existing arrangements; do not ask about a Worker when the task has none, and ask only when a role or channel is genuinely new. End the plan with a "Spec impact" section listing which spec entries to create, change or remove, with the acceptance sentences as they will read afterwards; write "none" if no spec is affected.
2. You review the package breakdown, role assignment and "Spec impact" together with the plan. Saying "go" approves all of them at once.
3. Implementation: the Lead changes the specs as listed and hands them to Workers as acceptance criteria; the Reviewer checks them one by one. You are asked again only for spec changes the plan did not cover, or to change approved acceptance criteria.
4. Wrap-up: the spec and the code are committed in the same task; if the spec was missed, task-end is blocked by the gate. The Lead also writes back to the plan what this task finished, where it deviated, and what remains; if task-start declared `plans` and the plan is untouched, the plugin reminds the Lead without blocking completion.
5. Once the whole plan is done, the Lead proposes archiving it; after you confirm, it moves to the archive directory with a status line at the top, remaining items split into a short todo, and navigation, the alignment index and links fixed. It does not become a spec.

The role method text is in the [common method](docs/workflow.md); the three roles are in `docs/roles/lead.md`, `worker.md` and `reviewer.md`. Protocol fields and the state machine are in [protocol v1](docs/design/protocol.md).

## More details

- Command details for install, onboarding, task signals, recovery and uninstall: [usage](docs/usage.md).
- Tutorials: [independent parallel work](examples/parallel-change/README.md), [dependencies and repair](examples/dependency-and-repair/README.md), [routine and small tasks](examples/routine/README.md).

## Development and verification

```powershell
npm test
npm run check
npm run demo
```

Tests and the demo run in isolated directories under `workflow-tests/` in the system temp directory, using a local Git remote and synthetic events. They do not write to the repository or touch your real projects and global config. The installer copies only whitelisted files; an active task or an unrecognized transaction postpones the upgrade.

## Current status and limits

Current version 0.6.3. It includes the collaboration rules, CLI, hook adapters for two hosts, persistent notes, graded knowledge, configuration and optional background review, as well as routing, the work package ledger, completion gates, role claims and spec drift checks. Real-host acceptance records are in [0.3.0 acceptance](docs/acceptance.md#6-030-真实宿主验收). The installer tells copies apart by content digest.

Changes in 0.6.3:

- Slimmer rules and entry context: `docs/roles/lead.md` is trimmed to essentials plus a scenario table, with delegation, spec/plan and UI details moved to `docs/references/` on demand (43% smaller initial read for simple tasks). Subsequent turns in the same session get a compact entry prompt; `SessionStart` (including post-compaction), role changes and version upgrades restore the full entry.
- One-call signals: `signal <action> --session --turn --id [fields]` fills in ticket and `expectedRevision` from local state so `lead-direct` tasks need only `task-start` and `task-end` without temp identity files. Structured fields such as `packages` pass a business-only JSON via `--input`; full-payload `signal --input` remains compatible.
- Package breakdown and role prompt on plan delivery: when delivering a plan, the Lead lists the proposed work packages (count, scope and dependencies, or why splitting is unnecessary) and asks you to choose the Worker and Reviewer channels; in plan mode, ending a turn without asking triggers a one-time Stop reminder.
- Local branch commits and blocking waits: local delivery/checkpoint commits scoped to `allowedPaths` on non-default branches are allowed by default so Git commit OIDs align reviews directly (committing to the default branch, `git push`, version bumps, tags and Releases still require explicit authorization). Codeg waits now use batched `wait_ms: 0` blocking calls instead of 60s polling loops that bloat context.
- Lower hook and CLI overhead: removes duplicate `git rev-parse` calls across lock boundaries, duplicate Stop writes and eager imports of infrequent modules, cutting subprocess entry and Stop median latency by ~62%.

After upgrading, reinstall the hosts. The AGENTS block is unchanged, so re-onboarding is not needed.

Changes in 0.6.2:

- Dispatch channels: when you name which agent plays each role, the Lead records it with `channels` on task-start and fills the actual `channel` on each work package. Switching to the host's built-in subagents midway, or the Lead implementing a worker package of a delegated task itself, must be told to you first and recorded with a `change` in the ledger; otherwise the signal is rejected. Silent switching is no longer possible.
- A repair under a new package ID uses `supersedes` to link the old package: rounds that already delivered or were asked to revise by review keep counting (so the two-round limit is visible), while a re-dispatch after a startup failure that never produced output no longer inflates attempts; the old package is closed automatically, and review applies only to the latest package in the chain.
- A worker package that already has a review verdict (including on a package it superseded) can no longer pass by waiver or by being marked waived when its review does not match the final delivery; it must be re-reviewed. Packages never reviewed can still be waived.
- When every in-flight package runs on the host's built-in subagents, Stop no longer asks for a Codeg-style wait, only for a note on what is pending. A built-in subagent that sends a signal gets a reply saying it has no workflow identity and nothing is recorded.

After upgrading, reinstall the hosts; re-onboarding is not needed. Tasks that do not use these new fields behave as in 0.6.1.

Changes in 0.6.1:

- Updating documents after a plan is done is now part of the rules: before task-end the Lead writes back to the plan what was finished, where it deviated, and what remains. When the whole plan is done, the Lead proposes archiving it; after you confirm, it follows fixed steps: move it to the archive directory, add a status line, split remaining items into a todo, fix navigation and links (see [How plans and specs work together](#how-plans-and-specs-work-together)).
- Soft plan gate: task-start can declare related plans with `plans`. If a plan is still unchanged at wrap-up, Stop and the task-end receipt remind the Lead to write back, without blocking completion (see [usage](docs/usage.md#任务与回执)).
- The Worker's "doc impact" line now covers user-facing docs such as the README and usage guide, and the Reviewer checks them too.

After upgrading, reinstall the hosts. The AGENTS block is unchanged, so re-onboarding is not needed; tasks without `plans` behave as in 0.6.0.

Changes in 0.6.0:

- The Lead no longer ends its turn right after dispatching. With packages in flight, Stop blocks once and asks the Lead to keep collecting results in the same turn with a bounded wait (batched `get_delegation_status`, `wait_ms` 60000, `check_user_feedback` between rounds), or to tell you why it is pausing. Codeg does not wake the main session when a child task finishes.
- Signals should be written to a UTF-8 JSON file and sent with `signal --input`. `--base64` stays for compatibility; long strings may be redacted by the host. When `task-start` lacks goal or permissions, or puts mode/allowedPaths at the top level, the receipt names the problem.
- Specs record only implemented behaviour. The post-change acceptance sentences from the plan's "spec impact" section travel in the work packages and govern during implementation; specs are updated at integration. A "spec impact" section the Lead adds afterwards needs your confirmation first.
- UI flow: before dispatching, the Lead confirms the approach and which local design skills to use. Work then proceeds step by step with your confirmation: baseline screenshots, HTML wireframes (2–3 layouts per region), then hi-fi. Hi-fi uses the project's own UI technology first (for example a temporary WPF window using the existing theme), with HTML as fallback. Image generation is only for direction exploration in from-scratch or restyle work. Each step is time-boxed, and switching medium or method needs confirmation.
- Work packages gain a "related skills" field. When the Lead reports something as satisfied, it says whether it was verified or inferred. If the plan or reference material exists only in uncommitted changes, the Lead suggests committing before dispatch.

After upgrading, reinstall the hosts. The AGENTS block is unchanged, so re-onboarding is not needed.

Changes in 0.5.1: rule documents only; code behaviour is unchanged. Plans end with a "spec impact" section, and saying "执行" (execute) approves those spec changes together with the plan, so the flow stays two steps, plan then execute (see [How plans and specs work together](#how-plans-and-specs-work-together)). After upgrading, reinstall the hosts; re-onboarding is not needed.

Changes in 0.5.0: important features can have a long-lived description in `.spec/<id>/spec.md` whose `code:` list names the files it governs. At `task-end` the plugin checks git history for governed files that changed without the spec being updated, and the task cannot end until that is handled (update the spec, or add `Spec-OK` to the content commit; use an empty commit only to acknowledge existing history; see the [usage guide](docs/usage.md#spec-检查)); `spec check` git failures carry the reason. If Lead ends a turn without sending `task-end`, Stop blocks once and lists what is missing. Worker deliveries gain a "documentation impact" line, and Reviewer checks against the spec. Saying "重新对齐" (re-align) triggers a full alignment including the spec list; running scan alone does not count as done. The README states what `disable`/`remove`/`uninstall` delete and keep. Projects without `.spec` behave as in 0.4.2 apart from the Stop reminder; the AGENTS managed block is unchanged, so re-onboarding is not needed.

Whether a host actually runs hooks, how context behaves after compaction, and what external coding agents can resume all change with Codex / Codeg / Claude Code versions. `doctor --agent <host>` checks the registration and copy integrity for that host; confirm the host side with `/hooks` and callbacks in a real session.

Field differences on the Claude Code side (`prompt_id` turns, `StopFailure` interrupts, stdout receipts) are in the [Claude Code adapter](docs/adapters/claude.md).

A task can declare a route (`operation-only` / `lead-direct` / `delegated`). Delegated tasks record the work package ledger with batched `packages` signals. At `task-end`, the gate checks that required packages reached a final state, that the reviewed version matches the delivered version, and that verification is bound to the final version. Missing items can be waived explicitly. The gate only checks that Lead's declared records are consistent; it does not prove that review or tests really happened. Delegated subsessions declare their role with `role-claim` so they are not counted as a second Lead. Host capabilities (telling subsessions apart, question tools in each mode) are recorded in the capability table of each adapter document; untested cells are marked unknown.

workflow manages project development knowledge; [document-learning](https://github.com/Inmata/document-learning) separately manages personal document lessons. The two share no store or signals. Persistence across sessions is limited to the same computer. Project config and formal knowledge can travel with Git; local notes are not synced across computers automatically.
