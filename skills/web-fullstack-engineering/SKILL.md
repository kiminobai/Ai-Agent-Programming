---
name: web-fullstack-engineering
description: Design and deliver end-to-end web features across frontend, API, persistence, authentication, file handling, and deployment. Use for full-stack applications, API contracts, databases, security boundaries, uploads, streaming, and production delivery.
---

# Web Full-Stack Engineering

## Workflow

1. Map the request across UI, API, domain logic, storage, authorization, and deployment.
2. Define request and response contracts before implementing both sides.
3. Keep validation at trust boundaries and return actionable user-safe errors.
4. Preserve transaction, idempotency, retry, and cancellation behavior where operations can repeat.
5. Store durable state in the correct database or local Work storage rather than process memory.
6. Stream long-running output without losing final persistence.
7. Test the critical user flow across frontend and backend, not only individual functions.

## Engineering Rules

- Keep Chat cloud storage and Work local storage boundaries explicit.
- Use relative resource identifiers in persisted records; construct deployment URLs at runtime.
- Treat uploads as staged until validation and processing complete.
- Never expose secrets, internal filesystem paths, hidden prompts, or raw provider errors.
- Make schema changes idempotent and safe across application restarts.
