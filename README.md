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

## Install

The repo is its own plugin marketplace (`.claude-plugin/marketplace.json`):

```sh
claude plugin marketplace add gal-leib/cc-todos
claude plugin install todos@cc-todos
```

Then restart Claude Code. Pick up new versions with `claude plugin marketplace update cc-todos`
and `claude plugin update todos@cc-todos`; bump `version` in both manifests when you release.

## Develop

```sh
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
claude --plugin-dir /path/to/cc-todos   # load the working copy in a session, reloading on save
```
