export const meta = {
  name: 'design-panel',
  description: 'Two designers forced onto different mechanisms, one selecting judge that returns the winner, a fix/graft diff, the probes to run before building and whether the user must choose',
  whenToUse: 'An open architecture or mechanism choice whose options differ in kind. Not for tuning numbers, physics or feel calibration (measure those), bug fixes or one-hunk changes.',
  phases: [
    { title: 'Design', detail: 'independent designs, each from a different mechanism' },
    { title: 'Select', detail: 'one judge scores both, picks a winner and writes a diff' },
    { title: 'Merge', detail: 'optional: apply the diff to the winner (args.merge)' },
  ],
}

// Design panel v2: 2 designers on different mechanisms -> 1 selecting judge -> (optional) thin merge.
//
// Installed in ~/.config/opencode/workflows/ (or <project>/.opencode/workflows/); run with:
//   workflow({ name: "design-panel", args: { brief, angles?, judgeLens?, criteria?, rules?, effort?, maxWords?, merge?, designs?, judgeNotes? } })
//   brief      (string, required) measured facts (unmeasured ones tagged UNMEASURED) + rules + what the design must specify
//   angles     [{ key, angle }]  designer starting points (default 2: 'obvious' = the obvious mechanism vs 'different' = a
//              deliberately different one). Keys must be unique non-empty strings. If ANY key is a default key ('obvious',
//              'different') the list is MERGED into the defaults by key (so one default's text can be edited alone);
//              otherwise it REPLACES the defaults.
//   judgeLens  (string)          the selecting judge's role (default: a strict, literal-request judge)
//   criteria   [{ key, description }] each scored pass/fail + 0-10 (default: constraints, fidelity, measurability, simplicity)
//   rules      (string) prepended to every agent (default: read files only, no live-system tool even read-only, list probes
//              but do not run them) - the main loop is usually driving the live system while the panel runs
//   effort     a model variant name such as 'high' for every agent (default: the agent's own)
//   maxWords   (number) word cap on each design's Markdown (default 1500)
//   merge      (boolean) true = one thin agent applies the judge's diff to the winner (default false: you apply it)
//   designs    [{ key, title, mechanism, design, ... }] designer outputs from an earlier run (result.designs) to REUSE: a key
//              present here skips its agent() call entirely (no cache needed). Pass BOTH to re-run only the judge.
//   judgeNotes (string) extra instructions for the judge (what to double-check, a new fact to diff the winner against)
// Returns { winner, selection, runnerUp, needsUserChoice, userQuestion, userOptions, merged, designs, next }.

// OpenCode port: a plain string becomes { brief: <string> } (the string-args trap that failed 7 Claude Code runs)
const A = typeof args === 'string' ? { brief: args } : (args || {})
const brief = A.brief
if (!brief || typeof brief !== 'string') throw new Error('args.brief (string) is required')
const effort = A.effort === undefined ? undefined : String(A.effort) // a model variant name, e.g. 'high'
let maxWords = 1500
if (A.maxWords !== undefined) {
  const n = Math.floor(Number(A.maxWords))
  if (Number.isFinite(n) && n > 0) {
    maxWords = n
    if (typeof A.maxWords !== 'number') log(`WARNING: args.maxWords ${JSON.stringify(A.maxWords)} is not a number; using ${n}`)
  } else log(`WARNING: args.maxWords ${JSON.stringify(A.maxWords)} is not a positive number; using the default 1500`)
}
const judgeNotes = A.judgeNotes ? String(A.judgeNotes) : ''
const rules = A.rules ? String(A.rules) : '## Rules for every agent in this panel\nREAD files only (read, grep, glob). Do not call any live-system tool (for example the Roblox Studio MCP, a running server, a browser), not even a read-only one: the main loop is driving it and concurrent use breaks it. Do not modify any file, do not run builds, tests, playtests or experiments. List probes; do not run them.'

