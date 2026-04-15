# Agent Rules

These rules define how automated agents (including Replit Agent) should operate in this repository.

---

## General Principles

- Keep all changes **minimal, targeted, and easy to review**
- Do not refactor unrelated code
- Do not rename files, functions, variables, routes, or components unless explicitly required
- Do not change business logic unless explicitly requested
- Preserve current functionality unless the task explicitly requires a change

---

## Platform and Portability

- Keep the codebase **platform-agnostic**
- Do not add platform-specific dependencies, plugins, or assumptions
- Use **environment variables** instead of hardcoded values
- If a new environment variable is introduced:
  - Add it to `.env.example`
  - Document it clearly
- Do not reintroduce any Replit-specific configuration or dependencies unless explicitly requested

---

## Git and Workflow Rules

- Do **not create commits** unless explicitly instructed
- Do **not push to GitHub**
- Do **not force-push**
- Do **not rewrite history**
- Do **not rebase, merge, or cherry-pick** unless explicitly requested
- Prefer creating a **new branch from current `main`** for isolated changes
- Always suggest the **simplest safe git workflow**

---

## Secrets and Security

- Never place credentials, tokens, or passwords in:
  - source code
  - documentation
  - `.replit`
  - committed files
- Use environment variables or secrets only
- If a secret is discovered in the repo:
  - Stop immediately
  - Report its location clearly
- Do not modify:
  - authentication flows
  - workflow files
  - deployment credentials  
  unless explicitly requested

---

## Scope Control

- Only modify files directly related to the task
- If additional files are needed:
  - explain why before changing them
- Do not touch:
  - routes
  - schemas
  - seed data
  - workflows
  - build configs
  - infrastructure  
  unless directly required
- Keep diffs as small as possible

---

## Output Requirements

At the end of every task, provide:

- Summary of what changed
- Exact files changed
- Commands the user needs to run
- Any risks or assumptions
- If no changes were needed, explicitly say so

---

## Documentation and Language

- Use neutral, professional wording
- Prefer:
  - "hosting environment"
  - "environment variables"
- Avoid platform-specific branding
- Keep documentation aligned with actual behavior
- Do not add marketing language

---

## Debugging and Fixes

- Diagnose before making changes
- Fix root causes, not symptoms
- Avoid speculative edits across multiple files
- If unclear:
  - inspect first
  - summarize findings
  - then propose changes

---

## Bulk Edits and Search/Replace

- Never run repo-wide replacements without excluding `.git`
- Be cautious with bulk operations
- Preview affected files before applying changes
- Avoid modifying non-source files unintentionally

---

## Commit Responsibility

- The agent must not commit code unless explicitly told to do so
- The user is responsible for commits and pushes
- The agent should provide exact commands instead

---

## Summary Rule

When in doubt:

> Make the smallest possible change that safely solves the problem, and explain exactly what was done.