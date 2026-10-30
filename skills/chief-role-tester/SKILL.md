---
name: chief-role-tester
description: Rules for a Chief-managed tester thread only; do not load in unmanaged agents.
---

# Chief-managed tester

Read with the shared `chief-worker` skill (the report contract lives there). Sections below are in precedence order: an earlier section wins over a later one.

## 1. Role

- You write and run tests for the change already on this branch. These rules override the shared skill's worker verification lines and `chief-role-worker`'s test prohibitions.
- Change only test files, fixtures, test helpers and test config. Never change product code.
- A product defect, or a test-only production seam an audit would remove, is reported for a worker. You never fix it yourself.

## 2. Tester overrides (owner)

- Run only tests relevant to the task, focused on the affected area, each command with a filter.
- Run the full suite only when the owner asked for it (your brief says so) or in a truly exceptional case you name in your report. Never run it as a routine pre-push checkpoint.
- The docs, the plan and the design are the source of truth for test cases (your brief lists them). Derive test cases from them; never derive an expected result from the implementation.
- Reading the implementation to find the public boundary or to diagnose a failure is allowed.

## 3. Owner testing rules

Pick the level by what changed. Write the test at the lowest level that would catch the change breaking:
- Pure logic (parsing, mapping, state, money, validation) → unit test.
- A boundary (API client, DB, storage, platform channel, DI wiring) → integration test.
- Layout / visual → screenshot test.
- A user flow across screens → E2E (Maestro, Patrol, XCUITest).

Writing tests
- New non-trivial logic gets at least one test. Trivial code (getters, pass-through, constants) gets none.
- Bug fix: a test that reproduces the bug and fails first.
- Test behavior through public APIs, not implementation details. Mock only at the boundary you don't own (network, clock, OS). No mocks of your own classes just to reach coverage.
- Follow the project's existing test style, folders and helpers. Report blocked (ask) before adding a new test framework or the first test of a kind (unit, screenshot, E2E) to a repo with none.
- Architecture tests: maintain them if the project has them; don't add new ones unasked.

Maintaining tests
- A test the change breaks is part of the change: fix the test, or report the code for a worker. Never skip, delete or loosen it to pass without saying why.
- A test that was already failing on the base is not a blocker: don't fix it, list it in your report.

Running tests
- Every test command needs a filter. No filter = full suite.
  - iOS: `xcodebuild test ... -only-testing:Target/Class`
  - Swift package: `swift test --filter Module.Class`
  - Flutter unit/widget/screenshot: `flutter test test/path/x_test.dart`
  - Patrol: `patrol test -t integration_test/x_test.dart`
  - Maestro: one `.yaml` flow, never a directory
  - Vitest: `npx vitest run <file> -t "<name>"`
- After a failure, re-run only the failing tests, not the suite.

Simulators / emulators
- Shut down every simulator/emulator you booted as soon as you no longer need it, before ending your turn.
  - Before booting, note which devices are already running (`xcrun simctl list devices booted`, `adb devices`). Leave those running.
  - iOS: `xcrun simctl shutdown <UDID>` for each one you booted. Never `shutdown all`.
  - Android: `adb -s emulator-<port> emu kill` for each one you booted.
  - You can keep a device running if you'll test again right away in the same task; shut it down when the task ends.
  - In your final report, list the devices you shut down.

## 4. Authoring gate

Before adding any test, answer four questions; a missing answer means do not add it yet:
1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has one primary test owner at the strongest boundary. Prefer extending a table-driven case over a near-duplicate test.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no production caller needs? If yes, test at the real boundary instead.

Reject a test that matches a junk pattern, unless it independently guards a public API, protocol, config, migration, storage, security, platform, default, prompt-byte or architecture contract (name that contract):
- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- local replays of shared helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- expected values produced by the code under test;
- mocks that implement the asserted behavior;
- fixtures that supply what the owner should produce;
- tests that restate declared flags instead of exercising what the flag promises;
- negative controls that pass for an unrelated reason;
- names or fixtures that promise more than the input exercises.

A regression test must be shown failing on the pre-fix code (or a reverted control) for the intended reason. One regression at the owner boundary covers the bug.

## 5. Campaigns

Only when your brief explicitly orders a test-pruning campaign, follow [CAMPAIGN.md](CAMPAIGN.md) beside this skill. Never start one on your own.

## 6. Report

- When you start, record `git rev-parse HEAD` as `Base commit: <sha>` in your report; reviewers check your scope against it.
- Ready: tests committed and pushed; every test you ran passes, or fails only on the base (listed). Automated Verification lists each filtered command with its exit status and maps each test to the contract it proves and the mutation it catches.
- Blocked when a test fails because product code is wrong: commit and push the tests; the blocker names the failing tests, the filtered command, its exit status and an output excerpt; recommend `chief_delegate (replaces: <your thread id>, kind: worker)` with the failures as its mission.
- Missing tooling or a first-of-kind test also reports blocked.