const checkKeyed = (list, name, field) => {
  if (!Array.isArray(list) || !list.length) throw new Error(`args.${name} must be a non-empty array of { key, ${field} }`)
  const seen = {}
  for (const x of list) {
    if (!x || typeof x.key !== 'string' || !x.key.trim()) throw new Error(`args.${name}: every entry needs a non-empty string key (got ${JSON.stringify(x)})`)
    if (typeof x[field] !== 'string' || !x[field].trim()) throw new Error(`args.${name}: entry "${x.key}" needs a non-empty string ${field}`)
    if (seen[x.key]) throw new Error(`args.${name}: duplicate key "${x.key}"`)
    seen[x.key] = true
  }
}

const DEFAULT_ANGLES = [
  { key: 'obvious', angle: 'Design the OBVIOUS mechanism: the most direct, conventional way to do what the user literally asked, reusing the levers, patterns and modules the codebase already has wherever they fit. It is the design an experienced engineer on this codebase would sketch first; make it complete and honest about its weak points.' },
  { key: 'different', angle: 'Design a DELIBERATELY DIFFERENT mechanism. Another designer is doing the obvious approach, so do not. Either pick a different mechanism entirely, or take the EXTREME option on the decisive axis of this problem (for example physical vs scripted, continuous vs discrete, server vs client, the literal reading of the request vs the conservative one). Name the decisive axis in "mechanism" and say where each design sits on it.' },
]
let angles = DEFAULT_ANGLES
if (A.angles !== undefined) {
  checkKeyed(A.angles, 'angles', 'angle')
  const isDefault = (k) => DEFAULT_ANGLES.some(d => d.key === k)
  if (A.angles.some(a => isDefault(a.key))) {
    angles = DEFAULT_ANGLES.map(d => A.angles.find(a => a.key === d.key) || d).concat(A.angles.filter(a => !isDefault(a.key)))
    log(`angles merged into the defaults by key: ${angles.map(a => a.key).join(', ')}`)
  } else angles = A.angles
}
if (angles.length < 2) log('WARNING: only one angle; the judge has nothing to select between (it still writes the diff and probes)')

const judgeLens = A.judgeLens || 'You are the SELECTING JUDGE. Recompute every exact number from the brief\'s measured facts; check the API claims against the codebase (read-only) where you can; judge each design against what the user LITERALLY asked for, verbs taken literally, never against a safer version of the request. You are not a synthesizer: you pick one design and write the smallest diff that fixes it.'

let criteria = [
  { key: 'constraints', description: 'obeys every measured fact and hard rule of the brief and the project. FAIL = breaks a rule, contradicts a measured fact, or relies on an API that does not exist.' },
  { key: 'fidelity', description: 'does what the user literally asked for. FAIL = silently narrows, softens or replaces the request (an option the user asked for was excluded without being surfaced).' },
  { key: 'measurability', description: 'every dynamic/tuning number is a RANGE with a harness, a metric and a pass criterion; every relied-on API has a probe; unmeasured assumptions are tagged. FAIL = point values presented as derived facts, or an unprobed API.' },
  { key: 'simplicity', description: 'fewest new mechanisms, state and code paths; buildable without further design decisions. FAIL = the builder would have to make a design decision.' },
]
if (A.criteria !== undefined) {
  checkKeyed(A.criteria, 'criteria', 'description')
  if (A.criteria.some(c => c.key === 'key')) throw new Error('args.criteria: "key" is reserved (it names the design in each score row)')
  criteria = A.criteria
}

