---
name: coding
description: Inspect, create, modify, debug, test, or explain source code in a bound Work workspace. Use for implementation tasks, bug fixes, refactoring, project setup, command execution, and file changes.
---

# Coding

## Workflow

1. Inspect the relevant project files before proposing changes.
2. State a short execution plan when the task has multiple steps.
3. Prefer focused edits over replacing an entire existing file.
4. Request approval through the existing tool flow before writing files or running commands.
5. Validate the change with the narrowest useful build, type check, or test.
6. Report the user-facing result and the files changed. Keep internal reasoning private.

## Boundaries

- Work only inside the workspace selected by the user.
- Do not read `.env`, credentials, `.git`, `node_modules`, or paths outside the workspace.
- Do not claim an edit or command succeeded before its tool result confirms success.
- Preserve unrelated user changes.
- Use the project snapshot and Diff mechanism instead of creating Git commits automatically.

## Output

Give the solution first. Mention validation failures or remaining risks plainly and briefly.
