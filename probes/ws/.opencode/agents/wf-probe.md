---
description: Test worker for the workflow engine probes. Never pick it yourself.
mode: subagent
hidden: true
permissions:
  - { action: "*", resource: "*", effect: "allow" }
  - { action: "shell", resource: "*", effect: "deny" }
  - { action: "webfetch", resource: "*", effect: "deny" }
  - { action: "websearch", resource: "*", effect: "deny" }
  - { action: "subagent", resource: "*", effect: "deny" }
  - { action: "question", resource: "*", effect: "deny" }
---
You are a test worker inside an automated probe of a workflow engine. Do exactly what the task says, using only the
tools it names, and nothing else. Do not explore the file system, do not read documentation, do not fix anything you
were not asked to fix. Keep your final reply short.
