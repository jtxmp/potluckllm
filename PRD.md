# PRD: PotluckLLM

Private AI over peer-to-peer. Use a local LLM on any machine you own, or a teammate's, from anywhere, with no cloud API, no open ports and no accounts.

| Field | Value |
|---|---|
| Status | Draft v0.4 (M2 complete, 2026-10-14) |
| Owner | JT |
| Date | 2026-10-14 |
| Name | PotluckLLM. Package `potluckllm`, command `potluck`. |

## 1. Problem

Teams want to use LLMs on sensitive material: unreleased product plans, customer data, internal code. Cloud AI APIs send that material to a third party. Local models avoid that, but they need a GPU, and most people work on laptops that lack one.

The usual way to reach a GPU machine remotely is one of these:

| Option | Cost to the user |
|---|---|
| Port forwarding | Exposes a service to the internet, needs router access |
| Hosted tunnel (ngrok, Cloudflare Tunnel) | Traffic passes through a third-party server, public URL |
| Mesh VPN (Tailscale, ZeroTier) | Account and vendor coordination server, grants network-level access to the whole machine |
| Generic P2P tunnel (Holesail) | Forwards one port, with no knowledge of models or per-request policy |

None of these gives a team "here are the models my teammates host; use them from my laptop; only people on the team can connect" without an account or a server.

## 2. Evidence the problem is real

- Tether shipped peer-to-peer "delegated inference" over Hyperswarm in `@qvac/sdk` 1.0.0 and 1.1.0 (November 2025): a consumer device sends inference to a provider device by public key, with a key allow-list. The current `latest` release, 0.21.0 (2026-10-04), contains no delegation API. Status unconfirmed (removed, renamed or moved). See open question Q1.
- Holesail, a community project, grew from a thin HyperDHT wrapper to a product with iOS and Android apps, which indicates demand for serverless P2P connectivity.

## 3. Users

| User | Situation | Job to be done |
|---|---|---|
| Primary: GPU owner | Has a desktop or home server with a GPU | Let their own laptop and a few trusted people use local models, safely |
| Primary: Consumer | Works on a laptop, cares about data privacy | Use a capable local model from any network, inside tools they already use |
| Secondary: Small team lead | 3 to 10 people, mixed hardware | Pool the team's GPUs without IT, VPN or cloud spend |

## 4. Goals and non-goals

**Goals**
- G1. A consumer reaches a provider's model from a different network with no port forwarding, no account and no third-party server in the data path.
- G2. Only keys listed in the team file can connect, in either direction.
- G3. Existing OpenAI-compatible tools work unchanged by pointing them at a local endpoint.
- G4. A new teammate goes from install to first completion in 5 commands or fewer.

**Non-goals (v1)**
- Splitting one model across several machines (exo and Petals cover that).
- Payments, metering or a public compute marketplace.
- GUI, mobile or web clients. Browsers can't open UDP sockets, so a web client would need a relay server.
- Model download or management. Providers manage models in their own runtime.
- Strong protection against a malicious provider. Members are trusted by design (section 9).

## 5. Solution overview

```
 consumer laptop                                   provider GPU box
 ┌──────────────────────┐                          ┌──────────────────────┐
 │ any OpenAI client    │                          │ Ollama :11434        │
 │   │ http             │                          │   ▲ http (localhost) │
 │   ▼                  │   Hyperswarm topic,      │   │                  │
 │ potluck use          │◀═ Noise-encrypted P2P ══▶│ potluck serve        │
 │ 127.0.0.1:11500/v1   │   hole-punched via DHT   │ allow-list firewall  │
 └──────────────────────┘                          └──────────────────────┘
          both sides load the same team.json (topic + member public keys)
```

1. Each person has an Ed25519 keypair stored locally (`potluck id`).
2. A team file holds a random 32-byte topic plus each member's name and public key. Members share it out of band (for example over Signal).
3. Providers join the topic and advertise which models they host. Consumers join the topic and connect only to keys in the team file.
4. The consumer runs a local OpenAI-compatible HTTP endpoint. It routes each request to a provider that hosts the requested model and streams the response back.

