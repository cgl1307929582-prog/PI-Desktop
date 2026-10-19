/**
 * The desktop's `RacpHostOperations` for relayed phones (D663). It reads the
 * same host-core state the renderer shows and offers only what a phone needs:
 * session list, new chat, rename, project list, and read-only workspace
 * access (list, read, diff). Everything else answers
 * `CAPABILITY_UNAVAILABLE`; the mobile policy forbids most of it anyway.
 */
import { basename } from "node:path";

import { RacpError, type SessionSummary } from "@pi-desktop/agent-host";
import {
  collectWorkspaceDiff,
  listDir,
  readWorkspaceFile,
  toSessionSummary,
  type HostRpc,
  type HostSessionRecord,
} from "@pi-desktop/host-runtime";
import type { RacpHostOperations } from "@pi-desktop/racp";
import type { RacpProjectSummary } from "@pi-desktop/shared";

type ProjectRow = { id: number | string; path: string; name?: string };

export type MobileHostOperationsDeps = {
  getHost: () => HostRpc | null;
  /** Tell the renderer the session list changed (a phone created or renamed a chat). */
  onSessionsChanged: () => void;
  registerPush: NonNullable<RacpHostOperations["registerPush"]>;
};

function unavailable(what: string): never {
  throw new RacpError("CAPABILITY_UNAVAILABLE", `${what} is not available from a phone`);
}

function hostError(error: unknown): never {
  if (error instanceof RacpError) throw error;
  const code = (error as { errorCode?: string; data?: { errorCode?: string } })?.data?.errorCode ?? (error as { errorCode?: string })?.errorCode;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "NOT_FOUND" || code === "SESSION_NOT_FOUND") throw new RacpError("NOT_FOUND", message);
  if (code === "INVALID_PARAMS" || code === "INVALID_ARGUMENT") throw new RacpError("INVALID_ARGUMENT", message);
  if (code === "HOST_UNAVAILABLE") throw new RacpError("AGENT_UNAVAILABLE", message, { retriable: true });
  throw new RacpError("INTERNAL", "host-core request failed", { details: code ? { code } : undefined });
}

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

function projectSummary(row: ProjectRow): RacpProjectSummary {
  return { id: String(row.id), label: row.name || basename(row.path), archived: false };
}

export function createMobileHostOperations(deps: MobileHostOperationsDeps): RacpHostOperations {
  const { getHost } = deps;

  async function projects(host: HostRpc): Promise<ProjectRow[]> {
    const result = await host.call<{ projects?: ProjectRow[] }>("projects.list", {}).catch(hostError);
    return result.projects ?? [];
  }

  async function decorate(host: HostRpc, records: HostSessionRecord[]): Promise<SessionSummary[]> {
    const byPath = new Map<string, string>();
    if (records.some((record) => record.projectPath)) {
      for (const project of await projects(host)) byPath.set(project.path, String(project.id));
    }
    return records.map((record) => {
      const summary = toSessionSummary(record);
      const projectId = record.projectPath ? byPath.get(record.projectPath) : undefined;
      return projectId ? { ...summary, projectId } : summary;
    });
  }

  async function sessionRecord(host: HostRpc, sessionId: string): Promise<HostSessionRecord> {
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(hostError);
    if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
    return result.session;
  }

  async function sessionRoot(sessionId: string): Promise<string> {
    const record = await sessionRecord(requireHost(getHost), sessionId);
    const root = record.projectPath?.trim();
    if (!root) throw new RacpError("CONFLICT", "the session has no project folder");
    return root;
  }

  const pathError = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    if (/escapes workspace root|outside allowed roots/.test(message)) throw new RacpError("REMOTE_PATH_FORBIDDEN", "the path is outside the project");
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new RacpError("REMOTE_PATH_NOT_FOUND", "no such file");
    if (/not a file/.test(message)) throw new RacpError("INVALID_ARGUMENT", "not a file");
    throw new RacpError("INTERNAL", "workspace read failed");
  };

  return {
    sessions: {
      async list() {
        const host = requireHost(getHost);
        const result = await host.call<{ sessions?: HostSessionRecord[] }>("session.list", {}).catch(hostError);
        return decorate(host, result.sessions ?? []);
      },
      async create(input) {
        const host = requireHost(getHost);
        let projectPath: string | undefined;
        if (input.projectId) {
          const project = (await projects(host)).find((row) => String(row.id) === input.projectId);
          if (!project) throw new RacpError("NOT_FOUND", `project ${input.projectId} is unknown`);
          projectPath = project.path;
        }
        // A phone never chooses the permission mode of a new chat; the desktop default applies.
        const result = await host
          .call<{ session?: HostSessionRecord | null }>("session.create", {
            ...(input.title ? { title: input.title } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
            ...(projectPath ? { projectPath } : {}),
          })
          .catch(hostError);
        if (!result.session) throw new RacpError("INTERNAL", "session.create returned no session");
        deps.onSessionsChanged();
        return (await decorate(host, [await sessionRecord(host, result.session.id)]))[0]!;
      },
      async configure() {
        return unavailable("changing session settings");
      },
      async fork() {
        return unavailable("forking");
      },
      async rename(sessionId, title) {
        await requireHost(getHost).call("session.rename", { id: sessionId, title: title.slice(0, 200) }).catch(hostError);
        deps.onSessionsChanged();
      },
      async deriveTitle(sessionId, title) {
        const result = await requireHost(getHost)
          .call<{ updated?: boolean }>("session.deriveTitle", { id: sessionId, title })
          .catch(hostError);
        if (result.updated === true) deps.onSessionsChanged();
        return result.updated === true;
      },
      async delete() {
        return unavailable("deleting");
      },
      async compact() {
        return unavailable("compaction");
      },
    },
    projects: {
      async list() {
        return (await projects(requireHost(getHost))).map(projectSummary);
      },
      async register() {
        return unavailable("registering a folder");
      },
      async browse() {
        return unavailable("browsing folders");
      },
    },
    workspace: {
      async list(sessionId, path) {
        return { entries: await listDir(await sessionRoot(sessionId), path).catch(pathError) };
      },
      async read(sessionId, path) {
        return readWorkspaceFile(await sessionRoot(sessionId), path).catch(pathError);
      },
      async diff(sessionId) {
        return collectWorkspaceDiff(await sessionRoot(sessionId));
      },
    },
    registerPush: deps.registerPush,
  };
}
