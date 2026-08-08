# Slim Guard Copilot review rules

`AGENTS.md` is the source of truth for repository and agent guidance. This
file is a short review-focused distillation for Copilot surfaces that do not
load the full hierarchy. Update `AGENTS.md` first when a rule changes.

- Reject changes that expose unauthorized Tools or allow a business Tool to
  reach the upstream server more than once.
- Reject changes that make `read_result` execute an upstream business Tool or
  lose exact result recovery.
- Require deterministic focused tests for behavior changes and the smallest
  complete verification matrix from `AGENTS.md`.
- Treat `any`, unchecked boundary casts, sensitive logs, private paths, and
  unsupported benchmark claims as review findings.
- Keep public runtime code, private evaluation material, and release actions
  in their separate boundaries.
