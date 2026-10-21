import type { UiMessage } from "@pi-desktop/shared";
import type {
  AssistantActivityItem,
  AssistantTurnEntry,
  AssistantTurnPart,
} from "./assistant-turns";
import { isStandaloneRunActivity } from "./assistant-turns";
import { collectDelegationStatuses, collectDelegationTimings, isDelegationActivityItem, subagentOutcome, type SubagentOutcome } from "./subagent-topology";
import { toolResultPayload } from "./tool-presentation";

/** A completed tool must not keep accruing time while its parent waits. */
export function processClockRunning(
  parts: readonly AssistantTurnPart[],
  active: boolean,
  statuses?: ReadonlyMap<string, SubagentOutcome>,
): boolean {
  return active && parts.some((part) => part.kind === "activity" && part.items.some((item) => {
    if (item.kind === "tool") {
      const message = item.message;
      return isDelegationActivityItem(item) ? subagentOutcome(message, statuses) === "running"
        : message.toolStatus === "running";
    }
    if (item.kind === "hostedSearch") return item.round.status === "searching";
    return isThinkingActive(item.message, active);
  }));
}

export function isThinkingActive(message: UiMessage, active: boolean): boolean {
  return active && message.status === "streaming" && !message.content.trim();
}

export function isTurnThinking(
  parts: readonly AssistantTurnPart[],
  active: boolean,
): boolean {
  const latestPart = parts.at(-1);
  const latestActivity =
    latestPart?.kind === "activity" ? latestPart.items.at(-1) : undefined;
  return (
    latestActivity?.kind === "thinking" &&
    isThinkingActive(latestActivity.message, active)
  );
}

export function processContainsMessage(
  parts: readonly AssistantTurnPart[],
  messageId: string,
): boolean {
  return parts.some((part) => {
    if (part.kind === "message") return part.message.id === messageId;
    return part.items.some((item) => {
      if (item.message.id === messageId) return true;
      return (
        item.kind === "tool" &&
        Boolean(item.delegate?.items.some((row) => row.message.id === messageId))
      );
    });
  });
}

/** A `Bash`/run call rendered as its own row outside any process disclosure. */
export type TurnProcessRunSegment = {
  kind: "run";
  key: string;
  item: Extract<AssistantActivityItem, { kind: "tool" }>;
};

/** One chronological chunk of non-run process content between run calls. */
export type TurnProcessBodySegment = {
  kind: "process";
  key: string;
  parts: AssistantTurnPart[];
};

/** Public progress is conversation content, never a disclosure payload. */
export type TurnProgressSegment = {
  kind: "progress";
  key: string;
  parts: Extract<AssistantTurnPart, { kind: "message" }>[];
};

export type TurnProcessSegment = TurnProcessRunSegment | TurnProcessBodySegment | TurnProgressSegment;

/**
 * Split one turn's process into the order it renders (ADR
 * turn-process-and-thinking-display).
 *
 * `Bash` and run aliases are pulled out of the process flow entirely: each is
 * its own `run` segment rendered as a standalone row with no process or group
 * ancestor, and adjacent calls stay separate. The remaining tools, thinking,
 * hosted searches keep their original order in `process` chunks. Public progress
 * paragraphs remain standalone between those chunks. Segment parts are the same part
 * objects as the input, so downstream reveal and active-tail identity still
 * hold.
 */
export function segmentTurnProcess(
  parts: readonly AssistantTurnPart[],
): TurnProcessSegment[] {
  const segments: TurnProcessSegment[] = [];
  let pending: AssistantTurnPart[] = [];
  const flushProcess = () => {
    if (pending.length === 0) return;
    const first = pending[0];
    const key =
      first.kind === "activity" ? first.items[0].message.id : first.message.id;
    segments.push({ kind: "process", key, parts: pending });
    pending = [];
  };
  for (const part of parts) {
    if (part.kind === "message") {
      flushProcess();
      segments.push({ kind: "progress", key: part.message.id, parts: [part] });
      continue;
    }
    if (part.kind === "activity" && part.items.length === 1) {
      const item = part.items[0];
      if (isStandaloneRunActivity(item)) {
        flushProcess();
        segments.push({ kind: "run", key: item.message.id, item });
        continue;
      }
    }
    pending.push(part);
  }
  flushProcess();
  return segments;
}

