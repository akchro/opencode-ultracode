// The script host: checks a workflow script before launch and runs it in a node:vm context with the clock and the
// random generator locked (they would break resume). Claude Code's script format is accepted unchanged:
//   export const meta = { name, description, whenToUse?, phases?: [{ title, detail? }] }   (a pure literal)
//   ...a plain-JavaScript body with top-level await, using agent / parallel / pipeline / phase / log / workflow /
//   args / budget, whose `return` value is the run's result.
// node:vm is a determinism guard, not a security boundary: scripts are written by your own lead agent.
import vm from "node:vm"
import { LaunchRejected, SCRIPT_MAX } from "./core.ts"

export type Meta = {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

export type ScriptApi = {
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>
  parallel: (thunks: Array<() => unknown>) => Promise<unknown[]>
  pipeline: (items: unknown[], ...stages: Array<(prev: any, item: any, index: number) => unknown>) => Promise<unknown[]>
  phase: (title: string) => void
  log: (message: unknown) => void
  workflow: (ref: unknown, args?: unknown) => Promise<unknown>
  args: unknown
  budget: { total: number | null; spent: () => number; remaining: () => number }
}

export type Program = { meta: Meta; body: string; script: vm.Script }

// CR is one of them: a CRLF script is refused (Claude Code refuses it in its approval check too).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/

const LOCKDOWN = `{
  const ban = (n) => () => { throw new Error(n + " is unavailable in workflow scripts (it would break resume); pass timestamps or seeds in args") }
  const RealDate = Date
  globalThis.Date = new Proxy(RealDate, {
    construct: (t, a) => (a.length ? new t(...a) : ban("new Date()")()),
    apply: ban("Date()"),
    get: (t, p) => (p === "now" ? ban("Date.now()") : Reflect.get(t, p)),
  })
  Math.random = ban("Math.random()")
}`

/** Finds the object literal after `export const meta =`, skipping strings and comments. */
function extractMeta(source: string): { literal: string; end: number; start: number } {
  const head = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*export\s+const\s+meta\s*=\s*/.exec(source)
  if (!head) throw new LaunchRejected("a workflow script must begin with `export const meta = {...}`")
  let i = head[0].length
  if (source[i] !== "{") throw new LaunchRejected("meta must be an object literal")
  const start = i
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '"' || c === "'" || c === "`") {
      const q = c
      for (i++; i < source.length && source[i] !== q; i++) if (source[i] === "\\") i++
      continue
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1
      if (i === 0) break
      continue
    }
    if (c === "{") depth++
    if (c === "}" && --depth === 0) return { literal: source.slice(start, i + 1), start: head.index, end: i + 1 }
  }
  throw new LaunchRejected("meta: unbalanced braces")
}

export function load(source: string): Program {
  if (typeof source !== "string" || !source.trim()) throw new LaunchRejected("empty script")
  if (source.length > SCRIPT_MAX) throw new LaunchRejected(`script over ${SCRIPT_MAX} characters`)
  if (CONTROL.test(source))
    throw new LaunchRejected("script contains control characters (a CR from CRLF line endings counts): save it with LF only")
  const { literal } = extractMeta(source)
  if (/`|\$\{|\.\.\.|[A-Za-z_$][\w$]*\s*\(/.test(literal.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')))
    throw new LaunchRejected("meta must be a pure literal: no variables, calls, spreads or template interpolation")
  let meta: Meta
  try {
    meta = vm.runInNewContext("(" + literal + ")", Object.create(null), { timeout: 100 })
  } catch (e) {
    throw new LaunchRejected("meta must be a pure literal: " + String((e as Error)?.message ?? e))
  }
  if (!meta || typeof meta.name !== "string" || !meta.name || typeof meta.description !== "string")
    throw new LaunchRejected("meta needs a string name and description")
  if (meta.phases && !Array.isArray(meta.phases)) throw new LaunchRejected("meta.phases must be an array")
  const body = source.replace(/export\s+const\s+meta\s*=/, "const meta =")
  let script: vm.Script
  try {
    script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: `${meta.name}.workflow.js` })
  } catch (e) {
    throw new LaunchRejected("Invalid workflow script: " + String((e as Error)?.message ?? e) + " (plain JavaScript, not TypeScript)")
  }
  return { meta, body, script }
}

export function run(program: Program, api: ScriptApi): Promise<unknown> {
  const ctx = vm.createContext({
    ...api,
    console: { log: api.log, info: api.log, warn: api.log, error: api.log },
  })
  vm.runInContext(LOCKDOWN, ctx)
  return Promise.resolve(program.script.runInContext(ctx))
}
