export const meta = {
  name: 'adversarial-audit',
  description: 'Read-only auditors with distinct lenses, a skeptic re-check of every high/medium finding pipelined behind its auditor, and a consolidated fix list; or one light reviewer',
  whenToUse: 'Verify / audit / review what was built. Full for behaviour or state-machine code; light (args.light) for UI or doc-only diffs.',
  phases: [
    { title: 'Audit', detail: 'independent read-only auditors (or one light reviewer)' },
    { title: 'Verify', detail: 'each high/medium finding re-checked by skeptics as soon as its auditor finishes' },
    { title: 'Consolidate', detail: 'confirmed findings merged into one fix list' },
  ],
}

// Adversarial audit v2: auditors -> (pipelined, no barrier) skeptics per finding -> consolidation of confirmed findings.
//
// Installed in ~/.config/opencode/workflows/ (or <project>/.opencode/workflows/); run with:
//   workflow({ name: "adversarial-audit", args: { context, auditors, rules?, skeptics?, verifyLevels?, light?, effort?, skepticEffort? } })
//   context       (string, required) the as-built spec with every number, what changed (files / diff), what tools auditors may use
//   auditors      [{ key, prompt }] (required unless light) one lens each; give exactly one of them the screenshot tools
//   rules         (string) prepended to every agent: the read-only rule, forbidden tools, what not to touch
//                 (auditors need unique non-empty string keys and prompts; bad args throw before any agent runs)
//   skeptics      (number >= 0, default 1) skeptics per verified finding; a finding survives if a strict majority say real;
//                 0 = verify nothing (every finding returned in 'unverified', no consolidation)
//   verifyLevels  (string[] of high/medium/low, default ['high','medium']) severities that get skeptics; the rest go to
//                 'unverified' as-is (a finding with an unknown severity is always verified)
//   light         (boolean) true = ONE reviewer (all auditor lenses folded into it), no skeptics, no consolidation;
//                 every finding is returned in 'unverified' (for UI / doc-only diffs)
//   effort        a model variant name such as 'high' (default: the agent's own)
//   skepticEffort (string) effort for skeptics (default: effort)
// Returns { fixes, confirmed, refuted, unverified, checked, notes }.

// OpenCode port: a plain string becomes { context: <string> } (the string-args trap that failed 7 Claude Code runs)
const A = typeof args === 'string' ? { context: args } : (args || {})
const context = A.context
if (!context || typeof context !== 'string') throw new Error('args.context (string) is required')
const light = A.light === true
const KNOWN = ['high', 'medium', 'low']
let auditors = null
if (A.auditors !== undefined && !(Array.isArray(A.auditors) && A.auditors.length === 0 && light)) {
  if (!Array.isArray(A.auditors) || !A.auditors.length) throw new Error('args.auditors must be a non-empty array of { key, prompt }')
  const seen = {}
  for (const a of A.auditors) {
    if (!a || typeof a.key !== 'string' || !a.key.trim()) throw new Error(`args.auditors: every auditor needs a non-empty string key (got ${JSON.stringify(a)})`)
    if (typeof a.prompt !== 'string' || !a.prompt.trim()) throw new Error(`args.auditors: auditor "${a.key}" needs a non-empty string prompt`)
    if (seen[a.key]) throw new Error(`args.auditors: duplicate key "${a.key}"`)
    seen[a.key] = true
  }
  auditors = A.auditors
}
// OpenCode port: default lenses when none are given (Claude Code's version required them).
const DEFAULT_AUDITORS = [
  { key: 'correctness', prompt: 'Correctness: does the change do what the context says, on every path? Wrong results, broken invariants, off-by-one, wrong units, error paths that lose data.' },
  { key: 'state-and-edges', prompt: 'State and edge cases: ordering, concurrency, re-entry, empty / huge / malformed input, partial failure, cleanup, resource leaks, timeouts.' },
  { key: 'tests-and-integration', prompt: 'Tests and integration: run the test suite and lint; check callers of every changed function and the docs that describe it; missing tests for the new behaviour; anything else in the codebase the change silently breaks.' },
]
if (!auditors && !light) { auditors = DEFAULT_AUDITORS; log('no args.auditors: using the default lenses ' + DEFAULT_AUDITORS.map(a => a.key).join(', ')) }
const rules = A.rules ? String(A.rules) : 'You are READ-ONLY: gather evidence, change nothing. If a tool could modify the system under audit, do not call it.'
let skepticCount = 1
if (A.skeptics !== undefined) {
  const n = Number(A.skeptics)
  if (!Number.isFinite(n) || n < 0) throw new Error(`args.skeptics must be a number >= 0 (got ${JSON.stringify(A.skeptics)})`)
  skepticCount = Math.floor(n)
  if (skepticCount !== n) log(`WARNING: args.skeptics ${JSON.stringify(A.skeptics)} rounded down to ${skepticCount}`)
  if (skepticCount === 0 && !light) log('WARNING: skeptics 0 - nothing is verified; every finding is returned in unverified and nothing is consolidated')
}
let verifyLevels = ['high', 'medium']
if (A.verifyLevels !== undefined) {
  let lv = A.verifyLevels
  if (typeof lv === 'string') { log(`WARNING: args.verifyLevels is a string; treating it as [${JSON.stringify(lv)}]`); lv = [lv] }
  if (!Array.isArray(lv)) throw new Error(`args.verifyLevels must be an array of ${KNOWN.join('/')} (got ${JSON.stringify(A.verifyLevels)})`)
  verifyLevels = lv.map(s => String(s).trim().toLowerCase())
  const bad = verifyLevels.filter(s => !KNOWN.includes(s))
  if (bad.length) throw new Error(`args.verifyLevels: unknown severities ${bad.join(', ')} (use ${KNOWN.join(', ')})`)
}
if (skepticCount === 0) verifyLevels = []
const effort = A.effort === undefined ? undefined : String(A.effort) // a model variant name, e.g. 'high'
const skepticEffort = A.skepticEffort === undefined ? effort : A.skepticEffort

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = wrong behaviour / crash / data loss / broken rule; medium = wrong in an edge case or a real risk; low = cosmetic, stale doc, style' },
          evidence: { type: 'string', description: 'the exact numbers / names / file:line / observations that prove it' },
          fix: { type: 'string', description: 'concrete fix (with numbers) for the builder' },
        },
        required: ['title', 'severity', 'evidence', 'fix'],
      },
    },
    checked: { type: 'string', description: 'what you verified as OK, briefly' },
  },
  required: ['findings', 'checked'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
    fix: { type: 'string' },
  },
  required: ['real', 'reason', 'fix'],
}

