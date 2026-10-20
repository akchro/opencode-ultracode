export const meta = {
  name: 'live-verify',
  description: 'One operator plays the game to run the given checks (setup, inputs, sampling) under an exclusive lock, then a read-only judge checks every pass against its evidence',
  whenToUse: 'After a build or fix that changes behaviour visible in the running app or game: the live check at the end of a build wave, or a regression check before handover.',
  phases: [
    { title: 'Operate', detail: 'one wf-operator drives the live system: preflight, the checks, restore' },
    { title: 'Judge', detail: 'a read-only reviewer compares each claimed pass with its evidence' },
  ],
}

// Live verify: operator (exclusive) -> judge. Run with:
//   workflow({ name: "live-verify", args: { context, checks, harness?, bringToFront?, judge?, exclusive?, budgetMinutes?, agentType? } })
//   context        (string, required) what changed and why, which place / app (Roblox: place name or placeId), what
//                  is synced (Rojo: the files whose Source must match disk)
//   checks         [{ key, expect, setup?, steps?, observe?, how? }] (required) one live check each, DRIVEN the way a
//                  player would: setup = the state to put the game in first (through its test hooks), steps = the
//                  inputs in order (press / hold / click / wait), observe = what to sample while it happens, expect =
//                  what passing looks like, with numbers. how = free text instead of (or besides) the steps.
//                  A plain string is one check.
//   harness        (string) the game's test hooks if you know them (virtual input, debug attributes / calls, headless
//                  switches); the operator also reads the project's instructions and notes for them
//   bringToFront   (boolean, default false) the operator may bring Studio's window to the front (it takes the focus on
//                  the user's desktop) when real input or a screenshot needs the viewport rendering
//   judge          (boolean, default true) a read-only reviewer re-reads the evidence of every claimed pass
//   exclusive      (string, default 'studio') the lock name; every agent that drives the same system must use it
//   budgetMinutes  (number, default 15) time budget given to the operator
//   agentType      (string, default 'wf-operator')
// Returns { status: 'pass' | 'fail' | 'blocked' | 'partial' | 'failed', checks, restored, blocked, consoleErrors,
//           notes, operatorNotes }.

const A = typeof args === 'string' ? { context: args } : (args || {})
if (!A.context || typeof A.context !== 'string') throw new Error('args.context (string) is required')
let checks = A.checks
if (typeof checks === 'string') checks = [{ key: 'check', how: checks, expect: 'as described' }]
if (!Array.isArray(checks) || !checks.length) throw new Error('args.checks must be a non-empty array of { key, expect, steps | how }')
const seen = {}
for (const c of checks) {
  if (!c || typeof c.key !== 'string' || !c.key.trim()) throw new Error(`every check needs a string key (got ${JSON.stringify(c)})`)
  if (seen[c.key]) throw new Error(`duplicate check key "${c.key}"`)
  seen[c.key] = true
  if (typeof c.expect !== 'string' || !c.expect.trim()) throw new Error(`check "${c.key}" needs a string expect`)
  const hasHow = typeof c.how === 'string' && c.how.trim().length > 0
  const hasSteps = Array.isArray(c.steps) ? c.steps.length > 0 : typeof c.steps === 'string' && c.steps.trim().length > 0
  if (!hasHow && !hasSteps) throw new Error(`check "${c.key}" needs steps (the inputs to perform) or how`)
}
const judge = A.judge !== false
const exclusive = typeof A.exclusive === 'string' && A.exclusive ? A.exclusive : 'studio'
const budgetMinutes = Number(A.budgetMinutes) > 0 ? Number(A.budgetMinutes) : 15
const agentType = typeof A.agentType === 'string' && A.agentType ? A.agentType : 'wf-operator'
const harness = typeof A.harness === 'string' && A.harness.trim() ? A.harness.trim() : ''
const bringToFront = A.bringToFront === true

const REPORT = {
  type: 'object',
  properties: {
    blocked: { type: 'string', description: 'empty when the checks ran; otherwise why nothing could be checked (a playtest the user is running, not synced, wrong place open, ...)' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          pass: { type: 'boolean' },
          measured: { type: 'string', description: 'the values you observed, with units' },
          evidence: { type: 'string', description: 'how you got them: the read, the console lines, the screenshot' },
          driven: { type: 'string', description: 'the setup and inputs you actually performed, in order, and through which path (a test hook, virtual input, real input)' },
          timeline: { type: 'string', description: 'values sampled over time while it happened (time: values), when the check is about change over time' },
        },
        required: ['key', 'pass', 'measured', 'evidence', 'driven'],
      },
    },
    consoleErrors: { type: 'array', items: { type: 'string' }, description: 'errors and warnings seen during the run, verbatim' },
    restored: { type: 'boolean', description: 'true only after reading back that every input is released, every playtest you started is stopped and every switch you set is cleared' },
    notes: { type: 'string', description: 'anything the lead must know: checks you could not run and why, the hooks you found, odd behaviour, a player save that may have changed' },
  },
  required: ['blocked', 'checks', 'consoleErrors', 'restored', 'notes'],
}

