# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: [open a private advisory](https://github.com/jtxmp/potluckllm/security/advisories/new). Please don't open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker gains. This is a personal project, so reports are handled on a best-effort basis. Fixes land on `main`, which is the only supported version.

## What PotluckLLM defends against

The full threat model is in [docs/threat-model.md](docs/threat-model.md). In short: PotluckLLM protects a team from outsiders on the internet and from web pages running in a member's browser. It does not protect members from each other, because a provider necessarily sees the prompts it processes.

In scope:

- Connecting to a provider or consumer without a key listed in `team.json`
- Learning a provider's or consumer's IP address without a member key
- Reaching the consumer's local endpoint from a web page or another origin
- Crashing or hanging a consumer or provider with crafted protocol messages
- Reaching upstream routes other than `/v1/models` and `/v1/chat/completions`
- Prompts, completions or private keys appearing in logs

Out of scope:

- A member reading the prompts they serve, or a team owner misusing `team.json`
- Attacks that need write access to the user's home directory
- Vulnerabilities in Ollama or the upstream model server
