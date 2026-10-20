// ultracode for OpenCode 2.x: a code-driven multi-agent workflow engine, modelled on Claude Code's Workflow tool.
// Tools for the lead: workflow (launch / resume), workflow_status, workflow_stop. Tool for workflow agents: wf_submit.
// Commands: /ultracode (switch the session to the ultra lead agent and send the task), /ultracode-off.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { LaunchRejected } from "./core.ts"
import { Engine } from "./engine.ts"
import { lastUserText, makeRunAgent, sharedSubmits } from "./opencode.ts"

const WORKFLOW_DESC = `Run a workflow script that orchestrates many subagents deterministically, in the background.
Pass ONE of: script (inline JavaScript, must begin with a pure-literal \`export const meta = { name, description, phases? }\`;
the default: do not write it to a file first, every launch persists a copy and returns its path),
scriptPath (that returned path, after you edit it), or name (a saved workflow, e.g. "adversarial-audit").
args: any JSON value, exposed to the script as \`args\` (pass objects as JSON objects, not as a JSON-encoded string).
resumeFromRunId: with scriptPath, replays every unchanged agent() call before the first edited one from cache.
Returns at once with taskId and runId; a <workflow-notification> message arrives in this session when the run ends.
Script API: agent(prompt, {label, phase, schema, agentType, model, effort, owns, readOnly}) -> value | null;
parallel(thunks) (a barrier); pipeline(items, stage1, stage2, ...) (no barrier: the default for multi-stage work);
phase(title); log(msg); workflow(name, args) (one nesting level); args; budget. Date.now / Math.random throw.
At most 6 agents run at once per run (configurable); the rest queue first come, first served.`

const configDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")

function summarise(rec: Record<string, any> | { live: true; progress: any[]; logs: string[] }) {
  const progress = "workflowProgress" in rec ? rec.workflowProgress : rec.progress
  const agents = (progress ?? []).filter((p: any) => p.type === "workflow_agent")
  const by = (st: string) => agents.filter((a: any) => a.state === st).length
  return {
    agents: agents.length, queued: by("queued"), running: by("progress"), done: by("done"), error: by("error"),
    cached: agents.filter((a: any) => a.cached).length,
    running_labels: agents.filter((a: any) => a.state === "progress").map((a: any) => a.label).slice(0, 12),
    last_logs: (rec.logs ?? []).slice(-8),
  }
}