## 6. Scope

### P0: must ship

| ID | Command / behavior | Acceptance criteria |
|---|---|---|
| F1 | `potluck id` | Creates a keypair on first run in `~/.potluck/` with file mode 0600. Prints the public key. |
| F2 | `potluck team init <name>` | Writes `team.json` with a random topic and the caller as first member. |
| F3 | `potluck team add <name> <pubkey>` | Adds a member. Rejects malformed keys. |
| F4 | `potluck serve --team team.json [--upstream http://127.0.0.1:11434]` | Joins the topic. Rejects any connection whose key is not in the team file (Hyperswarm `firewall`). Advertises the upstream's model list on connect. Refuses a non-loopback upstream unless `--allow-remote-upstream` is passed. |
| F5 | `potluck use --team team.json [--port 11500]` | Binds to 127.0.0.1 only. Serves `GET /v1/models` (union across connected providers) and `POST /v1/chat/completions` with streaming. Routes by the `model` field. Returns 503 with a clear message when no provider hosts the model. |
| F6 | `GET /potluck/status` on the `use` endpoint | Returns JSON listing connected members with name, key prefix and models. Served by the running `use` process, so no IPC is needed. |
| F7 | Path allow-list on provider | Forwards only `/v1/models` and `/v1/chat/completions`. Every other path returns 404, so Ollama admin routes such as `/api/pull` and `/api/delete` are never reachable. |
| F8 | Limits | Request body cap (default 1 MB) and upstream idle timeout (default 120 s, `--timeout`), answered with 504. The provider processes one request at a time from a single FIFO queue across all members. More than 16 waiting requests get 503. |
| F9 | Logging | One line per event to stderr: connect, reject (with key prefix), request start, first token, end, error. Includes timings. Never logs prompt or completion content. |

F5 additions: every connection has an `error` listener. If a provider disconnects mid-stream, the consumer returns 502 (or closes the SSE stream with an error event) and the process keeps running. When several providers list the same model, the first connected one wins.

### P1: should ship if P0 lands early

| ID | Feature | Why |
|---|---|---|
| F10 | Usage log on a Hypercore: timestamp, peer key, model, token counts. Never prompts or outputs. | Shows the signed append-only log, and gives the provider an audit trail. |
| F11 | `--relay <key>` passthrough to a blind relay | Fallback when both peers sit behind randomizing NATs. |

### P2: stretch

| ID | Feature | Note |
|---|---|---|
| F12 | Ship as a standalone binary with `hello-pear-bare`, update OTA with `pear stage` and `pear seed` | Shows P2P distribution of the tool itself. Requires porting to Bare (D1). |
| F13 | QVAC as an alternative upstream | Depends on Q1. |
| F14 | `/v1/completions`, `/v1/embeddings`, `/v1/responses` | Wider OpenAI API surface. |
| F15 | Load-aware routing when several providers host the same model | Makes "pool the team's GPUs" real. |
| F16 | Per-peer concurrency, for providers with GPUs that can serve requests in parallel | Not useful on the 4 GB demo GPU. |

## 7. Success metrics

Targets marked (H) are hypotheses to confirm or revise during the M3 rehearsal. The only figure measured so far: two Hyperswarm peers on this machine, over the public DHT, connected in 4.8 s (2026-10-14).

| Metric | Target |
|---|---|
| Time from `potluck use` start to first provider connected, different networks | ≤ 10 s p50 (H) |
| Added time to first token vs calling Ollama locally on the provider | ≤ 300 ms p50 (H) |
| Commands from install to first completion for a new teammate | ≤ 5 |
| Connection success across the 3 demo network pairs (home, café, phone tether) | 3 of 3, with relay fallback allowed |
| Non-member key connection attempts accepted | 0 |

