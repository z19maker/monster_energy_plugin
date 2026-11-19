import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { apply } from '../index.js'

const directory = await mkdtemp(join(tmpdir(), 'monster-tracker-'))
process.env.DSH_MONSTER_STATE = join(directory, 'state.json')

/** Minimal host context: the registries and the optional Web route table. */
function createContext({ web = true, deferWeb = false } = {}) {
  const tools = new Map()
  const commands = new Map()
  const routes = new Map()
  const disposers = []
  const pendingWeb = []
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const scope = {
    webServer,
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
  }
  const ctx = {
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    inject(dependencies, callback) {
      if (!dependencies.includes('webServer') || !web) return
      if (deferWeb) {
        pendingWeb.push(callback)
        return
      }
      callback(scope)
    },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    commands: { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
  }
  return {
    ctx,
    tools,
    commands,
    routes,
    provideWebServer() { for (const callback of pendingWeb.splice(0)) callback(scope) },
    dispose() { for (const dispose of disposers.reverse()) dispose?.() },
  }
}

function mount(options) {
  const harness = createContext(options)
  apply(harness.ctx)
  return harness
}

// Registration must also work when the web server mounts after apply().
const deferred = mount({ deferWeb: true })
assert.equal(deferred.routes.size, 0, 'route waits for the web server')
deferred.provideWebServer()
assert.ok(deferred.routes.get('/monster-tracker/state'), 'route registers when the web server arrives')
deferred.dispose()

const first = mount()
const tool = first.tools.get('monster_energy')
assert.ok(tool, 'tool registered')
const command = first.commands.get('monster')
assert.ok(command, 'command registered')
assert.equal(tool.parameters.required[0], 'action')

const call = async (args) => {
  const value = await tool.execute(args, {})
  const roundTrip = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTrip, value, 'canonical value is lossless JSON')
  for (const key of tool.output.schema.required) assert.ok(Object.hasOwn(value, key), `result has ${key}`)
  const rendered = tool.output.render(args, value)
  assert.ok(rendered[0].type === 'text' && rendered[0].text.length > 0)
  return value
}

let status = await call({ action: 'status' })
assert.equal(status.totalCans, 0)
assert.equal(status.todayCans, 0)
assert.equal(status.lastLoggedAt, '')

assert.equal((await call({ action: 'log' })).totalCans, 1)
assert.equal((await call({ action: 'log', cans: 2 })).totalCans, 3)
status = await call({ action: 'status' })
assert.equal(status.totalCans, 3)
assert.equal(status.todayCans, 3)
assert.notEqual(status.lastLoggedAt, '')

// The Web strip reads committed figures from the read-only route without
// consuming a recovery notice.
const stateRoute = first.routes.get('/monster-tracker/state')
assert.ok(stateRoute, 'state route registered')
const stateResponse = await stateRoute.resource(new Request('http://localhost/monster-tracker/state'))
assert.equal(stateResponse.status, 200)
const stateBody = await stateResponse.json()
assert.equal(stateBody.totalCans, 3)
assert.equal(stateBody.todayCans, 3)
assert.equal(stateBody.notice, undefined)

assert.equal((await call({ action: 'undo' })).totalCans, 1)

await assert.rejects(call({ action: 'log', cans: 0 }), /cans must be an integer/)
await assert.rejects(call({ action: 'log', cans: 2.5 }), /cans must be an integer/)
await assert.rejects(call({ action: 'bogus' }), /action must be one of/)

const runCommand = async (rawInput) => command.handler({ rawInput, signal: new AbortController().signal })
let result = await runCommand('')
assert.equal(result.kind, 'success')
assert.match(result.text, /2 cans total, 2 today/)
result = await runCommand(' status ')
assert.equal(result.kind, 'success')
assert.match(result.text, /2 cans total, 2 today/)
result = await runCommand('2')
assert.equal(result.kind, 'success')
assert.equal((await call({ action: 'status' })).totalCans, 4)
result = await runCommand('undo')
assert.equal(result.kind, 'success')
result = await runCommand('undo')
assert.equal(result.kind, 'success')
result = await runCommand('undo')
assert.equal(result.kind, 'success')
result = await runCommand('undo')
assert.equal(result.kind, 'error')

// Persistence across a remount.
result = await runCommand('3')
assert.equal(result.kind, 'success')
first.dispose()
assert.equal(first.routes.size, 0, 'state route removed on dispose')
const second = mount()
assert.equal((await second.tools.get('monster_energy').execute({ action: 'status' }, {})).totalCans, 3)
second.dispose()

