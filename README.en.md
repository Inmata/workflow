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

`install` does four things: it copies the current source into a release copy named by its digest (`releases/<version>-<digest>`), points the fixed `current` entry at that copy, registers this plugin's events in the host config (`hooks.json` for Codex, `settings.json` for Claude), and records the install transaction. Hook commands only contain the `current` path, so the path stays the same across upgrades and host trust is only needed once. Old copies are kept for rollback. It does **not** write host trust, change projects or commit to Git.

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

`onboard` runs every check before writing anything: whether a host is installed with a matching version, the directory and Git identity, whether `AGENTS.md` contains a copied or leftover managed block, and whether the background review executor can start (capabilities only, no model call). If any check fails, nothing is written, and all problems are listed at once with copyable fix commands. If the executor lacks a dedicated config, you get a warning and the command to register one. Add `--enable-learning` to enable background review at the same time (run it in your own terminal; the host's auto-approval blocks agents from running it). Add `--skip-learning` if you don't plan to enable it.

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
| Needs your decision | Marked waiting-user first; no guessing ahead |
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

1. Writing the plan: the plan ends with a "Spec impact" section listing which spec entries to create, change or remove, with the acceptance sentences as they will read afterwards; write "none" if no spec is affected.
2. You review that section together with the plan. Saying "go" approves the plan and these spec changes together.
3. Implementation: the Lead changes the specs as listed and hands them to Workers as acceptance criteria; the Reviewer checks them one by one. You are asked again only for spec changes the plan did not cover, or to change approved acceptance criteria.
4. Wrap-up: the spec and the code are committed in the same task; if the spec was missed, task-end is blocked by the gate.
5. Once the whole plan is done, archive it; it does not become a spec.

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

Current version 0.5.1. It includes the collaboration rules, CLI, hook adapters for two hosts, persistent notes, graded knowledge, configuration and optional background review, as well as routing, the work package ledger, completion gates, role claims and spec drift checks. Real-host acceptance records are in [0.3.0 acceptance](docs/acceptance.md#6-030-真实宿主验收). The installer tells copies apart by content digest.

Changes in 0.5.1: rule documents only; code behaviour is unchanged. Plans end with a "spec impact" section, and saying "执行" (execute) approves those spec changes together with the plan, so the flow stays two steps, plan then execute (see [How plans and specs work together](#how-plans-and-specs-work-together)). Saying "重新对齐" (re-align) triggers a full alignment including the spec list; running scan alone does not count as done. `spec check` git failures now carry the reason. The README states what `disable`/`remove`/`uninstall` delete and keep. After upgrading, reinstall the hosts; re-onboarding is not needed.

Changes in 0.5.0: important features can have a long-lived description in `.spec/<id>/spec.md` whose `code:` list names the files it governs. At `task-end` the plugin checks git history for governed files that changed without the spec being updated, and the task cannot end until that is handled (update the spec, or make an empty `Spec-OK` commit; see the [usage guide](docs/usage.md#spec-检查)). If Lead ends a turn without sending `task-end`, Stop blocks once and lists what is missing. Worker deliveries gain a "documentation impact" line, and Reviewer checks against the spec. Projects without `.spec` behave as in 0.4.2 apart from the Stop reminder; the AGENTS managed block is unchanged, so re-onboarding is not needed.

Whether a host actually runs hooks, how context behaves after compaction, and what external coding agents can resume all change with Codex / Codeg / Claude Code versions. `doctor --agent <host>` checks the registration and copy integrity for that host; confirm the host side with `/hooks` and callbacks in a real session.

Field differences on the Claude Code side (`prompt_id` turns, `StopFailure` interrupts, stdout receipts) are in the [Claude Code adapter](docs/adapters/claude.md).

A task can declare a route (`operation-only` / `lead-direct` / `delegated`). Delegated tasks record the work package ledger with batched `packages` signals. At `task-end`, the gate checks that required packages reached a final state, that the reviewed version matches the delivered version, and that verification is bound to the final version. Missing items can be waived explicitly. The gate only checks that Lead's declared records are consistent; it does not prove that review or tests really happened. Delegated subsessions declare their role with `role-claim` so they are not counted as a second Lead. Host capabilities (telling subsessions apart, question tools in each mode) are recorded in the capability table of each adapter document; untested cells are marked unknown.

workflow manages project development knowledge; [document-learning](https://github.com/Inmata/document-learning) separately manages personal document lessons. The two share no store or signals. Persistence across sessions is limited to the same computer. Project config and formal knowledge can travel with Git; local notes are not synced across computers automatically.
