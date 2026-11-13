import { expect } from "vitest";
import { managedSkills, type Role, type WorkerKind } from "../src/core/roles";

/** The `## Working contract` section of a rendered brief, as its list items. */
export const contractItems = (prompt: string) => {
  const body = prompt.split("\n## Working contract\n")[1];
  if (body === undefined) throw new Error("brief has no ## Working contract");
  return body.split("\n## ")[0]!.split("\n").filter((line) => line.startsWith("- "));
};

/** The skill-load order (wave 2 contract): the first Working contract item names exactly the skills managedSkills gives the
 * role and kind, in full, before any task or repository file read, by the Skill tool or a full SKILL.md read, with a
 * blocked report when one cannot be loaded, and with no provider branch. */
export function expectLoadLine(prompt: string, role: Exclude<Role, "chief">, kind?: WorkerKind) {
  const first = contractItems(prompt)[0]!;
  const named = [...first.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  expect(named).toEqual(managedSkills(role, kind));
  expect(first).toMatch(/^- Before any task or repository file read or other task action, load these skills in full: /);
  expect(first).toContain("Use your Skill tool; without one, read each offered SKILL.md file in full");
  expect(first).toContain("only exception to the sync-first rule");
  expect(first).toContain("report blocked before any repository work");
  expect(first).not.toMatch(/claude|pi\b|codex|openai/i);
  return first;
}
