/** Refill ready work immediately; on failure cancel and drain every started job. */
export async function scheduleWorkflowTasks<T extends { id: string; dependsOn: string[] }>(
  tasks: T[], concurrency: number,
  execute: (task: T, completed: ReadonlyMap<string, string>, signal: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
  const stop = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const completed = new Map<string, string>();
  const active = new Map<string, Promise<void>>();
  let failure: unknown;
  let failed = false;
  try {
    while (completed.size < tasks.length) {
      combined.throwIfAborted();
      for (const task of tasks) {
        if (active.size >= concurrency) break;
        if (active.has(task.id) || completed.has(task.id) || !task.dependsOn.every(id => completed.has(id))) continue;
        const running = Promise.resolve().then(() => {
          combined.throwIfAborted();
          return execute(task, completed, combined);
        }).then(report => { completed.set(task.id, report); }).catch(error => {
          if (!failed) { failed = true; failure = error; }
          stop.abort();
        }).finally(() => { active.delete(task.id); });
        active.set(task.id, running);
      }
      if (!active.size) throw new Error("Workflow has no runnable implementation task.");
      await Promise.race(active.values());
      if (failed) throw failure;
    }
  } finally {
    stop.abort();
    await Promise.allSettled(active.values());
  }
}