const PROBE = {
  type: 'object',
  properties: {
    api: { type: 'string', description: 'the engine/platform/library API, property, event or behaviour relied on' },
    probe: { type: 'string', description: 'a one-line check that confirms it exists and behaves as assumed' },
    why: { type: 'string', description: 'what in the design breaks if the probe fails' },
  },
  required: ['api', 'probe', 'why'],
}
const RANGE = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    low: { type: 'number' },
    high: { type: 'number' },
    unit: { type: 'string' },
    harness: { type: 'string', description: 'what to run to measure it (a lab, a test switch, a script)' },
    metric: { type: 'string', description: 'what is read from the harness' },
    pass: { type: 'string', description: 'the pass criterion that picks the value inside the range' },
  },
  required: ['name', 'low', 'high', 'unit', 'harness', 'metric', 'pass'],
}
const EXACT = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    value: { type: 'string', description: 'the exact value with its unit' },
    basis: { type: 'string', description: 'one line: the measured fact, budget or protocol it follows from' },
  },
  required: ['name', 'value', 'basis'],
}
const EXCLUSION = {
  type: 'object',
  properties: {
    option: { type: 'string', description: 'an option, feature or reading of the request deliberately left out' },
    why: { type: 'string' },
  },
  required: ['option', 'why'],
}

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    mechanism: { type: 'string', description: 'the core mechanism in 2-4 sentences' },
    design: { type: 'string', description: 'the full design in Markdown within the word cap; no code' },
    exact: { type: 'array', items: EXACT, description: 'exact values: geometry, budgets, protocols, anything derivable exactly' },
    ranges: { type: 'array', items: RANGE, description: 'every dynamic/tuning number as a range plus the measurement that picks it' },
    probes: { type: 'array', items: PROBE },
    unmeasured: { type: 'array', items: { type: 'string' }, description: 'assumptions not backed by a measured fact, each starting "UNMEASURED:"' },
    exclusions: { type: 'array', items: EXCLUSION },
  },
  required: ['title', 'mechanism', 'design', 'exact', 'ranges', 'probes', 'unmeasured', 'exclusions'],
}

const CRIT_SCORE = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number', description: '0-10' },
    note: { type: 'string', description: 'one line; for a fail, the exact rule, fact or number that fails' },
  },
  required: ['pass', 'score', 'note'],
}
const scoreProps = { key: { type: 'string', description: 'the design key exactly as given' } }
for (const c of criteria) scoreProps[c.key] = CRIT_SCORE
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: { type: 'array', items: { type: 'object', properties: scoreProps, required: Object.keys(scoreProps) } },
    winner: { type: 'string', description: 'the winning design key exactly as given' },
    why: { type: 'string', description: 'why it wins, in 2-5 sentences' },
    diff: {
      type: 'array',
      description: 'ordered changes to the WINNER: fixes (with the corrected number) and grafts from the other design; not a merged spec',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fix', 'graft', 'drop', 'widen'], description: 'fix an error, graft from the other design, drop an element, widen a range that is too narrow' },
          change: { type: 'string', description: 'the exact change, with numbers' },
          reason: { type: 'string' },
        },
        required: ['kind', 'change', 'reason'],
      },
    },
    probes: { type: 'array', items: PROBE, description: 'the merged, de-duplicated probes to run BEFORE building (the winner\'s, any graft\'s, and your own)' },
    differInKind: { type: 'boolean', description: 'true only if the designs differ in a way the USER would notice and should choose (behaviour, look, feel), not an implementation detail' },
    userQuestion: { type: 'string', description: 'if differInKind: one question in the user\'s terms; else empty' },
    userOptions: {
      type: 'array',
      description: 'if differInKind: 2-4 options in the user\'s terms (the winner first); else empty',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, description: { type: 'string' } },
        required: ['label', 'description'],
      },
    },
  },
  required: ['scores', 'winner', 'why', 'diff', 'probes', 'differInKind', 'userQuestion', 'userOptions'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    design: { type: 'string', description: 'the winner with the diff applied, Markdown, no code' },
    exact: { type: 'array', items: EXACT },
    ranges: { type: 'array', items: RANGE },
    probes: { type: 'array', items: PROBE },
    unmeasured: { type: 'array', items: { type: 'string' } },
    exclusions: { type: 'array', items: EXCLUSION },
    skipped: { type: 'array', items: { type: 'string' }, description: 'diff items not applied, with why' },
  },
  required: ['title', 'design', 'exact', 'ranges', 'probes', 'unmeasured', 'exclusions', 'skipped'],
}

