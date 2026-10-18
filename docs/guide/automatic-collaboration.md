---
title: Automatic model collaboration
description: Choose execution and review models from the composer in this fork.
---

# Automatic model collaboration

In Agent mode, select **Collaboration: Off** beside the permission control at
the bottom of the composer. Choose **Smart** or **Always**, select a primary developer
model and a collaboration model, choose a maximum concurrency, then save.
The selection applies to the next Agent turn in this conversation and survives
restart. Other conversations keep their own choices. You do not need to type a trigger phrase. To return to the usual
workflow, select Off and save.

For Claude implementation and pro GPT review, choose the Claude model from its
provider and the GPT model whose label ends in **pro**. The provider label
identifies the account/channel. Both models must be enabled for subagents in
model settings. A removed or disabled binding prevents launch instead of
silently choosing another channel.

- **Smart:** the current model decides each turn. Questions, lookups, small
  edits and focused tests normally stay direct. Complex independent work,
  high-risk changes needing independent review, or your explicit request can
  start collaboration. No extra agent is used just to decide.
- **Always:** coding and review tasks use collaboration; simple questions stay
  direct. Default concurrency is 8, adjustable from 1 to 10.
- **Native children:** expand the Task group within the current conversation
  to inspect roles, models and results. They do not appear as sidebar chats.
- **Review:** after collaboration starts, builtin file/shell changes trigger an independent
  source review before the parent's next response. Failed review can lead to
  repair and another review, up to three attempts. Test execution is reported
  separately.
- **Stop:** stops the parent, its children and an automatic review.

The collaboration switch does not grant permissions. It is unavailable while
a turn runs or outside the local Agent composer. More concurrency can cost
more and still depends on the channels' own rate limits. Review is assistance,
not a guarantee; plugin/MCP mutations and edits outside the running turn are
outside the builtin review gate.

In Smart mode the workflow is used only when collaboration is chosen. Solo work
uses the current conversation model and normal permissions, without automatic
review/test children. Once collaboration starts, its gates remain active until
the turn ends; the next user message gets a new decision. The Read-only review
preset always prohibits parent file writes and shell commands. Switch to Always
when you want coding tasks to follow the selected workflow every time. Existing
Auto/Deep settings map to Smart/Always without changing their model pins.

## Workflow presets and coding assignment

The composer stores workflow and coding choices separately for each conversation.
**Automatic** lets the current model choose Quick fix, Standard development,
Deep development or Read-only review for this turn, with a short reason recorded
in the workflow result. No extra router agent is started. Selecting a named
preset manually locks it until you choose Automatic again; Flexible remains a
manual option. A turn's automatic decision never overwrites the saved choice.
Smart still decides whether collaboration is useful before selecting its workflow.

**Automatic assignment** lets the planner assign each exact-file task to the
primary or collaboration developer. Claude can handle frontend or backend work;
pro GPT can also write either. Assignments depend on the task and dependencies,
not a fixed quota of agents. Primary-only and frontend/backend split remain
available. Planning, independent source reviews and test execution always use
fresh collaboration-model contexts, including when that model also writes code.
The implementation context cannot approve its own work.

Preferences use host-owned KV namespace `session-workflow-v1`, through
`session.workflow.get/set`; no transcript or schema rewrite is needed. The first
read snapshots legacy global preferences without changing them, preserving
explicit read-only and primary-only choices. New Desktop drafts default to
Automatic workflow/assignment except those preserved restrictions. Drafts do not
create conversations until sent. Forks copy preferences; deletion cleans only
that conversation's record. Saves affect its next turn, survive restart, and
are refused during running turns, pending plan approval or queued/running plan
execution. The composer handles loading, retry and late responses after a switch.
Provider-only plugin completions and voice classification do not load session
workflow settings or start collaboration.

Structured presets expose `CollaborationWorkflow`. For development the runtime
executes Plan → dependency-ordered Coding → Review + Test → bounded Fix → fresh
checks → Complete. Deep adds a plan review, regression review and boundary tests.
Quick bounds the plan to three tasks; Standard allows eight and Deep sixteen.
The active concurrency setting is shared by every stage, including worktree
preparation. Independent tasks run together; shared-file writers require a
validated dependency. A primary-model assistance task can follow a backend task
on the same file. Cyclic, unknown or unordered overlapping dependencies fail
before coding. Builtin Write/Edit enforce each task's declared exact file scope.
Shell permissions remain host-owned; file ownership is not a shell sandbox.

