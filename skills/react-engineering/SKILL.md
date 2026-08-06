---
name: react-engineering
description: Build, debug, refactor, and test React interfaces. Use for React components, hooks, state management, rendering behavior, forms, accessibility, responsive UI, streaming interfaces, and frontend performance.
---

# React Engineering

## Workflow

1. Identify component boundaries, data ownership, state transitions, and user interactions.
2. Follow the project's existing component, styling, routing, and data-fetching conventions.
3. Keep render logic pure; use Effects only for synchronization with external systems.
4. Model loading, empty, error, interrupted, approval, and completed states explicitly.
5. Preserve keyboard navigation, semantic markup, focus behavior, and responsive layout.
6. Test behavior from the user's perspective, including async and streaming updates.
7. Verify desktop and narrow viewport layouts after visual changes.

## Engineering Rules

- Do not add memoization by default; optimize after identifying an actual render problem.
- Avoid duplicated state that can be derived from existing state.
- Do not let automatic scrolling override a user who intentionally scrolled away.
- Keep internal Agent prompts, reasoning, retrieval details, and tool payloads out of the UI.
- Preserve the established design language unless the user requests a redesign.
