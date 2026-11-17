/**
 * Monster Energy tracker.
 *
 * Keeps one durable can counter for the user. The agent reaches it through the
 * `monster_energy` tool; the user reaches the same operations through the
 * `/monster` slash command. State is a small JSON file under `$DSH_HOME`, so it
 * survives restarts and survives removing and reinstalling this bundle.
 *
 * @module monster-tracker
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'monster-tracker'
export const inject = ['tools', 'commands']

/** Bump only when the stored shape or its meaning changes. */
const STATE_VERSION = 1
/** Per-entry ceiling; a single log call above this is treated as a mistake. */
const MAX_CANS_PER_ENTRY = 99
const ACTIONS = ['log', 'status', 'undo']
const USAGE = 'Usage: /monster adds one can; /monster N adds N; /monster status; /monster undo.'
/** Read-only JSON endpoint consumed by the composer strip. */
const STATE_ROUTE = '/monster-tracker/state'

/**
 * Resolve the state file. `DSH_MONSTER_STATE` exists for tests and for moving
 * the ledger; otherwise the file lives beside other DSH data.
 * @returns {string} absolute path of the JSON ledger.
 */
function resolveStatePath() {
  if (process.env.DSH_MONSTER_STATE) return process.env.DSH_MONSTER_STATE
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'monster-tracker.json')
}

/** @returns {{version: number, totalCans: number, entries: {at: string, cans: number}[]}} */
function emptyState() {
  return { version: STATE_VERSION, totalCans: 0, entries: [] }
}

/**
 * Accept only records this plugin can reason about. Unknown or malformed
 * entries are dropped rather than making the whole ledger unreadable.
 * @param {unknown} raw parsed JSON value.
 * @returns the normalized ledger.
 */
function normalizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.entries)) return state
  for (const item of raw.entries) {
    if (item === null || typeof item !== 'object') continue
    const cans = item.cans
    const time = typeof item.at === 'string' ? Date.parse(item.at) : Number.NaN
    if (!Number.isInteger(cans) || cans < 1 || cans > MAX_CANS_PER_ENTRY || !Number.isFinite(time)) continue
    state.entries.push({ at: new Date(time).toISOString(), cans })
  }
  state.totalCans = state.entries.reduce((sum, entry) => sum + entry.cans, 0)
  return state
}

/**
 * Read the ledger, treating a missing file as empty. A file that is not valid
 * JSON is moved aside so one interrupted write cannot brick the tracker; the
 * returned notice tells the user where the old file went.
 * @param {string} file absolute ledger path.
 * @returns the loaded ledger plus an optional recovery notice.
 */
async function readState(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: emptyState(), notice: '' }
    throw error
  }
  try {
    return { state: normalizeState(JSON.parse(text)), notice: '' }
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}`
    await rename(file, backup).catch(() => {})
    console.warn(`[monster-tracker] Unreadable ledger moved to ${backup}: ${error?.message ?? error}`)
    return {
      state: emptyState(),
      notice: `The previous ledger was unreadable and was saved as ${backup}; counts restarted from zero.`,
    }
  }
}

/**
 * Publish one ledger atomically: write a sibling temp file, then rename it.
 * @param {string} file absolute ledger path.
 * @param {{totalCans: number, entries: {at: string, cans: number}[]}} state ledger to save.
 */
async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(file), `.${process.pid}-${randomUUID()}.tmp`)
  const document = JSON.stringify({
    version: STATE_VERSION,
    totalCans: state.totalCans,
    entries: state.entries,
  }, null, 2)
  await writeFile(temporary, `${document}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}

/** @param {{version: number, totalCans: number, entries: {at: string, cans: number}[]}} state @returns {string} local calendar day, `YYYY-MM-DD`. */
function localDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Project the user-facing figures from one ledger.
 * @param {{totalCans: number, entries: {at: string, cans: number}[]}} state ledger.
 * @returns today's count, the account day, and the latest entry time.
 */
function summaryOf(state) {
  const now = new Date()
  const today = localDay(now)
  let todayCans = 0
  for (const entry of state.entries) {
    if (localDay(new Date(entry.at)) === today) todayCans += entry.cans
  }
  const last = state.entries.at(-1)
  return {
    totalCans: state.totalCans,
    todayCans,
    today,
    lastLoggedAt: last === undefined ? '' : last.at,
  }
}

