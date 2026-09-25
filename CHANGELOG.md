# Changelog

## cloud-v1.0 — 2026-09-25

The last release built in Claude Cloud. Everything that can be implemented and verified without DGX hardware, a real model endpoint, OS-level Worker isolation or the Digital Human runtime is done; the rest is listed in `NEXT_STEPS.md`. DSH core modifications: **0** (pinned `@deepseek-ai/dsh@0.1.7-rc.2` = `477b4f4`).

### Vibe-coding UX
- **One box.** In the UI, "What do you want?" takes a plain-language request. `POST /api/projects/:p/requests` and `sa do <project|path> "<request>" [--review]` do the same from the API and the CLI; `sa do` registers a directory as a project on first use.
- **Plain-language activity feed** (`GET /api/projects/:p/activity`, UI, `sa do` output), narrated from loop events.
- **Gate auto-detection.** Registering a project without gates proposes `unit` (npm test / node --test / pytest), `e2e` (Playwright config) and `architecture`.
- **Durable goal queue.** One goal runs per project tree and further requests queue. Requested runs resume after a server restart, and approving a Human Gate resumes its blocked goal.

### Chief decomposition and review
- **Planner.** A read-only DSH session (policy role `planner`) turns a request into 1–8 validated tasks. Tasks can only reference gate-registry ids. If planning fails, the request becomes a single task and the fallback is recorded (ADR-0020).
- **Reviewer in the loop.** Tasks with `review: true` get a model review of the task diff after their gates pass. The reviewer can request changes, which go to the next Worker attempt, but it can never pass a task. Persistent disagreement or an unavailable reviewer opens a `review-disagreement` Human Gate.
- **Advisor guard role.** Planner and reviewer sessions get read tools only, cannot read SuperAgent state and get no SuperAgent tools.
- **Chief tools.** `superagent_add_task` takes registry gate ids and a `review` flag. The status report lists the gate registry and review state.

### Held-out verification
- **Held-out gates** (`GateSpec.heldOut`, ADR-0019). Hidden tests live in `$SUPERAGENT_HOME/heldout/` and are registered with `sa heldout add`. They are mounted only into a throwaway export of the Worker's final tree.
  - Worker feedback shows failing test names only.
  - A task's own gate list cannot drop held-out gates.
  - Red-team RT-18 covers semantic test gaming.

### Reliability and integration
- **`StateStore.tailEvents`.** Followers now read the event log gap-free from a cached byte offset. Before this, the SSE pump could skip events during a burst. The wake monitor uses it too (ADR-0022).
- **Live policy appliers.** Promoted `routing-policy` candidates update the model-policy layers. Promoted `verifier-policy` candidates can only tighten verification. Invalid policies are rejected before anything is applied.
- **`goal/updated` events** now carry the previous status.
- **Graceful gate termination.** Timed-out or stopped gates get SIGTERM, then SIGKILL after 5 s, so runners such as Playwright can stop the web servers they start in their own process groups (an immediate SIGKILL left them holding their ports).
- **Held-out mount paths** are checked for symlinks; a link fails the gate closed.

### Verification
- `pnpm check`: 89 tests, 0 architecture drift, 0 hygiene blocks.
- `pnpm smoke:dsh`: 6/6.
- `pnpm test:evals`: 10/10 (new: DSH planner + reviewer, UI one-box).
- `pnpm redteam`: 19/19 scenarios fail closed (new: RT-18 held-out, RT-19 planner/reviewer abuse).
- Fresh-clone verification of `5da45d5` (empty directory, empty `SUPERAGENT_HOME`): all of the above green; recorded in `CURRENT_STATE.md`.

## terminal-harness (untagged) — Directive M1–M6
- Changes:
  - Verifier hardening (task-baseline integrity, test identities, Gate Registry, gate env allowlist).
  - Pre-tool Human Gates inside DSH; human/agent/anonymous privileges.
  - Chief auto-wake.
  - Fresh-replay learning with per-kind governance.
  - Layered model policy.
  - Observatory adapters and freshness.
  - Fail-closed recovery.
  - Red-team suite (17 scenarios).
- Decisions: ADR-0011…0018.

## v0.1 (untagged) — Foundation Freeze phases A–F
- Changes:
  - DSH pin and smoke test.
  - Project state, Chief/Worker loop and Verifier.
  - Architecture Observatory.
  - Browser/E2E, UI and DSH bundle.
  - Model policy, learning and handoff docs.
- Decisions: ADR-0001…0010.
