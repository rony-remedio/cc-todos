import type { Task, TaskState, TaskStatus } from '../types'

export type TaskAction = 'create' | 'update' | 'list' | 'get' | 'delete' | 'clear'

export type TaskParams = {
  action: TaskAction
  subject?: string
  description?: string
  activeForm?: string
  status?: TaskStatus
  blockedBy?: number[]
  addBlockedBy?: number[]
  removeBlockedBy?: number[]
  owner?: string
  id?: number
  includeDeleted?: boolean
}

export const EMPTY: TaskState = { tasks: [], nextId: 1 }

// completed is one-way to deleted; deleted is terminal.
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['in_progress', 'completed', 'deleted'],
  in_progress: ['pending', 'completed', 'deleted'],
  completed: ['deleted'],
  deleted: [],
}

export const isOpen = (t: Task) => t.status === 'pending' || t.status === 'in_progress'

const isTransitionValid = (from: TaskStatus, to: TaskStatus) =>
  from === to || TRANSITIONS[from].includes(to)

export function hasCycle(tasks: readonly Task[], id: number, blockedBy: readonly number[]): boolean {
  const edges = new Map(tasks.map(t => [t.id, t.id === id ? [...blockedBy] : (t.blockedBy ?? [])]))
  const visiting = new Set<number>()
  const done = new Set<number>()
  const walk = (node: number): boolean => {
    if (visiting.has(node)) return true
    if (done.has(node)) return false
    visiting.add(node)
    const found = (edges.get(node) ?? []).some(walk)
    visiting.delete(node)
    done.add(node)
    return found
  }
  return [...edges.keys()].some(walk)
}

const ids = (list: readonly number[]) => list.map(n => `#${n}`).join(',')

function listLine(t: Task): string {
  const form = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : ''
  const block = t.blockedBy?.length ? ` ⛓ ${ids(t.blockedBy)}` : ''
  return `[${t.status}] #${t.id} ${t.subject}${form}${block}`
}

