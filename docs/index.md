---
layout: home

hero:
  name: agent-mesh
  text: One interface for every coding agent
  tagline: Drive Claude Code, Codex, Antigravity, and Cursor as headless workers — spawn, revise, and route by quota, strength, and latency. Unofficial.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /guide/architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/Toragonite/agent-mesh

features:
  - title: One adapter contract
    details: Every vendor exposes the same shape — one-shot run, resume by id, token usage, quota, auth-gated models. The Adapter interface freezes it so the orchestrator never learns vendor specifics.
  - title: Route by what matters
    details: Send each task to the agent with headroom in its quota, strength in the domain, and the right latency class — instead of burning one account.
  - title: Real revision loops
    details: Resume any conversation to revise it; steer mid-run where the vendor supports it. The fleet keeps context per conversation, per vendor.
  - title: Bring your own logins
    details: Each adapter drives the vendor's own official CLI under your own login. No credential sharing, no socket impersonation, no rate-limit circumvention.
---