// A corrupt ledger is moved aside instead of bricking the tracker, and the
// recovery is reported exactly once.
await writeFile(process.env.DSH_MONSTER_STATE, '{not json', 'utf8')
const third = mount()
const recovered = await third.tools.get('monster_energy').execute({ action: 'status' }, {})
assert.equal(recovered.totalCans, 0)
assert.match(recovered.notice, /saved as/)
const quiet = await third.tools.get('monster_energy').execute({ action: 'status' }, {})
assert.equal(quiet.notice, '')
const files = await readdir(directory)
assert.ok(files.some(file => file.includes('.corrupt-')), 'corrupt file was preserved')
third.dispose()

// A fixed multi-day ledger exercises the seven-day buckets, including a
// multi-can day and an entry eight days old that must be excluded.
const historyDirectory = await mkdtemp(join(tmpdir(), 'monster-history-'))
const historyFile = join(historyDirectory, 'state.json')
const atOffset = (offset) => {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - offset)
  return date.toISOString()
}
const localDayOf = (date) => {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
const historyEntries = [
  { at: atOffset(0), cans: 2 },
  { at: atOffset(1), cans: 3 },
  { at: atOffset(3), cans: 1 },
  { at: atOffset(6), cans: 1 },
  { at: atOffset(7), cans: 9 },
]
await writeFile(historyFile, JSON.stringify({
  version: 1,
  totalCans: historyEntries.reduce((sum, entry) => sum + entry.cans, 0),
  entries: historyEntries,
}))
const previousState = process.env.DSH_MONSTER_STATE
process.env.DSH_MONSTER_STATE = historyFile
const historyHarness = mount()
const historyRoute = historyHarness.routes.get('/monster-tracker/state')
const historyBody = await (await historyRoute.resource(new Request('http://localhost/monster-tracker/state'))).json()
assert.equal(historyBody.days.length, 7)
assert.equal(historyBody.days.at(-1).cans, 2, 'today is the last bucket')
assert.equal(historyBody.days.reduce((sum, day) => sum + day.cans, 0), 7, 'eight days ago is excluded')
assert.equal(historyBody.days.at(-1).date, localDayOf(new Date()))

// A browser zone overrides the host's local day while keeping seven buckets.
const zone = 'America/New_York'
const zonedBody = await (await historyRoute.resource(new Request(
  `http://localhost/monster-tracker/state?tz=${encodeURIComponent(zone)}`,
))).json()
const zoneParts = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date())
const zoneValues = Object.fromEntries(zoneParts.map(part => [part.type, part.value]))
const zoneToday = `${zoneValues.year}-${zoneValues.month}-${zoneValues.day}`
assert.equal(zonedBody.today, zoneToday, 'today follows the requested zone')
assert.equal(zonedBody.days.at(-1).date, zoneToday)
const eightDaysAgo = new Date()
eightDaysAgo.setDate(eightDaysAgo.getDate() - 7)
assert.ok(!historyBody.days.some(day => day.date === localDayOf(eightDaysAgo)), 'window is exactly seven days')
historyHarness.dispose()
process.env.DSH_MONSTER_STATE = previousState

// The client artifact loads without an image URL, registers its dictionary
// plus the frame-wide overlay entry, and renders an inline SVG can.
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
assert.ok(!clientSource.includes('__CAN_DATA_URL__'), 'no unresolved image placeholder')
assert.ok(!clientSource.includes('data:image/png'), 'the card no longer depends on a PNG data URL')
assert.ok(clientSource.includes('?tz='), 'the client sends its time zone')

let loaded
const browserWindow = {
  innerWidth: 1200,
  innerHeight: 800,
  __ModuleLoader__: { load(entry) { loaded = entry } },
}
vm.runInNewContext(clientSource, { window: browserWindow })
assert.equal(loaded.id, '@local/monster-tracker')
const fakeReact = { createElement(...args) { return { args } }, useState() { return [null, () => {}] }, useEffect() {} }
const client = loaded.factory(() => fakeReact)
assert.deepEqual([...client.inject], ['slots', 'locale'])
const registered = { locales: [], slots: [] }
client.apply({
  effect(callback) { callback(); return () => {} },
  locale: {
    register(namespace, dictionaries) {
      registered.locales.push([namespace, dictionaries])
      return () => {}
    },
  },
  slots: {
    inject(name, callback) { registered.slots.push(name); callback() },
    register(options, component) { registered.slots.push([options, component]); return () => {} },
  },
})
assert.equal(registered.locales.length, 1)
const [namespace, dictionaries] = registered.locales[0]
assert.equal(namespace, 'monsterTracker')
assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
assert.equal(new Set(Object.keys(dictionaries.en)).size, Object.keys(dictionaries.en).length)
assert.ok(registered.slots.includes('shell.overlay'))
const slotRegistration = registered.slots.find(value => Array.isArray(value))
assert.equal(slotRegistration[0].id, 'monster-tracker-float')
assert.equal(slotRegistration[0].order, 60)
assert.equal(slotRegistration[0].locale, 'monsterTracker')
assert.equal(typeof slotRegistration[1], 'function')

