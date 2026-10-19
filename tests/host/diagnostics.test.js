/**
 * The diagnostics module's whole reason for existing is what it *refuses* to
 * record, so most of these tests assert absence: a provider error that quotes
 * the draft must not put any of the draft into the log line.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { failureSummary, logFailure, textFingerprint } from "../../lib/host/diagnostics.js";

test("a fingerprint is stable for the same text and differs for other text", () => {
  const a = textFingerprint("请帮我写一个下单流程的提示词");
  assert.equal(a, textFingerprint("请帮我写一个下单流程的提示词"));
  assert.notEqual(a, textFingerprint("请帮我写一个退款流程的提示词"));
});

test("a fingerprint states the length, so two failures of different inputs are distinguishable", () => {
  assert.match(textFingerprint("abcd"), /^4ch\/[0-9a-f]{12}$/);
});

test("text that is absent is named rather than fingerprinted", () => {
  assert.equal(textFingerprint(""), "none");
  assert.equal(textFingerprint(undefined), "none");
  assert.equal(textFingerprint(42), "none");
});

test("a failure summary keeps the class and the machine-readable code", () => {
  const summary = failureSummary(Object.assign(new Error("boom"), { code: "ECONNRESET" }), "draft");
  assert.match(summary, /name=Error/);
  assert.match(summary, /code=ECONNRESET/);
});

test("a provider error that quotes the draft does not put the draft in the log", () => {
  const draft = "用户的身份证号是 FAKE-ID-000000000000000000，请帮我润色这条客服回复";
  // The shape adapters actually produce: the offending input quoted back inside
  // the error they raise.
  const error = Object.assign(new Error(`model refused input: ${draft}`), { code: "invalid_request" });
  const summary = failureSummary(error, draft);
  for (const fragment of ["身份证", "FAKE-ID-000000000000000000", "客服回复", "model refused input"]) {
    assert.equal(summary.includes(fragment), false, `summary leaked ${JSON.stringify(fragment)}: ${summary}`);
  }
  // …while still recording that there was a message, and how long it was.
  assert.match(summary, /msg=\d+ch\/[0-9a-f]{12}/);
  assert.match(summary, /draft=\d+ch\/[0-9a-f]{12}/);
});

test("a failure summary never carries the stack header, which is where the message lives", () => {
  const error = new Error("secret-token-abc123");
  error.stack = `Error: secret-token-abc123\n    at polishDraft (/x/polish.js:1:1)\n    at handler (/x/routes.js:2:2)`;
  const summary = failureSummary(error, "d");
  assert.equal(summary.includes("secret-token-abc123"), false);
});

test("a failure summary keeps the top frames, because those localise our own bug", () => {
  const error = new Error("boom");
  error.stack = "TypeError: x is not a function\n    at polishDraft (/x/polish.js:1:1)\n    at handler (/x/routes.js:2:2)";
  const summary = failureSummary(error, "d");
  assert.match(summary, /at polishDraft \(\/x\/polish\.js:1:1\)/);
});

test("a thrown value that is not an Error is still described", () => {
  assert.match(failureSummary("just a string", "d"), /name=just a string/);
});

test("logFailure writes one line with the fingerprint and the elapsed time", () => {
  const lines = [];
  logFailure({ error: (line) => lines.push(line) }, "call to p/m", new Error("boom"), {
    draft: "abcd",
    elapsedMs: 65123.4
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^prompt-polish: call to p\/m failed: name=Error/);
  assert.match(lines[0], /draft=4ch\/[0-9a-f]{12}/);
  assert.match(lines[0], /elapsed=65123ms$/);
});

test("logFailure leaves the elapsed time out when it is not known", () => {
  const lines = [];
  logFailure({ error: (line) => lines.push(line) }, "route GET /status", new Error("boom"), {});
  assert.equal(lines[0].includes("elapsed="), false);
});

test("logFailure stays silent when the Host mounts no logger", () => {
  assert.doesNotThrow(() => logFailure(undefined, "x", new Error("boom"), { draft: "d" }));
});