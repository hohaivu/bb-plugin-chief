# Software Factory

This page shows how Chief turns one owner request into a merged pull request. The sequence chart shows who messages whom. The tables list the roles and the support tools.

> **Keep this page current.** When a change alters a tool, a role kind, a gate, or the order of steps, update the charts and tables in the same pull request. The code and the skills win over this page: `server.ts`, `src/core/roles.ts`, `skills/chief/SKILL.md`, and the README "Workflow" and "Planning" sections.

## Chart

> **Note.** The waves of one chain run one after another on one branch, each worker continuing the last through `replaces:`. Separate chains (separate branches and pull requests, started with `dependsOn: []`) can run in parallel.

A solid arrow is a tool call or a push. A dashed arrow is a `chief_report` that the plugin turns into a lifecycle alert for Chief, or an owner message. Every managed thread reports to Chief only. Threads never message each other. The one exception is the pull-only plan log (`chief_log`), which carries no alert.

```mermaid
sequenceDiagram
  autonumber
  actor Owner
  participant Chief
  participant Researcher
  participant Planner
  participant Advisor
  participant Designer
  participant SpecWriter as Spec Writer
  participant Worker
  participant Tester
  participant Reviewer
  participant Forge as Forge / GitHub

  Owner->>Chief: request (or tracker task)
  opt scope unclear
    Chief->>Researcher: chief_research
    Researcher-->>Chief: report (findings)
  end
  Chief->>Planner: chief_plan
  Planner-->>Chief: report with plan, alert lists waves and next call

  opt more than one implementation wave, or planner marked complex
    Chief->>Advisor: chief_consult planThreadId
    Advisor-->>Chief: report (advice, one review only)
    opt request_changes
      Chief->>Planner: chief_plan revises (fresh planner)
      Planner-->>Chief: revised plan, no second review
    end
  end

  Chief->>Forge: chief_forge_init, once per chain head
  Forge-->>Chief: branch, issue_url, pr_url (draft PR)

  opt design-only wave
    Chief->>Designer: chief_delegate kind designer
    Designer->>Forge: git push to task branch
    Designer-->>Chief: report (artboards)
    Chief->>Owner: ask approval of artboards
    Owner-->>Chief: approval, Chief calls chief_owner_approval
  end

  opt wave marked spec: true
    Chief->>SpecWriter: chief_delegate kind spec-writer
    SpecWriter->>Forge: git push docs/ only
    SpecWriter-->>Chief: report, alert names the worker call
  end

  loop each wave of the chain, later waves use replaces:
    Chief->>Worker: chief_delegate, one worker for this wave
    Worker->>Forge: git push to task branch
    Worker-->>Chief: report (ready, or blocked with a split)
    Note over Chief,Worker: no review between waves. A blocked report leads to a new chief_plan for the rest
  end
  Note over Chief,Worker: for a big feature the planner adds one optional reshape wave after the last feature wave. It is an ordinary worker wave in this loop

  Chief->>Tester: chief_delegate replaces: kind tester
  Tester->>Forge: git push tests
  Tester-->>Chief: report, alert names chief_review

  Chief->>Reviewer: chief_review, one review of the whole plan
  Reviewer-->>Chief: report with verdict approve or request_changes
  Note over Chief,Forge: the plugin posts each verdict, a blocked worker and the result on the PR

  loop while the verdict is request_changes, counted in a row on the task
    alt 1st rejection
      Chief->>Worker: fresh worker, chief_delegate replaces: with the findings
    else 2nd rejection
      Chief->>Advisor: chief_consult on the worker, before any new replaces:
      Advisor-->>Chief: report (advice), the next replaces: is refused until it arrives
      Chief->>Worker: one more fresh worker, chief_delegate replaces: with the advice
    else 3rd rejection, stop
      Chief->>Forge: chief_escalate posts Need you with @owner
      Chief->>Owner: Need you in chat, no new worker starts
      Owner-->>Chief: decision (chat, or an answer on the tracker task)
      opt owner authorizes one more round
        Chief->>Worker: chief_delegate replaces: userApprovedRound true
      end
    end
    Worker-->>Chief: report (ready)
    Chief->>Reviewer: chief_review again
    Reviewer-->>Chief: report with verdict
  end
  Note over Chief,Owner: if the owner does not authorize a round at the stop, the work ends there. An approve resets the count

  opt any other decision only the owner can make
    Chief->>Owner: Need you, also posted with chief_escalate
    Owner-->>Chief: decision
  end

  Note over Chief,Forge: only after an approve of the PR head, or skipReview or override with a reason
  Chief->>Forge: chief_complete marks the PR ready
  Owner->>Forge: merge
```

