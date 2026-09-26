# DGX Super Agent (Cloud v1.1)

A private Super Agent harness built as **plugins around one Agent Core — DeepSeek Harness 0.1.7-rc.2 (unmodified)**. Describe what you want in one box; the Chief plans it into verifiable tasks; Workers loop until independent, tamper-resistant gates pass — including **held-out tests Workers never see** — with an optional **reviewer** on the diff; dangerous tool calls stop at Human Gates inside DSH; the Chief wakes only when needed; learning must prove itself in fresh replays; every project gets a live architecture map; real-browser testing; layered model policy.

```bash
pnpm sa do /path/to/repo "the signup form should reject emails without an @" --review
```

Authoritative specs: [`DGX_SUPER_AGENT_FOUNDATION_FREEZE_v1.md`](DGX_SUPER_AGENT_FOUNDATION_FREEZE_v1.md) and [`SUPER_AGENT_TERMINAL_HARNESS_COMPLETION_DIRECTIVE.md`](SUPER_AGENT_TERMINAL_HARNESS_COMPLETION_DIRECTIVE.md).

| Read | For |
|---|---|
| [`CURRENT_STATE.md`](CURRENT_STATE.md) | what is done / partial / not started, known issues, last green checks |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how it works (loop, verifier, observatory, DSH integration) |
| [`SETUP_DGX.md`](SETUP_DGX.md) | install, configure the local model, run on Linux ARM64 |
| [`NEXT_STEPS.md`](NEXT_STEPS.md) | prioritized follow-up work |
| [`DECISIONS.md`](DECISIONS.md) | ADRs |
| [`REDTEAM_REPORT.md`](REDTEAM_REPORT.md) | adversarial scenarios and their evidence |
| [`CHANGELOG.md`](CHANGELOG.md) | release notes (cloud-v1.1, cloud-v1.0) |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | licenses |
| `.architecture/` | this repo's own machine-generated architecture map |

```bash
pnpm install && pnpm build
pnpm check            # typecheck + tests + architecture drift + repo hygiene
pnpm smoke:dsh        # DSH core boots and runs tools (keyless)
pnpm test:evals       # real-browser / real-DSH end-to-end scenarios
pnpm redteam          # adversarial suite → REDTEAM_REPORT.md
pnpm sa dsh setup && pnpm sa serve --browser   # API + UI on http://127.0.0.1:7788 (open the printed human link, type what you want)
pnpm sa serve --host <wireguard-ip>            # same UI on your phone over WireGuard (chat with the Chief, receive/preview/download files)
```
