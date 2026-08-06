---
name: python-engineering
description: Design, implement, debug, test, and review production Python code. Use for Python applications, scripts, APIs, data processing, packaging, virtual environments, typing, pytest, async code, and performance work.
---

# Python Engineering

## Workflow

1. Confirm the Python version, runtime, inputs, outputs, and operational constraints.
2. Inspect the existing package structure and dependency conventions before editing.
3. Prefer standard-library solutions unless an existing dependency is clearly appropriate.
4. Add useful type annotations and keep runtime behavior consistent with those types.
5. Handle expected failures explicitly; do not hide programming errors behind broad exceptions.
6. Cover boundary conditions, I/O failures, concurrency behavior, and cleanup paths.
7. Validate with the project's formatter, type checker, and focused pytest tests when available.

## Engineering Rules

- Preserve the active virtual-environment and dependency-management approach.
- Avoid mutable default arguments, silent exception swallowing, and unnecessary global state.
- Stream large files instead of loading them fully into memory.
- Use async only when the surrounding stack and workload benefit from it.
- Keep examples runnable and indicate the required command.
