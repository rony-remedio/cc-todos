# cc-todos

A Claude Code mod modelled on [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) for Pi:
a `todo` tool for the model, a live task band above the prompt, and `/todos`.

```
● Todos (2/5)
├─ ✓ Create DemoTodo domain entity
├─ ✓ Create IDemoTodoRepository interface
├─ ◐ Create DemoTodoRepository (creating the repository)
├─ ○ Register DI bindings
└─ ○ Add integration tests
```

- **Tool** `mcp__todos__todo`: `create / update / list / get / delete / clear`, status machine
  `pending → in_progress → completed` plus a `deleted` tombstone, `blockedBy` with cycle detection.
- **Band** above the prompt, up to 12 rows. Overflow drops completed rows first and truncates
  unfinished ones last (`+3 more (2 completed, 1 pending)`). Completed rows fade at the next turn.
  Collapse it with the band's own control (ctrl+x ctrl+a).
- **`/todos`** prints the full list grouped by status.
- The built-in `TodoWrite` / `Task*` list tools are refused with a pointer to `todo`, so there is one plan.
- State lives in the session (`$.state`): it survives hot reloads and compaction, and `/clear` resets it.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir /home/dev/work/cc-todos   # load it in any session
```
