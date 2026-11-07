# SPEC — dsh-prompt-polish

## Problem

DSH's composer sends the draft as typed. Turning a rough note into a professional,
unambiguous, executable prompt is real work that the user must currently do by hand, and the
composer is exactly where that work belongs: it has the text, the model route, and the user's
attention.

The reference behaviour (TRAE's composer) is a single obvious affordance that rewrites the
draft in place. This plugin supplies the same capability for DSH, with one deliberate
difference: the rewrite is **reviewed before it is applied** rather than substituted silently.

## Requirements

| # | Requirement | Where it is met |
|---|---|---|
| 1 | Analyse the draft's structure and content | `systemPrompt()` rule 4–5; `frameDraft()` passes the draft as JSON data |
| 2 | Correct vague wording, grammar errors, and unprofessional phrasing | `systemPrompt()` rules 2–3 |
| 3 | Strengthen logic and executability | `systemPrompt()` rules 4–5 |
| 4 | Preserve the original intent and key information | `systemPrompt()` rule 1 and rule 8; the change list makes the edits auditable |
| 5 | Show a before/after comparison | `PolishDialog` — two panes, the change list, the summary, and the route/timing/character meta line |
| 6 | Add a visually obvious button in the composer | `PolishButton` in `conversation.input.right`: an accent-outlined pill with a sparkle icon and a label |
| 7 | Fast, without disturbing normal typing | one HTTP round trip; the button prevents `mousedown` from moving focus; the draft is only written on explicit confirmation; a busy state blocks double submission |

## Surface

| Slot | Kind | Entry id | Order |
|---|---|---|---|
| `conversation.input.right` | list, session | `dsh-prompt-polish.polish` | 20 |
| `conversation.input.overlay` | list, session | `dsh-prompt-polish.overlay` | 60 |

Both entries are in the **same scope** and carry the **same store handle**, so DSH resolves one
instance per session for the pair. That is what lets the panel's "Replace draft" write into the
composer the button belongs to, without any hand-off between them, and it gives the whole
feature the right lifetime: a rewrite belongs to the draft it rewrote, so switching sessions
leaves it behind instead of carrying it into another conversation.

`Modal` and `Toast` both portal into `document.body`, so the panel and the banners still appear
frame-wide even though their seat is inside the composer card.

> **Trap this design avoids.** `SlotCore` records the scope a store handle is first mounted
> under and refuses the same handle under a *different* scope — "one handle, one scope". That
> refusal is thrown from inside the `slots.inject` callback, where it silently drops the
> registration: no error reaches the user, no surface appears, and only the browser console
> shows a slot-entry crash. An earlier revision of this plugin put the panel in `shell.overlay`
> (root) while the button sat in `conversation.input.right` (session), which is exactly that
> mistake. Moving the panel to `conversation.input.overlay` made both seats session-scoped and
> removed the need for the `create`-override and the `liveComposer` hand-off it had required.

### Notation: why `conversation.input.right` and not an overlay

The reference screenshot floats the control over the top-right corner of the input box. DSH's
composer gives the text surface `padding: 4px 8px 0 14px` inside a `position: absolute;
height: 0` overlay anchor and reserves **no** trailing inset for text, so a persistent control
in `conversation.input.overlay` would cover the end of the draft's first line whenever the
draft is long enough to reach it. The alternative top seat
(`conversation.input.attachments`) is a `single` slot already owned by the attachment strip,
so claiming it would shadow shipped UI.

`conversation.input.right` is the host-provided list seat for exactly this kind of control
("compact controls before the composer submit action"), inside the composer card, under the
draft. The trade — a different corner in exchange for never covering the user's own text — is
recorded here so it can be revisited deliberately. `SLOT_BUTTON` in `lib/client.js` is the
single constant to change.

## Host contract

### `GET /prompt-polish/status`

```json
{ "ok": true, "value": { "enabled": true, "ready": true,
  "route": { "provider": "deepseek-official", "model": "deepseek-flash", "source": "agent-default-model" },
  "reason": null } }
```

`reason` is one of `disabled`, `no-llm-service`, `no-model-route`, or `null`.

### `POST /prompt-polish/polish`

Request: `{ "text": string, "locale"?: string, "sessionId"?: string }`

Success:

```json
{ "ok": true, "value": {
  "original": "…", "prompt": "…", "changes": ["…"], "summary": "…",
  "structured": true, "unchanged": false,
  "route": { "provider": "…", "model": "…", "source": "config|agent-default-model" },
  "elapsedMs": 6969,
  "usage": { "inputChars": 24, "outputChars": 612 } } }
```

Refusal: `{ "ok": false, "code": string, "message": string }` with an HTTP status that matches
the class of failure — 400 for the draft, 403 for the caller, 404 disabled/unknown action, 405
for the method, 413 for the body, 499 aborted, 502 for the model, 503 for a missing service or
route, 504 for the plugin's deadline, 500 for anything unforeseen.

Every `code` is stable and has a client-side translation, so the panel does not display
Chinese text inside an English UI:

| Code | Meaning |
|---|---|
| `empty-input` | the draft is absent, not a string, or blank |
| `input-too-long` | the draft exceeds `maxInputChars` |
| `disabled` | `enabled: false` |
| `no-model-route` | no pinned route and the profile has no default model selection |
| `provider-unavailable` | the adapter reported `NO_ADAPTER` |
| `missing-credential` | `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` |
| `timeout` | the plugin's own deadline fired |
| `model-busy` | the route refused for lack of capacity (a gateway admitting one concurrent request); retried before it is reported |
| `output-truncated` | the model hit `maxTokens` |
| `empty-output` | the model returned no text |
| `malformed-output` | an object-shaped reply with no rewrite field in it |
| `aborted` | the provider aborted |
| `transport-failure` | any other provider failure |
| `network` | the client could not reach the route at all |
| `internal` | an unforeseen server-side error |

### Which failures may be retried

Only one class of failure is retried: a refusal for lack of capacity, which is what a
gateway answers with when it admits a single concurrent request per key. Two properties
make that safe. The request never reached the model, so re-sending it duplicates no work
and spends no tokens; and the wait is short and bounded, so the cost of being wrong is a
few seconds rather than a duplicated long call.

Everything else stays single-shot. A malformed reply, a credential problem, a truncated
output and the plugin's own deadline are all answers — asking again would either repeat
the same outcome or spend quota twice on a request that may already have been served.

The classification reads the provider's own wording as well as its code, because the
gateway reports the refusal as `RATE_LIMIT` with `concurrent_request_limit` in the
message, and DSH's own retry policy does not treat that as retryable on this route. A
`retryable: false` hint in the provider body is deliberately ignored for the same reason:
it is what the gateway says about admission, not about the request.

### What a failure is allowed to leave behind

A refusal is answered to the caller, but it is also logged, and the log is the
one artefact that outlives the session. The failure record therefore carries
the error class, its machine-readable code, the elapsed time, and a fingerprint
of the draft and of the error message — each a length plus a short SHA-256
prefix — and drops the bodies of both. A provider's rejection is the one place
the draft can come back out verbatim, and a stack header is the one place the
message is guaranteed to be.

The top three stack frames are kept. They are `at fn (file:line:col)` and they
say which of *this plugin's* lines failed, which is the whole point of a stack
in a log. What is lost, deliberately, is the free text: a fault distinguishable
only by its wording has to be reproduced locally, and in exchange a log line is
safe to paste into a bug report.

Two drafts produce two fingerprints, so two occurrences of one fault are
recognisable as the same without either of them being readable.

## Model call

```js
ctx.llm.stream({
  provider, model,                       // pinned config, else the profile default model
  system: systemPrompt(chinese),         // instruction language follows the draft's script
  messages: [{ role: 'user', content: [{ type: 'text', text: frameDraft(text, locale) }] }],
  maxTokens: maxOutputTokens,
  purpose: 'prompt-polish',              // auxiliary: not an agent-loop request
  signal,                                // the plugin's own deadline
  sessionId,                             // attribution only, when the caller supplied one
})
```

The draft is framed as a JSON *value* with an explicit note that its contents are data to be
preserved and improved, never instructions to follow. That closes both the delimiter-injection
and the "model follows the draft's own instructions" failure modes in one step.

### Reply decoding

Auxiliary calls are not schema-constrained, so decoding is layered rather than strict:

1. Strip a Markdown fence (with and without a trailing newline), then take the outermost
   `{…}` slice.
2. `JSON.parse`. On success, accept the first usable rewrite field among
   `prompt, improved, rewritten, optimized, polished, result, text, content`; accept `changes`
   as an array or as a newline-separated string; clean, de-duplicate, and cap the bullets.
3. An object-shaped reply with no rewrite field **and** no prose around it is a malformed
   wrapper: fail with `malformed-output` rather than pasting braces into the composer.
4. Anything else is taken as the rewrite itself (`structured: false`). A real rewrite is worth
   more than a protocol detail, and the panel says the model returned no notes.
5. When the output cap fired, the partial reply goes through the same layering. A cut reply is
   recovered only when the rewrite ends on real sentence punctuation — for a JSON envelope *and*
   for a prose reply alike — because half a sentence pasted into a composer is worse than an
   honest error. Otherwise the call fails with `output-truncated`.

## Configuration resolution

Values are read through `readConfigValue`, which also unwraps the live reference objects a
settings write leaves behind. Numbers are clamped (never trusted), `provider` and `model` are
either both used or both ignored, and `trustedHosts` entries are shape-checked because they
widen an access decision. `enabled` is read per request so turning the plugin off in the
profile takes effect without a remount.

## State machine (client)

```
idle ──start──▶ loading (panel open, progress) ──succeed──▶ ready (panel open)
                   │                                            │
                   └────────────fail──▶ error (panel open, reason + retry)

loading ──close──▶ idle (panel closed, call aborted)   ← the human's way out
loading ──start──▶ loading (older run's answer is dropped, not shown)
```

`start` opens the panel immediately and `fail` keeps it open. Both were changed after a real
long-draft run: a spinner confined to a 28px button, followed by a four-second toast, is what
made a working button read as a dead one. `ready` may additionally carry `truncated: true`,
when the output cap fired but a trustworthy rewrite was recovered from the partial reply.

`close` ends the call, not just the panel. A long draft holds the model for up to the timeout,
and a panel dismissed with the answer still in flight used to reappear by itself the moment
that answer landed: the late `succeed` reopened a modal the human had already closed. Closing
now aborts the `fetch` through `closePanel`, and `runPolish` drops any answer whose run no
longer owns its seat, so a cancelled, superseded, or otherwise stale result can never write to
the store. The Host half reads the disconnect too (`res.on("close")`), so the model call ends
instead of being paid for and thrown away.

`PolishDialog` renders all three states. The loading state names the expected wait, because a
call measured 46–65 s across draft sizes and silence reads as a hang; its
single button reads "cancel" rather than "close", because that is what it now does. The error
state carries the Host's own sentence plus a retry that re-runs the same draft.

There is no cross-entry hand-off left to police: the button and the panel are handed the same
session-scoped store by DSH, and the panel's retry and replace actions are ordinary store
actions. A session switch unmounts the composer, which unmounts the panel with it.

## Verification performed

| Check | Result |
|---|---|
| Host policy unit tests (28) | pass |
| Host route tests, including access fences, every finish reason, the deadline, and body overflow, caller disconnection, and the log record of a failed call (19) | pass |
| Diagnostics tests: fingerprint stability, message- and draft-text absence, stack-header absence, frame retention, logger-less operation (11) | pass |
| Client bundle tests: platform-table imports, registration surface under a registry that enforces `one handle, one scope`, store transitions and the three panel states, click → POST → panel, apply/retry/copy, panel cancellation and stale-answer rejection (32) | pass |
| `npm test` | 90 pass, 0 fail |
| Bundle installation through `pluginManager/installBundle` | `application: applied`, `changed: true`, no warnings |
| Live Host route on the running GUI | `GET /prompt-polish/status` → `ready: true`. Observed routes differ over time: `deepseek-official / deepseek-flash` when first recorded, `minimax-cn / MiniMax-M3.1-Flash-Preview` on 2026-10-13, `deepseek-account / deepseek-flash` on 2026-10-19 — the route follows the profile default, not a pin |
| Live client-module graph | `dsh-prompt-polish/client.js` present in `__DSH_BOOT__` |
| Served bundle bytes | byte-identical to `lib/client.js` plus the source-map trailer |
| Real end-to-end polish call | the user's own 317-character draft → 1200-character structured rewrite + 7 change notes in 36.9 s, on `deepseek-flash` |
| Real polish calls at the documented input sizes | 2026-10-13, on `minimax-cn / MiniMax-M3.1-Flash-Preview`: 2 000 chars → 1 077 out in 65.1 s · 6 000 → 1 150 in 57.9 s · 8 000 → 1 373 in 46.1 s, all `ok` |
| Live refusal paths | 400 empty, 413 oversized body, 403 cross-site, 404 unknown action |
| Cancellation regression (client) | closing a running panel aborts the call, and its late reply — a value or a refusal — leaves the store untouched |
| Cancellation regression (Host) | a socket that closes mid-call aborts `llm.stream`'s signal and nothing is written to the dead response |
| Rendered button and panel | **not verified** — no browser control in this session |
| `InputActions.setDraft` replace semantics | **not verified** — no contract readable from inside the plugin |

### A wrong assumption, recorded because it was wrong

The system prompt asks for a rewrite "proportionate to the draft", and the
configuration advertises `maxInputChars: 8000` against `maxOutputTokens: 16384`
and `timeoutMs: 150000`. Extrapolating from the only prior sample — 317
characters in, 1 200 out, 36.9 s — suggests a long draft produces a
proportionally long rewrite and therefore overflows either the output cap or the
deadline.

Measured, it does not. Output length is flat at roughly 1 100–1 400 characters
from 2 000 characters of input to the full 8 000, and elapsed time does not
track input length at all: the 46 s and 65 s ends of that table are the same
kind of job. The rewrite is bounded by what the model chooses to write, not by
what it reads.

So the defaults stay as they are, and the two sentences that recorded the old
guess are replaced by the measurement. The generalisable part is the reason the
table exists: an assumption written into a comment or a default survives until
something runs it, and running it here was cheaper than the argument about it.

### The limits of that measurement

The input-size sweep ran on one route on one day: `minimax-cn /
MiniMax-M3.1-Flash-Preview`, 2026-10-13, with `reasoningEffort` left at the
patch layer's `low`. The profile default has since pointed at
`deepseek-account / deepseek-flash`, and nothing here re-measured against it.

What the sweep actually establishes is narrower than "output length does not
scale". It establishes that *a non-reasoning flash route asked for a concise
rewrite* does not scale, because that route compresses rather than expanding.
The "proportionate to the draft" rule is an instruction, and an instruction can
be followed in the other direction by a model that treats a long draft as a long
rewrite. So the safe reading is:

- On a flash route, `maxInputChars: 8000` and `timeoutMs: 150000` are
  comfortable, with 2–3× headroom observed.
- On a reasoning route, or one that expands rather than compresses, these
  numbers do not transfer. A 8 000-character draft that produced 8 000
  characters of rewrite would be roughly six times the longest output observed
  here, and the caller's wait scales with it.

Raising either default on the strength of this table would be the same mistake
in the opposite direction, so the numbers are recorded as the route they were
taken on, and a re-measurement is a precondition for changing them.

### Post-incident note

The first installation produced no visible button. Two causes compounded:

1. **The browser half needs a page load.** In this deployment the client-plugin HMR receiver
   only reloads plugin bundles live while a `pnpm run dev:web` watcher is running from the same
   checkout. There is none, so a refresh (or restart) is required before any client change is
   visible.
2. **The registration was silently dropped** by the one-handle-one-scope rule described above.

The lesson is recorded in the test harness as well: the fake slot registry now enforces the same
scope rule (`tests/client/bundle.test.js`), so this class of mistake fails a test instead of
disappearing into a console nobody is reading.

The last row is the honest gap: nothing here establishes what the user sees. The button's
rendered size, the panel's two-column layout at the user's window width, and light/dark
appearance must be confirmed by looking at the composer.
