import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { apply, EMPTY, layout } from '../hooks/tasks'

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

test('a completed row fades at the next turn', async ($, on) => {
  await start($, on)
  await call($, { action: 'create', subject: 'One' })
  await call($, { action: 'create', subject: 'Two' })
  await call($, { action: 'update', id: 1, status: 'completed' })

  let ui = await $.ui.mount({ plugin: 'todos', surface: 'terminal', ...BAND })
  expect(await lines(ui)).toEqual(['● Todos (1/2)', '├─ ✓ One', '└─ ○ Two', ' '])
  await ui.unmount()

  await $.turn.start({ text: 'next', turnId: 't2' })
  ui = await $.ui.mount({ plugin: 'todos', surface: 'terminal', ...BAND })
  expect(await lines(ui)).toEqual(['● Todos (0/1)', '└─ ○ Two', ' '])
  await ui.unmount()
})

test('the built-in list tools point at the todo tool', async $ => {
  const ran = await $.tool.call({ tool: 'TodoWrite', todos: [] } as never)
  expect(ran.deny).toContain(TOOL)
})
