# Caveman effectiveness and Chief model/effort settings

Research notes from 2026-10-12 and 2026-10-13. All times are Asia/Ho_Chi_Minh (+07).

Sources: read-only research run `wfr_7acdeab5-ad5c-48ca-98cc-1b7ecb407a77` (chief-research `investigate`, 2026-10-12) and the Chief thread `thr_4wgwrv9zqk` chat of 2026-10-12/13.

## Summary

- **Caveman effectiveness.** We asked whether installing caveman made agent runs less effective between 2026-10-08 and 2026-10-12. There was no measurable overall drop, but there was one real problem: on 10-12, caveman hid file contents and agents had to re-read files. Other changes made on 10-09 make it impossible to isolate caveman's effect.
- **Caveman removal.** Caveman was fully removed on 2026-10-13. Ponytail is kept.
- **Model and effort.** Recommended: planner Opus medium -> high, and worker Sonnet high -> medium, tested as one package. Judge it after about a week or about 20 tasks using two numbers: reviewer request-changes share and review rounds per task. Haiku with ultracode effort as the worker is not recommended.

## Caveman effectiveness

Question: did installing caveman make agent runs less effective over 2026-10-08 to 2026-10-12?

### Method

- Caveman went live on 2026-10-09 at about 14:48:40. This was a reinstall: there were earlier installs on 08-12 and 08-13, and caveman was idle from 08-14 to 10-09.
- Evidence for the install time: `~/.zsh_history` lines 10968-10971; `~/.caveman/integrations/claude.json` `installed_at`; the first "Caveman task contract" injection at 14:49:25.
- "Before" = 10-08 to 10-09 14:48. "After" = 10-09 14:48 to 10-12.
- Data: `~/.bb/plugins/chief/data.db` (read-only) and Claude Code transcripts.

### Before/after

| Metric | Before | After |
|---|---|---|
| Worker and reviewer threads that failed (connection) | 0 of 55 | 1 of 52 |
| Reviewer request-changes share | 7/27 (26%) | 4/15 (27%) up to 10-12 09:04, then 4/8 (50%) |
| Review rounds per task (mean) | 1.29 | 2.18 (1.50 without one task that took 9 rounds) |
| Shell command error rate | 5.34% | 5.37% |
| MCP tool errors, excluding calls the user declined | 2.07% | 2.56% |
| `rtk proxy` re-runs per 100 shell calls | 0.73 | 1.93 |

Notes on the table:

- The one failed thread after install was a gpt-6.1-sol 503 "overloaded" error, not caveman.
- The request-changes rise to 50% came after the worker model was changed to Sonnet at 10-12 09:04.

### The 10-12 elision incident

- Between about 09:58 and 14:38 on 10-12, Read output showed `/* caveman: body elided */` instead of file contents.
- Four threads re-read the file with `sed` (for example session `c1d77ab5`, lines 51-53), and one research report said its evidence was degraded.
- Transcripts do not store the placeholder, so the count is undercounted.
- The trigger is unknown.

### Other noise observed in the Chief thread

- Wrong task-type labels on turns.
- File hints unrelated to the task.
- Waiting on long research flagged as a "repeat loop".
- The word "caveman" masked as `<cvm>` in command output.
- Rows dropped from research output.

### Confounders

All within about 15 minutes of the install on 10-09, or later in the window:

- Reviewer switched to pi/cpa gpt-6.1-sol medium at 14:50 on 10-09.
- RTK reinstalled at 14:55 on 10-09.
- Haiku subagent env (`CLAUDE_CODE_SUBAGENT_MODEL=haiku`) appeared.
- Several Chief commits on 10-09.
- Claude Code updated 2.1.295 to 2.1.296 on 10-11.
- 10-10 and 10-11 were a weekend.
- Worker model set to Sonnet 5.5 high on 10-12 09:04.

### Unconfirmed

- Small samples: about 25 reviewers and 11-21 tasks per side.
- Thread state is stored only as its current value, so failures may be undercounted.
- Not verified whether gpt reviewers run through pi, or whether bb-spawned workers loaded caveman.
- Conflicting notes on whether caveman hooks were active before 10-09 (one note saw them on 09-28).
- Caveman's token savings were never measured: token usage is "unavailable" on most rows and cost is 0 everywhere.

## Caveman removal

Done on 2026-10-13.

### Reasons