/**
 * Only a trailing assistant text can be the answer: text followed by tools is
 * progress. The stream carries no final-answer marker, so a live trailing text
 * remains visible until a later activity establishes that it was intermediate.
 * Errors remain outside the disclosure even when more activity follows them.
 */
export function projectTurnProcess(entry: AssistantTurnEntry) {
  const last = entry.parts.at(-1);
  const answer =
    last?.kind === "message" && last.message.content.trim() ? last : undefined;
  const process: AssistantTurnPart[] = [];
  const responses: Extract<AssistantTurnPart, { kind: "message" }>[] = [];
  for (const part of entry.parts) {
    if (part.kind === "message" && (part === answer || part.message.error)) {
      responses.push(part);
    } else {
      process.push(part);
    }
  }
  return { process, responses };
}

/**
 * Steps a process body renders under the thinking preference.
 *
 * `hideThinking` is `!showThinking`: completed reasoning rows and excerpts are
 * hidden, while the live reasoning indicator still counts as a visible step so
 * a thinking-only process keeps its indicator. The helper counts exactly the
 * parts it is given; Bash and run aliases are segmented out before rendering
 * and never reach a process chunk, so they are never counted here.
 */
export function visibleProcessSteps(
  parts: readonly AssistantTurnPart[],
  hideThinking: boolean,
  active: boolean,
): number {
  let count = 0;
  for (const part of parts) {
    if (part.kind === "message") {
      if (part.message.content.trim()) count += 1;
      continue;
    }
    for (const item of part.items) {
      if (
        item.kind !== "thinking" ||
        !hideThinking ||
        isThinkingActive(item.message, active)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Response duration includes provider wait, whereas createdAt can be the first
 * response event. Adding the duration to that timestamp counts the wait twice.
 * Sum recorded model work once and union parallel tool/delegate intervals.
 * The separate current-turn clock owns wall time, including gaps and retries.
 */
export function turnProcessDuration(parts: readonly AssistantTurnPart[], now?: number): number {
  const messages = new Map(parts.flatMap((part) =>
    part.kind === "message" ? [part.message] : part.items.map((item) => item.message),
  ).map((message) => [message.id, message]));
  const items = parts.flatMap((part) => part.kind === "activity" ? part.items : []);
  const byId = new Map(items.map((item) => [item.message.id, item]));
  const delegates = collectDelegationTimings(items);
  const statuses = collectDelegationStatuses(items, { turnLive: now !== undefined });
  const duration = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  const intervals: Array<{ start: number; end: number }> = [];
  let total = 0;
  for (const message of messages.values()) {
    const createdAt = Date.parse(message.createdAt);
    if (message.role === "assistant") {
      total += message.status === "streaming" && now !== undefined && Number.isFinite(createdAt)
        ? duration(message.providerWaitMs) + duration(message.modelStreamDurationMs) + Math.max(0, now - createdAt)
        : duration(message.responseDurationMs);
      continue;
    }
    if (message.role !== "tool") continue;
    const item = byId.get(message.id);
    const delegated = item && isDelegationActivityItem(item);
    const payload = toolResultPayload(message) as { delegationId?: string } | undefined;
    const timing = delegated ? delegates.get(payload?.delegationId ?? message.toolCallId ?? message.id) : undefined;
    const start = timing?.startedAt ?? createdAt;
    const storedEnd = timing?.completedAt ?? Date.parse(message.toolCompletedAt ?? "");
    const live = now !== undefined && (delegated ? subagentOutcome(message, statuses) === "running" : message.toolStatus === "running");
    const end = live ? now : Number.isFinite(storedEnd) ? storedEnd : start + duration(message.toolDurationMs);
    if (Number.isFinite(start) && Number.isFinite(end)) intervals.push({ start, end: Math.max(start, end) });
    else total += duration(message.toolDurationMs);
  }
  intervals.sort((left, right) => left.start - right.start);
  let end = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    total += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return total;
}