const FIXLIST_SCHEMA = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string' },
          rootCause: { type: 'string' },
          fix: { type: 'string', description: 'one concrete, minimal fix with numbers; merge duplicates' },
          sources: { type: 'array', items: { type: 'string' }, description: 'auditor keys that reported it' },
        },
        required: ['title', 'severity', 'rootCause', 'fix', 'sources'],
      },
    },
    notes: { type: 'string', description: 'refuted findings that still deserve a doc fix or a follow-up' },
  },
  required: ['fixes', 'notes'],
}

const needsVerify = (f) => {
  if (skepticCount === 0) return false
  const sev = String(f.severity || '').toLowerCase()
  return verifyLevels.includes(sev) || !KNOWN.includes(sev) // an unknown severity is verified, never silently dropped
}
const auditPrompt = (lens) => `${rules}\n\n${context}\n\n## Your role\n${lens}\n\nReport only real defects with the evidence that proves them (numbers, names, file:line); rate severity honestly (low = cosmetic, stale doc, style). List what you verified as OK in "checked".`

// ---- Light: one reviewer, nothing verified ----
if (light) {
  phase('Audit')
  const lens = auditors
    ? `You are the single reviewer of a light audit. Cover every lens below yourself:\n${auditors.map(a => `- (${a.key}) ${a.prompt}`).join('\n')}`
    : 'You are the single reviewer of a light audit (a UI / doc-only change): check correctness against the context, the rules, stale or contradictory docs, and anything a user would see broken.'
  const r = await agent(auditPrompt(lens), { label: 'review:light', phase: 'Audit', schema: FINDINGS_SCHEMA, effort, agentType: 'wf-reviewer' })
  const unverified = r ? r.findings.map(f => ({ ...f, auditor: 'light', why: 'light mode: not verified' })) : []
  log(r ? `light review: ${unverified.length} findings, none verified - check each before acting` : 'WARNING: the light reviewer returned nothing')
  return { fixes: [], confirmed: [], refuted: [], unverified, checked: r ? [{ key: 'light', checked: r.checked }] : [], notes: '' }
}