## Support tools

Support tools run beside the pipeline. This chart shows who reaches Chief and who does not.

```mermaid
flowchart LR
  Roster["chief_roster Pending block, lifecycle alerts, stall alerts"] --> Chief
  Tracker["Tracker (optional): mirrors work to tasks"] <--> Chief
  Chief --> Escalate["chief_escalate: Need you on the PR or issue"]
  Coordinator["Coordinator: chief_coordinate, chief_attach, chief_spawn"] --> Child["Child Chiefs, any project"]
  Child -- "Need you or done" --> Coordinator
  Chief -. "chief_stop on a stuck thread" .-> Threads["Managed threads"]
  Threads -- "chief_report" --> Roster
```

| Tool | Use |
| --- | --- |
| `chief_research` | Read-only survey or investigation by a researcher thread. Chief uses it before a plan or to check doubtful evidence. |
| `chief_consult` | Read-only advisor. It gives a plan its one review, and Chief must call it after the second `request_changes` in a row. |
| `chief_roster` | Starts every Chief turn. Its Pending block is the work list. |
| `chief_escalate` | Posts a **Need you** request on the pull request or issue with an @mention of the owner. Chief also writes it in chat. |
| `chief_stop` | Interrupts a stuck thread. It keeps the worktree, branch and history. |
| `chief_coordinate` | Upgrades a Chief to a Coordinator. It wakes only on a child's Need you or done. |
| Tracker | Mirrors each plan or unplanned worker to a task. The owner's answer on the task reaches Chief once, as an alert. |

## Gates

| Step | Rule |
| --- | --- |
| Plan | With planning on, `chief_delegate` refuses a call without `planThreadId` and `wave`, unless it carries `unplannedReason`. A plan has 2 to 8 waves. Each chain ends with a test wave. |
| Plan review | `chief_forge_init` and `chief_delegate` refuse a qualifying plan until its one advisor review resolves. There is no skip. |
| Forge | Chief owns the forge. `chief_forge_init` runs on a chain head with no worker yet. A worker never touches the pull request. |
| Review | `chief_review` is refused for an intermediate wave, a design wave, and while any wave is not ready. `skipReview` on `chief_complete` needs a reason. |
| Complete | `chief_complete` needs the newest review to approve the PR's current head. `skipReview` or `override` with a reason bypass it. A design wave needs the owner's approval. A Spec Writer is never completed. |
| Merge | Only the owner merges. Chief never merges. |

## Roles inside a plan chain

A plan chain has one branch, one pull request and one worker worktree. Worker kinds come from `workerKindSchema` in `src/core/roles.ts`. Planner, Advisor, Researcher and Reviewer are thread roles.

| Role | Kind or thread role | Job | Waived by |
| --- | --- | --- | --- |
| Designer | `kind: "designer"` | Decides or implements how the UI looks. A design-only wave draws artboards. | n/a |
| Spec Writer | `kind: "spec-writer"` | Changes only `docs/`. Runs first on a `spec: true` wave. | `chief_skip_specs` |
| Worker | `kind: "worker"` | Implements one wave. It never writes tests. A reshape wave is also a worker. | n/a |
| Tester | `kind: "tester"` | Writes and runs the tests for the waves it builds on. | `chief_skip_tests`, or `testsSkipped` on `chief_complete` |
| Reviewer | thread role `reviewer` | Reports a `verdict` of `approve` or `request_changes`. It never edits. | `skipReview` |
| Planner | thread role `planner` | Read-only. Splits the work into waves. | `unplannedReason` |
| Advisor | thread role `advisor` | Read-only. Reviews a plan or helps a stuck review. | n/a |
| Researcher | thread role `researcher` | Read-only. Runs `chief_research` and reports the findings. | Optional |

A fresh worker takes every follow-up through `replaces:`. A worker that already reported is never reused.

## Related

- [Plan chains](specs/plan-chains.md)
- [Review engine](specs/review-engine.md)
- [Work list](specs/work-list.md)
- [Coordinator](specs/coordinator.md)
- [Tracker](specs/tracker.md)
- [Forge comments](specs/forge-comments.md)
