import { describe, expect, test } from "vitest";
import { trackerProjects } from "./tracker";

// Contract (docs/specs/tracker.md, Settings): "proj_x=KEY" entries split on newlines or commas, trimmed, malformed entries
// ignored, the last entry of a repeated project wins. The map decides which Chief projects mirror to a tracker, so a wrong
// split silently maps (or drops) a project.
describe("trackerProjects", () => {
  test.each<[string, unknown, [string, string][]]>([
    ["one entry", "proj_a=ABC", [["proj_a", "ABC"]]],
    ["newline separated", "proj_a=ABC\nproj_b=DEF", [["proj_a", "ABC"], ["proj_b", "DEF"]]],
    ["comma separated", "proj_a=ABC,proj_b=DEF", [["proj_a", "ABC"], ["proj_b", "DEF"]]],
    ["newlines and commas mixed, with CRLF", "proj_a=ABC,proj_b=DEF\r\nproj_c=GHI", [["proj_a", "ABC"], ["proj_b", "DEF"], ["proj_c", "GHI"]]],
    ["whitespace around names, keys and separators", "  proj_a = ABC  ,\n\t proj_b\t=\tDEF \n", [["proj_a", "ABC"], ["proj_b", "DEF"]]],
    ["malformed entries are ignored, valid neighbours kept", "nokey\n=ABC\nproj_x=\n\nproj_a=ABC\n,,", [["proj_a", "ABC"]]],
    ["the last entry of a duplicate project wins", "proj_a=OLD\nproj_b=KEEP,proj_a=NEW", [["proj_a", "NEW"], ["proj_b", "KEEP"]]],
    ["an empty string", "", []],
    ["a non-string setting value", undefined, []],
    ["a number", 3, []],
    ["null", null, []],
  ])("%s", (_name, raw, expected) => {
    expect([...trackerProjects(raw)].sort(([a], [b]) => a.localeCompare(b))).toEqual(expected);
  });
});