- Hidden file contents.
- The local proxy sat in front of every model call (`ANTHROPIC_BASE_URL` -> `127.0.0.1:8787`), with 10 "upstream unavailable" errors and a port clash.
- Per-turn noise.
- Evidence masking.
- Its "optimize total complexity, not lines" rules contradict ponytail's "shortest diff wins".
- RTK already shortens command output.

### Steps done

1. Backed up settings.
2. `caveman disable --all` removed the Claude hooks, the proxy route, the MCP entry, and the pi extension `~/.pi/agent/extensions/caveman-native.js`. `ENABLE_TOOL_SEARCH`, which caveman had added, was removed with them.
3. `claude plugin marketplace remove caveman`.
4. Moved the caveman, megacave and ultracave skills to a backup.
5. After restarting bb so that no session used the proxy: stopped the `caveman-proxy` and `caveman-mcp` processes, ran `npm uninstall -g @caveman-ai/cli`, and deleted `~/.caveman` (562 MB, including caveman's own backups).

### Verified

- No caveman CLI, no `~/.caveman`, no caveman process.
- No caveman entries in `~/.claude/settings.json` or `~/.pi/agent/settings.json`.

### Backups and related changes

- Backups are kept in Chief thread storage, `caveman-removal-backup`.
- Ponytail is kept (installed 06-26).
- `~/.claude/CLAUDE.md` was also trimmed, removing the rules that duplicated ponytail/bb instructions (DRY/SOLID skills, simplicity, testing, report headings).

## Model and effort recommendations

### Current settings

| Role | Model | Effort |
|---|---|---|
| chief, planner, advisor, designer | claude-opus-5-5 | medium |
| worker | claude-sonnet-5-5 | high |
| reviewer | pi cpa/gpt-6.1-sol | medium |
| research: survey | Sonnet 5.5 | medium |
| research: review | gpt-6.1-sol | medium |
| research: investigate | Haiku 5.5 | xhigh |

### Paper used

arXiv 2609.20804. Its findings:

- Planning helps weaker executors most.
- Reliable judging needs a strong judge (kappa 0.93).
- Weak models struggle to localize problems unless the question is narrowed.

### Planner: Opus medium -> high

- The planner runs once per task, so the extra cost is small.
- It now also does root-cause work, for example it found the SQLite placeholder bug fixed in PR #107.

### Worker: Sonnet high -> medium

Change this as one package with the planner going to high: a detailed plan removes most of the worker's decisions. Caveats:

- Some workers get no plan (`#simple`, `unplannedReason`, review-fix successors).
- Workers must handle code that differs from the plan.
- Checking (build, fixes, honest reporting) is the worker's job.

### How to judge the package

- Judge after about a week or about 20 tasks.
- Use two numbers: reviewer request-changes share and review rounds per task.
- The weekly digest automation `auto_xpfwmiab9s8` reports both; its first run is 2026-10-19.
- Revert the worker to high if either number rises.

### Haiku with ultracode effort as the worker: not recommended

- Effort adds thinking, not capability.
- Ultracode burns tokens, and failed rounds cost a new worker plus a gpt-6.1-sol review.
- It would confound the experiment.
- Chief has a single worker model setting, so Haiku cannot be used just for small tasks.
- Haiku fits narrow, checked research (`investigate`).
- A later trial on a quiet week is possible, judged by the same two numbers.

### Other

- Reviewer research review is only for large changes or a specific suspicion (merged in PR #106).
- Claude Code settings (`CLAUDE_CODE_SUBAGENT_MODEL=haiku`, `model`, `advisorModel`) do not change Chief role models.
- Unconfirmed: whether the haiku subagent setting applies inside Chief-launched threads.

## Sources

- Research run `wfr_7acdeab5-ad5c-48ca-98cc-1b7ecb407a77` (chief-research `investigate`, 2026-10-12). Full output: `bb workflows history wfr_7acdeab5-ad5c-48ca-98cc-1b7ecb407a77 --cursor 0 --limit 1`.
- Chief thread `thr_4wgwrv9zqk`, chat of 2026-10-12/13.
- `~/.bb/plugins/chief/data.db` (read-only) and Claude Code transcripts.
- `~/.zsh_history` lines 10968-10971; `~/.caveman/integrations/claude.json`.
- arXiv 2609.20804.
- PR #106 (reviewer research review scope), PR #107 (SQLite placeholder fix).
