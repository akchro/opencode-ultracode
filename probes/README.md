# Probes

Small real runs that pinned down how OpenCode 2.0.32 behaves before the engine was built on it. Each runs a private
server (`opencode run --standalone`) in `probes/ws`, so the background service is not touched, and a plugin drives the
steps itself (no model orchestrating) and writes its findings to `probes/out/` (gitignored).

| file | what it does |
|---|---|
| `ws/.opencode/plugins/probe.ts.off` | P1-P8 (rename to `.ts` and run with `OC_PROBE=1`) |
| `ws/.opencode/plugins/l1-driver.ts` | L1: the real engine and adapter on real child sessions (`OC_L1=1`) |
| `ws/.opencode/agents/wf-probe.md` | a locked-down test worker (no shell, web, subagents or questions) |
| `e2e/` | created by hand for the end-to-end test: a scratch repo with a buggy uncommitted change |

Keep a run alive while a plugin works in the background: the triggering session calls a sleep tool.

```sh
cd probes/ws
OC_L1=1 opencode-cli run --standalone --agent wf-probe "Call the tool probe_sleep with {\"seconds\": 900}."
```

## Findings (2026-10-19)

| probe | result |
|---|---|
| P1 plugin shape | `export const X = async (input) => ({ tool })` (v1) fails: "Plugin must export a default definition with an id and an effect or setup function". v2: `export default { id, setup(ctx) }`, tools through `ctx.tool.transform(editor => editor.add({ name, description, input, execute }))`. A tool's `execute(input, context)` gets `sessionID, agent, messageID, id, progress, signal`. |
| P2 child session | `ctx.session.create({ parentID, agent })` then `prompt`, `wait`, `context`: reply read back in 3.1 s; the child records its `parentID`. Messages are `{ type: "user" | "assistant" | "idle", ... }`; assistant `content` holds `reasoning`, `text` and `tool` parts. |
| P3 structured result | 2.x prompts have no `format` field. A `wf_submit` tool that throws on a bad shape: the model read the error and resubmitted (1 reject, then `{ answer: 42 }`). Plugin tools are called through Code Mode (`execute` with `tools.<name>()`). |
| P4 long tool call | 240 s tool call completed (246 s round trip); the trigger's 600 s call too. |
| P5 notification | `ctx.session.synthetic({ sessionID, text, resume: true })` into an idle session started a model turn. |
| P6 ownership | session `permissions` deny edits; the allow rule must use a project-relative path (`owned/*`): an absolute path matched nothing (both writes refused). L1 confirmed: `owned/x.txt` written, `other/y.txt` refused ("Permission denied: edit"). |
| P7 concurrency | four child sessions at once: 8.6 s wall for 14.2 s of work. |
| P8 | `ctx.session.list` does not exist on 2.0.32. |
| L1 engine | 10 agents, 2.5 min: text and schema agents, a 3-item two-stage pipeline (values chained), FIFO queueing at 3 slots, ownership by permission, the `workflow` tool absent from a `wf-worker` (a permission deny on a plugin tool's name removes it from the catalog), and the notification woke the lead ("NOTIFIED completed"). |
| default model | `opencode/minimax-m3.1-flash-free` (the DeepSeek provider is signed in but not the default). |
