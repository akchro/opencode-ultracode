// The OpenCode adapter and the saved harnesses, against a fake plugin ctx and fake agents.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Engine, type RunAgent } from "../src/engine.ts"
import { lastAssistantText, makeRunAgent, modelRef, SubmitRegistry } from "../src/opencode.ts"
import plugin, { addSystem, claudeMdSource } from "../src/plugin.ts"

const WF = join(import.meta.dir, "..", "workflows")

/** A fake ctx.session: each prompt runs `behave(sessionID, text, n)` which may call wf_submit through `submits`. */
function fakeCtx(behave: (sid: string, text: string, n: number, s: SubmitRegistry) => { reply?: string; outcome?: string }) {
  const sessions = new Map<string, { messages: any[]; prompts: number; created: any }>()
  let n = 0
  const submits = new SubmitRegistry()
  const calls: any[] = []
  const ctx = {
    model: { default: async () => ({ providerID: "opencode", id: "m1" }) },
    session: {
      create: async (input: any) => {
        const id = `ses_${++n}`
        sessions.set(id, { messages: [], prompts: 0, created: input })
        calls.push(["create", input])
        return { id, ...input }
      },
      prompt: async ({ sessionID, text }: any) => {
        const s = sessions.get(sessionID)!
        s.messages.push({ type: "user", text })
        const r = behave(sessionID, text, s.prompts++, submits)
        s.messages.push({ type: "assistant", content: [{ type: "text", text: r.reply ?? "" }, { type: "tool", name: "execute" }], tokens: { input: 100, output: 7, cache: { read: 50, write: 0 } }, cost: 0.001 })
        s.messages.push({ type: "idle", outcome: r.outcome ?? "succeeded" })
      },
      wait: async () => {},
      context: async ({ sessionID }: any) => sessions.get(sessionID)!.messages,
      interrupt: async (x: any) => { calls.push(["interrupt", x]) },
    },
  }
  return { ctx, submits, sessions, calls }
}

function req(over: Partial<Parameters<RunAgent>[0]> = {}): Parameters<RunAgent>[0] {
  return {
    agentId: "a1", runId: "wf_test0000-000", label: "lab", phase: "P", text: "do it", prompt: "do it",
    transcriptDir: tmpdir(), signal: new AbortController().signal, onUsage: () => {}, onTool: () => {}, ...over,
  }
}

describe("adapter", () => {
  test("text agent: child of the lead, default worker agent, reply read back", async () => {
    const f = fakeCtx(() => ({ reply: "PONG" }))
    const children = new Set<string>()
    const run = makeRunAgent({ ctx: f.ctx, leadSessionID: "ses_lead", submits: f.submits, children })
    let usage: any
    const out = await run(req({ onUsage: (u) => { usage = u } }))
    expect(out.value).toBe("PONG")
    expect(f.calls[0][1]).toMatchObject({ parentID: "ses_lead", agent: "wf-worker" })
    expect(children.has(out.sessionID!)).toBe(true)
    expect(usage).toMatchObject({ input: 100, output: 7, cacheRead: 50 })
    expect(out.tokens).toBe(157)
  })

  test("schema agent: a rejected submit is retried, the valid one is the value", async () => {
    const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }
    const f = fakeCtx((sid, _t, _n, s) => {
      expect(s.submit(sid, { result: { answer: "forty-two" } }).ok).toBe(false)
      expect(s.submit(sid, { result: { answer: 42 } }).ok).toBe(true)
      return { reply: "done" }
    })
    const run = makeRunAgent({ ctx: f.ctx, leadSessionID: "L", submits: f.submits, children: new Set() })
    const out = await run(req({ schema }))
    expect(out.value).toEqual({ answer: 42 })
  })

  test("schema agent that never submits is nudged, then fails (null in the script)", async () => {
    const schema = { type: "object", properties: { a: { type: "string" } } }
    const f = fakeCtx(() => ({ reply: "forgot" }))
    const run = makeRunAgent({ ctx: f.ctx, leadSessionID: "L", submits: f.submits, children: new Set(), nudges: 2 })
    await expect(run(req({ schema }))).rejects.toThrow(/wf_submit/)
    expect([...f.sessions.values()][0].prompts).toBe(3) // the task + 2 nudges
  })

  test("a failed outcome (usage limit, provider error) is a dead agent", async () => {
    const f = fakeCtx(() => ({ reply: "", outcome: "failed" }))
    const run = makeRunAgent({ ctx: f.ctx, leadSessionID: "L", submits: f.submits, children: new Set() })
    await expect(run(req())).rejects.toThrow(/failed/)
  })

  test("owns becomes session permissions; model and effort become a Model.Ref", async () => {
    const f = fakeCtx(() => ({ reply: "ok" }))
    const run = makeRunAgent({ ctx: f.ctx, leadSessionID: "L", submits: f.submits, children: new Set() })
    await run(req({ effort: "high", permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: "src/a.ts", effect: "allow" }] }))
    expect(f.calls[0][1].permissions).toHaveLength(2)
    expect(f.calls[0][1].model).toEqual({ providerID: "opencode", id: "m1", variant: "high" })
    expect(modelRef("anthropic/claude-x#max", undefined)).toEqual({ providerID: "anthropic", id: "claude-x", variant: "max" })
  })

  test("lastAssistantText takes the last assistant's text parts, not reasoning", () => {
    expect(lastAssistantText([
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "final" }] },
      { type: "idle" },
    ])).toBe("final")
  })
})

