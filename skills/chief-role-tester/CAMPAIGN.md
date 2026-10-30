# Test-pruning campaign

Only when your brief explicitly orders it. A campaign prunes one subsystem's whole test surface in one branch. The authoring gate and report rules in [SKILL.md](SKILL.md) apply to every lane. Each step ends on its completion criterion; do not start the next step early. Product fixes and production seam removals are reported for a worker, never done by you.

## 1. Baseline
Record the subsystem's test and support line counts and every test file's pass/fail state at a pinned SHA. Keep baseline failures in their own list: they are often real bugs, not stale tests.
Done when every in-scope test file has a recorded baseline result.

## 2. Lanes and inventory
Split the surface into lanes along production owner boundaries, not file prefixes. Include the subsystem's cases at shared boundaries and its QA harness tests.
Done when every test file belongs to exactly one lane.

## 3. Read-only ledger per lane
Read every assigned test in full, with its production owners, callers and history. Mark each test declaration in a written ledger:
- `R`: retain, naming the contract and the bug it catches;
- `F`: retain the contract but repair the assertion;
- `C`: consolidate, naming the owner that absorbs the assertion first;
- `D`: delete, naming the proof that remains, or why no contract exists.
Judge a test by its assertions, not its name.
Done when every declaration has a mark and an evidence line.

## 4. Layer plan per lane
From the ledger, look for the redundant layer. Name the keeper suite for each contract; prefer the real boundary with a fake network over a mocked collaborator. Correct ledger errors this pass finds.
Done when each lane plan names its retired files, its keeper per contract, the assertions to carry into keepers, and the test-only production seams unlocked (reported for a worker).

## 5. Cutover
Edit lane by lane. Serialize changes to shared harnesses through one owner. Register moved suites in CI routing and test inventories.
Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review
Compare deleted coverage against the keepers: look for contracts that lost their only proof and new assertions that cannot fail. For each restored contract, make one deliberate mutation of the production owner, confirm the keeper goes red, then restore the source byte for byte.
Done when every gap is restored or rejected with source evidence, and every restored contract has a caught mutation.

## 7. Product defects
A baseline failure that survives into a keeper is a bug report: report it for a worker with a control run showing the old behavior. Record unrelated discrepancies as follow-ups.
Done when each defect is reported with its failing control.

## 8. Reconcile and hand off
Merge the base rather than rebasing a long campaign. When the base modified a file the campaign deleted, keep the deletion and port the new contract into the keeper. Rerun the subsystem's tests on the merged head.
Hand off with the SKILL.md report plus: baseline and final test/support line counts; lanes, retired layers and keepers; preservation gaps and their mutations; product defects with control proof.
