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
| L3 driving, ac-combat | `live-verify` with driven checks on the user's mech game (9.7 min): `AcHeadless` set in Edit before Play (the game logged it), `AcVirtualKeys = "Boost,Forward"` 2.5 s with a Client Heartbeat recorder: the ground boost plateaued at 378.1 km/h (the Light's 378.15); the check failed only because the spawn is now on the sky-lobby deck and the boost ran off it (the 3-D speed then includes the fall) and because a plain boost spends no EN, both expectation errors the operator diagnosed from the code; it re-ran the boost on the Training lane through `AcDebug` for clean numbers. The stop check passed (walk 108 km/h, 0 km/h 0.33 s after release). Restored: keys cleared, `AcHeadless` removed, recorder disconnected, Play stopped; the class record only read. |
| L3 driving, Anime Clickers | `live-verify` with real clicks, `bringToFront: true` (18.8 min, both checks pass, judged): `studio-front.ps1` raised Studio (61 render frames/s); 15 real clicks on the monster, aimed after calibrating that injected clicks arrive as Touch offset (-62, -20) px; proof through the server's own `Clicks` counter 0 -> 14 (an auto clicker also kills monsters, so HP alone proves nothing); a real click on Close, then on HEROES: the shop opened on its Heroes tab. Raycasts return nil from `execute_luau`. Restored; the Studio profile changed through the autosave (accepted). |
| L2 live testing | On the user's open `brick-building.rbxl` (2026-10-20), from a temporary global driver plugin on a private server: a `wf-worker` and a `wf-reviewer` found no Roblox / Studio tool in their catalog (the `roblox-studio_*` deny works on MCP tool names). `live-verify` (9.6 min, 4 agents): the operator held the `studio` lock, ran preflight (Edit mode, no test switches, Rojo sync checked file by file with CRLF normalisation), started Play, confirmed a fresh session (DistributedGameTime 36.9 s), stopped Play and read back Edit mode with the tree as before (`restored: true`). It failed the "a Character exists" check honestly and traced why (`BuildService.luau:51` sets `CharacterAutoLoads = false`); the judge agreed with the two passes from their quoted evidence. |
