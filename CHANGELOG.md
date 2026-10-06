# Changelog



## v1.3.0 — second batch of one-click features (2026-09-26)

- ⌂ Home across projects; task type in the ask box (bug fix / feature / refactor / front-end test / research with a report check); safe mode (read-only / normal / high); System → Remote access (addresses, bind switch, phone QR); System → Notifications (ntfy / Bark / Telegram).
- Fixed on the way: a long option in the new task-type menu widened the page on phones (the phone browser then zoomed out and the bottom bar could not be tapped).
- All in Chinese and English; unit, E2E (incl. the new pages) and red-team suites green on the DGX.

## v1.2.1 — first run on the DGX (2026-09-26)

Found and fixed by running on the DGX Spark with a local llama.cpp model and real use:
- Keyless model servers (llama.cpp) were unusable; Chief/planner/reviewer sessions did not receive saved keys.
- The integrity check rejected correct fixes when a test file could not load at baseline.
- Adding a cloud API "hung" on Save: `deepseek` is a reserved name and the error rendered behind the modal. Errors now float above modals; names are normalised; provider templates; models can be typed by hand; searchable model lists.
- Update check offered an older tag as new; a busy queue never let an update start — "update when idle" drains (the running task finishes, nothing new starts) and the queue resumes after the update.
- `sa do /path`, restart detection under foreign systemd units, a flaky test.

Added: Chinese UI (follows the browser, 中/EN toggle, bilingual activity), a four-step first-run guide, Worker read isolation via bubblewrap, `sa link`, stable token by default in `sa service install`.
Verified on the DGX: check 115/115, evals 14/14, redteam 22/22, smoke 6/6, and a real `sa do --review` task on the local model.

## Unreleased (after cloud-v1.1) — one-click operations

The goal is that nothing routine costs model tokens: buttons for everything that repeats (ADR-0023). Everything is under **⚙ System** (on phones: More → System) and at `/api/system/*`, and every operation is human-only.

- **Health Check.** Checks the runtime, DSH version and profiles, SuperAgent bundle, browser, UI build, state directory, disk space, secret permissions, each model server in use (via `/models`, which costs no tokens; **Test models** sends one tiny request each), leftovers of interrupted runs, failed Chief wakes, each project (folder, git, test gates, hidden tests) and remote access.
  - Results are green, yellow or red, each with a fix: a copyable command or a button.
  - The sidebar shows a health dot.
  - **Starting work is refused while something is red.** The ask box explains why and offers **Run anyway**.
- **Model servers (Provider wizard).** Enter the Base URL and key → **Connect** lists the models → pick models → optional 1-token test → Save.
  - Supports OpenAI-compatible servers (vLLM, SGLang, Ollama, LM Studio, API gateways) and Anthropic-compatible ones.
  - Saved as a DSH `llm-pi-ai` route. The key goes into `model-routes.json` (0600) and is never shown again.
  - A server can also be made the **local default**.
- **Model presets.** All local / Budget / Default / Max.
  - Fill a preset once in the editor; one click switches Chief, Planner, Workers, Reviewer and Escalation.
  - A preset that names an unconfigured server is shown as unavailable.
  - The ask box can use a preset **for one request only**.
- **Project wizard.** Browse folders on the server → **Scan** → review → Create.
  - The scan reports languages, package manager and git state (with **Initialize git**).
  - It proposes checks: tests, E2E and architecture, plus optional build, lint and typecheck; Go and Rust are detected.
  - It also flags whether a browser is needed, declared architecture, and warnings.
- **Backup / Restore.**
  - A backup is a `.tar.gz` with a manifest. Secrets and DSH sessions are opt-in, and keys are stripped otherwise.
  - Backups can be downloaded, uploaded and deleted.
  - Restore refuses while work runs and refuses newer state formats. It backs up the current state first, then swaps the state in, keeping the replaced state aside.
- **Update / Rollback.** `sa install` sets up a managed install: each release is a git worktree and `current` is a symlink.
  - **Check for updates** lists tagged versions. **Update** builds the new version beside the running one, backs up state, switches and restarts under systemd.
  - If the new version is red at start-up, it switches back by itself. Manual **Roll back** is also available.
  - Update refuses while work runs or when the target can't read the current state format. A failed build leaves everything as it was.
- **Service and restart.** `sa service install` writes a systemd user unit (auto-start, restart after update, env file for a stable phone link). **Restart** works under the supervisor.
- **Cleanup.** Preview, then clean selected items: orphaned Workers, stale leases, old verification snapshots in project repositories (kept for open tasks and pending learning), old logs and command output, temp folders, old backups, restore leftovers and old releases.
- **Verification:** red-team RT-22 (misuse of the one-click operations); unit/API tests for every operation; a browser test that clicks through the whole System page on desktop and phone; a real `sa install` of this repository.

## cloud-v1.1 — 2026-09-26

The features below were added after cloud-v1.0. The release audit then reviewed all of it independently (Chief chat, transcripts, file sharing/downloads, WireGuard remote access, the phone UI, ▷ Run / Terminal, Appearance/background upload and the Digital Human bridge). It fixed the confirmed defects listed next, each with a regression test that fails on the pre-fix code.

