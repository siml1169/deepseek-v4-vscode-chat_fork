# Pick a DeepSeek V4 model

After setting your API key, open Copilot Chat and use the model picker at
the bottom of the chat input. You will see six DeepSeek V4 variants:

| Variant | Best for |
|---|---|
| **DeepSeek V4 Pro (thinking)** | Complex agent tasks, deep reasoning (effort tunable, see next step) |
| **DeepSeek V4 Pro** | Strong coding without the thinking-mode latency |
| **DeepSeek V4 Flash (thinking)** | Extended thinking and image input |
| **DeepSeek V4 Flash** | Fast everyday edits and image input |
| **DeepSeek V4 Flash Vision (thinking)** | Legacy picker entry for Flash with thinking and images |
| **DeepSeek V4 Flash Vision** | Legacy picker entry for Flash with images |

All four Flash entries now use `deepseek-flash`. Existing picker IDs and
saved selections remain compatible; Pro entries do not accept images.

If you don't see them in the picker, open VS Code's Language Models manager
and make sure DeepSeek V4 is enabled.

## Status bar

The DeepSeek V4 status-bar item shows your account balance and the running
session cost after the first request. Click it to view the full log channel
or refresh the balance.

## Cost transparency

Every chat completion logs the prompt-cache hit rate, completion tokens,
and reasoning tokens to the **DeepSeek V4** output channel. Session
spend is shown in the status-bar tooltip and is derived from your
account's `/user/balance` delta, so the figure always matches the real
bill regardless of DeepSeek's price changes. Run
**Show DeepSeek V4 Log** to inspect per-request token usage.
