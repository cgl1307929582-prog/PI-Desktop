import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentActivity } from "@pi-desktop/shared";
import type { AssistantTurnEntry } from "../../../lib/assistant-turns";
import { formatToolDuration } from "../../../lib/tool-display";
import { useAppStore } from "../../../stores/app-store";
import { Button } from "../../../components/ui";
import { currentWork, type CurrentWorkInput } from "./current-work";
import { runActivityLabel } from "./ActivityGroup";
import "../../../styles/current-work.css";

export const CurrentWorkStatus = memo(function CurrentWorkStatus({
  sessionId, entry, activity, awaiting, turnStartedAt, onLatest,
}: {
  sessionId: string;
  entry?: AssistantTurnEntry;
  activity?: AgentActivity;
  awaiting?: CurrentWorkInput["awaiting"];
  turnStartedAt?: number;
  onLatest: () => void;
}) {
  const { t, i18n } = useTranslation();
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId));
  const modelId = useAppStore((state) => state.agentStatuses[sessionId]?.modelId) ?? session?.modelId;
  const providers = useAppStore((state) => state.providers);
  const modelLabel = (model: string | undefined, providerId?: string) => {
    const provider = providers.find((item) => item.id === providerId)?.name;
    return [model, provider].filter(Boolean).join(" · ");
  };
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const work = useMemo(() => currentWork({ entry, activity, awaiting, turnStartedAt, running: true }), [entry, activity, awaiting, turnStartedAt]);
  const label = work.label ? t(work.label) : activity ? runActivityLabel(activity, t, now) : t("chat.running");
  const duration = (start: number, end = now) => formatToolDuration(Math.max(0, end - start) / 1000);
  const clock = (value: number) => new Date(value).toLocaleTimeString(i18n.language, { hour12: false });
  return (
    <section className="current-work" aria-label={t("chat.execution.current")} data-current-work-session={sessionId}>
      <div className="current-work-heading">
        <strong>{t("chat.execution.current")}</strong>
        <span className="current-work-model" title={modelId}>{modelLabel(modelId, session?.providerId) || t("chat.subagentCoordinator")}</span>
        {work.startedAt !== undefined && <span className="current-work-time">{t("chat.execution.total", { time: duration(work.startedAt) })}</span>}
        <Button size="sm" variant="ghost" onClick={onLatest}>{t("chat.execution.latest")}</Button>
      </div>
      <div className="current-work-action">
        <span role="status" aria-live="polite">{label}{work.target ? ` · ${work.target}` : ""}</span>
        {work.phaseStartedAt !== undefined && <span className="current-work-time">{duration(work.phaseStartedAt)}</span>}
      </div>
      {work.progress && <p className="current-work-progress" title={work.progress}>{work.progress}</p>}
      <div className="current-work-evidence">
        {t("chat.execution.toolsFinished", { count: work.completedTools })}
        {work.lastToolAt !== undefined && <span>{t("chat.execution.lastTool", { time: clock(work.lastToolAt) })}</span>}
      </div>
      {!awaiting && activity?.phase === "retrying" && activity.error && (
        <p className="current-work-error">{activity.error.code}: {activity.error.message}</p>
      )}
      {work.agents.length > 0 && (
        <div className="current-work-agents" aria-label={t("chat.execution.assignments")}>
          {work.agents.map((agent) => (
            <div className="current-work-agent" key={agent.id} data-agent-status={agent.status}>
              <strong>{agent.name || t("chat.subagentUnnamed")}</strong>
              <span className="current-work-model">{modelLabel(agent.model, agent.providerId) || t("chat.execution.modelPending")}</span>
              <span>{agent.creating ? t("chat.subagentCreating") : t(`chat.subagentStatus.${agent.status}`)}</span>
              {agent.startedAt !== undefined && (agent.status === "running" || agent.completedAt !== undefined) && <span className="current-work-time">{duration(agent.startedAt, agent.completedAt)}</span>}
              {agent.task && <span className="current-work-assignment" title={agent.task}>{agent.task}</span>}
              {agent.failure && <span className="current-work-error">{agent.failure.code}: {agent.failure.message}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