function getLines(task: Task, state: TaskState): string {
  const blocks = state.tasks.filter(t => t.blockedBy?.includes(task.id)).map(t => t.id)
  const lines = [`#${task.id} [${task.status}] ${task.subject}`]
  if (task.description) lines.push(`  description: ${task.description}`)
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`)
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map(n => `#${n}`).join(', ')}`)
  if (blocks.length) lines.push(`  blocks: ${blocks.map(n => `#${n}`).join(', ')}`)
  if (task.owner) lines.push(`  owner: ${task.owner}`)
  return lines.join('\n')
}

function sameTask(a: Task, b: Task): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Applies one `todo` call: the next state and the text the model reads. */
export function apply(state: TaskState, p: TaskParams): { state: TaskState; text: string } {
  const fail = (message: string) => ({ state, text: `Error: ${message}` })

  switch (p.action) {
    case 'create': {
      if (!p.subject?.trim()) return fail('subject required for create')
      // Nothing open means the last list is done: a new one starts again at #1.
      const base = state.tasks.some(isOpen) ? state : EMPTY
      if (base !== state && state.tasks.length && p.blockedBy?.length) {
        return fail('nothing is open, so this create starts a new list at #1; blockedBy cannot name the finished list')
      }
      for (const dep of p.blockedBy ?? []) {
        const depTask = base.tasks.find(t => t.id === dep)
        if (!depTask) return fail(`blockedBy: #${dep} not found`)
        if (depTask.status === 'deleted') return fail(`blockedBy: #${dep} is deleted`)
      }
      const task: Task = { id: base.nextId, subject: p.subject, status: 'pending' }
      if (p.description) task.description = p.description
      if (p.activeForm) task.activeForm = p.activeForm
      if (p.blockedBy?.length) task.blockedBy = [...p.blockedBy]
      if (p.owner) task.owner = p.owner
      return {
        state: { tasks: [...base.tasks, task], nextId: base.nextId + 1 },
        text:
          `Created #${task.id}: ${task.subject} (pending)` +
          (base !== state && state.tasks.length ? '. Started a new list: earlier task ids no longer apply.' : ''),
      }
    }

    case 'update': {
      if (p.id === undefined) return fail('id required for update')
      const idx = state.tasks.findIndex(t => t.id === p.id)
      if (idx === -1) return fail(`#${p.id} not found`)
      const current = state.tasks[idx]!

      const hasMutation =
        p.subject !== undefined ||
        p.description !== undefined ||
        p.activeForm !== undefined ||
        p.status !== undefined ||
        p.owner !== undefined ||
        !!p.addBlockedBy?.length ||
        !!p.removeBlockedBy?.length
      if (!hasMutation) {
        return fail(
          'update requires at least one mutable field: subject, description, activeForm, status, owner, addBlockedBy, or removeBlockedBy',
        )
      }

      const status = p.status ?? current.status
      if (!isTransitionValid(current.status, status)) {
        return fail(`illegal transition ${current.status} → ${status}`)
      }

      const remove = new Set(p.removeBlockedBy ?? [])
      const blockedBy = (current.blockedBy ?? []).filter(dep => !remove.has(dep))
      if (p.addBlockedBy?.length) {
        for (const dep of p.addBlockedBy) {
          if (dep === current.id) return fail(`cannot block #${current.id} on itself`)
          const depTask = state.tasks.find(t => t.id === dep)
          if (!depTask) return fail(`addBlockedBy: #${dep} not found`)
          if (depTask.status === 'deleted') return fail(`addBlockedBy: #${dep} is deleted`)
          if (!blockedBy.includes(dep)) blockedBy.push(dep)
        }
        if (hasCycle(state.tasks, current.id, blockedBy)) {
          return fail('addBlockedBy would create a cycle in the blockedBy graph')
        }
      }

      const updated: Task = { ...current, status }
      if (p.subject !== undefined) updated.subject = p.subject
      if (p.description !== undefined) updated.description = p.description
      if (p.activeForm !== undefined) updated.activeForm = p.activeForm
      if (p.owner !== undefined) updated.owner = p.owner
      if (blockedBy.length) updated.blockedBy = blockedBy
      else delete updated.blockedBy

      // Saying "No change" keeps a model from re-sending the same update in a loop.
      if (sameTask(current, updated)) {
        return { state, text: `No change: #${current.id} already matches the requested values (status: ${status})` }
      }
      const tasks = [...state.tasks]
      tasks[idx] = updated
      const transition = current.status !== status ? ` (${current.status} → ${status})` : ''
      return { state: { ...state, tasks }, text: `Updated #${current.id}${transition}` }
    }

    case 'list': {
      let view = state.tasks
      if (!p.includeDeleted) view = view.filter(t => t.status !== 'deleted')
      if (p.status) view = view.filter(t => t.status === p.status)
      return { state, text: view.length === 0 ? 'No tasks' : view.map(listLine).join('\n') }
    }

    case 'get': {
      if (p.id === undefined) return fail('id required for get')
      const task = state.tasks.find(t => t.id === p.id)
      if (!task) return fail(`#${p.id} not found`)
      return { state, text: getLines(task, state) }
    }

    case 'delete': {
      if (p.id === undefined) return fail('id required for delete')
      const idx = state.tasks.findIndex(t => t.id === p.id)
      if (idx === -1) return fail(`#${p.id} not found`)
      const current = state.tasks[idx]!
      if (current.status === 'deleted') return fail(`#${current.id} is already deleted`)
      const tasks = [...state.tasks]
      tasks[idx] = { ...current, status: 'deleted' }
      return { state: { ...state, tasks }, text: `Deleted #${current.id}: ${current.subject}` }
    }

    case 'clear':
      return { state: EMPTY, text: `Cleared ${state.tasks.length} tasks` }

    default:
      return fail(`unknown action ${String((p as { action: unknown }).action)}`)
  }
}

export type Layout = { visible: Task[]; hiddenCompleted: number; truncatedTail: number }

/**
 * Fits `tasks` into `budget` rows: completed rows go first, then the tail of
 * the unfinished ones, one row kept for the "+N more" summary.
 */
export function layout(tasks: readonly Task[], budget: number): Layout {
  if (tasks.length <= budget) return { visible: [...tasks], hiddenCompleted: 0, truncatedTail: 0 }
  const inner = budget - 1
  const open = tasks.filter(t => t.status !== 'completed')
  const totalCompleted = tasks.length - open.length
  if (open.length > inner) {
    return { visible: open.slice(0, inner), hiddenCompleted: totalCompleted, truncatedTail: open.length - inner }
  }
  const kept = new Set(open)
  for (const t of tasks) {
    if (kept.size >= inner) break
    if (t.status === 'completed') kept.add(t)
  }
  const visible = tasks.filter(t => kept.has(t))
  const shown = visible.filter(t => t.status === 'completed').length
  return { visible, hiddenCompleted: totalCompleted - shown, truncatedTail: 0 }
}

/**
 * The blockers each band row shows: open ones not drawn above it, since the
 * band already reads top-down.
 */
export function chains(visible: readonly Task[], tasks: readonly Task[]): number[][] {
  const open = new Set(tasks.filter(isOpen).map(t => t.id))
  return visible.map((t, i) => {
    const above = new Set(visible.slice(0, i).map(v => v.id))
    return (t.blockedBy ?? []).filter(n => open.has(n) && !above.has(n))
  })
}

/** The `/todos` report, grouped by status. */
export function report(state: TaskState): string {
  const live = state.tasks.filter(t => t.status !== 'deleted')
  if (live.length === 0) return 'No todos yet. Ask the agent to add some!'
  const pending = live.filter(t => t.status === 'pending')
  const active = live.filter(t => t.status === 'in_progress')
  const completed = live.filter(t => t.status === 'completed')

  const header: string[] = []
  if (completed.length) header.push(`${completed.length}/${live.length} completed`)
  if (active.length) header.push(`${active.length} in progress`)
  if (pending.length) header.push(`${pending.length} pending`)

  const line = (t: Task, glyph: string) => {
    const form = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : ''
    const block = t.blockedBy?.length ? `    ⛓ ${ids(t.blockedBy)}` : ''
    return `  ${glyph} #${t.id} ${t.subject}${form}${block}`
  }
  const lines = [header.join(' · ')]
  if (pending.length) lines.push('── Pending ──', ...pending.map(t => line(t, '○')))
  if (active.length) lines.push('── In Progress ──', ...active.map(t => line(t, '◐')))
  if (completed.length) lines.push('── Completed ──', ...completed.map(t => line(t, '✓')))
  return lines.join('\n')
}