For the portfolio, track these after launch: GitHub stars, issues opened by people other than the author, and LinkedIn post comments asking how to use it. These are signals, not targets.

## 8. Technical decisions

| ID | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Runtime | Node 22 for v1. Bare port only for F12. | Hyperswarm and Autobase verified on Node 22.22.2 on this machine. Bare requires `bare-*` replacements for `http` and `fetch`, which adds risk before the core works. |
| D2 | Transport framing | One Hyperswarm connection per peer carrying newline-delimited JSON, tagged by request id. Messages: `hello {models}`, `req {id, method, path, body}`, `cancel {id}`, `head {id, status, contentType}`, `chunk {id, d}` (base64 bytes), `end {id}`, `err {id, status, message}`. Schema in `src/protocol.js`. | Spike on 2026-10-14 (local testnet, fake SSE upstream): two concurrent streamed requests arrived complete and interleaved on one connection, about 15 lines of transport code. Protomux would add a dependency and protocol design for no v1 gain. A raw TCP pipe (the Hypertele pattern) can't route by model. Known limit: no per-request backpressure. |
| D3 | Discovery | Hyperswarm topic from `team.json`. Provider sends a `hello` message with its model list on connect and on change. | The topic only helps peers find each other. Access control is the key allow-list, not secrecy of the topic. |
| D4 | Upstream | Ollama's OpenAI-compatible API at `http://127.0.0.1:11434/v1`. | Most common local runtime. Any OpenAI-compatible server (llama.cpp `llama-server`, LM Studio) works the same way. |
| D5 | Language and tooling | Plain JavaScript ESM with `// @ts-check`, pnpm, vitest. No build step. | Holepunch modules and docs are JS. TypeScript adds a build step and type gaps on untyped modules. |
| D6 | Dependencies | Runtime: `hyperswarm` only, exact version pin. `b4a` dropped, since Node's `Buffer` covers it. Keys derive from the seed with `node:crypto` (test confirms they match Hyperswarm's). Dev: `vitest`, `hyperdht` (for `hyperdht/testnet`). `pnpm.packageExtensions` adds `b4a` to `bogon@1.3.0`, a HyperDHT dependency that requires it without declaring it. | Every dependency is code we don't control. HyperDHT releases often (6.34.1 published 2026-10-05). |
| D7 | Test strategy | `test/fake-ollama.js` (fake OpenAI-compatible SSE upstream) is the default dev target. CI runs one vitest integration suite on `hyperdht/testnet`: routing, streaming, firewall rejection of a non-member key, path allow-list, mid-stream disconnect. | Development and CI need no GPU, no Ollama and no internet. Real networks and Ollama are tested once, in the M3 rehearsal. |

## 9. Security and privacy

- **Threat model.** Team members trust each other. The design protects against outsiders on the internet, not against a malicious member.
- **Authentication.** Every connection is Noise-encrypted and bound to the remote Ed25519 public key. Both sides reject keys not in `team.json`.
- **A malicious provider can read prompts.** It sees what it processes. The README must say this plainly.
- **Topic exposure.** A leaked topic lets an outsider see that peers exist on it, but they can't connect without a member key.
- **Local surface.** The consumer endpoint binds to 127.0.0.1 only. The provider talks to a loopback upstream only, by default.
- **Upstream protection.** Path allow-list (F7) and limits (F8) stop members from managing models or exhausting the GPU.
- **Secrets.** Private keys live in `~/.potluck/` with mode 0600, are never logged and never go in `team.json`. `.gitignore` covers `.potluck/`, `*.key`, `.env*`.
- **Logging.** No prompts or completions are written to disk or logs. The usage log (F10) stores metadata only.

## 10. Milestones

Transport risk was retired by the D2 spike, so there is no separate spike milestone. Timeboxes are targets, not estimates from data.

