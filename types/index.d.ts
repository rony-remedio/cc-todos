export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export type Task = {
  id: number
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  blockedBy?: number[]
  owner?: string
}

export type TaskState = { tasks: Task[]; nextId: number }

declare module 'claude-code' {
  interface PluginState {
    todos: {
      list: TaskState
      // Set at a turn start that finds no open task; the band then drops completed rows.
      hideCompleted: boolean
    }
  }
}