export default {
  id: "ultracode",
  async setup(ctx: any) {
    const opts = (ctx.options ?? {}) as { slots?: number; home?: string; workerAgent?: string; nudges?: number }
    const home = opts.home ?? join(homedir(), ".local", "share", "opencode", "ultracode")
    const project: string = ctx.location?.directory ?? process.cwd()
    const submits = sharedSubmits
    const children = new Set<string>()
    const engines = new Map<string, Engine>()
    let defaultModel = "default"
    try {
      const d = await ctx.model.default()
      const m = d?.data ?? d
      if (m?.providerID) defaultModel = `${m.providerID}/${m.id ?? m.modelID}`
    } catch {}

    const engineFor = (lead: string) => {
      let e = engines.get(lead)
      if (e) return e
      e = new Engine({
        home, sessionID: lead, model: defaultModel, slots: opts.slots ?? 6,
        runAgent: makeRunAgent({ ctx, leadSessionID: lead, submits, children, defaultAgent: opts.workerAgent ?? "wf-worker", nudges: opts.nudges }),
        // A synthetic message with resume starts a turn in the lead when it is idle (probe P5); queued when busy.
        notify: async (text) => {
          await ctx.session.synthetic({ sessionID: lead, text, resume: true, delivery: "queue" })
        },
        registryDirs: () => [join(configDir(), "workflows"), join(project, ".opencode", "workflows")],
        // OpenCode's tmp dir and the OS temp dir: leads tend to write a script there before launching it by path.
        readableRoots: [project, configDir(), home, tmpdir()],
      })
      engines.set(lead, e)
      return e
    }

    ctx.tool.transform((editor: any) => {
      editor.add({
        name: "workflow",
        description: WORKFLOW_DESC,
        input: {
          type: "object",
          properties: {
            script: { type: "string", description: "inline workflow script (JavaScript)" },
            scriptPath: { type: "string", description: "path of a script this tool returned (edit it, then relaunch)" },
            name: { type: "string", description: "a saved workflow's name" },
            args: { description: "any JSON value, exposed to the script as `args`" },
            resumeFromRunId: { type: "string", description: "a prior run's runId (with scriptPath)" },
          },
          additionalProperties: false,
        },
        async execute(input: any, context: any) {
          if (children.has(context.sessionID)) throw new Error("workflow is not available inside a workflow agent")
          const e = engineFor(context.sessionID)
          const relay = await lastUserText(ctx, context.sessionID)
          e.o.relay = () => relay
          try {
            const r = e.launch(input ?? {})
            return {
              content: JSON.stringify(r, null, 1) +
                `\nThe workflow runs in the background. Keep working; a <workflow-notification> arrives in this session when it ends. ` +
                `workflow_status shows progress; workflow_stop kills it. To iterate, edit ${r.scriptPath} and relaunch with ` +
                `{scriptPath, resumeFromRunId: "${r.runId}"}.`,
            }
          } catch (err) {
            if (err instanceof LaunchRejected) throw new Error("Workflow refused: " + err.message)
            throw err
          }
        },
      })
      editor.add({
        name: "workflow_status",
        description: "Progress of this session's workflow runs: live ones (agents queued / running / done / failed, recent logs) and the last finished ones.",
        input: { type: "object", properties: { taskId: { type: "string" } }, additionalProperties: false },
        async execute(input: any, context: any) {
          const e = engines.get(context.sessionID)
          const live = e ? [...e.live.entries()].filter(([t]) => !input?.taskId || t === input.taskId)
            .map(([taskId, v]) => ({ taskId, runId: v.runId, status: "running", ...summarise({ live: true, progress: v.shared.progress, logs: v.shared.logs }) })) : []
          const dir = join(home, "sessions", context.sessionID, "workflows")
          const done = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).slice(-5).map((f) => {
            const rec = JSON.parse(readFileSync(join(dir, f), "utf8"))
            return { taskId: rec.taskId, runId: rec.runId, workflow: rec.workflowName, status: rec.status, minutes: Math.round(rec.durationMs / 600) / 100, ...summarise(rec) }
          }) : []
          return { content: JSON.stringify({ live, recent: done }, null, 1) }
        },
      })
      editor.add({
        name: "workflow_stop",
        description: "Stop a running workflow by taskId. A stopped run sends no notification; its finished agents stay in the journal for a resume.",
        input: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"], additionalProperties: false },
        async execute(input: any, context: any) {
          const e = engines.get(context.sessionID)
          if (!e) throw new Error("no workflows in this session")
          return { content: JSON.stringify(e.stop(input.taskId)) }
        },
      })
      editor.add({
        name: "wf_submit",
        description: "Workflow agents only: submit your final structured result as {\"result\": <object matching the schema in your task>}. A rejected call says why; fix it and call again.",
        input: { type: "object", properties: { result: { description: "your result" } }, required: ["result"], additionalProperties: false },
        async execute(input: any, context: any) {
          const r = submits.submit(context.sessionID, input)
          if (!r.ok) throw new Error(r.message)
          return { content: r.message }
        },
      })
    })

    ctx.command.transform((editor: any) => {
      editor.add({
        name: "ultracode",
        description: "Switch this session to the ultra lead agent (multi-agent workflows on) and send the task",
        async execute(input: any) {
          await ctx.session.switchAgent({ sessionID: input.sessionID, agent: "ultra" })
          const text = (input.prompt ?? "").trim()
          if (text) await ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })
        },
      })
      editor.add({
        name: "ultracode-off",
        description: "Switch this session back to the build agent",
        async execute(input: any) {
          await ctx.session.switchAgent({ sessionID: input.sessionID, agent: "build" })
        },
      })
    })
  },
}