| Milestone | Timebox | Exit criteria |
|---|---|---|
| M1 Single pair | 1 day | Done 2026-10-14. F1, F4, F5, F9 on the fake upstream, plus parts of F7 (path allow-list) and F8 (1 MB body cap). 17 tests pass on testnet, 5 consecutive clean runs. CLI verified on the public DHT on one machine. CI workflow written, not yet run on GitHub. |
| M2 Team | 1 day | Done 2026-10-14. F2, F3, F6, F8 complete; F7 completed in M1. 25 tests pass, 5 consecutive clean runs. Queue and timeout tests fail when their feature is disabled (checked). Full demo.md command flow verified on the public DHT on one machine. |
| M3 Ship | 1 day | Ollama with a 1B to 3B model on the provider. Rehearsal across the 3 demo network pairs. Section 7 numbers recorded from F9 logs. README with "why P2P" section, threat model and 60 s demo GIF. Repo public. |
| M4 Stretch | Open | P1 items, then P2 by priority. |

**Cut line:** if M2 overruns its timebox, ship M3 with one provider and a `--allow <key>` flag in place of `team.json`. Team files, discovery and the status endpoint move to v1.1.

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Hole punching fails on the demo networks (both sides behind randomizing NAT) | Medium | Rehearse on the exact networks. F11 relay fallback. |
| 4 GB GPU limits demo quality | High | Use a small instruction-tuned model. Show privacy and reachability, not model quality. Optionally borrow a larger GPU for the recording. |
| Reviewers see it as "Holesail plus Ollama" | Medium | README compares directly against section 1 options. Lead with discovery, key allow-list and model routing. |
| A slow consumer causes the provider to buffer a whole response (NDJSON has no per-request backpressure) | Low | Responses from a small model are small. The FIFO queue caps concurrent work at one request. Revisit with Protomux if F16 ships. |
| Unhandled stream errors crash the process (seen in the D2 spike on teardown) | Medium | `error` listener on every connection, covered by the mid-stream disconnect test (D7). |
| Consumer started before a provider announces waits for Hyperswarm's 10-minute lookup refresh (found in M1) | Fixed | Consumer looks up again every 5 s, backing off to 60 s, while no provider is connected. Regression test in place. On the public DHT the consumer connected 5.6 s after start. |
| Two processes sharing one identity (a member running `serve` and `use` at once) | Resolved | Supported and tested. Only `serve` announces on the DHT, so the key appears once. Your own `use` does not list your own models, since Hyperswarm skips your own key. Call Ollama directly for those. |
| Holepunch API changes mid-build | Medium | Exact version pins. Lockfile committed. |

## 12. Open questions

None of these block development. Q1 and Q2 block the public launch only.

- Q1. What happened to QVAC delegated inference after 1.1.0? Check the QVAC changelog and GitHub before citing it publicly.
- Q2. Name. Chosen 2026-10-14: PotluckLLM. As of that date `potluckllm` was free on npm, had no GitHub repos, and potluckllm.com (whois) and potluckllm.dev (RDAP) were unregistered. Rejected: `potluck` (potluck.com is an LLM monitoring product), `PeerLLM` (active GitHub org with SDKs), `llmnet` and `privatelm` (active local-LLM projects with the same pitch), `tunnellm` (frames the product as a tunnel), `p2pllm` (.com taken, generic). Still open: trademark search, and whether `potluck` is free as an npm name (not required, since the command ships inside `potluckllm`).
- Q3. Closed: flat member list in v1, no roles.
- Q4. Closed: Linux and macOS in v1. Windows is untested and unsupported.

## 13. Portfolio deliverables

- `README.md`: one-paragraph pitch, demo GIF, quickstart, "why P2P" comparison table, threat model.
- `PRD.md`: this document, kept current.
- `AI-WORKFLOW.md`: how AI was used for research, scoping, spikes and code, including ideas rejected and why. The first rejected idea was a P2P team decision log, dropped because P2P was decoration rather than necessary.
- LinkedIn post: the problem, the 60 s demo, one measured number, and what the AI-assisted process changed about how you scoped it.