const designerRules = (n) => `## How to answer
You are one of ${n} independent designers, each starting from a different mechanism. Commit to ONE design; do not hedge.
- mechanism: the core idea in 2-4 sentences.
- exact: exact values ONLY for geometry, budgets, protocols / wire formats and anything derivable exactly from the brief's measured facts, each with a one-line basis.
- ranges: EVERY dynamic or tuning number (gains, thresholds, timings, forces, anything that depends on physics, feel or other agents' behaviour) as a range [low, high] plus the measurement that will pick it: the harness to run, the metric it reads and the pass criterion. Do NOT derive dynamic numbers by long mental simulation: in this kind of project such point values are routinely overturned by the first live measurement, and a bracket plus a test is worth more than a guess. Keep the ranges honest (wide where you do not know).
- probes: every engine / platform / library API, property, event or behaviour the design relies on, each with a one-line probe that confirms it exists and behaves as assumed. An API you have not seen in the brief or the codebase must be listed here.
- unmeasured: every assumption not backed by a measured fact in the brief, each starting "UNMEASURED:".
- exclusions: what you deliberately left out (options, features, other readings of the request) and why, so a choice the user may want stays visible.
- design: the full design in Markdown, at most ${maxWords} words, no code.
You may read files to confirm a fact (within the rules at the top); list probes, do not run them.`

// ---- Design ----
phase('Design')
const reuse = {}
if (A.designs !== undefined && !Array.isArray(A.designs)) throw new Error('args.designs must be an array (result.designs from an earlier run)')
for (const d of (A.designs || [])) if (d && typeof d.key === 'string' && d.design) reuse[d.key] = d
const reusedKeys = angles.filter(a => reuse[a.key]).map(a => a.key)
const unusedKeys = Object.keys(reuse).filter(k => !angles.some(a => a.key === k))
if (unusedKeys.length) log(`WARNING: args.designs keys that match no angle, ignored: ${unusedKeys.join(', ')}`)
const liveCalls = angles.filter(a => !reuse[a.key]).map(a => `design:${a.key}`).concat(['select'], A.merge === true ? ['merge'] : [])
log(`reused (no agent call): ${reusedKeys.join(', ') || 'none'}; agent calls in order: ${liveCalls.join(', ')} (on resume, the first changed call and everything after it runs live)`)

const designs = (await parallel(angles.map(a => () => {
  if (reuse[a.key]) return Promise.resolve({ ...reuse[a.key], key: a.key })
  return agent(`${rules}\n\n${brief}\n\n## Your angle\n${a.angle}\n\n${designerRules(angles.length)}`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort, agentType: 'wf-reviewer' })
    .then(d => d && { ...d, key: a.key })
}))).filter(Boolean)
if (!designs.length) throw new Error('no designs produced')
if (designs.length < angles.length) log(`WARNING: only ${designs.length} of ${angles.length} designers returned; the judge sees what exists`)
log(`${designs.length} designs: ${designs.map(d => `${d.key} = ${d.title}`).join(' | ')}`)

