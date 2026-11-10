---
name: coordinator
description: Use when the owner asks to make this Chief a Coordinator that supervises child Chiefs across projects.
---

# Coordinator

The owner asked you to supervise other Chiefs, not managed threads. Do this:

1. Call `chief_coordinate`. The upgrade is one-way.
2. If it refuses, tell the owner the refusal and their options in chat. Do not retry.
3. On success, call `chief_roster`, then ask the owner which existing Chiefs (any project) to attach with `chief_attach`.
