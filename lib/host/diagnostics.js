/**
 * Failure diagnostics that describe *what was being polished* without ever
 * recording *what it said*.
 *
 * A provider's rejection message is the one channel that can echo the draft
 * back: adapters routinely quote the offending input inside the error they
 * raise. A log line is also the one place that outlives the session that
 * produced it. So the failure record keeps only what is needed to correlate and
 * localise a fault — class, machine-readable code, HTTP status, the *length*
 * and a short hash of both the message and the draft, and the top frames of
 * the stack — and drops every free-text body.
 *
 * The cost is deliberate: a message that is only distinguishable by its text
 * has to be reproduced locally instead of read from a log. What that buys is a
 * log line that is safe to paste into an issue, and two occurrences of the same
 * fault that can be told apart without either one of them leaking the prompt.
 *
 * @module dsh-prompt-polish/host/diagnostics
 */

import { createHash } from "node:crypto";

/** Free-text is dropped, so this only bounds the fingerprint fields. */
const HASH_CHARS = 12;

/** Stack frames kept; enough to localise the fault, too few to dump a wall. */
const MAX_FRAMES = 3;

/**
 * A short, non-reversible identifier for some text.
 *
 * Two runs over the same draft produce the same fingerprint, so a repeated
 * failure is recognisable as repeated; two runs over different drafts produce
 * different fingerprints, so a single failure is not silently attributed to a
 * different input.
 *
 * @param {unknown} text - the text to fingerprint; non-strings yield `"none"`.
 * @returns {string} `"<length>ch/<hash>"`, or `"none"`.
 */
export function textFingerprint(text) {
  if (typeof text !== "string" || text === "") return "none";
  return `${String(text.length)}ch/${shortHash(text)}`;
}

/**
 * The stack's top frames, with its header line removed.
 *
 * The header (`Name: message`) is the part that can carry provider text; the
 * frames are `at fn (file:line:col)` and carry our own control flow, which is
 * what a maintainer actually needs.
 *
 * @param {unknown} stack - the raw stack.
 * @returns {string} the frames joined by a space, or `""` when there is none.
 */
function topFrames(stack) {
  if (typeof stack !== "string" || stack === "") return "";
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_FRAMES)
    .join(" <- ");
}

/**
 * Summarise a failure without its text.
 *
 * @param {unknown} error - the caught value.
 * @param {unknown} draft - the draft being polished, fingerprinted not quoted.
 * @returns {string} a single-line summary safe to log.
 */
export function failureSummary(error, draft) {
  if (error === null || typeof error !== "object") {
    return `name=${String(error)} draft=${textFingerprint(draft)}`;
  }
  const parts = [
    `name=${String(error.name ?? "Error")}`,
    `code=${String(error.code ?? error.status ?? error.statusCode ?? "-")}`
  ];
  if (error.message !== undefined) {
    parts.push(`msg=${textFingerprint(error.message)}`);
  }
  parts.push(`draft=${textFingerprint(draft)}`);
  const frames = topFrames(error.stack);
  if (frames !== "") parts.push(frames);
  return parts.join(" ");
}

/**
 * Emit one failure line through the Host logger, when there is one.
 *
 * @param {object|undefined} logger - `ctx.logger`, which may be absent in tests.
 * @param {string} prefix - what was being attempted, e.g. `"route POST /polish"`.
 * @param {unknown} error - the caught value.
 * @param {{draft?: unknown, elapsedMs?: unknown}} [meta] - correlation metadata.
 * @returns {void}
 */
export function logFailure(logger, prefix, error, meta = {}) {
  let line = `prompt-polish: ${prefix} failed: ${failureSummary(error, meta.draft)}`;
  if (Number.isFinite(meta.elapsedMs)) line += ` elapsed=${String(Math.round(meta.elapsedMs))}ms`;
  logger?.error?.(line);
}

/**
 * @param {string} text - text to hash.
 * @returns {string} the first {@link HASH_CHARS} hex characters of its SHA-256.
 */
function shortHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_CHARS);
}