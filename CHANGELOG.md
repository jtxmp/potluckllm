# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.1 (2026-10-15)

- New package description: "Share access to local LLMs privately, peer-to-peer."

## 0.1.0 (2026-10-15)

First release.

- `potluck serve` shares a local OpenAI-compatible server (such as Ollama) with team members over Hyperswarm. `potluck use` exposes the team's models at `http://127.0.0.1:11500/v1`.
- `potluck try` runs a provider, a consumer and a fake model on one machine, over the real DHT, with no GPU.
- `potluck id`, `potluck team init` and `potluck team add` manage identities and the team file. Edits to `team.json` apply without a restart, and removed members are disconnected.
- Both sides accept only public keys listed in `team.json`. Only `GET /v1/models` and `POST /v1/chat/completions` are forwarded.
- The provider runs one request at a time, with a queue of 16, a limit of 4 per member, a `max_tokens` cap, an idle timeout and a total time limit.
- The local endpoint refuses DNS rebinding, cross-site requests and non-JSON chat requests, and can require an API key (`POTLUCK_API_KEY`).
- `GET /potluck/status` lists connected members, their models and requests in flight.
- `scripts/rehearse.js` and `scripts/simnet.sh` measure connection time and latency on real or simulated networks.
