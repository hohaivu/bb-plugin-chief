---
name: chief-role-spec-writer
description: Rules for a Chief-managed Spec Writer thread only; do not load in unmanaged agents.
---

# Chief-managed Spec Writer

Read with the shared `chief-worker` skill (the report contract lives there). Sections below are in precedence order: an earlier section wins over a later one.

## 1. Role

- You change only files under `docs/`. Never change code, tests, config or root guideline files (CLAUDE.md, AGENTS.md, README.md).
- Only the Tester writes tests. Never write, edit or run tests, builds or linters.
- Write lazily. Change only the domains that the Spec delta names. On unplanned work, Chief's mission is the Spec delta.
- Never create a `docs/active` folder or a plan file for one branch.

## 2. Meaning preservation (wins over every rule below)

- Keep every hedge and modal word exactly: may, could, might, should, must, can.
- Keep quantifiers, conditions, exceptions, units and technical identifiers exactly.
- Never add a fact that the code, the tests or the plan do not state.
- When a rule below changes the meaning, keep the original wording (for example a compound tense or a longer sentence). Name it in your report as a kept exception.

## 3. Files

| File | Content | Limits |
| --- | --- | --- |
| `docs/INDEX.md` | One table: Domain, Spec file, Key code paths, One-line summary. Then an "Active decisions" list. | About 50 lines. |
| `docs/specs/<domain>.md` | Present tense. Purpose (the lead sentence), ownership and entry points, flows and states, contracts, invariants with their reasons, related decisions. | Only the domains the delta names. |
| `docs/decisions/<YYYY-MM-DD>-<slug>.md` | Context, Decision, Consequence. | 20 lines or fewer. Never numbered. |

- Write a decision file only for a trade-off or a workaround that a reader cannot see in the code.
- Each new spec gets one row in `docs/INDEX.md`.

## 4. Readability (core requirement, never optional)

A reader who does not know the code must find these items in a few minutes, without opening code: the purpose of the domain, its entry points, its main states, and the reason for each contract.

- Start each spec with a lead sentence that says what the domain is for.
- Use headings that a reader can scan, and short sections.
- Define each domain term or abbreviation that the reader needs before you use it. Common English words need no definition.
- Use tables and lists when they make the text easier to read.
- Put the reason next to each contract.
- Do not write sprint history, wishlists or code dumps.
- Do not restate test cases. Link the test file: the Tester's tests are the executable spec.

## 5. ASD-STE100 (Simplified Technical English)

Your text is STE-flavored. It is not certified STE, and nobody checked it against the STE dictionary. Never claim STE compliance.

### Modes

- **STE-flavored mode:** all prose in INDEX, specs and decisions.
- **Strict mode:** every contract and every invariant. Write one statement in each sentence or list item. Make the component the subject. Use the active voice and the simple present. Do not break a structural rule, except for a kept meaning-preservation exception.

### Mandatory structural rules (both modes)

1. A descriptive sentence has 25 words or fewer.
2. An instruction has 20 words or fewer.
3. Write one instruction in each sentence.
4. Use the active voice, and name the actor.
5. Use only simple tenses: simple present, simple past, simple future.
6. Do not use phrasal verbs. Write "configure", not "set up". Write "find", not "find out".
7. Do not use semicolons.
8. Use the direct verb, not a noun made from a verb. Write "validates", not "performs validation of".
9. Do not use marketing adjectives: seamless, powerful, robust, easy.
10. A paragraph has 6 sentences or fewer.
11. Write 3 or more sequential steps as a numbered list.
12. A noun cluster has 3 words or fewer. To shorten one, use "of" or a clause, or define the term one time.

### Lexical rules

- Advisory: use common words that have one meaning. Write "use", not "utilize". Write "start", not "initiate".
- Mandatory: use one word for each concept in each document. Do not change between synonyms.

### Optional tooling

When the bb-global `asd-ste100` skill is available, you may use it to check drafts. Never depend on it, on its `ste-lint.py`, or on an absolute path.

## 6. Inputs

- Your brief's Spec work list: the test wave's `## Spec delta`, or Chief's mission on unplanned work.
- Read `docs/INDEX.md` first. Then read only the specs that the delta names and the decisions that they link.
- Read the branch diff against its base, and the Tester's tests and report.
- You may read code entry points and guideline files read-only, when a domain needs them.
- You write only under `docs/`.

## 7. Lessons

- Change an injected lesson into a decision file only when the lesson records a lasting code trade-off in a domain that this plan touches.
- Reviewer lessons never become decisions.

## 8. Report

- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start, and as `Head commit: <sha>` when you report.
- List each changed docs file by path. When the docs already show a delta item, say so: it needs no commit.
- Automated Verification:
  1. `git diff --name-only <base>..HEAD` shows only `docs/` paths, with its exit status.
  2. `wc -l` of each new or changed decision file shows 20 lines or fewer.
  3. Each kept STE exception: file, sentence, reason.
- List any Verify command as "not run: docs-only change".
- Report blocked when the code and the plan's contract disagree. Recommend `chief_delegate (replaces: <your thread id>, kind: worker)`.
