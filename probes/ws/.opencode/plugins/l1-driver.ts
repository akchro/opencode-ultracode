// L1: the real engine + adapter on real OpenCode child sessions, driven without a lead model. Runs only when OC_L1=1.
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Engine } from "C:/dev/opencode-ultracode/src/engine.ts"
import { lastAssistantText, makeRunAgent, sharedSubmits } from "C:/dev/opencode-ultracode/src/opencode.ts"

const OUT = "C:/dev/opencode-ultracode/probes/out"
const WS = "C:/dev/opencode-ultracode/probes/ws"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SCRIPT = `export const meta = { name: 'l1', description: 'live engine test', phases: [{ title: 'Fan' }, { title: 'Chain' }] }
const SCHEMA = { type: 'object', properties: { word: { type: 'string' }, n: { type: 'number' } }, required: ['word', 'n'] }
const fan = await parallel([
  () => agent('Reply with exactly the word ALPHA and nothing else.', { label: 'text:alpha', phase: 'Fan' }),
  () => agent('Your result is the word "beta" and the number 2.', { label: 'schema:beta', phase: 'Fan', schema: SCHEMA }),
  () => agent('Use your file write tool to create owned/x.txt (relative to the project folder) containing x, then try to create other/y.txt containing y. Report which of the two writes succeeded.', { label: 'owns', phase: 'Fan', owns: ['owned/*'] }),
  () => agent('Call the tool named workflow with input {"script": "x"} and report exactly what happened, quoting any error.', { label: 'recursion', phase: 'Fan' }),
])
log('fan done: ' + fan.map((x) => (x === null ? 'null' : 'ok')).join(','))
const chain = await pipeline([1, 2, 3],
  (i) => agent('Your result is the word "item' + i + '" and the number ' + i + '.', { label: 'stage1:' + i, phase: 'Chain', schema: SCHEMA }),
  (r, i) => agent('The previous step returned ' + JSON.stringify(r) + '. Your result is the word "checked' + i + '" and that number times 10.', { label: 'stage2:' + i, phase: 'Chain', schema: SCHEMA }))
return { fan, chain }
`

export default {
  id: "l1-driver",
  async setup(ctx: any) {
    ctx.tool.transform((editor: any) => {
      editor.add({
        name: "probe_sleep",
        description: "Waits the given number of seconds, then returns.",
        input: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"], additionalProperties: false },
        async execute(input: any, context: any) {
          const ms = Math.min(900, Number(input?.seconds) || 1) * 1000
          const t = Date.now()
          while (Date.now() - t < ms && !context?.signal?.aborted) await sleep(2000)
          return { content: `slept ${(Date.now() - t) / 1000}s` }
        },
      })
    })
    if (process.env.OC_L1 !== "1") return
    ;(async () => {
      const report: any = { steps: [] }
      const save = () => writeFileSync(`${OUT}/l1-report.json`, JSON.stringify(report, null, 1))
      try {
        const lead = await ctx.session.create({ title: "l1 lead", agent: "build" })
        const leadID = lead.id
        await ctx.session.prompt({ sessionID: leadID, text: "Reply with the word READY and nothing else." })
        await ctx.session.wait({ sessionID: leadID })
        report.steps.push({ t: "lead ready" })
        save()
        const notes: string[] = []
        const children = new Set<string>()
        // wf_submit is the ultracode plugin's tool; both plugins share the process-wide registry.
        const engine = new Engine({
          home: `${OUT}/l1-home`, sessionID: leadID, slots: 3,
          runAgent: makeRunAgent({ ctx, leadSessionID: leadID, submits: sharedSubmits, children }),
          notify: async (text) => {
            notes.push(text)
            await ctx.session.synthetic({ sessionID: leadID, text: text + "\n(Test: reply with the word NOTIFIED followed by the workflow's status.)", resume: true, delivery: "queue" })
          },
        })
        const t0 = Date.now()
        const r = engine.launch({ script: SCRIPT })
        report.launch = r
        save()
        const rec = await engine.live.get(r.taskId)!.promise
        report.minutes = (Date.now() - t0) / 60000
        report.record = { status: rec.status, result: rec.result, logs: rec.logs, usage: rec.usage, error: rec.error,
          agents: rec.workflowProgress.filter((p: any) => p.type === "workflow_agent").map((p: any) => ({ label: p.label, state: p.state, ms: p.durationMs, err: p.error, queuedAt: p.queuedAt, startedAt: p.startedAt })) }
        report.files = { owned: existsSync(join(WS, "owned", "x.txt")), other: existsSync(join(WS, "other", "y.txt")) }
        save()
        await sleep(3000)
        await ctx.session.wait({ sessionID: leadID })
        report.leadReply = lastAssistantText(await ctx.session.context({ sessionID: leadID }))
        report.notification = notes[0]?.slice(0, 3000)
        report.steps.push({ t: "done" })
      } catch (e: any) {
        report.fatal = String(e?.stack ?? e)
      }
      save()
    })()
  },
}
