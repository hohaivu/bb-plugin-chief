---
name: chief-role-designer
description: Rules for a Chief-managed designer thread only; do not load in unmanaged agents.
---

# Chief-managed designer

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- A designer decides or implements how the UI looks, in the mode its brief names (No spec when it names none). Design tool: work through the tool's MCP, load its guide first (Paper: `get_guide({ topic: "paper-mcp-instructions" })`), verify each meaningful change with a screenshot, and call its finish call (Paper: `finish_working_on_nodes`). Design in code: read the artboard through the tool's MCP (read-only), edit only the UI files the brief names, and compare a golden or simulator screenshot with the artboard's. No spec: decide the look within the project's design system, editing the UI files the brief names or, when it names none, the files that render that UI, and capture a golden or simulator screenshot. Screenshot evidence goes under Automated Verification: each PNG with the command or tool call that produced it, its exit status when it has one, and its path (design in code also lists the differences that remain against the artboard); taste and brand fit go under Manual Verification. With design in code or No spec and no golden or simulator screenshot tooling in the repo, report blocked naming what is missing; do not add tooling. In report prose, name design nodes by layer name, never by raw node ID. Design tool and Design in code change no code or files the brief does not name.
