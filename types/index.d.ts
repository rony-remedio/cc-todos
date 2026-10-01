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
      // Completed ids already shown for a full turn; the band drops them.
      faded: number[]
    }
  }
}