const listText = (arr, f) => (arr && arr.length) ? arr.map(f).join('\n') : '(none)'
const designText = (d) => `\n\n=====================\n# DESIGN "${d.key}": ${d.title}\n## Mechanism\n${d.mechanism}\n\n${d.design}\n\n## Exact values\n${listText(d.exact, e => `- ${e.name} = ${e.value} (${e.basis})`)}\n\n## Ranges (picked by measurement)\n${listText(d.ranges, r => `- ${r.name}: ${r.low}..${r.high} ${r.unit}; harness: ${r.harness}; metric: ${r.metric}; pass: ${r.pass}`)}\n\n## Probes\n${listText(d.probes, p => `- ${p.api}: ${p.probe} (${p.why})`)}\n\n## Unmeasured\n${listText(d.unmeasured, u => `- ${u}`)}\n\n## Exclusions\n${listText(d.exclusions, x => `- ${x.option}: ${x.why}`)}`
const dossier = designs.map(designText).join('')
const criteriaText = criteria.map(c => `- ${c.key}: pass/fail + 0-10. ${c.description}`).join('\n')

// ---- Select (the one real barrier: the judge needs every design) ----
phase('Select')
const judged = await agent(`${rules}\n\n${brief}\n\n## Your role\n${judgeLens}\n\nScore EVERY design below on each criterion (pass/fail and 0-10):\n${criteriaText}\n\nThen:\n1. winner: the design key to build. A design that fails "constraints" or "fidelity" cannot win over one that passes both unless the diff repairs it.\n2. diff: an ordered list of changes to the WINNER only (fix with the corrected number, graft from the other design, drop, widen a range). Do NOT write a merged spec and do NOT re-derive dynamic numbers by mental simulation: if a range looks wrong, widen it and say what measurement settles it.\n3. probes: the merged, de-duplicated list of probes to run before any code is written (API existence, signs, units, identities), including any claim you could not confirm.\n4. differInKind: true only when the designs differ in a way the USER would notice and should choose (for example a clean pass vs a ram, a fan vs a horseshoe, a scripted vs a physical effect). Then write userQuestion and 2-4 userOptions in the user's own terms, the winner first. Also set it when the winner EXCLUDES something the user literally asked for.\nUse each design's key exactly as given. Keep the whole answer under about 900 words. ${judgeNotes}${dossier}`,
  { label: 'select', phase: 'Select', schema: JUDGE_SCHEMA, effort, agentType: 'wf-reviewer' })

const byKey = {}
for (const d of designs) byKey[d.key] = d
// Judges echo keys loosely ("Obvious", " different"): match on trimmed lower case, map back to the real key.
const norm = (k) => String(k === undefined || k === null ? '' : k).trim().toLowerCase()
const byNorm = {}
for (const d of designs) byNorm[norm(d.key)] = d.key
const realKey = (k) => byKey[k] ? k : byNorm[norm(k)]
const scored = []
if (judged && judged.scores) {
  for (const s0 of judged.scores) {
    const k = s0 && realKey(s0.key)
    if (!k || scored.some(x => x.key === k)) continue
    const s = { ...s0, key: k }
    let total = 0
    let passes = 0
    const failed = []
    for (const c of criteria) {
      const cs = s[c.key] || {}
      total += Number(cs.score) || 0
      if (cs.pass) passes += 1
      else failed.push(`${c.key}: ${cs.note || 'fail'}`)
    }
    scored.push({ key: s.key, total, passes, failed })
  }
}
scored.sort((a, b) => (b.passes - a.passes) || (b.total - a.total))
const scoreLeader = scored.length ? scored[0].key : null
const judgeWinner = judged ? realKey(judged.winner) : undefined
const winnerKey = judgeWinner || scoreLeader || designs[0].key
if (!judged) log('WARNING: the judge returned nothing; defaulting to the first design. Resume with resumeFromRunId to re-run only the judge.')
else {
  if (judged.scores && judged.scores.length && !scored.length) log(`WARNING: judge scores did not match any design key (got ${judged.scores.map(s => JSON.stringify(s && s.key)).join(', ')}; designs ${designs.map(d => d.key).join(', ')}); no scores used`)
  if (!judgeWinner) log(`WARNING: judge named an unknown winner ${JSON.stringify(judged.winner)}; using ${scoreLeader ? `the score leader ${scoreLeader}` : `the first design ${winnerKey}`}`)
  else if (scoreLeader && judgeWinner !== scoreLeader) log(`note: the judge picked ${judgeWinner} over the score leader ${scoreLeader}; read "why"`)
}
log(`scores: ${scored.map(s => `${s.key} ${s.total}/${10 * criteria.length} (${s.passes}/${criteria.length} pass)`).join(', ') || 'none'}; winner ${winnerKey}`)

