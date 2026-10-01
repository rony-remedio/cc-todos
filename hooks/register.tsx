import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task } from '../types'
import { apply, EMPTY, layout, report } from './tasks'
import type { TaskParams } from './tasks'

const TOOL = 'mcp__todos__todo'
const MAX_ROWS = 12

const list = atom({ plugin: 'todos', key: 'list' } as const, EMPTY)
const faded = atom({ plugin: 'todos', key: 'faded' } as const, [])

// The built-in list tools would split the plan in two; they point the model here.
const BUILTIN_LISTS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']

const DESCRIPTION = `Manage a task list for tracking multi-step progress; the person sees it live above their prompt.
Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all).

- Use it for complex work with 3+ steps, when the user gives you a list of tasks, or right after new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.
- Mark a task in_progress BEFORE starting it, and completed IMMEDIATELY when done; never batch completions. Exactly one task in_progress at a time.
- Never mark a task completed while tests fail, the work is partial or errors are unresolved: keep it in_progress and create a task for the blocker.
- Status is pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous, e.g. "writing tests") when marking in_progress.
- To change status: {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. An update with no mutable field is rejected.
- Dependencies: blockedBy on create; addBlockedBy / removeBlockedBy on update (additive, do not resend the full array). Cycles are rejected.
- list hides deleted tasks unless includeDeleted:true; pass status to filter.
- subject is short and imperative ("Research existing tool"); description holds long-form detail.`

const STATUS = { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] }
const IDS = { type: 'array', items: { type: 'number' } }

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'update', 'list', 'get', 'delete', 'clear'] },
    subject: { type: 'string', description: 'Task subject line (required for create)' },
    description: { type: 'string', description: 'Long-form task description' },
    activeForm: {
      type: 'string',
      description: "Present-continuous label shown while status is in_progress (e.g. 'writing tests')",
    },
    status: {
      ...STATUS,
      description: "Set this task's status (update). With list, filters the returned tasks by this status.",
    },
    blockedBy: { ...IDS, description: 'Initial blockedBy ids (create only)' },
    addBlockedBy: { ...IDS, description: 'Task ids to add to blockedBy (update only, additive merge)' },
    removeBlockedBy: { ...IDS, description: 'Task ids to remove from blockedBy (update only)' },
    owner: { type: 'string', description: 'Agent/owner assigned to this task' },
    id: { type: 'number', description: 'Task id (required for update, get, delete)' },
    includeDeleted: { type: 'boolean', description: 'list: include deleted tasks too. Default false.' },
  },
  required: ['action'],
}

const GLYPH = { pending: '○', in_progress: '◐', completed: '✓', deleted: '✗' } as const
const GLYPH_COLOR = { pending: 'inactive', in_progress: 'warning', completed: 'success', deleted: 'error' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'todo', description: DESCRIPTION, inputSchema: INPUT_SCHEMA })
    await $.command.register({ name: 'todos', description: 'Show all todos, grouped by status' })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { tool: _tool, tool_use_id: _id, ...params } = e as unknown as TaskParams & {
      tool: string
      tool_use_id: string
    }
    let text = ''
    await update($, list, state => {
      const out = apply(state, params)
      text = out.text
      return out.state
    })
    // ids restart at 1 after a clear, so an old faded id would hide a new task.
    if (params.action === 'clear') await update($, faded, () => [])

    return { result: text }
  })

  on('tool.call', ($, e, next) =>
    BUILTIN_LISTS.includes(e.tool)
      ? { deny: `This session tracks tasks with ${TOOL} (the person sees that list). Use it instead of ${e.tool}.` }
      : next(e),
  )

  // A completed row stays for the rest of the turn it was completed in.
  on('turn.start', async ($, e, next) => {
    const { tasks } = await read($, list)
    await update($, faded, () => tasks.filter(t => t.status === 'completed').map(t => t.id))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, list, () => EMPTY)
      await update($, faded, () => [])
    }

    return next(e)
  })

  on('command.run', { command: 'todos' }, async $ => ({ text: report(await read($, list)) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { tasks } = await read($, list)
    const hidden = new Set(await read($, faded))
    const shown = tasks.filter(t => t.status !== 'deleted' && !hidden.has(t.id))
    if (shown.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const done = shown.filter(t => t.status === 'completed').length
    const isActive = done < shown.length
    const showIds = shown.some(t => t.blockedBy?.length)
    // Heading and the trailing spacer take a row each.
    const rows = Math.max(3, Math.min(MAX_ROWS, e.props.maxRows - 1))
    const { visible, hiddenCompleted, truncatedTail } = layout(shown, rows - 1)
    const more = hiddenCompleted + truncatedTail

    const row = (t: Task, isLast: boolean) => {
      const isDone = t.status === 'completed'
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{isLast ? '└─ ' : '├─ '}</Text>
          <Text color={GLYPH_COLOR[t.status]}>{GLYPH[t.status]} </Text>
          {showIds && <Text dimColor>#{t.id} </Text>}
          <Text color={t.status === 'in_progress' ? 'claude' : undefined} dimColor={isDone} strikethrough={isDone}>
            {t.subject}
          </Text>
          {t.status === 'in_progress' && t.activeForm && <Text dimColor> ({t.activeForm})</Text>}
          {!!t.blockedBy?.length && <Text dimColor> ⛓ {t.blockedBy.map(n => `#${n}`).join(',')}</Text>}
        </Text>
      )
    }

    const summary: string[] = []
    if (hiddenCompleted) summary.push(`${hiddenCompleted} completed`)
    if (truncatedTail) summary.push(`${truncatedTail} pending`)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text color={isActive ? 'claude' : undefined} dimColor={!isActive}>
          {isActive ? '●' : '○'} Todos ({done}/{shown.length})
        </Text>
        {visible.map((t, i) => row(t, more === 0 && i === visible.length - 1))}
        {more > 0 && (
          <Text dimColor wrap="truncate-end">
            └─ +{more} more ({summary.join(', ')})
          </Text>
        )}
        <Text> </Text>
      </Box>
    )
  })
}