Planner task entries describe implementation only and must each own at least one
exact writable file. Independent review and test execution are runtime-owned
stages, not extra tasks with empty file lists. When an initial or repair plan
fails JSON/schema/dependency validation, the runtime names the invalid field or
constraint, marks that planning attempt failed, and requests a fresh complete
plan from the pinned read-only planner, at most twice. No implementation starts
for that plan until validation succeeds. Corrections preserve the original task
and write-scope constraints and do not consume the two code-repair rounds.
Provider failures and missing source reads are not format retries. Stop cancels
correction as well as planning; repeated workflow calls still reuse the current
turn's result rather than repeating edits.

Each check returns structured evidence. Source review requires a successful Read
of current files against the original task. It does not invent a requirement for
a clean tree or a pre-change dirty-workspace snapshot; explicitly requested scope
audits remain required. An inconclusive source verdict gets one fresh clarification
per check, retaining the earlier report. Missing required evidence still blocks;
no verdict is changed to pass by matching report wording. Test owns command execution.

Test requires observed Bash results. A real nonzero exit is a failing check even
when the host marks the tool `TOOL_FAILED`; it can trigger at most two code-repair
rounds. Missing prerequisites stop without speculative code edits. All observed
commands are retained. A later successful run of the identical command can resolve
its earlier failure. Cross-runtime replacement is limited to unavailable launchers
(exit 126/127 or a recognized Go launcher version error), with the same cwd, test
runner, arguments and selectors. A real version-specific failure cannot be cleared
by another interpreter, a narrower test or an unrelated successful command.
Missing, denied or truncated evidence never passes. Verifiers reuse project runners
and environments without installing dependencies or modifying tests.

Deep plan review judges coverage before implementation, not whether planned fixes
already exist. A rejected plan gets at most two revisions and independent reviews
before any writer starts. Planning format corrections retain their separate bound.
Plans may use `tasks: []` when only verification remains; nonempty original acceptance
criteria and independent Review/Test evidence remain mandatory.

Independent coding refills free slots immediately when dependencies are satisfied.
A worker failure stops scheduling, aborts siblings and waits for every started child
to settle. Stop also covers worktree preparation; file ownership guards survive
until child tools and cancellation acknowledgement have completed. Direct Task
calls cannot bypass a structured workflow. Read-only requests/presets keep their
existing restrictions.

Ordinary repeated workflow calls return the settled result. After failed verification,
`retry: "verify"` with a concrete `retryReason` permits one fresh Review/Test attempt
in the same turn, without writers or more repair rounds. The original task, acceptance,
preset, model pins and read-only restrictions are frozen; replacement task text cannot
narrow them. Planning/coding failures and cancellation cannot use this shortcut.
A later user turn rechecks current files and may plan verification only. Error cards
distinguish plan rejection, verification blockers, failed checks and execution failure.

Stage progress, plans, commands and results are recorded in ordinary tool history.
Children remain native Tasks in the current conversation; no Worker session or
sidebar conversation is created. Completed settings/history survive restart.
An interrupted workflow is not automatically resumed after runtime restart;
inspect the existing changes before starting a new run. Arbitrary workflow scripts,
workflow editing and cross-process durable resume are not part of these presets.
The verifier uses read and shell tools; workflows do not install browser tooling.
Required browser checks need an available project test harness or a separately
assigned operator check, reported explicitly rather than claimed as executed by an agent.

## Installing this fork on macOS

Build a local application with `pnpm --filter @pi-desktop/desktop pack`.
The arm64 app is produced at `apps/desktop/release/mac-arm64/PI-Desktop.app`.
It includes the release host-core and bundled agent runtime, so normal use
does not require a development server or preview script. Local builds without
a Developer ID certificate are not Apple-notarized release builds.

Before replacing `/Applications/PI-Desktop.app`, quit the existing application
and back up both the app and its data: `~/.pi-desktop` plus
`~/Library/Application Support/PI-Desktop`. Preserve any custom storage roots
and externally loaded plugins as well. Replace only the app bundle; do not
copy a development or validation profile over the existing data. The bundle
identifier, product name and default storage paths remain unchanged.

This fork's update feed and release link point to
`cgl1307929582-prog/PI-Desktop`, so a later upstream release cannot replace
the collaboration build automatically. A successful update still requires a
compatible release and signing setup in that fork. Source pushes alone do
not publish an application update.

After installation, open PI-Desktop normally, check the existing projects,
conversations, providers and plugins, then choose the collaboration settings
using the existing provider bindings. To roll back after a data migration,
quit the app and restore the matching app and data backup together.
