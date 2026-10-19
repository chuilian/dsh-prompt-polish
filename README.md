# dsh-prompt-polish

**提示词美化 / Prompt polish** — a one-click prompt rewriter for the DeepSeek Harness Web composer.

Your draft usually reaches the agent exactly as you typed it. This plugin adds the missing
step: a sparkle pill in the composer that rewrites the draft into a professional,
unambiguous, executable prompt, and then shows you the before/after comparison before
anything is sent.

![icon](icon.svg)

## What it does

Click **美化** (or **Polish**) in the composer's control row:

1. The Host analyses the draft and rewrites it with the profile's own model — the same
   route the composer is already talking to.
2. The rewrite is held back for review. Nothing is sent to the agent.
3. A comparison panel opens with the original on the left, the rewrite on the right, and a
   list naming every edit.
4. **替换输入框** replaces the draft so you can keep editing or send it. **复制** copies the
   rewrite, **重新美化** runs the model again.

The rewriting policy, in the order the instructions state it:

| Duty | What that means in practice |
|---|---|
| Preserve intent | No requirement, file, technology, or datum is invented; no constraint, name, path, number, or example the author gave is dropped. An unknowable detail stays an explicit placeholder (`<目标文件>`) rather than a silent guess. |
| Remove vagueness | "优化一下", "有点问题", "差不多", "something like" become concrete and checkable. |
| Fix language | Grammar, punctuation, spelling, and casual or unprofessional wording, in the draft's own language — the rewrite is never translated. |
| Improve logic and executability | Organized as goal → requirements → constraints → deliverables → acceptance criteria, numbered when it helps, with every requirement independently checkable and obvious missing prerequisites filled in. |
| Repair logic | Contradictions, duplication, reversed causation, and missing preconditions are merged or reordered. |
| Stay proportionate | A short request stays short. No padding, no boilerplate, no invented persona. |
| Preserve code | Code blocks, commands, paths, and quotations are reproduced verbatim. |

## Where the button is

The composer's **bottom-right control cluster**, immediately left of the model selector —
the seat DSH's own slot contract calls "compact controls before the composer submit
action" (`conversation.input.right`, a list slot with room allocated for it).

It is deliberately *not* a floating button over the top-right corner of the input box. DSH's
composer reserves no trailing inset for the text surface, so a persistent control there
would sit on top of the first line of a long draft. Moving it is one constant
(`SLOT_BUTTON` in `lib/client.js`) if you would rather have the overlay look.

## Install

Installed the same way as any DSH bundle, from a source directory:

```
dsh plugin --profile <name> add link:/absolute/path/to/dsh-prompt-polish
```

…or through the Web GUI's plugin manager, or through the `plugin_manager` tool
(`install_bundle` with this directory as `target`). Each route has its own
prerequisite, because the two are easy to confuse:

| Route | What it does | What you must still do |
|---|---|---|
| `dsh plugin … add link:` | Installs the dependency only | Add `dsh-prompt-polish` to `dsh.profile.bundles` yourself, or nothing loads |
| `plugin_manager` / `install_bundle` | Adds the bundle **and** hot-reloads the profile | Refresh the page — the client half is a browser bundle |

Whichever route you take, a change to `lib/host/*` needs a DSH restart and a
change to `lib/client.js` needs a page refresh. Nothing here hot-reloads.

## Configuration

