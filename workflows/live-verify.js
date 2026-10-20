export const meta = {
  name: 'live-verify',
  description: 'One operator runs the given checks on the live system (Roblox Studio by default) under an exclusive lock, then a read-only judge checks every pass against its evidence',
  whenToUse: 'After a build or fix that changes behaviour visible in the running app or game: the live check at the end of a build wave, or a regression check before handover.',
  phases: [
    { title: 'Operate', detail: 'one wf-operator drives the live system: preflight, the checks, restore' },
    { title: 'Judge', detail: 'a read-only reviewer compares each claimed pass with its evidence' },
  ],
}

// Live verify: operator (exclusive) -> judge. Run with:
//   workflow({ name: "live-verify", args: { context, checks, judge?, exclusive?, budgetMinutes?, agentType? } })
//   context        (string, required) what changed and why, which place / app (Roblox: place name or placeId), what
//                  is synced (Rojo: the files whose Source must match disk), test switches the code reads
//   checks         [{ key, how, expect }] (required) one live check each: how to exercise it and what passing looks
//                  like, with numbers where they exist. A plain string is one check.
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
if (!Array.isArray(checks) || !checks.length) throw new Error('args.checks must be a non-empty array of { key, how, expect }')
const seen = {}
for (const c of checks) {
  if (!c || typeof c.key !== 'string' || !c.key.trim()) throw new Error(`every check needs a string key (got ${JSON.stringify(c)})`)
  if (seen[c.key]) throw new Error(`duplicate check key "${c.key}"`)
  seen[c.key] = true
  if (typeof c.how !== 'string' || typeof c.expect !== 'string') throw new Error(`check "${c.key}" needs string how and expect`)
}
const judge = A.judge !== false
const exclusive = typeof A.exclusive === 'string' && A.exclusive ? A.exclusive : 'studio'
const budgetMinutes = Number(A.budgetMinutes) > 0 ? Number(A.budgetMinutes) : 15
const agentType = typeof A.agentType === 'string' && A.agentType ? A.agentType : 'wf-operator'

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
        },
        required: ['key', 'pass', 'measured', 'evidence'],
      },
    },
    consoleErrors: { type: 'array', items: { type: 'string' }, description: 'errors and warnings seen during the run, verbatim' },
    restored: { type: 'boolean', description: 'true only after reading back that every playtest you started is stopped and every switch you set is cleared' },
    notes: { type: 'string', description: 'anything the lead must know: checks you could not run, odd behaviour, what you left as is' },
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

const checkText = checks.map((c, i) => `${i + 1}. [${c.key}] HOW: ${c.how}\n   EXPECT: ${c.expect}`).join('\n')

phase('Operate')
const report = await agent(`${A.context}

## Your role
You are the live-system operator for this check run (you hold the "${exclusive}" lock). Follow your protocol:
preflight (right instance, state, sync, record the test switches), then run every check below in order, then restore.
Time budget: about ${budgetMinutes} minutes; report checks you could not run instead of overrunning.

## Checks
${checkText}

Report each check by its key with the measured values and the evidence. A check passes only if what you measured
meets its EXPECT line.`, { label: 'operate', phase: 'Operate', schema: REPORT, agentType, exclusive })

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

let verdicts = {}
const passed = (report.checks || []).filter((r) => r.pass)
if (judge && passed.length) {
  phase('Judge')
  const v = await agent(`${A.context}

## Your role
You are a skeptical judge. An operator ran live checks and claims these passed. For each one, decide from the
measured values and the evidence ONLY whether they really meet the EXPECT line (you cannot rerun anything; the live
system is not yours to touch). Disagree when the evidence is missing, vague ("looks fine"), measures something else,
or contradicts the expectation.

${passed.map((r) => {
  const c = checks.find((x) => x.key === r.key) || { expect: '(unknown check)' }
  return `- [${r.key}] EXPECT: ${c.expect}\n  MEASURED: ${r.measured}\n  EVIDENCE: ${r.evidence}`
}).join('\n')}`, { label: 'judge', phase: 'Judge', schema: VERDICTS, agentType: 'wf-reviewer' })
  if (v) for (const x of v.verdicts) verdicts[x.key] = x
  else log('WARNING: the judge returned nothing; passes are unjudged')
}

const out = checks.map((c) => {
  const r = byKey[c.key]
  if (!r) return { key: c.key, pass: false, status: 'not run', measured: '', evidence: '', judge: null }
  const v = verdicts[c.key]
  const pass = r.pass && (!judge || !v || v.agree)
  return { key: c.key, pass, status: !r.pass ? 'fail' : v && !v.agree ? 'pass claimed, judge disagrees' : 'pass', measured: r.measured, evidence: r.evidence, judge: v ? v.reason : null }
})
const nPass = out.filter((c) => c.pass).length
log(`${nPass}/${out.length} checks pass${judge ? ' (judged)' : ''}; restored: ${report.restored}`)
const status = nPass === out.length ? 'pass' : out.some((c) => c.status === 'not run') ? 'partial' : 'fail'
return { status, checks: out, restored: report.restored, blocked: '', consoleErrors: report.consoleErrors || [], notes: missing.length ? `not reported: ${missing.join(', ')}` : '', operatorNotes: report.notes }
