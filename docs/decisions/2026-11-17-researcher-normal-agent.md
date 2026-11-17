# Researcher is a normal agent with a role model

## Context

Chief's research ran as a BB workflow. A researcher thread only relayed the call and polled the run. Each mode had its own model pick and its own timeout, and a server cap limited agent calls.

## Decision

The researcher is a normal managed thread. It decides whether to answer alone or to split the question across up to 6 helper threads. Its model is a `researcher` row in Chief models by machine, like the Worker row. The workflow path stays for the retro judge only.

Rejected: a server-side helper scheduler, a per-mode timeout, and a runtime fallback to another role's model.

## Consequence

- The helper cap and the read-only rule are prompt rules, with no server enforcement.
- A researcher that waits on helpers can raise the stall alert. The stall alert replaces the hard timeout.
- Upgrading needs a manual cutover of live research runs before the merge.
- The retro judge follows the researcher pick.
