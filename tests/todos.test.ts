import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Task } from '../types'
import { apply, chains, EMPTY, layout } from '../hooks/tasks'

const TOOL = 'mcp__todos__todo'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// Stands in for the engine beneath the plugin, then starts the session.
async function start($: Engine, on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__todos__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  // The engine draws nothing of its own in the band.
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

// The band's rows: the text of each child of its column Box.
type Node = { children?: unknown[] }
const flat = (n: unknown): string =>
  typeof n === 'string' || typeof n === 'number' ? String(n) : ((n as Node)?.children ?? []).map(flat).join('')
async function lines(ui: { drawn: () => Promise<unknown> }) {
  return ((await ui.drawn()) as Node).children?.map(flat) ?? []
}

const call = ($: Engine, args: Record<string, unknown>) =>
  $.tool.call({ tool: TOOL, ...args } as never)

test('the reducer enforces the status machine and the dependency graph', () => {
  let s = apply(EMPTY, { action: 'create', subject: 'A' }).state
  s = apply(s, { action: 'create', subject: 'B', blockedBy: [1] }).state
  expect(apply(s, { action: 'update', id: 1, addBlockedBy: [2] }).text).toBe(
    'Error: addBlockedBy would create a cycle in the blockedBy graph',
  )
  expect(apply(s, { action: 'update', id: 1, addBlockedBy: [1] }).text).toBe('Error: cannot block #1 on itself')

  s = apply(s, { action: 'update', id: 1, status: 'completed' }).state
  expect(apply(s, { action: 'update', id: 1, status: 'in_progress' }).text).toBe(
    'Error: illegal transition completed → in_progress',
  )
  expect(apply(s, { action: 'update', id: 1, status: 'completed' }).text).toMatch(/^No change: #1/)
})

test('overflow drops completed rows first, then the unfinished tail', () => {
  const tasks = [1, 2, 3, 4, 5].map(id => ({
    id,
    subject: `t${id}`,
    status: id <= 2 ? ('completed' as const) : ('pending' as const),
  }))
  expect(layout(tasks, 4)).toEqual({ visible: tasks.slice(2), hiddenCompleted: 2, truncatedTail: 0 })
  expect(layout(tasks, 3)).toEqual({ visible: tasks.slice(2, 4), hiddenCompleted: 2, truncatedTail: 1 })
})

test('the todo tool feeds the band and /todos', async ($, on) => {
  await start($, on)

  const empty = await $.ui.mount({ plugin: 'todos', surface: 'terminal', ...BAND })
  expect(await empty.find({ text: /Todos/ })).toBeUndefined()
  await empty.unmount()

  expect((await call($, { action: 'create', subject: 'Write the reducer' })).result).toBe(
    'Created #1: Write the reducer (pending)',
  )
  await call($, { action: 'create', subject: 'Draw the band' })
  await call($, { action: 'update', id: 1, status: 'in_progress', activeForm: 'writing it' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'todos', surface, ...BAND })
    expect(await lines(ui)).toEqual([
      '● Todos (0/2)',
      '├─ ◐ Write the reducer (writing it)',
      '└─ ○ Draw the band',
      ' ',
    ])
    await ui.unmount()
  }

  const { text } = await $.command.run({ command: 'todos', args: '' } as never)
  expect(text).toContain('1 in progress · 1 pending')
  expect(text).toContain('◐ #1 Write the reducer (writing it)')
})

test('completed rows stay until the list is done, then fade at the next turn', async ($, on) => {
  await start($, on)
  await call($, { action: 'create', subject: 'One' })
  await call($, { action: 'create', subject: 'Two' })
  await call($, { action: 'update', id: 1, status: 'completed' })

  const band = async () => {
    const ui = await $.ui.mount({ plugin: 'todos', surface: 'terminal', ...BAND })
    const out = await lines(ui)
    await ui.unmount()
    return out
  }
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await band()).toEqual(['● Todos (1/2)', '├─ ✓ One', '└─ ○ Two', ' '])

  await call($, { action: 'update', id: 2, status: 'completed' })
  expect(await band()).toEqual(['○ Todos (2/2)', '├─ ✓ One', '└─ ✓ Two', ' '])
  await $.turn.start({ text: 'next', turnId: 't3' })
  expect(await band()).toEqual([])

  expect((await call($, { action: 'create', subject: 'Three' })).result).toBe(
    'Created #1: Three (pending). Started a new list: earlier task ids no longer apply.',
  )
  await call($, { action: 'create', subject: 'Four' })
  await call($, { action: 'update', id: 1, status: 'completed' })
  expect(await band()).toEqual(['● Todos (1/2)', '├─ ✓ Three', '└─ ○ Four', ' '])
  await call($, { action: 'update', id: 2, status: 'completed' })
  expect(await band()).toEqual(['○ Todos (2/2)', '├─ ✓ Three', '└─ ✓ Four', ' '])
})

