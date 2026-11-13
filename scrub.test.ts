import { describe, expect, test } from "vitest";
import { normalize, scrub } from "./src/observe/scrub";

describe("scrub", () => {
  // One credential-shaped value per pattern the spec lists; the second column is what must not survive.
  const CASES: [string, string, string][] = [
    ["url credentials", "clone https://deploy:hunter2pass@github.com/org/repo.git", "hunter2pass"],
    ["sk- key", "key sk-abcdefghijklmnopqrstuvwx end", "sk-abcdefghijklmnopqrstuvwx"],
    ["GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123 end", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["GitHub fine-grained token", "github_pat_11ABCDEFG0123456789abcdefghij end", "github_pat_11ABCDEFG0123456789abcdefghij"],
    ["Slack token", "slack xoxb-1234567890-abcdefghij end", "xoxb-1234567890-abcdefghij"],
    ["AWS key id", "aws AKIAABCDEFGHIJKLMNOP end", "AKIAABCDEFGHIJKLMNOP"],
    ["Bearer header", "Authorization: Bearer example-secret-value", "example-secret-value"],
    ["JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln-nature end", "eyJhbGciOiJIUzI1NiJ9"],
    ["password pair", "password=hunter2", "hunter2"],
    ["api key pair", "api_key: abc123def", "abc123def"],
    ["dsn pair", "dsn=https://publickey@o1.ingest.sentry.io/42", "publickey"],
  ];

  test.each(CASES)("removes a %s", (_name, input, secret) => {
    expect(scrub(input)).not.toContain(secret);
  });

  test("keeps the key of a key=value pair so the line stays readable", () => {
    expect(scrub("password=hunter2 and token: abc")).toBe("password=[redacted] and token: [redacted]");
  });

  test("is idempotent over every pattern at once", () => {
    const all = CASES.map(([, input]) => input).join("\n");
    const once = scrub(all, ["configured-secret-value"]);
    expect(scrub(once, ["configured-secret-value"])).toBe(once);
  });

  test("replaces a configured secret everywhere, longest first, and never rewrites a placeholder", () => {
    const text = "dsn-long-secret-value and long-secret and [redacted]";
    const out = scrub(text, ["long-secret", "dsn-long-secret-value", "redacted"]);
    expect(out).not.toContain("long-secret");
    expect(out).toBe("[secret] and [secret] and [redacted]");
    expect(scrub(out, ["long-secret", "dsn-long-secret-value", "redacted"])).toBe(out);
  });

  test("leaves a commit SHA and a thr_ id readable", () => {
    const text = "head 4f9c2ab51d0e7a3b6c8d9e0f1a2b3c4d5e6f7a8b on thr_abc123 passed";
    expect(scrub(text)).toBe(text);
  });
});

describe("normalize", () => {
  test("collapses ids, runs, SHAs and numbers so one problem keeps one fingerprint", () => {
    expect(normalize("thr_ab12 run wfr_x-9 head 4f9c2ab51d0e7a3b after 17 tries"))
      .toBe(normalize("thr_zz99 run wfr_y-1 head 0a1b2c3d4e5f6a7b after 3 tries"));
    expect(normalize("thr_ab12 failed 3 times")).toBe("<id> failed <n> times");
  });
});