const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, agree: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['key', 'agree', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const list = (v) => (Array.isArray(v) ? v.map((x, i) => `${i + 1}) ${x}`).join('  ') : String(v))
const describe = (c, i) => [
  `${i + 1}. [${c.key}]`,
  c.setup ? `   SETUP: ${list(c.setup)}` : '',
  c.steps ? `   STEPS: ${list(c.steps)}` : '',
  c.how ? `   HOW: ${c.how}` : '',
  c.observe ? `   OBSERVE: ${list(c.observe)}` : '',
  `   EXPECT: ${c.expect}`,
].filter(Boolean).join('\n')
const checkText = checks.map(describe).join('\n')

phase('Operate')
const report = await agent(`${A.context}

## Your role
You are the live-system operator for this check run (you hold the "${exclusive}" lock). Follow your protocol:
preflight (right instance, state, sync, record the test switches, learn the test harness), then DRIVE every check
below in order (setup, then the steps as virtual or real input, observing while it happens, then compare), then
restore.
${harness ? `Test harness (from the lead): ${harness}\n` : ''}Bringing Studio's window to the front: ${bringToFront ? 'allowed when real input or a screenshot needs the viewport rendering' : 'NOT allowed; if a step needs real input and Studio is not rendering, report that check as not run and say why'}.
Time budget: about ${budgetMinutes} minutes; report checks you could not run instead of overrunning.

## Checks
${checkText}

Report each check by its key with the measured values, the evidence and what you actually drove. A check passes only
if what you measured, after performing its steps, meets its EXPECT line.`, { label: 'operate', phase: 'Operate', schema: REPORT, agentType, exclusive })

if (!report) {
  log('the operator returned nothing (died or never submitted)')
  return { status: 'failed', checks: [], restored: false, blocked: '', consoleErrors: [], notes: 'operator failed: check that the live system is open, then rerun', operatorNotes: '' }
}
if (report.blocked) {
  log(`blocked: ${report.blocked}`)
  return { status: 'blocked', checks: report.checks || [], restored: report.restored, blocked: report.blocked, consoleErrors: report.consoleErrors || [], notes: '', operatorNotes: report.notes }
}
if (!report.restored) log('WARNING: the operator did not confirm that the live system was restored')

const byKey = {}
for (const r of report.checks || []) byKey[r.key] = r
const missing = checks.filter((c) => !byKey[c.key]).map((c) => c.key)
if (missing.length) log(`the operator did not report: ${missing.join(', ')}`)

const verdicts = {}
const passed = (report.checks || []).filter((r) => r.pass)
if (judge && passed.length) {
  phase('Judge')
  const v = await agent(`${A.context}

## Your role
You are a skeptical judge. An operator played the game to run these live checks and claims they passed. For each one,
decide from what it says it drove, the measured values and the evidence ONLY whether they really meet the EXPECT line
(you cannot rerun anything; the live system is not yours to touch). Disagree when the evidence is missing or vague
("looks fine"), measures something else, contradicts the expectation, or when the steps were not actually performed
(a static read where the check needed input).

${passed.map((r) => {
  const c = checks.find((x) => x.key === r.key) || { expect: '(unknown check)' }
  return [
    `- [${r.key}] STEPS: ${c.steps ? list(c.steps) : c.how || '(none given)'}`,
    `  EXPECT: ${c.expect}`,
    `  DROVE: ${r.driven || '(not said)'}`,
    `  MEASURED: ${r.measured}`,
    r.timeline ? `  TIMELINE: ${r.timeline}` : '',
    `  EVIDENCE: ${r.evidence}`,
  ].filter(Boolean).join('\n')
}).join('\n')}`, { label: 'judge', phase: 'Judge', schema: VERDICTS, agentType: 'wf-reviewer' })
  if (v) for (const x of v.verdicts) verdicts[x.key] = x
  else log('WARNING: the judge returned nothing; passes are unjudged')
}

const out = checks.map((c) => {
  const r = byKey[c.key]
  if (!r) return { key: c.key, pass: false, status: 'not run', measured: '', driven: '', timeline: '', evidence: '', judge: null }
  const v = verdicts[c.key]
  const pass = r.pass && (!judge || !v || v.agree)
  const status = !r.pass ? 'fail' : v && !v.agree ? 'pass claimed, judge disagrees' : 'pass'
  return { key: c.key, pass, status, measured: r.measured, driven: r.driven || '', timeline: r.timeline || '', evidence: r.evidence, judge: v ? v.reason : null }
})
const nPass = out.filter((c) => c.pass).length
log(`${nPass}/${out.length} checks pass${judge ? ' (judged)' : ''}; restored: ${report.restored}`)
const status = nPass === out.length ? 'pass' : out.some((c) => c.status === 'not run') ? 'partial' : 'fail'
return { status, checks: out, restored: report.restored, blocked: '', consoleErrors: report.consoleErrors || [], notes: missing.length ? `not reported: ${missing.join(', ')}` : '', operatorNotes: report.notes }