test('a list made and finished in one turn stays until the next turn', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await call($, { action: 'create', subject: 'A' })
  await call($, { action: 'update', id: 1, status: 'completed' })
  const ui = await $.ui.mount({ plugin: 'todos', surface: 'terminal', ...BAND })
  expect(await lines(ui)).toEqual(['○ Todos (1/1)', '└─ ✓ A', ' '])
  await ui.unmount()
})

test('ids restart at #1 once nothing is open, and a failed create keeps the list', () => {
  let s = apply(EMPTY, { action: 'create', subject: 'A' }).state
  s = apply(s, { action: 'create', subject: 'B' }).state
  s = apply(s, { action: 'delete', id: 1 }).state
  expect(apply(s, { action: 'create', subject: 'C' }).text).toBe('Created #3: C (pending)')
  s = apply(s, { action: 'update', id: 2, status: 'completed' }).state
  expect(apply(s, { action: 'create', subject: 'C', blockedBy: [2] })).toEqual({
    state: s,
    text: 'Error: nothing is open, so this create starts a new list at #1; blockedBy cannot name the finished list',
  })
  expect(apply(s, { action: 'create', subject: 'C' }).state).toEqual({
    tasks: [{ id: 1, subject: 'C', status: 'pending' }],
    nextId: 2,
  })
})

test('the band drops blocker ids that the order or a finished task already explains', () => {
  const t = (id: number, status: Task['status'], blockedBy?: number[]) => ({ id, subject: `t${id}`, status, blockedBy })
  const tasks = [t(1, 'in_progress'), t(2, 'pending', [1]), t(3, 'pending', [1, 2]), t(4, 'pending', [5]), t(5, 'pending')]
  expect(chains(tasks, tasks)).toEqual([[], [], [], [5], []])
  expect(chains(tasks.slice(1), [{ ...tasks[0]!, status: 'completed' }, ...tasks.slice(1)])).toEqual([[], [], [5], []])
})

test('the band names a blocker only when the order does not show it', async ($, on) => {
  await start($, on)
  await call($, { action: 'create', subject: 'Plan' })
  await call($, { action: 'create', subject: 'Build', blockedBy: [1] })
  let ui = await $.ui.mount({ plugin: 'todos', surface: 'terminal', ...BAND })
  expect(await lines(ui)).toEqual(['● Todos (0/2)', '├─ ○ Plan', '└─ ○ Build', ' '])
  await ui.unmount()

  await call($, { action: 'create', subject: 'Review' })
  await call($, { action: 'update', id: 1, addBlockedBy: [3] })
  ui = await $.ui.mount({ plugin: 'todos', surface: 'terminal', ...BAND })
  expect(await lines(ui)).toEqual(['● Todos (0/3)', '├─ ○ #1 Plan ⛓ #3', '├─ ○ #2 Build', '└─ ○ #3 Review', ' '])
  await ui.unmount()
})

test('the built-in list tools point at the todo tool', async $ => {
  const ran = await $.tool.call({ tool: 'TodoWrite', todos: [] } as never)
  expect(ran.deny).toContain(TOOL)
})
