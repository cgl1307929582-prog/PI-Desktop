---
title: Automatic model collaboration
description: Choose execution and review models from the composer in this fork.
---

# Automatic model collaboration

In Agent mode, select **Collaboration: Off** beside the permission control at
the bottom of the composer. Choose **Auto** or **Deep**, select a primary developer
model and a collaboration model, choose a maximum concurrency, then save.
The selection applies to new Agent turns on this installation and survives
restart. You do not need to type a trigger phrase. To return to the usual
workflow, select Off and save.

For Claude implementation and pro GPT review, choose the Claude model from its
provider and the GPT model whose label ends in **pro**. The provider label
identifies the account/channel. Both models must be enabled for subagents in
model settings. A removed or disabled binding prevents launch instead of
silently choosing another channel.

- **Auto:** small tasks use a small team; simple questions remain direct.
- **Deep:** encourages parallel analysis, implementation and verification where
  the work can be split. Default concurrency is 8, adjustable from 1 to 10.
- **Native children:** expand the Task group within the current conversation
  to inspect roles, models and results. They do not appear as sidebar chats.
- **Review:** changes made with builtin file/shell tools trigger an independent
  source review before the parent's next response. Failed review can lead to
  repair and another review, up to three attempts. Test execution is reported
  separately.
- **Stop:** stops the parent, its children and an automatic review.

The collaboration switch does not grant permissions. It is unavailable while
a turn runs or outside the local Agent composer. More concurrency can cost
more and still depends on the channels' own rate limits. Review is assistance,
not a guarantee; plugin/MCP mutations and edits outside the running turn are
outside the builtin review gate.

## Workflow presets and coding assignment

The same composer menu stores optional `workflow` and `codingMode` fields.
Missing fields retain flexible collaboration and primary-model implementation.
Presets are Flexible, Quick fix, Standard development, Deep development and
Read-only review. Coding can use the primary model alone, or assign frontend
and scoped assistance to the primary model and backend implementation to the
collaboration model. Planning, independent source reviews and test execution
always use fresh collaboration-model contexts. Both models can therefore write
code without allowing the implementation context to approve its own work.

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

Each check returns structured evidence. Source review requires an observed successful
Read of current files; listing filenames alone cannot pass. Its verdict covers source
correctness, while the separate Test stage owns command execution.
Test verification additionally requires observed Bash results with exit code zero.
A claim without executed commands cannot pass. Actionable source defects or
executed failing tests produce a fresh repair plan, followed by coding and both
checks, at most twice. An inconclusive report, malformed report, missing source
reads, missing command evidence or unavailable executable blocks verification
immediately without starting another code repair. If any required check is
blocked, preserve all findings and command evidence, including failures from
other checks; none are treated as a pass. Resolve the reported prerequisites
before starting a fresh run. Verifiers read project instructions and reuse the
documented test runner and existing project environment; they do not install
dependencies or edit source/tests to bypass a blocker. Provider failures and
unresolved checks still block successful delivery. Read-only
requests and the review preset use only the read-only analyst. Direct parent
Task calls cannot bypass a selected structured workflow. Stop aborts native
children and prevents later stages. Repeated workflow calls within one turn
return the same result rather than repeating edits.

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
