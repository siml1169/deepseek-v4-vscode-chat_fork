# Tune reasoning effort

Thinking variants accept three effort levels via the
`deepseekv4.reasoningEffort` setting:

| Value | Behavior |
|---|---|
| **`low`** | Lighter reasoning for lower latency. |
| **`high`** (default) | Balanced reasoning, matching the API default. |
| **`max`** | Deepest reasoning chain. Best for complex agent tasks, refactors, and bug hunts. Uses the most reasoning tokens. |

The setting is read at request time, so changes take effect on the **next
message** — no reload required.

## When to switch

- Use `high` for everyday work and `max` for harder tasks.
- Switch to `low` when response latency matters more than reasoning depth.

Existing explicit settings remain unchanged. Documented aliases map
`minimal` to `low`, `medium`/`xhigh` to `high`, and `ultra` to `max`.

You can flip between modes any time without changing the model.

## Where it shows up

- Hover the **DS V4** status-bar item — it displays the current effort
  next to a "configure" link.
- Each request also logs `[req] reasoning_effort=...` to the
  **DeepSeek V4** output channel (run `Show DeepSeek V4 Log`).

## What it does NOT affect

- Non-thinking variants (`DeepSeek V4 Pro`, `DeepSeek V4 Flash`) — the
  setting is ignored when thinking is disabled.
- Reasoning content already cached from prior turns — those round-trip
  unchanged. Only the new request uses the new effort.