const w = byKey[winnerKey]
const r = designs.find(d => d.key !== winnerKey) || null
const diff = ((judged && judged.diff) || []).map((d, i) => ({ n: i + 1, ...d }))
const probes = (judged && judged.probes && judged.probes.length) ? judged.probes : (w.probes || [])
// Not gated on designs.length: with one design left the flag still means "the winner excludes something the user asked for".
const needsUserChoice = !!(judged && judged.differInKind)
let userQuestion = needsUserChoice ? String(judged.userQuestion || '').trim() : ''
if (needsUserChoice && !userQuestion) {
  userQuestion = 'The designs differ in a way you would notice (or the winner leaves out something you asked for): which do you want?'
  log('WARNING: the judge set differInKind but wrote no userQuestion; using a generic one - read selection.why and the exclusions')
}
const userOptions = needsUserChoice ? (judged.userOptions || []) : []

// ---- Merge (optional, thin) ----
let merged = null
if (A.merge === true) {
  phase('Merge')
  merged = await agent(`${rules}\n\n${brief}\n\n## Your role\nYou are a thin MERGE step. Apply the numbered diff below to the WINNER design and output it. Do not re-derive any number, do not add ideas of your own, do not run any tool (no reads, no probes, no experiments): this is text editing. Keep every range a range (with its harness, metric and pass criterion); keep the exact values exact. List in "skipped" any diff item you could not apply cleanly, with why.\n\n## Diff (apply in order)\n${diff.map(d => `${d.n}. [${d.kind}] ${d.change} (${d.reason})`).join('\n') || '(empty)'}\n\n## Winner${designText(w)}${r ? `\n\n## The other design (source of the grafts only)${designText(r)}` : ''}`,
    { label: 'merge', phase: 'Merge', schema: MERGE_SCHEMA, effort, agentType: 'wf-reviewer' })
  if (!merged) log('WARNING: merge agent returned nothing; apply the diff yourself')
}

// ---- What the main loop does next ----
const rangeCount = ((merged && merged.ranges) || w.ranges || []).length
const next = []
if (needsUserChoice) next.push(`ASK THE USER before building (AskUserQuestion): ${userQuestion}`)
next.push(`run the ${probes.length} probes (the 5-minute spec lint: API existence, signs, units, identities) before writing code`)
if (!merged && diff.length) next.push(`apply the ${diff.length}-item diff to the winner yourself (or re-run with merge: true)`)
next.push(`let measurement pick the ${rangeCount} ranged numbers (labs on the real system first, then >= 3 runs per arm against a same-session control)`)
next.push('read winner.exclusions: anything the user literally asked for that the winner left out goes to the user, not to the bin')
for (const n of next) log(`NEXT: ${n}`)

return {
  winner: {
    key: w.key, title: w.title, mechanism: w.mechanism, design: w.design, exact: w.exact || [], ranges: w.ranges || [],
    probes: w.probes || [], unmeasured: w.unmeasured || [], exclusions: w.exclusions || [],
  },
  selection: {
    winner: winnerKey,
    scoreLeader,
    why: judged ? judged.why : 'judge failed',
    scores: scored,
    diff,
    probes,
    raw: judged ? judged.scores : [],
  },
  runnerUp: r ? {
    key: r.key, title: r.title, mechanism: r.mechanism, exclusions: r.exclusions || [],
    total: (scored.find(s => s.key === r.key) || { total: null }).total,
  } : null,
  needsUserChoice,
  userQuestion,
  userOptions,
  merged,
  designs,
  next,
}
