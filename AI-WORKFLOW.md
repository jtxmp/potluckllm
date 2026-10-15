# How AI was used to build PotluckLLM

I built PotluckLLM with Claude Code (Claude Opus) as a pair: it researched, drafted and wrote code, and I made the product calls. This file records what that looked like, including the parts that went wrong.

## 1. Research before picking an idea

The brief was a portfolio project on the Holepunch stack (Bare, Hyperswarm, HyperDHT, Hypercore, Autobase, Pear). Claude read the Holepunch docs and module READMEs and summarised what each layer is for. One finding shaped the product: browsers cannot open UDP sockets, so a web client would need a relay server. That pushed the project to a CLI.

## 2. The first idea was rejected

Claude's first proposal was a P2P team decision log built on Autobase. I rejected it as low impact. A shared document works fine on a server, so P2P was decoration. From then on the filter was: the showcased technology has to be necessary for the product to exist.

The second round produced "private AI over P2P": share a local LLM between team members, authenticated by public key. Here P2P removes the need for a cloud API, an open port or an account, which is the product's whole point.

Research for that idea found prior work worth citing:

- Tether's `@qvac/sdk` 1.0 and 1.1 (November 2025) had P2P "delegated inference" over Hyperswarm. The current release (0.21.0) does not include it. Why is still an open question (PRD Q1).
- mcpmesh does MCP over iroh, a different P2P stack.
- AntSeed runs a paid P2P inference market between strangers. PotluckLLM targets a private team instead.

## 3. Naming, checked rather than guessed

Claude checked each candidate name against npm, GitHub, PyPI and domain registries. peerlm, PeerLLM, llmnet, privatellm, tunnellm and p2pllm were all in use or too close to existing projects. potluckllm was free on npm and GitHub, and its .com and .dev domains were unregistered on 2026-10-14.

## 4. PRD, then a scored review

Claude drafted [the PRD](docs/PRD.md), then reviewed it for speed to delivery and scored it 60/100 against a weighted rubric. The changes that followed:

- Replace Protomux with newline-delimited JSON over the Hyperswarm stream. A spike showed the whole transport fit in about 15 lines and handled two interleaved streams on one connection. The same spike found that a connection without an `error` listener crashed the process on shutdown.
- Drop the TypeScript build in favour of `// @ts-check`, and drop a `peers` command that would have needed IPC between processes.
- Add 1-day milestone timeboxes and a cut line.
- Add a fake Ollama and a DHT testnet so development and CI need no GPU or second network.
- Close two open questions with defaults, and mark unmeasured metric targets as hypotheses.

I kept two items the review wanted to cut, `team init` and `team add`, because a hand-edited JSON file with 64-character keys would fail the "5 commands to first completion" goal.

## 5. Code and tests

Decisions: plain JavaScript with `// @ts-check`, Node 22, one runtime dependency (`hyperswarm`), and an integration suite that runs on a local DHT testnet with a fake Ollama, so CI needs no GPU or internet.

Bugs the process caught before a user did:

- **Discovery took up to 10 minutes.** If the consumer started before the provider, Hyperswarm did not look up the topic again until its 10-minute refresh. The consumer now retries the lookup with backoff (5 s up to 60 s) while it has no provider. A regression test starts the consumer first, and it fails when the fix is disabled.
- **A dependency bug under pnpm.** `bogon@1.3.0` requires `b4a` without declaring it, which crashed with "Cannot find module 'b4a'" under pnpm's strict layout. Fixed with `pnpm.packageExtensions` in `package.json`.
- **Error handling after headers were sent.** On a mid-stream provider disconnect, the failure path read the response's content type with `getHeader`, but the headers had gone out through `writeHead`, which `getHeader` cannot see. The consumer now uses `setHeader`, so a stream that breaks mid-answer ends with an SSE error event.

Tests were checked by breaking the code on purpose. With the request queue removed, three requests reached the upstream at once and the queue test failed. With the idle timeout removed, the timeout test hung. Both tests catch the regression they exist for.

## 6. Verification on real hardware

Ollama 0.35.1 was installed in user space (no sudo, no system service), with the release checksum verified and the listening socket confirmed on 127.0.0.1 only. `llama3.2:3b` runs fully on a 4 GB RTX 3050 Ti. Medians are computed by script from six runs per path, not estimated. See the measurements in the [README](README.md#measurements).

## What I would do differently

- Ask for the impact filter at the start. One round of ideation went to an idea that failed it.
- Measure real cross-network numbers earlier. Most of the metric targets stayed hypotheses until M3.