describe("plugin", () => {
  test("registers the lead tools, wf_submit and the commands", async () => {
    const tools: any[] = []
    const commands: any[] = []
    await plugin.setup({
      options: { home: mkdtempSync(join(tmpdir(), "ucp-")) },
      location: { directory: tmpdir() },
      model: { default: async () => ({ providerID: "p", id: "m" }) },
      tool: { transform: (fn: any) => fn({ add: (t: any) => tools.push(t) }) },
      command: { transform: (fn: any) => fn({ add: (c: any) => commands.push(c) }) },
      session: {},
    })
    expect(tools.map((t) => t.name).sort()).toEqual(["wf_submit", "workflow", "workflow_status", "workflow_stop"])
    expect(commands.map((c) => c.name).sort()).toEqual(["ultracode", "ultracode-off"])
    for (const t of tools) expect(t.input.type).toBe("object")
  })

  test("/ultracode switches the agent and forwards the task, whatever shape the prompt comes in", async () => {
    const commands: any[] = []
    const calls: any[] = []
    await plugin.setup({
      options: { home: mkdtempSync(join(tmpdir(), "ucp-")) },
      location: { directory: tmpdir() },
      model: { default: async () => ({ providerID: "p", id: "m" }) },
      tool: { transform: () => {} },
      command: { transform: (fn: any) => fn({ add: (c: any) => commands.push(c) }) },
      session: {
        switchAgent: async (x: any) => { calls.push(["switch", x]) },
        prompt: async (x: any) => { calls.push(["prompt", x]) },
      },
    })
    const ultracode = commands.find((c) => c.name === "ultracode")
    const files = [{ type: "file", path: "a.ts" }]
    // OpenCode 2.0.32: a draft object (this shape threw "(input.prompt ?? "").trim is not a function" before the fix)
    await ultracode.execute({ sessionID: "s1", prompt: { text: "  review my diff  ", files, agents: [], skills: [] }, delivery: "queue" })
    await ultracode.execute({ sessionID: "s2", prompt: { prompt: { text: "nested draft" } } })
    await ultracode.execute({ sessionID: "s3", prompt: "plain string" })
    await ultracode.execute({ sessionID: "s4", prompt: { text: "   " } })
    expect(calls.filter((c) => c[0] === "switch").map((c) => c[1])).toEqual(
      ["s1", "s2", "s3", "s4"].map((sessionID) => ({ sessionID, agent: "ultra" })))
    const prompts = calls.filter((c) => c[0] === "prompt").map((c) => c[1])
    expect(prompts).toEqual([
      { sessionID: "s1", text: "review my diff", files, delivery: "queue" },
      { sessionID: "s2", text: "nested draft", delivery: undefined },
      { sessionID: "s3", text: "plain string", delivery: undefined },
    ])
  })
})

describe("CLAUDE.md compatibility", () => {
  const { mkdirSync, writeFileSync } = require("node:fs")
  test("a project with CLAUDE.md and no AGENTS.md gets it; AGENTS.md here or in a parent wins", async () => {
    const root = mkdtempSync(join(tmpdir(), "ucm-"))
    const proj = join(root, "proj")
    mkdirSync(proj)
    writeFileSync(join(proj, "CLAUDE.md"), "Playtest with AcHeadless.")
    const src = claudeMdSource(proj, root)!
    expect(src()).toContain("Playtest with AcHeadless.")
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(proj, "CLAUDE.md"), "Changed rules.")
    expect(src()).toContain("Changed rules.")
    writeFileSync(join(root, "AGENTS.md"), "parent agents")
    expect(claudeMdSource(proj, tmpdir())).toBeNull()
    const proj2 = join(root, "proj2")
    mkdirSync(proj2)
    expect(claudeMdSource(proj2, root)).toBeNull() // no CLAUDE.md at all
  })

  test("the context hook appends the block whatever shape the system prompt has", () => {
    const a: any = { system: ["base"] }
    addSystem(a, "X")
    expect(a.system).toEqual(["base", "X"])
    const b: any = { system: "base" }
    addSystem(b, "X")
    expect(b.system).toBe("base\n\nX")
    const c: any = { system: [{ type: "text", text: "base", cache: true }] }
    addSystem(c, "X")
    expect(c.system[1]).toEqual({ type: "text", text: "X", cache: true })
    const d: any = {}
    addSystem(d, "X")
    expect(d.system).toEqual(["X"])
  })

  test("the plugin registers the hook only for a CLAUDE.md project", async () => {
    const proj = mkdtempSync(join(tmpdir(), "ucq-"))
    writeFileSync(join(proj, "CLAUDE.md"), "rules")
    const hooks: any[] = []
    const base = (dir: string) => ({
      options: { home: mkdtempSync(join(tmpdir(), "ucp-")) }, location: { directory: dir },
      model: { default: async () => ({ providerID: "p", id: "m" }) },
      tool: { transform: () => {} }, command: { transform: () => {} },
      session: { hook: (name: string, fn: any) => hooks.push([name, fn]) },
    })
    await plugin.setup(base(proj))
    expect(hooks.map((h) => h[0])).toEqual(["context"])
    const ev: any = { system: ["s"] }
    hooks[0][1](ev)
    expect(ev.system[1]).toContain("rules")
    hooks.length = 0
    await plugin.setup(base(mkdtempSync(join(tmpdir(), "ucr-"))))
    expect(hooks.length).toBe(0)
  })
})

