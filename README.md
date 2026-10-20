# opencode-ultracode

Code-driven multi-agent workflows for **OpenCode 2.x**, modelled on Claude Code's ultracode mode and its `Workflow`
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
| workflow agents | `agents/wf-worker.md`, `agents/wf-reviewer.md` | hidden subagents; no sub-subagents, no questions, no git state changes; the reviewer cannot edit |
| saved workflows | `workflows/adversarial-audit.js`, `workflows/design-panel.js` | the two harnesses used most in the Claude Code history this is based on |

## Install

```powershell
.\install.ps1                 # Windows; add -DefaultAgent to make ultra the default agent everywhere
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

The lead decides on its own when to fan out (`agents/ultra.md`, "When to fan out, when not"): reviews, research with
many questions, builds that split by file, item-scale production and open design choices get workflows;
corrections, small fixes, questions and live-tool loops stay solo.

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
is denied by permission), `readOnly`, `permissions` (raw rules). `Date.now()` and `Math.random()` throw (resume).

### How it maps onto Claude Code

| Claude Code | here |
|---|---|
| ultracode session mode / keyword | the `ultra` agent: `default_agent`, Tab, or `/ultracode` |
| `Workflow` tool, background, `<task-notification>` | `workflow` tool, background, `<workflow-notification>` posted as a synthetic message that starts the lead's turn |
| subagent StructuredOutput tool | `wf_submit`, validated against the call's schema; a rejected call says why and the agent retries |
| `min(16, CPUs - 2)` concurrent agents per run | 6 per run by default (plugin option `slots`) |
| journal + chained cache keys + `resumeFromRunId` | the same formula and semantics: only the unchanged prefix of calls replays |
| ownership written into prompts | `owns` / `readOnly` enforced as session permission rules |
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

## Limits

- `node:vm` is a determinism guard, not a sandbox: scripts are written by your own lead agent.
- Runs live in the OpenCode server process: restarting the service kills running workflows (resume them from the
  journal with `{ scriptPath, resumeFromRunId }`).
- The lead only sees a run's result when the notification arrives; `workflow_status` shows progress meanwhile.
- `effort` maps to a model variant; variant names depend on the provider and model.
