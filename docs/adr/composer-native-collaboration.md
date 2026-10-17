# ADR: Composer-controlled native multi-model collaboration

- Status: Accepted for this fork
- Date: 2026-10-17
- Related: [Native Task](0062-bounded-subagents-behind-a-task-tool.md), [background delegation](0089-proactive-background-subagent-delegation.md)

## Context

Users want a persistent collaboration switch beside the composer's mode and
permission controls. Worker sessions clutter the sidebar, and a prompt-only
instruction cannot ensure an independent review follows file modifications.

## Decision

The composer owns an Off / Smart / Always control and its model/concurrency form.
Each conversation stores its mode, full `provider-id/model-id` execution and
review pins, workflow, coding assignment and concurrency (1–10, default 8)
through host-owned session workflow RPCs. Legacy `AppSettings.collaboration`
is an initial seed and is never overwritten by this composer. Missing mode
means Off. Saving affects the next Agent turn in that conversation. Permission mode is a separate setting. Plan,
Goal, remote composer surfaces and running turns do not offer this control.

Both launch resolvers validate enabled provider rows, subagent opt-in, and
resolved credentials. There is no fallback to another account. Agent mode
adds three app-owned native definitions, plus a collaboration developer in automatic or split assignment,
before the existing catalog (bounded
by the existing 16-definition limit): executor, read-only analyst, and test
verifier. Each has a distinct prompt and tool set. Their names are reserved
while enabled; existing definitions are preserved on disk and return when Off.
The same role can be instantiated several times. A new delegation is required
when a resumed chain's model differs from the configured pin.

Once collaboration is engaged, the parent coordinates, reads and delegates.
Its builtin Write, Edit and Bash calls are refused. Delegate calls retain the
existing host permission checks. Background Bash is refused during collaboration
because a review cannot wait for its eventual effects. Potentially mutating
builtin calls invalidate the turn's review. Before the next parent model
response, the runtime waits for delegates
(including worktree merge-back), starts a pinned read-only native Task, and
feeds the bounded reports back to the parent. The reviewer must inspect files
with a tool and return structured pass/fail/inconclusive evidence. Later writes
invalidate an earlier pass; failed reviews permit repair followed by a fresh
review. Three attempts cap automatic review per user turn. Unpassed work cannot
end as a successful completed turn. Stop cancels waiting and the reviewer.

Concurrency counts both running delegates and worktrees being prepared. Native
Task events retain the parent session and parent tool-call identity. No Worker
session, sidebar conversation, or window is created by this feature.

### On-demand routing

The UI labels are Off / Smart / Always; stored values remain `off` / `auto` /
`deep`. Smart changes the existing Auto behavior: the current conversation
model assesses each new user turn itself, without a separate router agent.
Questions, lookups, narrow low-risk changes and focused checks can use ordinary
parent tools directly. A coding request or selected workflow alone does not
require delegation. Substantial independent work, context-heavy exploration,
non-trivial changes needing independent review, or an explicit collaboration
request justify delegation. The model briefly explains why it is starting it.

The selected workflow is a conditional recipe in Smart mode. Calling
`CollaborationWorkflow`, or successfully starting a native Task in Flexible
mode, engages collaboration for the rest of that turn. Parent builtin
Write/Edit/Bash are then refused, even after the children finish, and the
existing model pins, review/test gates, cancellation and concurrency rules apply.
Flexible review includes earlier direct file/shell activity in the same turn;
when escalating to a workflow, include earlier changes and checks in its brief.
An invalid Task call does not engage collaboration. Every new user turn starts
with a fresh decision, including after a failed or canceled workflow.

Always retains the previous Deep behavior: implementation and code review use
collaboration; simple questions can remain direct. The Read-only review preset
keeps parent Write/Edit/Bash disabled in both modes, even for direct analysis.
Solo work uses the conversation's model, not the configured delegate model,
and does not automatically create a reviewer or verifier. Choosing the route
is a model judgment, not a deterministic complexity classifier or a guarantee.
Off retains its existing behavior. Provider bindings, permissions, database
schema and history format remain compatible; per-conversation choices use the
existing KV extension boundary described below.

## Consequences

The mode is directly discoverable in the composer. It trades additional model
requests and review latency for a separate implementation/review loop.

### Limits and compatibility

- Decomposition, useful parallelism, and review quality remain model judgments.
  Always suggests two execution and up to six analysis/verification jobs; it does
  not create eight jobs for trivial requests. Concurrency is an upper bound.
- A pass is a source review, not proof of test execution. A verifier can execute
  tests; Bash cannot technically be made read-only by its role prompt.
- The review gate covers builtin Write/Edit/Bash in the active runtime turn.
  External edits, plugin/MCP mutations, and process restarts are outside this
  gate; this is workflow assistance, not a security or correctness guarantee.
- Existing tools, permission enforcement, stored provider secrets, and Task
  history formats are reused. No database schema migration is introduced.
- Old hosts ignore the optional setting. Off preserves ordinary delegation.

## Validation

`collaboration-runtime.test.ts` runs real pi loops and delegates through an HTTP
provider fixture and temporary files. It covers automatic review, failure and
repair, Stop, model override refusal, Off, simple questions, and concurrency
while preparing worktrees. Shared/Rust validators, both launch resolvers and
settings RPC round-trips cover the boundary. The isolated Electron composer
user path covers mode/model selection, nested menus, save failure, remount,
concurrency and unchanged permissions. Live-provider acceptance is recorded
separately; a fixture does not establish provider availability.

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
