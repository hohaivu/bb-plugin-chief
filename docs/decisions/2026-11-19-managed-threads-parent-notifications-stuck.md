# Managed threads use BB stuck notices

## Context

BB sends the parent a `completed` notice for each managed thread under the default `auto` setting. The plugin's report alert already carries each report. The duplicate notice could arrive before the richer alert. Under `auto`, the completed notice was also the only signal for a turn that ended without a report.

## Decision

Each thread spawned through `launch` gets `parentNotifications: "stuck"`. The plugin's alerts cover completion and a turn that ends without a report. BB keeps the failed, interrupted and needs-attention notices.

## Consequence

- Chief gets one no-report alert for each turn that ends idle without a report receipt. This covers managed threads that a Chief owns, not Chief threads. A ready, blocked or complete row sends none.
- Threads spawned with `stuck` get no BB `completed` notice. Threads spawned earlier keep `auto` and their notice until they are replaced.
- Chief threads have no parent and keep their own setting. The pr-agent helper keeps `off`.
