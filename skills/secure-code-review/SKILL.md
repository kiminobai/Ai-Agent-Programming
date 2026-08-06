---
name: secure-code-review
description: Perform evidence-based security and correctness review of application code. Use for authentication, authorization, uploads, filesystem access, command execution, databases, secrets, model tools, prompt injection, and other trust-boundary reviews.
---

# Secure Code Review

## Workflow

1. Identify assets, trust boundaries, entry points, privileged operations, and persisted state.
2. Trace untrusted input to filesystem, command, SQL, HTML, model, and network sinks.
3. Verify authentication and authorization independently.
4. Check path containment, upload lifecycle, secret handling, injection, and data isolation.
5. Check approval timing: protected operations must occur only after approval succeeds.
6. Confirm cancellation, retries, and duplicate requests cannot repeat side effects unexpectedly.
7. Report only evidence-backed findings with trigger conditions and practical fixes.

## Boundaries

- Do not label a theoretical possibility as exploitable without a reachable path.
- Do not reveal real secrets or reproduce sensitive values in findings.
- Do not modify reviewed code unless the user explicitly requests remediation.
- Prioritize exploitable behavior and data loss over stylistic hardening.