describe("saved harnesses", () => {
  function fakeAgents(byLabel: (label: string, agentType?: string) => unknown) {
    const seen: Array<{ label: string; agentType?: string; prompt: string }> = []
    const run: RunAgent = async (r) => {
      seen.push({ label: r.label, agentType: r.agentType, prompt: r.prompt })
      return { value: byLabel(r.label, r.agentType) }
    }
    return { run, seen }
  }
  const launch = async (run: RunAgent, input: any) => {
    const e = new Engine({ home: mkdtempSync(join(tmpdir(), "uch-")), sessionID: "s", runAgent: run, notify: () => {}, registryDirs: () => [WF] })
    const r = e.launch(input)
    return e.live.get(r.taskId)!.promise
  }

  test("adversarial-audit with a plain string: default lenses, high/medium verified, lows unverified, consolidated", async () => {
    const { run, seen } = fakeAgents((label) => {
      if (label.startsWith("audit:")) return { findings: [{ title: "bug " + label, severity: "high", evidence: "x.ts:1", fix: "f" }, { title: "nit", severity: "low", evidence: "e", fix: "f" }], checked: "ok" }
      if (label.startsWith("verify:")) return { real: !label.includes("tests"), reason: "r", fix: "f" }
      if (label === "consolidate") return { fixes: [{ title: "t", severity: "high", rootCause: "c", fix: "f", sources: ["a"] }], notes: "" }
    })
    const rec = await launch(run, { name: "adversarial-audit", args: "Review the uncommitted diff of src/x.ts" })
    expect(rec.status).toBe("completed")
    expect(seen.filter((s) => s.label.startsWith("audit:")).length).toBe(3)
    expect(seen.every((s) => s.agentType === "wf-reviewer")).toBe(true)
    expect(rec.result.confirmed.length).toBe(2)
    expect(rec.result.refuted.length).toBe(1)
    expect(rec.result.unverified.length).toBe(3)
    expect(rec.result.fixes.length).toBe(1)
  })

  test("adversarial-audit light mode: one reviewer, nothing verified", async () => {
    const { run, seen } = fakeAgents(() => ({ findings: [{ title: "a", severity: "medium", evidence: "e", fix: "f" }], checked: "c" }))
    const rec = await launch(run, { name: "adversarial-audit", args: { context: "docs change", light: true } })
    expect(seen.length).toBe(1)
    expect(rec.result.unverified.length).toBe(1)
  })

  test("the example scripts in agents/ultra.md load and run", async () => {
    const md = await Bun.file(join(import.meta.dir, "..", "agents", "ultra.md")).text()
    const blocks = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1])
    expect(blocks.length).toBe(2)
    const { run, seen } = fakeAgents((label) => {
      if (label.startsWith("audit:")) return { findings: [{ file: "a.ts", severity: "high", claim: "c", scenario: "s" }] }
      if (label.startsWith("verify:") && label.includes(".ts")) return { real: true, evidence: "e" }
      if (label.startsWith("trace:")) return { rules: [{ rule: "r", where: "x.cs:1" }] }
      if (label.startsWith("verify:")) return { wrong: [], corrected: [] }
      return "no gaps"
    })
    const review = await launch(run, { script: blocks[0] })
    expect(review.status).toBe("completed")
    expect(review.result.confirmed.length).toBe(2)
    const research = await launch(run, { script: blocks[1] })
    expect(research.status).toBe("completed")
    expect(research.result.topics.map((t: any) => t.key)).toEqual(["connections", "placement"])
    expect(research.result.gaps).toBe("no gaps")
    expect(seen.filter((s) => s.label.startsWith("trace:")).every((s) => s.agentType === undefined)).toBe(true)
  })

  test("live-verify: the operator runs the checks, the judge can overturn a pass, blocked and dead operators", async () => {
    const checks = [
      { key: "spawn", how: "start Play, read the spawn position", expect: "player spawns within 5 studs of SpawnPad" },
      { key: "errors", how: "read the console for 20 s", expect: "no errors" },
    ]
    const report = (over: any = {}) => ({
      blocked: "", consoleErrors: [], restored: true, notes: "",
      checks: [
        { key: "spawn", pass: true, measured: "2.1 studs", evidence: "Players.x.Character position vs SpawnPad.Position" },
        { key: "errors", pass: true, measured: "looks fine", evidence: "" },
      ], ...over,
    })
    let a = fakeAgents((label) => label === "operate" ? report() : { verdicts: [{ key: "spawn", agree: true, reason: "measured" }, { key: "errors", agree: false, reason: "no evidence" }] })
    let rec = await launch(a.run, { name: "live-verify", args: { context: "brick placement change", checks } })
    expect(rec.status).toBe("completed")
    expect(a.seen.map((s) => [s.label, s.agentType])).toEqual([["operate", "wf-operator"], ["judge", "wf-reviewer"]])
    expect(rec.result.status).toBe("fail")
    expect(rec.result.checks.map((c: any) => c.status)).toEqual(["pass", "pass claimed, judge disagrees"])

    a = fakeAgents(() => report({ blocked: "a playtest is running" }))
    rec = await launch(a.run, { name: "live-verify", args: { context: "c", checks } })
    expect(rec.result.status).toBe("blocked")
    expect(a.seen.length).toBe(1)

    a = fakeAgents(() => null)
    rec = await launch(a.run, { name: "live-verify", args: { context: "c", checks } })
    expect(rec.result.status).toBe("failed")

    a = fakeAgents((label) => label === "operate" ? report({ checks: [{ key: "spawn", pass: true, measured: "1", evidence: "e" }] }) : { verdicts: [{ key: "spawn", agree: true, reason: "ok" }] })
    rec = await launch(a.run, { name: "live-verify", args: { context: "c", checks, judge: true } })
    expect(rec.result.status).toBe("partial")
  })

  test("live-verify: driven checks reach the operator and the judge; a check with no steps is refused", async () => {
    const check = {
      key: "boost", setup: ["AcHeadless = true in Edit before Play", "AcDebug mech Light"],
      steps: ["AcVirtualKeys = 'Boost,Forward' for 2 s", "clear AcVirtualKeys"],
      observe: "AcSpeedKmh every frame", expect: "peak AcSpeedKmh 370-386",
    }
    const a = fakeAgents((label) => label === "operate"
      ? { blocked: "", consoleErrors: [], restored: true, notes: "", checks: [{ key: "boost", pass: true, measured: "peak 377.9", evidence: "recorder", driven: "AcVirtualKeys Boost,Forward 2.0 s", timeline: "0.5: 210, 1.0: 377.9" }] }
      : { verdicts: [{ key: "boost", agree: true, reason: "timeline shows it" }] })
    const rec = await launch(a.run, { name: "live-verify", args: { context: "ac-combat boost change", harness: "AcHeadless, AcVirtualKeys, AcDebug", bringToFront: true, checks: [check] } })
    expect(rec.result.status).toBe("pass")
    expect(rec.result.checks[0].driven).toContain("AcVirtualKeys")
    const op = a.seen.find((s) => s.label === "operate")!.prompt
    expect(op).toContain("SETUP: 1) AcHeadless = true in Edit before Play  2) AcDebug mech Light")
    expect(op).toContain("STEPS: 1) AcVirtualKeys = 'Boost,Forward' for 2 s")
    expect(op).toContain("OBSERVE: AcSpeedKmh every frame")
    expect(op).toContain("Test harness (from the lead): AcHeadless, AcVirtualKeys, AcDebug")
    expect(op).toContain("front: allowed")
    const jp = a.seen.find((s) => s.label === "judge")!.prompt
    expect(jp).toContain("DROVE: AcVirtualKeys Boost,Forward 2.0 s")
    expect(jp).toContain("TIMELINE: 0.5: 210")

    const b = fakeAgents(() => null)
    const bad = await launch(b.run, { name: "live-verify", args: { context: "c", checks: [{ key: "x", expect: "y" }] } })
    expect(bad.status).toBe("failed")
    expect(bad.error).toContain("needs steps")
  })

  test("design-panel loads, and refuses a missing brief inside the run", async () => {
    const { run } = fakeAgents(() => null)
    const rec = await launch(run, { name: "design-panel", args: {} })
    expect(rec.status).toBe("failed")
    expect(rec.error).toContain("args.brief")
  })
})