/** @param {number} cans @returns {string} `1 can` or `3 cans`. */
function cansLabel(cans) {
  return cans === 1 ? '1 can' : `${cans} cans`
}

/** @param {ReturnType<typeof summaryOf>} summary @returns {string} one shared account line. */
function summaryLine(summary) {
  return `${cansLabel(summary.totalCans)} total, ${summary.todayCans} today (${summary.today})`
}

/** @param {ReturnType<typeof summaryOf>} summary @returns {string} one-line state description. */
function statusText(summary) {
  if (summary.totalCans === 0) return 'No Monster Energy cans logged yet. Use /monster to add one.'
  return `Monster Energy: ${summaryLine(summary)}.`
}

/** @param {string} notice @returns {string} a sentence suffix for a one-time recovery notice. */
function noticeSuffix(notice) {
  return notice === '' ? '' : ` ${notice}`
}

/**
 * One ledger with serialized writes. Reads wait for the write chain so a
 * status call cannot report a half-applied change.
 */
class MonsterStore {
  /** @param {string} file absolute ledger path. */
  constructor(file) {
    this.file = file
    /** @type {{version: number, totalCans: number, entries: {at: string, cans: number}[]} | null} */
    this.state = null
    /** @type {Promise<{state: {version: number, totalCans: number, entries: {at: string, cans: number}[]}, notice: string}> | undefined} */
    this.loading = undefined
    /** Recovery notice waiting for the next result. */
    this.pendingNotice = ''
    /** Tail of the write chain; never rejects. */
    this.tail = Promise.resolve()
  }

  /** @returns {Promise<{version: number, totalCans: number, entries: {at: string, cans: number}[]}>} the cached or loaded ledger. */
  async load() {
    if (this.state !== null) return this.state
    if (this.loading === undefined) this.loading = readState(this.file)
    try {
      const loaded = await this.loading
      this.state = loaded.state
      if (loaded.notice !== '') this.pendingNotice = loaded.notice
    } finally {
      this.loading = undefined
    }
    return this.state
  }

  /** @returns {string} the pending recovery notice, reported once. */
  takeNotice() {
    const notice = this.pendingNotice
    this.pendingNotice = ''
    return notice
  }

  /** @returns {Promise<ReturnType<typeof summaryOf>>} committed figures without consuming a notice. */
  async snapshot() {
    await this.tail
    return summaryOf(await this.load())
  }

  /** @returns {Promise<ReturnType<typeof summaryOf> & {notice: string}>} committed figures for a status request. */
  async read() {
    return { ...(await this.snapshot()), notice: this.takeNotice() }
  }

