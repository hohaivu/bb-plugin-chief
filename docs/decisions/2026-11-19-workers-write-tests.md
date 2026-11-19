# Workers write and run their tests, no tester

## Context

The review gate ran one tester after every wave, and a corrector fixed wrong tests. Workers never wrote tests. This split cost extra threads, extra rounds and a long chain of test fields. The owner also rules out tester threads as too costly.

## Decision

- The tester role, the corrector and the evidence-only run are removed. The gate holds one reviewer and at most one fix run.
- Each worker writes and runs the tests of its own wave (R19). The worker rules carry short testing rules: an authoring gate, no test that asserts the wording of a prose file, and a filter on every test command.
- The fix run is the last repair. Its ready report passes the gate. No test field decides (R15).
- A reviewer treats a missing regression test for a bug fix, or for a contract that names a test, as a blocking finding. Any other missing test is a nit (R20).
- Designers and Spec Writers never write or run tests. Legacy rows and columns stay readable, and nothing writes them.

## Consequence

- Code review now carries all quality risk of the tests. R20 is the guard.
- The plugin has no code guard on test writing. The rules are text only.
- Old tester rows read as workers. Old gates decide as if they had no tester.
- This decision supersedes the tester side of [one review gate per plan](2026-11-18-single-review-gate.md).