### Release audit (fixes)
- **P0: human token leaked to the Chief.** With `SUPERAGENT_HUMAN_TOKEN` exported (the new stable-link option), the Chief's DSH process inherited it and could act as the human (resolve Human Gates, run commands). Child processes now never inherit SuperAgent credentials. The Chief receives only the agent token passed explicitly, and `sa serve` removes the variable from its own environment after reading it.
- **P1: DNS rebinding.** A web page whose domain resolves to 127.0.0.1 could use the anonymous loopback reads to list projects and download project files. A loopback server with anonymous reads now answers only to loopback `Host` names. A remote bind is unaffected, because it already needs the token.
- **P1: server crash from the SSE stream.** `/api/events/stream?project=<malformed>` threw inside the event pump timer and killed `sa serve`. The filter is now validated (404), and a failing client only ends its own stream.
- **P1: server crash when serving a file.** A file that could not be read after its `stat` (a root-owned file, a file deleted or replaced mid-request) raised an unhandled stream error. Files are now opened before any header is sent, and read errors end only that response.
- **P1: ▷ Run / Terminal recovery.** Commands left running by a stopped server (a crash, or Ctrl-C on `sa serve`) stayed `running` forever, and their detached process groups kept running. On start they are now closed as `interrupted`, and the orphaned group is killed. A process is killed only if it carries that command's id, so a reused pid is never touched.
- **P1: phone/desktop UI could brick itself.** A "this device only" background URL is not checked by the server. A scheme-less URL crashed the UI on every load until the browser storage was cleared. Invalid URLs are now refused on save and ignored if already stored.
- **Token hygiene:** the UI removes `?token=` from the address bar and history once the token is stored. `.git` is refused at any depth when sharing or serving files (a nested repo's `.git/config` can hold credentials).
- Red-team RT-07, RT-20 and RT-21 now cite these regression tests.

### Features

- **Agents send you files:** `superagent_share_file` for Workers and the Chief. Only regular project files can be shared: no `.git`, no SuperAgent state and no links that escape the project, up to 200 MB. Each file is copied into the store and shows up in the UI's **Files** tab and in the activity feed.
- **Preview and download from any browser, phone included.** Images, PDF, text/code, audio and video preview inline, and any file can be downloaded, through signed links that expire after 15 minutes. The links never contain the human token. HTML/SVG/XML are served sandboxed. Byte ranges are supported, so video plays on iOS.
- **Project file browser:** read-only.
- **Chief chat in the SuperAgent UI** (the **Chief** tab). It uses the same persistent Chief DSH session as the automatic wakes. Tool calls, replies and wake digests appear in one conversation.
- **Worker transcripts:** tap a Worker to see its prompt and every DSH tool call, result and message.
- **Remote access (WireGuard):** binding to a non-loopback `--host` requires the token for every request. `SUPERAGENT_HUMAN_TOKEN` keeps the login link stable across restarts, and `sa serve` prints the reachable URLs.
- **Phone layout:** a responsive UI for small screens.
- **Redesigned UI.**
  - The default **Clean** style is calm: warm neutrals, hairline borders, one accent, monospace for anything runnable. An optional **Glass** style puts translucent cards over a background. Themes are light, dark and auto.
  - On phones, a bottom bar holds Overview / Chief / Files / Terminal / More.
  - Markdown in Chief replies and Worker transcripts.
- **Code blocks with ⧉ Copy and ▷ Run.** Run executes a command in the project on the server, from any device including your phone over WireGuard.
  - A confirmation sheet shows the exact command before it runs.
  - Commands the pre-tool classifier flags (destructive, credentials, production…) need an explicit acknowledgement.
  - SuperAgent credentials are scrubbed from the command's environment; there are a timeout and a Stop button.
  - Output streams back live. Each run is recorded in the activity feed.
- **Terminal tab:** type any command, see live output and the history of past runs. The endpoints are human-only: `/api/projects/:p/commands`.
- **Appearance panel.**
  - Style, theme, accent and card opacity.
  - Background: none, gradient presets, an uploaded image/video, or a **web page** (e.g. the Web Digital Human), with blur/dim.
  - Settings apply to **all devices** (server) or **this device only**.
  - Uploads are checked by content: PNG/JPEG/GIF/WebP/AVIF/MP4/WebM only, never SVG/HTML. Appearance is human-only: `/api/ui/appearance`, `/api/ui/backgrounds`.
- **Digital Human background bridge** (`docs/DIGITAL_HUMAN_BACKGROUND.md`).
  - The embedded page receives `hello` / `activity` / `chief` messages and can send `chat` to the Chief (off by default; opt-in).
  - It runs sandboxed; a same-origin page never gets `allow-same-origin`.
  - The SSE stream now also emits plain-language `activity` events, so a standalone Digital Human can follow along.
- **Verification:**
  - New red-team scenarios: RT-20 (file-sharing abuse) and RT-21 (UI remote-control abuse).
  - New evals for Chief chat, file sharing and transcripts (real DSH), the phone-viewport UI (incl. ▷ Run, Terminal, Appearance) and appearance/Digital Human embed.
  - Totals before the release audit: `pnpm check` 97/97, evals 13/13, red-team 21/21 (87 tests).

## cloud-v1.0 — 2026-09-25

The last release built in Claude Cloud. Everything that can be implemented and verified without DGX hardware, a real model endpoint, OS-level Worker isolation or the Digital Human runtime is done; the rest is tracked in the issue tracker. DSH core modifications: **0** (pinned `@deepseek-ai/dsh@0.1.7-rc.2` = `477b4f4`).

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
- Fresh-clone verification of `5da45d5` (empty directory, empty `SUPERAGENT_HOME`): all of the above green.

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
