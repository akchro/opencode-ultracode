// The OpenCode 2.x adapter: runAgent as a child session of the lead, structured results through the wf_submit tool,
// and the reply text read back from the session's messages. Everything OpenCode-specific lives here; the engine
// (engine.ts) only sees the RunAgent seam.
import { TerminalAgentError, validate } from "./core.ts"
import type { AgentOutcome, AgentRequest, RunAgent } from "./engine.ts"

/** Child sessions that owe a structured result, by session ID. */
export class SubmitRegistry {
  private m = new Map<string, { schema: Record<string, any>; value?: unknown; done: boolean; rejects: number }>()
  expect(sessionID: string, schema: Record<string, any>) {
    this.m.set(sessionID, { schema, done: false, rejects: 0 })
  }
  has(sessionID: string) {
    return this.m.has(sessionID)
  }
  get(sessionID: string) {
    return this.m.get(sessionID)
  }
  forget(sessionID: string) {
    this.m.delete(sessionID)
  }
  /** What the wf_submit tool does: validate, store, or explain the rejection so the model can retry. */
  submit(sessionID: string, input: any): { ok: true; message: string } | { ok: false; message: string } {
    const e = this.m.get(sessionID)
    if (!e) return { ok: false, message: "No structured result is expected from this session: answer in plain text instead." }
    let result = input?.result
    if (typeof result === "string") {
      try {
        result = JSON.parse(result)
      } catch (err) {
        e.rejects++
        return { ok: false, message: `result could not be parsed as JSON (${(err as Error).message}); pass an object.` }
      }
    }
    const err = validate(result, e.schema)
    if (err) {
      e.rejects++
      return { ok: false, message: err + ". Fix the shape and call wf_submit again." }
    }
    e.value = result
    e.done = true
    return { ok: true, message: "Result accepted. End your turn now with one short line; nothing else is read." }
  }
}

/** One registry per process, keyed by child session ID: every plugin instance (one per project location) and the wf_submit
 *  tool see the same expectations. */
export const sharedSubmits: SubmitRegistry = ((globalThis as any).__ultracodeSubmits ??= new SubmitRegistry())

/** "provider/model#variant" -> a Model.Ref; effort becomes the variant (OpenCode's reasoning-effort knob). */
export function modelRef(model: string | undefined, effort: string | undefined, fallback?: { providerID: string; id: string }) {
  let ref: { providerID: string; id: string; variant?: string } | undefined
  if (model) {
    const [main, variant] = model.split("#")
    const slash = main.indexOf("/")
    if (slash > 0) ref = { providerID: main.slice(0, slash), id: main.slice(slash + 1), ...(variant ? { variant } : {}) }
  }
  if (!ref && effort && fallback) ref = { providerID: fallback.providerID, id: fallback.id }
  if (ref && effort && !ref.variant) ref.variant = effort
  return ref
}

type Message = { type: string; text?: string; outcome?: string; error?: unknown; content?: Array<Record<string, any>>; tokens?: Record<string, any>; cost?: number }

export function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type !== "assistant") continue
    const texts = (m.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string)
    if (texts.length) return texts.join("\n").trim()
  }
  return ""
}

function lastOutcome(messages: Message[]): { outcome?: string; error?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === "idle" || m.outcome) return { outcome: m.outcome, error: m.error ? JSON.stringify(m.error) : undefined }
  }
  return {}
}

function usageOf(messages: Message[]) {
  const u = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let finalContext = 0
  let toolCalls = 0
  for (const m of messages) {
    if (m.type !== "assistant") continue
    const t = m.tokens ?? {}
    u.input += t.input ?? 0
    u.output += t.output ?? 0
    u.reasoning += t.reasoning ?? 0
    u.cacheRead += t.cache?.read ?? 0
    u.cacheWrite += t.cache?.write ?? 0
    u.cost += m.cost ?? 0
    finalContext = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + (t.output ?? 0)
    toolCalls += (m.content ?? []).filter((c) => c.type === "tool").length
  }
  return { u, finalContext, toolCalls }
}

export type AdapterOptions = {
  ctx: any
  leadSessionID: string
  submits: SubmitRegistry
  /** agent used when a script passes no agentType */
  defaultAgent?: string
  /** how many times a schema agent that ended without wf_submit is told to call it */
  nudges?: number
  /** session IDs created for this lead, so the plugin can tell workflow children apart */
  children: Set<string>
}

export function makeRunAgent(o: AdapterOptions): RunAgent {
  const { ctx } = o
  return async (req: AgentRequest): Promise<AgentOutcome> => {
    let fallback: { providerID: string; id: string } | undefined
    if (req.effort && !req.model) {
      try {
        const d = await ctx.model.default()
        const m = d?.data ?? d
        if (m?.providerID && (m?.id || m?.modelID)) fallback = { providerID: m.providerID, id: m.id ?? m.modelID }
      } catch {}
    }
    const model = modelRef(req.model, req.effort, fallback)
    const created = await ctx.session.create({
      parentID: o.leadSessionID,
      title: `${req.label} (${req.runId})`,
      agent: req.agentType ?? o.defaultAgent ?? "wf-worker",
      ...(model ? { model } : {}),
      ...(req.permissions ? { permissions: req.permissions } : {}),
    })
    const sid: string = created?.id ?? created?.data?.id
    if (!sid) throw new TerminalAgentError("could not create a child session")
    o.children.add(sid)
    if (req.schema) o.submits.expect(sid, req.schema)
    const onAbort = () => {
      ctx.session.interrupt({ sessionID: sid, continue: false }).catch(() => {})
    }
    req.signal.addEventListener("abort", onAbort, { once: true })
    try {
      await ctx.session.prompt({ sessionID: sid, text: req.text })
      await ctx.session.wait({ sessionID: sid })
      let messages: Message[] = await ctx.session.context({ sessionID: sid })
      let left = o.nudges ?? 2
      while (req.schema && !o.submits.get(sid)?.done && left-- > 0 && !req.signal.aborted) {
        const { outcome } = lastOutcome(messages)
        if (outcome && outcome !== "succeeded") break
        await ctx.session.prompt({
          sessionID: sid,
          text: "[Workflow harness] You ended without calling wf_submit. Call wf_submit now with {\"result\": ...} matching the schema in your task.",
        })
        await ctx.session.wait({ sessionID: sid })
        messages = await ctx.session.context({ sessionID: sid })
      }
      if (req.signal.aborted) throw new Error("aborted")
      const { u, finalContext, toolCalls } = usageOf(messages)
      req.onUsage(u)
      const { outcome, error } = lastOutcome(messages)
      if (req.schema) {
        const e = o.submits.get(sid)
        if (!e?.done) throw new TerminalAgentError(outcome && outcome !== "succeeded" ? `agent ended: ${outcome} ${error ?? ""}`.trim() : "ended without calling wf_submit")
        return { value: e.value, tokens: finalContext, toolCalls, sessionID: sid }
      }
      if (outcome && outcome !== "succeeded") throw new TerminalAgentError(`agent ended: ${outcome} ${error ?? ""}`.trim())
      return { value: lastAssistantText(messages), tokens: finalContext, toolCalls, sessionID: sid }
    } finally {
      req.signal.removeEventListener("abort", onAbort)
      o.submits.forget(sid)
    }
  }
}

/** The last human message of the lead session: the user request relayed to every workflow agent. */
export async function lastUserText(ctx: any, sessionID: string): Promise<string | null> {
  try {
    const messages: Message[] = await ctx.session.context({ sessionID })
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === "user" && typeof m.text === "string" && !m.text.startsWith("<workflow-notification")) return m.text
    }
  } catch {}
  return null
}
