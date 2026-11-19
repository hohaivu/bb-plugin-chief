# Managed threads use BB stuck notices

## Context

BB sends the parent a `completed` notice for each managed thread under the default `auto` setting. The plugin's report alert already carries each report. The duplicate notice could arrive before the richer alert. Under `auto`, the completed notice was also the only signal for a turn that ended without a report.

## Decision

Each managed thread spawns with `parentNotifications: "stuck"`. The plugin's alerts cover completion and a turn that ends without a report. BB keeps the failed, interrupted and needs-attention notices.

## Consequence

- Chief gets one no-report alert for each turn that ends without `chief_report`.
- Chief receives no BB `completed` notice for a managed thread.
- Live threads keep `auto` until they are replaced.
- Chief threads have no parent and keep their own setting.
