# PotluckLLM LinkedIn demo

A 60-second screen recording that shows one claim: a laptop on a phone hotspot uses a local LLM on another machine, with no cloud API, no open port and no account, and a stranger's key gets refused.

All commands match PRD v0.2. Values in `<angle brackets>` come from the real run. Don't put invented numbers on screen.

## Cast

| Role | Machine | Network |
|---|---|---|
| **Provider (A)** | GPU machine running Ollama (current dev laptop, RTX 3050 Ti 4 GB) | Home wifi |
| **Consumer (B)** | Second laptop, no GPU needed | Phone hotspot |
| **Intruder** | Laptop B with a throwaway identity (`HOME=/tmp/intruder`) | Phone hotspot |

The intruder uses a temporary `HOME`, so `potluck` generates a fresh key in `/tmp/intruder/.potluck/` that isn't in `team.json`. No extra feature is needed.

## Preparation (off camera)

1. On A: install Ollama and pull a model that fits 4 GB of VRAM, for example a 3B model at 4-bit quantization. Check that the model loads on the GPU and returns a completion locally.
2. On A and B: install `potluckllm` and confirm `potluck --version` on both.
3. On B: switch to the phone hotspot. Confirm A and B are on different networks (the two public IPs differ).
4. Terminal setup on both machines: large font (at least 18 pt), dark theme, prompt shortened to `A $` and `B $`, window title shows the machine role.
5. Clear `~/.potluck/` on both machines so the identity setup runs fresh on camera.
6. Pick the demo prompt (see Shot 6) and run it once to warm the model, so the on-camera first token isn't a cold load.

## Shot list

Target total: 60 seconds. Record each machine's screen separately and compose them side by side, A on the left and B on the right.

| # | Time | Screen | Action | On-screen caption |
|---|---|---|---|---|
| 1 | 0 to 5 s | A | Title card over A's terminal | "My GPU is at home. My laptop is on a phone hotspot. No cloud." |
| 2 | 5 to 12 s | A | Run `ss -tlnp \| command grep 11434` | "Ollama listens on localhost only. No port is open to the internet." |
| 3 | 12 to 22 s | B, then A | B runs `potluck id`. A runs `potluck team init demo` and `potluck team add laptop-b <B key>`. | "Each member is a public key. No accounts." |
| 4 | 22 to 30 s | A and B | A runs `potluck serve --team team.json`. B runs `potluck use --team team.json`. Both logs show `connect`. | "Found each other across two networks and connected directly, encrypted." |
| 5 | 30 to 35 s | B | `curl -s localhost:11500/potluck/status` | "Laptop B sees the models hosted on A." |
| 6 | 35 to 48 s | B | Streamed chat completion against `localhost:11500/v1` (command below) | "Inference ran on A's GPU. The prompt never touched a third-party server." |
| 7 | 48 to 56 s | B, then A | Intruder runs `HOME=/tmp/intruder potluck use --team team.json`. A's log shows `reject <key prefix>`. | "A key that isn't on the team gets refused." |
| 8 | 56 to 60 s | End card | Repo URL and one measured number from the F9 logs | "Open source: github.com/<user>/potluckllm" |

`team.json` reaches B off camera. In the edit, a one-second cut with the caption "team.json shared over Signal" covers it.

## Commands

**Shot 2** (A):

```sh
ss -tlnp | command grep 11434
```

Expected: one line bound to `127.0.0.1:11434`. If Ollama shows `0.0.0.0` or `*`, fix the Ollama bind address before recording. The claim in the caption depends on it.

**Shot 6** (B). Use a prompt whose content makes the privacy point:

```sh
curl -sN localhost:11500/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"<model tag>","stream":true,"messages":[{"role":"user","content":"Summarize the risks in this unreleased Q4 pricing plan in 3 bullets: <short fake plan text>"}]}'
```

Raw SSE output is hard to read on video. Two options, in order of preference:

1. Point an existing OpenAI-compatible chat client at `http://localhost:11500/v1`. This also shows G3: existing tools work unchanged.
2. Pipe the curl output through a short `jq` filter that prints only the content deltas.

Use fictional content in the prompt. Don't put real company data on screen.

**Shot 7** (B):

```sh
HOME=/tmp/intruder potluck use --team team.json
```

Expected on A: a `reject` line with the intruder key prefix. Expected on B: no provider connects, and `/potluck/status` lists no members.

## Numbers to capture for the post

Take these from the F9 log lines of the recorded run, not from memory:

- Time from `potluck use` start to first `connect` (Shot 4).
- Time to first token through PotluckLLM vs calling Ollama directly on A with the same prompt.
- Model name and quantization.

Run each measurement at least 5 times and report the median, computed with a tool. Use one number in the end card and the full set in the README.

## Pre-flight checklist (day of recording)

- [ ] A and B on different networks, confirmed by public IP.
- [ ] Ollama bound to 127.0.0.1 only (Shot 2 output checked).
- [ ] Model warm on A.
- [ ] `~/.potluck/` cleared on both machines. `/tmp/intruder` removed.
- [ ] No real names, emails, keys of real team members, or company data visible in any window, tab or notification.
- [ ] Notifications muted on both machines.
- [ ] One full dry run completed end to end.

## Fallback plan

| Failure | Action |
|---|---|
| A and B don't connect within 30 s | Retry once. If it fails again, run with `--relay <key>` (F11) and add a caption saying a relay was used. Don't hide it. |
| F11 not built yet | Move B to another network (different hotspot or wifi) and retry. |
| Model too slow on 4 GB GPU | Switch to a smaller model. The demo shows reachability and privacy, not model quality. |
| Anything else breaks on camera | Re-record. Don't splice steps from different runs, since the latency number in the post must come from the run shown. |
