import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { zhCN } from "@pi-desktop/i18n";
import type { UiMessage, AgentActivity } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/** User-visible behavior in real Chromium, with deterministic event evidence. */
export async function executionVisibilityProbe() {
  const i18n = createInstance();
  await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const initial = useAppStore.getState();
  const errors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  const checks: string[] = [];
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(label);
    checks.push(label);
  };
  const at = (seconds: number) => new Date(Date.now() - 120_000 + seconds * 1000).toISOString();
  const msg = (id: string, role: UiMessage["role"], content: string, extra: Partial<UiMessage> = {}): UiMessage =>
    ({ id, role, content, createdAt: at(0), status: "complete", ...extra });
  const tool = (id: string, toolName: string, extra: Partial<UiMessage> = {}) =>
    msg(id, "tool", "", { toolName, toolCallId: id, toolStatus: "success", ...extra });
  const tasks = Array.from({ length: 8 }, (_, index) => tool(`task-${index}`, "Task", {
    toolArgs: { agent: `agent-${index}`, description: index % 2 ? "检查消息同步" : "实现手机聊天界面" },
    toolResult: { details: { delegationId: `delegate-${index}`, status: "running",
      modelId: index % 2 ? "pro/gpt" : "claude-opus", startedAt: Date.parse(at(5)) } },
  }));
  const messages: UiMessage[] = [
    msg("user", "user", "检查并修复手机端"),
    msg("intro", "assistant", "正在检查项目。"),
    tool("read", "Read", { toolDurationMs: 100, toolCompletedAt: at(0.1) }),
    msg("progress", "assistant", "通信层已完成，正在验证断线恢复。", { createdAt: at(10) }),
    tool("edit", "Edit", { createdAt: at(10), toolDurationMs: 3000, toolCompletedAt: at(13) }),
    ...Array.from({ length: 30 }, (_, index) => tool(`cmd-${index}`, "Bash", {
      createdAt: at(15 + index), toolArgs: { command: "echo checked" }, toolDurationMs: 200,
      toolResult: { details: { exitCode: 0, stdout: "checked" } },
    })),
    ...tasks,
  ];
  let sessionId = "visibility-a";
  let current = messages;
  let running = true;
  let readingWindow = false;
  let askPending = false;
  const render = async () => {
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <ChatTranscript sessionId={sessionId} messages={current} isRunning={running}
        readingWindow={readingWindow} askPending={askPending} />
    </I18nextProvider>));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    check(errors.length === 0, "renderer stays error-free");
  };
  const activity = (value: AgentActivity | undefined) => flushSync(() => useAppStore.setState({
    agentStatuses: { [sessionId]: { sessionId, isRunning: true, pendingToolConfirmations: 0, modelId: "claude-opus", activity: value } },
  }));
  const bar = () => host.querySelector<HTMLElement>(".current-work");
  try {
    useAppStore.setState({ settings: { ...initial.settings, smoothStreaming: false, showThinking: false } });
    activity({ phase: "waiting-subagents", since: Date.parse(at(5)), subagentCount: 8 });
    await render();
    const progress = host.querySelector<HTMLElement>('[data-message-id="progress"]');
    check(progress && progress.getBoundingClientRect().height > 0 && !progress.closest(".turn-process"), "Chinese progress remains visible after later tools");
    const headers = [...host.querySelectorAll<HTMLElement>(".turn-process > button")];
    check(headers.some((header) => header.textContent?.includes("<1s")), "short completed step reports subsecond duration");
    check(headers.some((header) => header.textContent?.includes("3s")), "another completed step retains its own three-second duration");
    check(bar()?.textContent?.includes("8"), "parent shows actual child wait");
    check(bar()?.querySelectorAll(".current-work-agent").length === 8, "all eight child assignments appear together");
    check(bar()?.textContent?.includes("pro/gpt") && bar()?.textContent?.includes("claude-opus"), "effective models are visible");
    const scroller = host.querySelector<HTMLElement>(".thread-scroll");
    check(scroller && scroller.scrollHeight > scroller.clientHeight, "fixture exercises a scrollable conversation");
    const top = bar()!.getBoundingClientRect().top;
    scroller!.scrollTop = 0;
    scroller!.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    check(Math.abs(bar()!.getBoundingClientRect().top - top) < 1, "current status remains fixed while reading history");
    current = [...messages, tool("wait", "TaskWait", { toolResult: { details: { delegations: [
      { delegationId: "delegate-0", status: "completed", startedAt: Date.parse(at(5)), completedAt: Date.parse(at(9)) },
    ] } } })];
    await render();
    check(bar()?.querySelectorAll('[data-agent-status="completed"]').length === 1, "child completion updates independently");
    check(bar()?.querySelectorAll('[data-agent-status="running"]').length === 7, "other children remain running");
    activity({ phase: "retrying", since: Date.now(), attempt: 2, retryDelayMs: 5000, error: { code: "NETWORK_ERROR", message: "Connection interrupted" } });
    await render();
    check(bar()?.textContent?.includes("NETWORK_ERROR"), "retry exposes its concrete reason");
    askPending = true;
    await render();
    check(bar()?.textContent?.includes("等待你回答问题"), "pending user action takes priority over stale model wait");
    askPending = false;
    readingWindow = true;
    await render();
    check(bar() && bar()?.querySelectorAll(".current-work-agent").length === 0, "older history never becomes the current assignment roster");
    check(bar()?.textContent?.includes("NETWORK_ERROR"), "live runtime state survives reading an older window");
    readingWindow = false;
    current = messages.slice(0, 5);
    activity({ phase: "waiting-model", since: Date.now() });
    await render();
    const completedTail = [...host.querySelectorAll(".turn-process > button")].at(-1);
    check(completedTail?.textContent?.includes("已处理 3s") && !completedTail.querySelector(".running"), "completed tail keeps recorded duration while parent waits for the model");
    sessionId = "visibility-b";
    current = [msg("user-b", "user", "另一个任务"), msg("progress-b", "assistant", "正在检查另一个项目。")];
    activity({ phase: "waiting-model", since: Date.now() });
    await render();
    check(bar()?.dataset.currentWorkSession === sessionId && !bar()?.textContent?.includes("通信层"), "switching sessions drops the previous progress and roster");
    host.style.width = "390px";
    await render();
    check(bar()!.getBoundingClientRect().right <= host.getBoundingClientRect().right + 1, "status fits a narrow pane");
    const startedAt = Date.now() - 90000;
    current = [
      msg("buffered-user", "user", "只读核对", { createdAt: new Date(startedAt).toISOString() }),
      msg("buffered-progress", "assistant", "开始核对。", { createdAt: new Date(startedAt + 20000).toISOString(), responseDurationMs: 20000 }),
      tool("buffered-wait", "TaskWait", { createdAt: new Date(startedAt + 20000).toISOString(), toolDurationMs: 1 }),
      msg("buffered-answer", "assistant", "核对完成。", { createdAt: new Date(startedAt + 75000).toISOString(), thinking: "fixture", responseDurationMs: 55000 }),
    ];
    await render();
    const wallClock = bar()?.querySelector(".current-work-heading")?.textContent?.match(/已用 1m (\d+)s/);
    check(wallClock && Number(wallClock[1]) >= 28 && Number(wallClock[1]) <= 31, "turn clock retains the initial provider wait after output arrives");
    check([...host.querySelectorAll(".turn-process > button")].some((header) => header.textContent?.includes("已处理 55s")), "buffered response duration is counted once instead of added to its late timestamp");
    running = false;
    await render();
    check(!bar(), "completed turn removes the live status without changing its history");
    return { ok: true, checks };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState(initial);
  }
}
