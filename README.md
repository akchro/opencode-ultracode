# opencode-ultracode

Code-driven multi-agent workflows for **OpenCode 2.x**, inspired by Claude Code's ultracode mode and its `Workflow`
tool. The lead agent writes a short JavaScript program; the plugin runs it in the background, fans the work out to
child sessions with a concurrency cap, checks every structured result against a JSON Schema, journals each result for
resume, and posts a completion notice back into your session, which starts the lead's next turn.

It is the "code-driven version" of the idea: the orchestration lives in a script, not in a prompt, so fan-out,
pipelining, vote counting, severity triage and caps run exactly as written, results stay out of the lead's context,
and a run can be resumed.

## What you get

| piece | file | what it does |
|---|---|---|
| engine plugin | `src/plugin.ts` | tools `workflow`, `workflow_status`, `workflow_stop` (lead) and `wf_submit` (workflow agents); commands `/ultracode`, `/ultracode-off` |
| engine | `src/engine.ts`, `src/core.ts`, `src/sandbox.ts` | `agent` / `parallel` / `pipeline` / `phase` / `log` / `workflow` / `args` / `budget`, FIFO limiter, chained cache keys, journal, run record, notification |
| OpenCode adapter | `src/opencode.ts` | one child session per `agent()` call, results through `wf_submit`, ownership as session permissions |
| lead agent | `agents/ultra.md` | the authoring reference, when to fan out, the loop around a workflow |
| workflow agents | `agents/wf-worker.md`, `agents/wf-reviewer.md` | hidden subagents; no sub-subagents, no questions, no git state changes, no live-system tools; the reviewer cannot edit |
| live operator | `agents/wf-operator.md` | the only agent type allowed live-system tools (Roblox Studio's MCP): preflight, run the checks, restore, report measured values |
| saved workflows | `workflows/adversarial-audit.js`, `workflows/design-panel.js`, `workflows/live-verify.js` | the two harnesses used most in the Claude Code history this is based on, and a live check: one operator runs your checks, a read-only judge rejects passes without evidence |
| CLAUDE.md support | `src/plugin.ts` | a project with a CLAUDE.md and no AGENTS.md gets its CLAUDE.md added to every model request (OpenCode 2 reads AGENTS.md only); plugin option `claudeMd: false` turns it off |

## Install

```powershell
.\install.ps1                 # Windows; add -DefaultAgent to make ultra the default agent everywhere
powershell -ExecutionPolicy Bypass -File .\install.ps1   # if running local scripts is disabled
```

```sh
./install.sh                  # macOS / Linux; --default-agent, --uninstall
```

Then restart the OpenCode background service so it loads the plugin: `opencode service restart`.

## Use

- **Per session:** type `/ultracode <task>` (switches the session to the `ultra` agent and sends the task), or press
  Tab to the `ultra` agent. `/ultracode-off` switches back to `build`.
- **Everywhere:** install with `-DefaultAgent` (sets `"default_agent": "ultra"`).
- **A saved workflow:** ask the lead, e.g. "audit the uncommitted diff", and it calls
  `workflow({ name: "adversarial-audit", args: { context: "..." } })`. Auditor lenses default to correctness,
  state and edge cases, tests and integration; pass `auditors: [{ key, prompt }]` to choose your own, `light: true`
  for a UI- or doc-only change.

The lead decides on its own when to fan out, per phase of a task (`agents/ultra.md`, "When to fan out, when not"):
reading a lot first (a large or unfamiliar codebase, decompiled or reference source: roughly over 10 files or 3,000
lines) gets a research workflow even when the work after it is a live-tool loop; reviews, research with many
questions, builds that split by file, item-scale production and open design choices get workflows; small corrections
to code it already understands, questions and the live-tool tuning loop itself stay solo. Research notes go to
`.ultracode/notes/` in the project.

### Script API (what the lead writes)

```js
export const meta = { name: 'review-changes', description: 'Review the diff, verify each serious finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }] }            // a pure literal
const results = await pipeline(LENSES,
  (l) => agent(prompt(l), { label: `audit:${l.key}`, phase: 'Review', schema: FINDINGS, agentType: 'wf-reviewer' }),
  (r) => parallel(r.findings.filter((f) => f.severity !== 'low').map((f) => () =>
    agent(refute(f), { label: 'verify', phase: 'Verify', schema: VERDICT, agentType: 'wf-reviewer' }))))
return { results }
```

`agent()` options: `label`, `phase`, `schema`, `agentType` (any subagent; default `wf-worker`), `model`
(`provider/model#variant`), `effort` (a model variant name), `owns` (project-relative paths or globs: every other edit
is denied by permission), `readOnly`, `permissions` (raw rules), `exclusive` (a lock name: agents with the same name run
one at a time across all runs; give it to every agent that drives a live system). `Date.now()` and `Math.random()` throw (resume).

### How it maps onto Claude Code

| Claude Code | here |
|---|---|
| ultracode session mode / keyword | the `ultra` agent: `default_agent`, Tab, or `/ultracode` |
| `Workflow` tool, background, `<task-notification>` | `workflow` tool, background, `<workflow-notification>` posted as a synthetic message that starts the lead's turn |
| subagent StructuredOutput tool | `wf_submit`, validated against the call's schema; a rejected call says why and the agent retries |
| `min(16, CPUs - 2)` concurrent agents per run | 6 per run by default (plugin option `slots`) |
| journal + chained cache keys + `resumeFromRunId` | the same formula and semantics: only the unchanged prefix of calls replays |
| ownership written into prompts | `owns` / `readOnly` enforced as session permission rules |
| one Studio operator, a hand-written promise-chain mutex | `agentType: 'wf-operator'` with `exclusive: 'studio'`: a built-in lock shared by every run, so one agent drives the live system at a time |
| saved workflows in `.claude/workflows/` | `~/.config/opencode/workflows/` and `<project>/.opencode/workflows/`, re-read at every launch |

Run records, journals and outputs are kept under `~/.local/share/opencode/ultracode/sessions/<sessionID>/`.

## Verified on OpenCode 2.0.32 (Windows, the bundled CLI)

Probes (`probes/`), each a real run with the default model:

| probe | finding |
|---|---|
| plugin API | v2 plugins default-export `{ id, setup(ctx) }`; tools via `ctx.tool.transform`; the v1 shape does not load |
| child sessions | `ctx.session.create({ parentID, agent })`, `prompt`, `wait`, `context` give a child run and its reply (3.1 s round trip) |
| structured output | no `format` field on 2.x prompts: a `wf_submit` tool that throws on a bad shape makes the model fix and resubmit |
| long tool calls | a 4-minute tool call and a 10-minute one completed |
| notification | `ctx.session.synthetic({ resume: true })` into an idle session starts a turn |
| concurrency | four child sessions at once: 8.6 s wall for 14.2 s of work |
| ownership | session permission rules deny edits; resources match project-relative paths |
| worker isolation | a permission deny on a plugin tool's name removes it from a worker's catalog: `wf-worker` cannot call `workflow` |
| engine on real sessions | 10 agents in 2.5 min: text and schema results, a chained 3-item pipeline, FIFO queueing, the notification waking the lead |
| end to end | "Review my uncommitted change in this repo for bugs." to `ultra` on the default model (MiniMax M3.1 Flash Free): it scouted, proved the 5 seeded bugs with its own Deno harness, launched a 31-agent review (5 lenses, a skeptic per high/medium finding: 26 verified, 24 confirmed, 2 refuted, 18.7 min), built and tested a fix meanwhile, was woken by the notification, read the full result from the output file and reported a verified patch. Fixes it prompted: OpenCode's temp dir as a readable root, scripts inline, no status polling |

Tests: `bun test` (the CLI's embedded Bun works: `BUN_BE_BUN=1 opencode-cli test`): the engine's conformance suite
(resume prefix, null semantics, FIFO, kills, refusals, nesting, budget, neutralisation, the 8,000-character cut,
string args), the adapter against a fake `ctx`, plugin registration and both harnesses.

## Live testing

Builds and fixes that change what the running game or app does end with a live check by ONE operator agent
(`agentType: 'wf-operator'`, `exclusive: 'studio'`), usually through the saved workflow:

```js
workflow({ name: 'live-verify', args: {
  context: 'What changed; the Studio place (name or placeId); the Rojo-synced files',
  harness: 'AcHeadless (Edit, before Play); AcVirtualKeys = held actions; state in Player attributes',
  checks: [{
    key: 'boost',
    setup: ['AcHeadless = true in Edit, then Play', 'wait for the mech in the world'],
    steps: ["AcVirtualKeys = 'Boost,Forward' for 2.5 s", 'clear AcVirtualKeys'],
    observe: 'a Client Heartbeat recorder of AcSpeedKmh and AcEN',
    expect: 'peak AcSpeedKmh within 2 % of the class boost speed; AcEN falls',
  }],
  bringToFront: false,   // true lets the operator raise Studio's window for real input / screenshots
} })
```

The operator PLAYS each check the way Claude Code did in these projects: it learns the game's test harness from
AGENTS.md / CLAUDE.md and the user's Claude Code notes for the project, puts the game in the state the check needs
through the game's own hooks (headless switches set in Edit before Play, debug attributes such as `BH_DebugZone`,
debug calls such as `AcDebug:Invoke`), drives it with the game's virtual input (`AcVirtualKeys`) or real input
(`user_keyboard_input`, `user_mouse_input` on GUI paths or world points), records state over time with a client
Heartbeat recorder, and compares numbers. It checks Studio's state first and reports `blocked` instead of stopping a
playtest you are in; it releases every input, clears what it set and stops its playtest; the judge turns a pass with
no evidence, or a static read where the check needed input, into a failure. Real input and screenshots need Studio's
viewport rendering: with `bringToFront: true` the operator runs `tools/studio-front.ps1` to raise the window. Workers and reviewers cannot see the Studio tools (`roblox-studio_*` is denied in their agent files: add a
line per other live-system MCP server you use). While an operator holds the lock, `workflow_status` shows it under
`locks`.

## Limits

- `node:vm` is a determinism guard, not a sandbox: scripts are written by your own lead agent.
- Runs live in the OpenCode server process: restarting the service kills running workflows (resume them from the
  journal with `{ scriptPath, resumeFromRunId }`).
- The lead only sees a run's result when the notification arrives; `workflow_status` shows progress meanwhile.
- `effort` maps to a model variant; variant names depend on the provider and model.

## License

MIT, see [LICENSE](LICENSE).