Optional, read from this plugin row's `config:` block. A later patch layer replaces the whole
block rather than merging into it, so restate any key you keep.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Answer the routes at all |
| `provider` / `model` | unset | Pin an explicit model route. Unset uses the profile's default model, so the polish matches the model you are talking to. Setting only one half is ignored — it is treated as unset rather than half-applied. |
| `maxInputChars` | `8000` | Longest draft accepted, in characters |
| `maxOutputTokens` | `16384` | Output cap for the polishing call. A measured 317-character draft about two subtasks produced 1200 characters of rewrite plus change notes, which overflowed the old `4096` default and made the plugin discard the whole rewrite |
| `timeoutMs` | `150000` | Deadline for one polishing call. Measured on the live installation: 46–65 s per call, flat across draft sizes (see [Measured behaviour](#measured-behaviour)). The old `90000` default was tight for anything longer |
| `reasoningEffort` | unset | `off`/`low`/`medium` are honoured; `high`/`max` are capped to `medium`. Unset leaves the route's own default, which is often `high` — correct, but slow on long drafts |
| `trustedHosts` | `[]` | Extra non-loopback authorities allowed to call the routes |

Changing any of these takes effect on the next request; no remount is needed.

## How it works

```
composer draft ──click──▶ POST /prompt-polish/polish
                              │
                              ├─ caller fences (loopback/trusted authority, no cross-site)
                              ├─ draft validation (non-empty, under the character cap)
                              ├─ route resolution (pinned → profile default model)
                              ├─ ctx.llm.stream({ system, messages, maxTokens, purpose })
                              ├─ caller disconnection (panel closed → the model call is aborted)
                              └─ reply decoding (JSON → prompt + changes + summary)
                              ▼
                     before/after panel ──替换输入框──▶ composer draft
```

- **Host half** (`lib/index.js`, `lib/host/*`): the route, the safety decisions, the model
  call, and the reply decoding. It imports **nothing** from DSH — only Node built-ins — so it
  cannot break on a Harness version change.
- **Client half** (`lib/client.js`): the button, the comparison panel, the banners, and the
  shared store. It is hand-written in DSH's lazy-CJS dialect and requires only the platform
  module table (`react`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-store`).

The polishing call is an **auxiliary** model request, not an agent turn: it is stateless,
nothing is appended to the session, and a polished draft only becomes conversation when the
human sends it. That is also why the model's answer is asked for as JSON and decoded
defensively rather than trusted — a model that answers with prose still produces a usable
rewrite.

## Measured behaviour

The system prompt tells the model to keep the rewrite "proportionate to the
draft", which reads like a promise that a long draft takes proportionally
longer. Measured against the running installation, it does not. Same seeded
text, truncated to each length, through the real route:

| Draft in | Elapsed | Rewrite out | Change notes |
|---|---|---|---|
| 2 000 chars | 65.1 s | 1 077 chars | 7 |
| 6 000 chars | 57.9 s | 1 150 chars | 6 |
| 8 000 chars | 46.1 s | 1 373 chars | 7 |

The rewrite stays around 1 100–1 400 characters whatever goes in, and the
elapsed time does not grow with the input — run-to-run spread on the same work
(46 s to 65 s) is wider than any input-size effect. The call is bounded by how
much it *writes*, not by how much it reads, so `maxInputChars` at `8000` is
honest and the default deadline has ample headroom.

**Which model produced that.** The three rows were measured on 2026-10-13
through the profile default, `minimax-cn / MiniMax-M3.1-Flash-Preview`. The
earlier 317-character sample was a different route, `deepseek-flash`. Both are
fast non-reasoning routes, which matters: the flat output length above is the
*model's* choice to rewrite concisely, not a guarantee the system prompt can
extract from any route. A reasoning route, or one that expands a long draft
instead of compressing it, would write more and take proportionally longer, and
this table would not predict it. Check `GET /prompt-polish/status` for the route
currently in play, and treat the numbers as the flash-route baseline rather than
as a property of the plugin.

Worth recording how that went: the defaults were originally justified by
extrapolating from a single 317-character sample, which predicted that a long
draft would overflow `maxOutputTokens` and then the deadline. Neither
happened. The table is the reason the defaults are what they are, because the
argument that replaced the extrapolation is weaker than running it.

## Security

`/prompt-polish/polish` spends the deployment's model quota and is reachable from a page, so
it is fenced exactly the way DSH fences its own `/api` bridge: the request authority must be
loopback or an authority this deployment declares (including the connection service's own
`trustedHosts`), `Sec-Fetch-Site` may not be `cross-site`, and `Origin`, when present, must
match the request authority. Bodies are capped at 256 KiB and drained on overflow. The Host
never reads a file, never touches the session log, and returns no credential or route
secret — only the provider and model id already visible in the composer.

Failure logging follows the same rule about text. A provider's rejection
message is the one channel that can quote the draft back, and a log line
outlives the session that wrote it, so `lib/host/diagnostics.js` records the
error class, its machine-readable code, and the *length plus a short hash* of
both the message and the draft — never either body. The stack's top three
frames are kept, because those localise a bug in this plugin; its header line,
which carries the message, is not.

## Development

```
npm test            # 90 tests: host policy, host routes, diagnostics, client bundle
npm run test:host
npm run test:client
```

The client test loads `lib/client.js` exactly the way the browser does — a stub
`window.__ModuleLoader__` captures the registration and a stub `require` answers only the
platform module table — which is what catches a plugin requiring a module the platform does
not expose or declaring a service it cannot have. Those are contract and logic tests; they
are not a substitute for looking at the running page.

## Limits

Attribution matters more than the count, so each one says whether it is a
platform boundary, a choice, or simply not done.

| # | Limit | Whose |
|---|---|---|
| L1 | The **rendered** button and panel have never been looked at. Verification reached the Host route, the live client-module graph and the served bundle bytes, and stopped there | Platform — this session has no browser control, so nobody can claim it looks right |
| L2 | A model that ignores the JSON contract still yields a rewrite, but with no change list | Platform — the other party to the call |
| L3 | **替换输入框** replaces the composer draft only if this DSH version's `InputActions.setDraft` replaces the whole value. A version that appends or reformats would silently alter the user's own text | Platform, and **unverified** — `setDraft`'s semantics are not something this plugin can read a contract for |
| L4 | Closing the panel during a call **cancels** it: the client aborts the request, the Host aborts the model call, and the answer is dropped rather than pushed into a panel the human already dismissed | My decision — a discarded answer costs one call, while a reopening panel costs the user's attention |
| L5 | How long a call takes, and how long the answer is, is the **model's** call. The measured flatness (see above) is what a non-reasoning flash route does when asked to keep the rewrite proportionate; a route that expands a long draft instead of compressing it would write more and take proportionally longer, and `timeoutMs` has been tuned against the compressing case only | Platform — the model is the other party, and which model is in play changes with the profile default |

L1 and L3 are the honest "this may genuinely be broken" entries. Nothing in
this list is a placeholder for work that was skipped silently.

### Where the plugin actually stands

| Tier | Means | What is in it |
|---|---|---|
| **Verified** | Exercised against the running installation | Host route, caller fences, every refusal path, client store and panel logic under a stubbed module loader, served bundle bytes, live calls at 317 / 2 000 / 6 000 / 8 000 characters, and the cancellation regression on both halves |
| **Unverified** | Never looked at — treat as possibly broken | L1, L3 |
| **Fixed** | Was broken; the defect and its regression test are both recorded | The panel reopening itself when a late answer arrived after the human had closed it — closed-panel cancellation, client and Host, each with a test that fails against the old code |