// ---- Audit -> Verify, pipelined per auditor (no barrier between the phases) ----
phase('Audit')
const perAuditor = await pipeline(auditors,
  (_, a) => agent(auditPrompt(a.prompt), { label: `audit:${a.key}`, phase: 'Audit', schema: FINDINGS_SCHEMA, effort, agentType: 'wf-reviewer' }),
  async (audit, a) => {
    if (!audit) { log(`WARNING: auditor ${a.key} returned nothing`); return null }
    const toVerify = audit.findings.filter(needsVerify)
    const skipped = audit.findings.filter(f => !needsVerify(f)).map(f => ({ ...f, auditor: a.key, why: skepticCount === 0 ? 'skeptics 0: not verified' : `severity ${f.severity} is not in verifyLevels` }))
    log(`${a.key}: ${audit.findings.length} findings, ${toVerify.length} to verify`)
    const verified = await parallel(toVerify.map(f => () =>
      parallel(Array.from({ length: skepticCount }, (_, i) => () =>
        agent(`${rules}\n\n${context}\n\n## Your role\nYou are SKEPTIC ${i + 1}. An auditor (${a.key}) reported this finding:\n\nTITLE: ${f.title}\nSEVERITY: ${f.severity}\nEVIDENCE: ${f.evidence}\nPROPOSED FIX: ${f.fix}\n\nTry to REFUTE it. Re-check the claim yourself from primary evidence (read the code / the live state; do not trust the evidence text). Default to real=false if you cannot reproduce it, if it is cosmetic below the precision that matters here, a matter of taste, or already explained by the as-built spec. If it is real, restate the minimal concrete fix with numbers.`,
          { label: `verify:${a.key}:${String(f.title).slice(0, 30)}${skepticCount > 1 ? `#${i + 1}` : ''}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: skepticEffort, agentType: 'wf-reviewer' })))
        .then(votes => {
          const valid = votes.filter(Boolean)
          const yes = valid.filter(v => v.real).length
          return { ...f, auditor: a.key, voted: valid.length > 0, real: valid.length > 0 && yes * 2 > valid.length, verdicts: valid }
        })
    ))
    return { key: a.key, checked: audit.checked, verified: verified.filter(Boolean), skipped }
  })

const done = perAuditor.filter(Boolean)
const verifiedAll = done.flatMap(x => x.verified)
const confirmed = verifiedAll.filter(f => f.voted && f.real)
const refuted = verifiedAll.filter(f => f.voted && !f.real)
const unverified = done.flatMap(x => x.skipped)
  .concat(verifiedAll.filter(f => !f.voted).map(f => ({ title: f.title, severity: f.severity, evidence: f.evidence, fix: f.fix, auditor: f.auditor, why: 'every skeptic failed to return' })))
log(`${confirmed.length} confirmed, ${refuted.length} refuted, ${unverified.length} unverified (returned as-is)`)

// ---- Consolidate (only when something was confirmed) ----
let fixes = []
let notes = ''
if (confirmed.length) {
  phase('Consolidate')
  const text = confirmed.map(f => `\n- [${f.severity}] (${f.auditor}) ${f.title}\n  EVIDENCE: ${f.evidence}\n  FIX: ${f.verdicts.filter(v => v.real).map(v => v.fix).join(' | ')}`).join('')
  const refutedText = refuted.map(f => `\n- (${f.auditor}) ${f.title}: ${f.verdicts.map(v => v.reason).join(' | ')}`).join('')
  const merged = await agent(`${rules}\n\n${context}\n\n## Your role\nYou consolidate audit findings into one fix list. Several auditors often report the same root cause under different titles: merge those into one entry (keep every source key), order by severity, and make each fix minimal and concrete with numbers. Do not invent new findings and do not run tools.\n\n## Confirmed findings${text}\n\n## Refuted findings (only for the notes: anything here that still deserves a documentation fix or follow-up)${refutedText || '\n(none)'}`,
    { label: 'consolidate', phase: 'Consolidate', schema: FIXLIST_SCHEMA, effort, agentType: 'wf-reviewer' })
  if (merged) { fixes = merged.fixes; notes = merged.notes }
  else {
    log('WARNING: consolidation returned nothing; returning the confirmed findings as fixes unmerged')
    fixes = confirmed.map(f => ({ title: f.title, severity: f.severity, rootCause: f.evidence, fix: f.verdicts.filter(v => v.real).map(v => v.fix).join(' | '), sources: [f.auditor] }))
  }
} else {
  log('nothing confirmed; skipping consolidation')
}

return {
  fixes,
  confirmed,
  refuted: refuted.map(f => ({ title: f.title, auditor: f.auditor, reasons: f.verdicts.map(v => v.reason) })),
  unverified,
  checked: done.map(x => ({ key: x.key, checked: x.checked })),
  notes,
}
