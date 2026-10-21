import type { AgentActivity, UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnEntry } from "../../../lib/assistant-turns";
import { getToolAction, TOOL_RUNNING_KEYS } from "../../../lib/tool-display";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { turnProcessTiming } from "../../../lib/turn-process";
import {
  collectDelegationFailures, collectDelegationStatuses, collectDelegationTimings,
  delegationIsCreating, isDelegationActivityItem, subagentOutcome,
} from "../../../lib/subagent-topology";
import { delegateAgentName, delegateModelId } from "./model";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Public task description only; never infer intent from private reasoning. */
export function toolTarget(message: UiMessage): string {
  const args = record(message.toolArgs);
  const description = text(args.description);
  if (description) return description;
  const path = text(args.path) || text(args.file_path);
  return path ? path.replaceAll("\\", "/").split("/").at(-1) ?? "" : "";
}

export type CurrentWorkInput = {
  entry?: AssistantTurnEntry;
  activity?: AgentActivity;
  awaiting?: "permission" | "input" | "plan";
  running: boolean;
};

/** Read-only projection of the current turn, including native workflow Task rows. */
export function currentWork({ entry, activity, awaiting, running }: CurrentWorkInput) {
  const parts = entry?.parts ?? [];
  const items = parts.flatMap((part) => part.kind === "activity" ? part.items : []);
  const tools = items.filter((item) => item.kind === "tool");
  const statuses = collectDelegationStatuses(items, { turnLive: running });
  const timings = collectDelegationTimings(items);
  const failures = collectDelegationFailures(items);
  const agents = items.filter(isDelegationActivityItem).map((item) => {
    const payload = record(toolResultPayload(item.message));
    const args = record(item.message.toolArgs);
    const id = text(payload.delegationId) || item.message.toolCallId || item.message.id;
    const timing = timings.get(id);
    return {
      id,
      name: delegateAgentName(item.message, item.delegate),
      model: delegateModelId(item.message),
      providerId: item.delegate?.items.findLast((row) => row.message.providerId)?.message.providerId,
      task: text(args.description) || text(args.task),
      status: subagentOutcome(item.message, statuses),
      creating: running && delegationIsCreating(item.message),
      startedAt: timing?.startedAt,
      completedAt: timing?.completedAt,
      failure: failures.get(id),
    };
  });
  const lastPart = parts.at(-1);
  const lastMessage = lastPart?.kind === "message" ? lastPart.message : lastPart?.items.at(-1)?.message;
  const activeTool = tools.findLast((item) => item.message.toolStatus === "running")?.message;
  const latestProgress = parts.findLast((part) => part.kind === "message" && part.message.content.trim());
  const progress = latestProgress?.kind === "message" ? latestProgress.message.content : "";
  const timing = turnProcessTiming(parts);
  const completedTools = tools.filter((item) => ["success", "error", "denied"].includes(item.message.toolStatus ?? ""));
  const lastToolAt = completedTools.reduce<number | undefined>((latest, { message }) => {
    const timestamp = Date.parse(message.toolCompletedAt ?? "");
    return Number.isFinite(timestamp) ? Math.max(latest ?? timestamp, timestamp) : latest;
  }, undefined);
  // Permission/input takes precedence over a stale model wait. Runtime wait
  // phases are authoritative while a workflow tool waits on its delegates.
  const label = awaiting ? `chat.execution.waiting${awaiting[0].toUpperCase()}${awaiting.slice(1)}`
    : activity ? undefined
      : activeTool ? TOOL_RUNNING_KEYS[getToolAction(activeTool.toolName)]
        : lastMessage?.status === "streaming" && lastMessage.thinking && !lastMessage.content
          ? "chat.thinking" : lastMessage?.status === "streaming"
            ? "chat.execution.responding" : "chat.running";
  const phaseStartedAt = awaiting ? undefined : activity?.since ?? (activeTool ? Date.parse(activeTool.createdAt) : undefined);
  return {
    agents, progress, label,
    target: !awaiting && !activity && activeTool ? toolTarget(activeTool) : "",
    startedAt: timing.startedAt,
    phaseStartedAt: typeof phaseStartedAt === "number" && Number.isFinite(phaseStartedAt) ? phaseStartedAt : undefined,
    lastToolAt,
    completedTools: completedTools.length,
  };
}
