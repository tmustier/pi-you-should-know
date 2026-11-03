# pi-you-should-know

A Pi extension that occasionally taps you on the shoulder: "heads up, you probably missed this."

While an agent works, a second copy of the conversation is asked one question every few steps: is there something the user should know but probably didn't notice? Usually the answer is no and you see nothing. When the answer is yes, a short note appears above the editor, with a pointer to where it came from (a file and line, a test, a command).

It's a port of the "you should know" plugin built into Claude Code.

## Using it

- A note shows up above the editor, like `✦ Heads up · The agent loosened the test threshold from 0.8 to 0.65.` One note shows at a time. When more are waiting, `2 more waiting` appears under it; click that in fullscreen mode to see them all.
- `/ysk` or alt+shift+y: open the top note. You can have it explained, send it to the agent or dismiss it.
- alt+x: dismiss the top note.
- In fullscreen mode, each note ends with `[Ask agent]  [×]`: one click sends it to the agent or dismisses it. Dismissing shows Undo for 5 seconds. Click the note's text to open it under its line: it shows the evidence (a link, when the evidence is a file) and an Explain button. The explanation appears in place, with Ask agent and Dismiss below it. You can keep typing while a note is open. The open note is the one `/ysk` and alt+x act on. Dragging across a note still selects its text.
- The explanation screen opened from `/ysk` shows Ask agent and Dismiss as buttons, which you can click or press the key shown. Enter and Esc dismiss.
- `/ysk off`, `/ysk on`, `/ysk status`: turn it off and on, or see how many checks it has run.

Notes leave on their own when the agent deals with them. Each later check, and one more when the agent finishes, is asked which waiting notes the agent has since fixed, investigated or told you about; those disappear (the note you have open stays). The checks also skip anything the agent has only just come across, since it usually handles that itself. Up to 5 notes wait at once; while 5 are waiting, new notes are held back until there is room.

If you keep ignoring notes, it checks less often. Answering any note resets that.

Open notes and answer history are saved with the Pi session. The last 50 notes shown are saved under `~/.pi/agent/you-should-know/` (or your `PI_CODING_AGENT_DIR`), shared by every project, and later checks skip them. Relayed child notes stay in the inbox until they appear in the parent’s saved conversation.

## In RPC clients

Without Pi's terminal UI (for example in T3 Code), each note is sent once as a notification in the form `[ysk:<id>] <tag> · <line> (<evidence>)`, followed by its explanation, so the client can show and answer it. The client reports each answer back with `/ysk answer <id> <action>` (`knew`, `dismiss`, `learn` or `send`); that removes the note silently. `knew` is treated as `dismiss`. Notes are sent immediately, including between runs. T3 Code shows them in its heads-up band; `/ysk` points to those controls. Notes and answers survive a Pi restart. The client can undo an answer with `/ysk answer <id> undo`. Unanswered notes reduce the check frequency in RPC clients too.

## With herdr subagents

When the extension runs inside a [pi-herdr-subagents](https://github.com/aliceisjustplaying/pi-herdr-subagents) subagent, its notes aren't shown in the subagent's pane. They're passed to the parent agent as a message instead, labeled with the subagent's name, so the agent that's coordinating the work can act on them.

## Side models

By default each check uses the main model at the main thinking level. The check then starts with the same request bytes as the main agent and reads the main conversation from the prompt cache. Another model, or the same model at another thinking level, misses that cache and pays for the whole conversation again: on GPT-6.1 Sol a check read 72% to 83% of its input from cache at the main level and 0% at another level, about four times the cost.

You can still route a model family to another model or thinking level in `~/.pi/agent/you-should-know/config.json` (under `PI_CODING_AGENT_DIR` when set):

```json
{
  "gpt": { "model": "openai-codex/gpt-6.1-sol", "thinking": "high" },
  "fable": { "model": "anthropic/claude-opus-5-5", "thinking": "medium" }
}
```

`gpt` covers GPT models and `fable` covers Claude Fable models (including versioned variants). Each model value is a registered `provider/model-id`, using that provider's credentials; a missing model means the main model. Thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, subject to the selected model's support. A route to the main model at the main thinking level is treated as the cached default. Changes apply to the next check or explanation; `/ysk status` shows the effective model, thinking and config path.

The existing `YSK_MODEL` environment variable overrides the model for any family. Unknown model IDs fail the check rather than silently using the main model.

## Cost

A same-model check copies the main request (tools, system prompt, thinking) and adds only the new turn and the question, so most of its input is read from cache. This also works when another extension puts a message in front of the main request, as the Anthropic OAuth fix does. Pi does not run other extensions' request hooks on a check's own request, so an extension that rewrites requests (such as the OAuth fix) must load before this one. Every check is logged, with token usage, to `~/.pi/agent/you-should-know/checks.jsonl`.

With `YSK_DEBUG=1`, each check reports its outcome. When it retains the entire main request prefix, it also compares its cache read with the main request's cache read plus write. A shortfall shows a warning and logs `cache: { read, expected, ok: false }`. Partial matches still reuse the matching prefix, but skip this comparison: they cannot be expected to read the entire main cache. Diagnostics belong to each request, even when an explanation runs concurrently.

## Install

    pi install git:github.com/aliceisjustplaying/pi-you-should-know