// Exercise the rendered tree with a fake React: the draggable card, its inline
// SVG, and the seven-day popup with seven bars and a total.
function renderCan(todayCans, failed = false, open = false, days = []) {
  let component
  const states = [
    failed ? null : { todayCans, totalCans: 9, days },
    failed,
    { x: 10, y: 10 },
    false,
    open,
  ]
  const renderReact = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...props, children })
      return { type, props, children }
    },
    useState() { const [value] = states.splice(0, 1); return [value, () => {}] },
    useEffect() {},
    useRef(initial) { return { current: initial } },
  }
  const clientModule = loaded.factory(() => renderReact)
  clientModule.apply({
    effect(callback) { callback(); return () => {} },
    locale: { register() { return () => {} } },
    slots: {
      inject(_name, callback) { callback() },
      register(_options, value) { component = value; return () => {} },
    },
  })
  return component({ t: key => key })
}
const walkTree = (node) => {
  if (typeof node === 'string') return { svgs: 0, paths: 0, bars: 0, text: node }
  if (node === null || node === undefined) return { svgs: 0, paths: 0, bars: 0, text: '' }
  if (Array.isArray(node)) {
    return node.reduce((sum, child) => {
      const part = walkTree(child)
      return {
        svgs: sum.svgs + part.svgs,
        paths: sum.paths + part.paths,
        bars: sum.bars + part.bars,
        text: `${sum.text} ${part.text}`,
      }
    }, { svgs: 0, paths: 0, bars: 0, text: '' })
  }
  let svgs = node.type === 'svg' ? 1 : 0
  let paths = node.type === 'path' ? 1 : 0
  let bars = node.props !== undefined && node.props !== null && Object.hasOwn(node.props, 'data-day') ? 1 : 0
  let text = ''
  for (const child of node.children ?? []) {
    const part = walkTree(child)
    svgs += part.svgs
    paths += part.paths
    bars += part.bars
    text += ` ${part.text}`
  }
  return { svgs, paths, bars, text }
}
const three = renderCan(3)
assert.equal(walkTree(three).svgs, 1, 'the card renders the inline can SVG')
assert.equal(walkTree(three).paths, 1, 'the can has its lightning-bolt path')
assert.match(walkTree(three).text, /3\s+today/)
assert.match(walkTree(three).text, /9\s+total/)
assert.equal(three.props.style.position, 'fixed')
assert.equal(three.props.style.left, 10)
assert.equal(three.props.style.top, 10)
assert.equal(three.props.style.zIndex, 9000)
assert.match(walkTree(renderCan(0, true)).text, /unavailable/)

const days = [
  { date: '2026-11-11', cans: 0 },
  { date: '2026-11-12', cans: 1 },
  { date: '2026-11-13', cans: 0 },
  { date: '2026-11-14', cans: 2 },
  { date: '2026-11-15', cans: 0 },
  { date: '2026-11-16', cans: 3 },
  { date: '2026-11-17', cans: 2 },
]
globalThis.window = { innerWidth: 1200, innerHeight: 800 }
const findNode = (node, predicate) => {
  if (node === null || node === undefined || typeof node === 'string') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}
browserWindow.innerWidth = 1200
browserWindow.innerHeight = 800
try {
  const withPopup = renderCan(2, false, true, days)
  const popupTree = walkTree(withPopup)
  assert.equal(popupTree.bars, 7, 'the popup renders one bar per day')
  assert.match(popupTree.text, /last7Days/)
  assert.match(popupTree.text, /weekTotal: 8/)
  const dialog = findNode(withPopup, node => node.props?.role === 'dialog')
  assert.ok(dialog, 'popup dialog is rendered')
  assert.ok(dialog.props.style.width <= 288)
} finally {
  browserWindow.innerWidth = 1200
  browserWindow.innerHeight = 800
}

browserWindow.innerWidth = 320
browserWindow.innerHeight = 640
try {
  const narrow = renderCan(2, false, true, days)
  const dialog = findNode(narrow, node => node.props?.role === 'dialog')
  assert.ok(dialog, 'narrow popup dialog is rendered')
  assert.ok(dialog.props.style.width <= 300, 'narrow popup fits the viewport')
} finally {
  browserWindow.innerWidth = 1200
  browserWindow.innerHeight = 800
}

console.log('smoke: ok')