  /**
   * Apply one mutation and publish it before resolving.
   * @param {(state: {version: number, totalCans: number, entries: {at: string, cans: number}[]}) => Record<string, unknown>} mutate
   * @returns committed figures plus the mutation's extra fields.
   */
  run(mutate) {
    const operation = this.tail.then(async () => {
      const current = await this.load()
      const draft = {
        version: STATE_VERSION,
        totalCans: current.totalCans,
        entries: current.entries.map(entry => ({ at: entry.at, cans: entry.cans })),
      }
      const extra = mutate(draft) ?? {}
      draft.totalCans = draft.entries.reduce((sum, entry) => sum + entry.cans, 0)
      await saveState(this.file, draft)
      this.state = draft
      return { ...summaryOf(draft), notice: this.takeNotice(), ...extra }
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** @param {number} cans @returns {Promise<{changedCans: number} & ReturnType<typeof summaryOf>>} committed figures after logging. */
  log(cans) {
    return this.run(state => {
      state.entries.push({ at: new Date().toISOString(), cans })
      return { changedCans: 0 }
    })
  }

  /** @returns {Promise<{changedCans: number} & ReturnType<typeof summaryOf>>} committed figures after undoing the latest entry. */
  undo() {
    return this.run(state => {
      const last = state.entries.pop()
      if (last === undefined) throw new Error('No Monster Energy cans have been logged yet, so there is nothing to undo.')
      return { changedCans: last.cans }
    })
  }
}

/** @param {unknown} value @returns {number} a validated can count from a tool call. */
function readCans(value) {
  const cans = value === undefined ? 1 : value
  if (typeof cans !== 'number' || !Number.isInteger(cans) || cans < 1 || cans > MAX_CANS_PER_ENTRY) {
    throw new Error(`cans must be an integer from 1 to ${MAX_CANS_PER_ENTRY}`)
  }
  return cans
}

/**
 * Build the agent tool over the shared store.
 * @param {MonsterStore} store shared ledger.
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition} registry-ready definition.
 */
function toolDefinition(store) {
  return {
    name: 'monster_energy',
    description:
      'Track cans of Monster Energy the user has consumed. '
      + 'Use `log` when the user says they drank one or more cans, `status` to report the running total '
      + 'and today\'s count, and `undo` to remove the most recently logged entry.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'log (record cans), status (report totals), or undo (remove the latest entry).',
        },
        cans: {
          type: 'integer',
          description: 'Cans to record; only meaningful with action log. Defaults to 1; 1 to 99.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ACTIONS },
          totalCans: { type: 'integer' },
          todayCans: { type: 'integer' },
          today: { type: 'string' },
          lastLoggedAt: { type: 'string' },
          changedCans: { type: 'integer' },
          notice: { type: 'string' },
        },
        required: ['action', 'totalCans', 'todayCans', 'today', 'lastLoggedAt', 'changedCans', 'notice'],
      },
      render(_args, value) {
        const line = summaryLine(value)
        const notice = value.notice === '' ? '' : ` ${value.notice}`
        if (value.action === 'log') return [{ type: 'text', text: `Logged ${cansLabel(value.changedCans)}. ${line}.${notice}` }]
        if (value.action === 'undo') return [{ type: 'text', text: `Removed the latest entry (${cansLabel(value.changedCans)}). ${line}.${notice}` }]
        return [{ type: 'text', text: `${value.totalCans === 0 ? 'No Monster Energy cans logged yet.' : `Monster Energy: ${line}.`}${notice}` }]
      },
    },
    async execute(args) {
      const action = args?.action
      if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
      if (action === 'status') return { action, ...(await store.read()), changedCans: 0 }
      if (action === 'undo') {
        const summary = await store.undo()
        return { action, ...summary }
      }
      const cans = readCans(args?.cans)
      const summary = await store.log(cans)
      return { action, ...summary, changedCans: cans }
    },
  }
}

/**
 * Build the human command over the shared store.
 * @param {MonsterStore} store shared ledger.
 * @returns {import('@deepseek-ai/dsh-commands').CommandDefinition} registry-ready definition.
 */
function commandDefinition(store) {
  return {
    name: 'monster',
    description: 'Log a Monster Energy can (bare /monster adds one), check your total, or undo the last entry',
    input: { hint: '[count|status|undo]' },
    async handler(invocation) {
      const input = invocation.rawInput.trim()
      const word = input.toLowerCase()
      if (input === '' || word === 'log') {
        const summary = await store.log(1)
        return { kind: 'success', text: `Logged ${cansLabel(1)}. ${summaryLine(summary)}.${noticeSuffix(summary.notice)}` }
      }
      if (word === 'status') {
        const summary = await store.read()
        return { kind: 'success', text: `${statusText(summary)}${noticeSuffix(summary.notice)}` }
      }
      if (word === 'undo') {
        try {
          const summary = await store.undo()
          return { kind: 'success', text: `Removed the latest entry (${cansLabel(summary.changedCans)}). ${summaryLine(summary)}.${noticeSuffix(summary.notice)}` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
      if (/^\d+$/u.test(input)) {
        const cans = Number(input)
        if (cans < 1 || cans > MAX_CANS_PER_ENTRY) return { kind: 'error', text: `Log between 1 and ${MAX_CANS_PER_ENTRY} cans. ${USAGE}` }
        const summary = await store.log(cans)
        return { kind: 'success', text: `Logged ${cansLabel(cans)}. ${summaryLine(summary)}.${noticeSuffix(summary.notice)}` }
      }
      return { kind: 'error', text: `Couldn't understand "${input}". ${USAGE}` }
    },
  }
}

/**
 * Mount the ledger, the agent tool, and the user command.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context with `tools` and `commands`.
 */
export function apply(ctx) {
  const store = new MonsterStore(resolveStatePath())
  ctx.effect(() => ctx.tools.register(toolDefinition(store)))
  ctx.effect(() => ctx.commands.register(commandDefinition(store)))
  // The Web UI (client.js) polls this read-only route. Routes default to the
  // web server's authenticated-peer admission, so only the signed-in page reads it.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      resource: async () => Response.json(await store.snapshot(), {
        headers: { 'cache-control': 'no-store' },
      }),
    }))
  }
}
