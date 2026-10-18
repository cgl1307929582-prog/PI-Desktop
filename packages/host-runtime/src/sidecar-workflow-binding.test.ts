import { expect, it } from "vitest";
import { AgentSidecar } from "./agent-sidecar.js";

it("still dispatches host-local tools while host-core is unavailable", async () => {
  const source = `const rl = require('node:readline').createInterface({input:process.stdin});
    let parentId;
    rl.on('line', line => { const message = JSON.parse(line);
      if(message.method === 'probe') { parentId = message.id; console.log(JSON.stringify({id:'proxy',method:'host.proxy',params:{method:'tools.execute',params:{sessionId:'session',toolCallId:'local',mode:'agent',toolName:'BrowserPreview',args:{path:'index.html'}}}})); }
      if(message.id === 'proxy') console.log(JSON.stringify({id:parentId,result:message.result,error:message.error}));
    });`;
  const sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr() {} });
  sidecar.setLocalTool("BrowserPreview", async () => ({ ok: true, content: "Local preview" }));
  try { expect(await sidecar.call("probe", {})).toMatchObject({ ok: true, content: "Local preview" }); }
  finally { await sidecar.dispose(); }
});

it("validates the workflow root before resolving instructions across the real sidecar proxy", async () => {
  const source = `const rl = require('node:readline').createInterface({input:process.stdin});
    let parentId;
    rl.on('line', line => { const message = JSON.parse(line);
      if(message.method === 'probe') { parentId = message.id; console.log(JSON.stringify({id:'proxy',method:'host.proxy',params:{method:'project.instructions.resolve',params:{sessionId:'session',path:'src/file.ts',projectPath:'/untrusted',workflowWorkspace:'/target'}}})); }
      if(message.id === 'proxy') console.log(JSON.stringify({id:parentId,result:message.result,error:message.error}));
    });`;
  const sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr() {} });
  const calls: unknown[] = [];
  sidecar.setHost({
    async call<T>(method: string, params?: unknown): Promise<T> { calls.push({ method, params }); return { workspaceRoot: "/validated-target" } as T; },
    onNotification: () => () => {}, onExit: () => () => {},
  });
  sidecar.setProjectInstructionResolver(async input => input);
  try {
    expect(await sidecar.call("probe", {})).toEqual({ sessionId: "session", path: "src/file.ts", projectPath: "/validated-target" });
    expect(calls).toEqual([{ method: "worktree.workflow.resolve", params: { sessionId: "session", workspace: "/target", delegationId: undefined } }]);
  } finally { await sidecar.dispose(); }
});
