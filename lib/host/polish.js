/**
 * The polishing call: route resolution, the deadline, the stream, and the
 * translation of every failure into this plugin's own refusal vocabulary.
 *
 * The call is an *auxiliary* model request, not an agent turn. It is deliberately
 * stateless: the draft arrives from the composer, the rewrite goes back to the
 * composer, and nothing is appended to a session. A polished draft is not part of
 * the conversation until the human accepts it with the composer's own submit
 * action, so it must not become conversation history merely because it was
 * previewed.
 *
 * @module dsh-prompt-polish/host/polish
 */

import { logFailure } from "./diagnostics.js";
import {
  CODES,
  classifyFailure,
  collectText,
  decodeModelReply,
  decodeTruncatedReply,
  effectiveConfig,
  frameDraft,
  isChineseLocale,
  looksChinese,
  systemPrompt,
  validateDraft
} from "./prompt.js";

/**
 * Resolve the model route to call.
 *
 * Order: the plugin's own pinned route, then the profile's default model
 * selection. The default is what the composer is already using, so the polish
 * matches the model the user is talking to.
 *
 * @param {object} ctx - host context.
 * @param {{provider?: string, model?: string}} config - resolved plugin config.
 * @returns {{provider: string, model: string, source: string}|undefined} the route, or undefined when none is resolvable.
 */
export function resolveRoute(ctx, config) {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model, source: "config" };
  }
  let selection;
  try {
    selection = ctx.get?.("agentDefaultModel")?.currentSelection?.();
  } catch {
    return undefined;
  }
  if (typeof selection?.provider === "string" && selection.provider !== "" && typeof selection?.model === "string" && selection.model !== "") {
    return { provider: selection.provider, model: selection.model, source: "agent-default-model" };
  }
  return undefined;
}

/**
 * A deadline that is distinguishable from a caller's own cancellation, because
 * the two produce different advice for the user.
 *
 * @param {number} timeoutMs - how long the call may take.
 * @param {AbortSignal} external - the caller's signal, set when the human closed the panel.
 * @returns {{signal: AbortSignal, timedOut: () => boolean, cancelled: () => boolean, dispose: () => void}} the deadline.
 */
function deadline(timeoutMs, external) {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  // Deliberately not `unref`'d: the timer is cleared in `polishDraft`'s `finally`
  // before the call returns, so it cannot leak, and leaving it referenced is what
  // guarantees the deadline fires even if the request is the only work in flight.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // The client aborts its `fetch` when the human dismisses the panel, which closes
  // the connection. Without this the Host would keep paying for a full model call
  // whose answer is already known to be unwanted.
  const onExternalAbort = () => {
    cancelled = true;
    controller.abort();
  };
  if (external !== undefined && external !== null) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
    dispose: () => {
      clearTimeout(timer);
      if (external !== undefined && external !== null) external.removeEventListener("abort", onExternalAbort);
    }
  };
}

/**
 * Narrow a configured reasoning effort to one the chosen model declares.
 *
 * `dsh-llm` rejects a request whose `reasoningEffort` the model does not declare
 * (`UNSUPPORTED_REASONING_EFFORT`), and rejects ANY effort on a model with no
 * reasoning support at all. Clamping `high` down to `medium` therefore turned a
 * preference into a hard 502 on every model that does not offer `medium` — the
 * error surfaced as a generic transport failure. Send the value only when the
 * model lists it; otherwise leave the field out and let the route decide.
 *
 * When the capability lookup itself fails, the field is left out as well: a lost
 * speed tweak is cheaper than a failed polish.
 *
 * @param {object} llm - the mounted LLM service.
 * @param {{provider: string, model: string}} route - the resolved route.
 * @param {string|undefined} configured - the configured effort.
 * @param {AbortSignal} signal - the call's deadline signal.
 * @returns {Promise<string|undefined>} a supported effort, or undefined to defer.
 */
async function supportedEffort(llm, route, configured, signal) {
  if (configured === undefined) return undefined;
  if (typeof llm.resolveModelInfo !== "function") return undefined;
  let info;
  try {
    info = await llm.resolveModelInfo(route.provider, route.model, signal);
  } catch {
    return undefined;
  }
  const reasoning = info?.reasoning;
  if (reasoning === undefined) return undefined; // the model takes no effort at all
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts.map((entry) => entry?.id) : [];
  return efforts.includes(configured) ? configured : undefined;
}

/**
 * Wait for `ms`, waking early when the call is cancelled or its deadline passes.
 *
 * @param {number} ms - how long to wait.
 * @param {AbortSignal} signal - the call's deadline signal.
 * @returns {Promise<boolean>} true when the wait ran to completion, false when it was cut short.
 */
function pause(ms, signal) {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Drop the internal retry flag before a result leaves the module: the client
 * contract is `code` plus `message`, and an extra field in the JSON would be an
 * undocumented second contract.
 *
 * @param {object} result - a result carrying an optional `retryable` flag.
 * @returns {object} the same result without that flag.
 */
function withoutRetryFlag(result) {
  if (result.retryable === undefined) return result;
  const { retryable: _retryFlag, ...rest } = result;
  return rest;
}

/**
 * Polish one draft through the mounted LLM service.
 *
 * A capacity refusal (a gateway admitting one request at a time, which is what
 * a 429 on a shared key means) is retried here before it becomes the human
 * answer: the request never reached the model, so asking again duplicates
 * nothing, and the alternative is a button that fails whenever the session is
 * mid-generation.
 *
 * @param {object} ctx - host context exposing `llm` and optionally `agentDefaultModel`.
 * @param {object} options - the request.
 * @param {unknown} options.text - the raw draft.
 * @param {string|undefined} options.locale - the caller's locale tag.
 * @param {string|undefined} options.sessionId - the calling session, for attribution only.
 * @param {object|undefined} options.config - this plugin row's config.
 * @param {AbortSignal} options.signal - set when the caller went away (the human closed the panel).
 * @returns {Promise<{ok: true, value: object}|{ok: false, status: number, code: string, message: string}>} the result or a refusal.
 */
export async function polishDraft(ctx, { text, locale, sessionId, config, signal }) {
  const live = effectiveConfig(config);
  if (!live.enabled) {
    return { ok: false, status: 404, code: CODES.disabled, message: "prompt-polish 已在配置中关闭" };
  }
  const draft = validateDraft(text, live.maxInputChars);
  if (!draft.ok) {
    return { ok: false, status: 400, code: draft.code, message: draft.message };
  }
  const llm = ctx.get?.("llm");
  if (llm === undefined || llm === null) {
    return { ok: false, status: 503, code: CODES.noRoute, message: "这个部署没有挂载模型服务，无法美化" };
  }
  const route = resolveRoute(ctx, live);
  if (route === undefined) {
    return {
      ok: false,
      status: 503,
      code: CODES.noRoute,
      message: "无法确定使用哪个模型：请在插件配置里设置 provider 与 model，或先在本机选好默认模型"
    };
  }

  const call = deadline(live.timeoutMs, signal);
  const startedAt = Date.now();
  // Resolved against the chosen model's declared efforts BEFORE the call: see
  // supportedEffort() for why an unverified value is a hard 502.
  const effort = await supportedEffort(llm, route, live.reasoningEffort, call.signal);
  // Measured where it is reported, not once at the end: the old shape assigned it
  // only after a successful `collectText`, so every timeout and transport failure
  // logged `elapsed=0ms` — indistinguishable from a call that died instantly.
  const elapsed = () => Date.now() - startedAt;
  // How long to wait between attempts, from the plugin config: the default rides
  // out a session that is mid-generation, an empty list switches retrying off.
  const delays = live.retryDelaysMs;
  try {
    for (let attempt = 0; ; attempt += 1) {
      // Same deadline for every attempt: retrying must not buy the call more
      // wall-clock time than one call was promised.
      const result = await polishOnce({
        ctx,
        call,
        llm,
        live,
        route,
        effort,
        draft,
        locale,
        sessionId,
        elapsed
      });
      if (result.ok === true || result.retryable !== true || attempt >= delays.length) {
        return withoutRetryFlag(result);
      }
      const delayMs = delays[attempt];
      // Not enough of the deadline left to wait and still be useful: report the
      // refusal now instead of answering long after the caller gave up.
      if (live.timeoutMs - elapsed() <= delayMs) return withoutRetryFlag(result);
      if (!(await pause(delayMs, call.signal))) return withoutRetryFlag(result);
    }
  } finally {
    call.dispose();
  }
}

/**
 * One attempt at the call: the whole stream lifecycle for a single request.
 *
 * Split out of polishDraft so the retry loop owns the deadline and the backoff
 * while this function stays a straight line from request to decoded answer.
 *
 * @returns {Promise<object>} the result, with `retryable` set when another attempt may succeed.
 */
async function polishOnce({ ctx, call, llm, live, route, effort, draft, locale, sessionId, elapsed }) {
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: frameDraft(draft.text, locale) }]
        }
      ],
      system: systemPrompt(looksChinese(draft.text) || isChineseLocale(locale)),
      maxTokens: live.maxOutputTokens,
      // Rewriting is editing, not reasoning: without this the route's own default
      // (often `high`) would spend most of a long call thinking about text it is
      // about to copy. Undefined leaves the route in charge.
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      // An auxiliary purpose keeps this call out of the agent-loop attribution
      // path and lets provider extensions treat it as a side request.
      purpose: "prompt-polish",
      signal: call.signal,
      ...(typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {})
    });
    const { deltas, finish } = await collectText(stream);

    // The caller is gone: its answer has nowhere to go, so it is dropped before
    // it is decoded rather than handed back to a socket that no longer exists.
    if (call.cancelled()) {
      return { ok: false, status: 499, ...classifyFailure(undefined, false, true) };
    }
    if (call.timedOut()) {
      return { ok: false, status: 504, ...classifyFailure(undefined, true) };
    }
    const reason = finish?.reason;
    if (reason === undefined || typeof reason !== "object") {
      return {
        ok: false,
        status: 502,
        code: CODES.transport,
        message: "模型调用没有正常结束，请重试"
      };
    }
    if (reason.kind !== "stop") {
      if (reason.kind === "max-tokens") {
        // Whatever the model managed to write is still worth more than a refusal:
        // throwing it away turned a long draft into a dead button after a minute
        // of waiting. Recovery only accepts a rewrite that ends on real sentence
        // punctuation, so a half-thought is never pasted into the composer.
        const recovered = decodeTruncatedReply(deltas.join(""));
        if (recovered.ok) {
          return {
            ok: true,
            value: {
              original: draft.text,
              prompt: recovered.prompt,
              changes: recovered.changes,
              summary: recovered.summary,
              structured: recovered.structured,
              unchanged: recovered.prompt === draft.text,
              truncated: true,
              route: { provider: route.provider, model: route.model, source: route.source },
              elapsedMs: elapsed(),
              usage: { inputChars: draft.text.length, outputChars: recovered.prompt.length }
            }
          };
        }
        return {
          ok: false,
          status: 502,
          code: recovered.code,
          message: `${recovered.message}（当前上限 ${String(live.maxOutputTokens)}）`
        };
      }
      const refusal = classifyFailure(reason.failure, false);
      return {
        ok: false,
        status: refusal.code === CODES.aborted ? 499 : 502,
        code: refusal.code,
        message: refusal.message,
        retryable: refusal.retryable === true
      };
    }

    const decoded = decodeModelReply(deltas.join(""));
    if (!decoded.ok) {
      return { ok: false, status: 502, code: decoded.code, message: decoded.message };
    }
    return {
      ok: true,
      value: {
        original: draft.text,
        prompt: decoded.prompt,
        changes: decoded.changes,
        summary: decoded.summary,
        structured: decoded.structured,
        unchanged: decoded.prompt === draft.text,
        route: { provider: route.provider, model: route.model, source: route.source },
        elapsedMs: elapsed(),
        usage: { inputChars: draft.text.length, outputChars: decoded.prompt.length }
      }
    };
  } catch (error) {
    // A cancellation is a decision, not a fault: the caller's socket closed, so
    // there is nothing to report and a stack trace would only be noise.
    if (call.cancelled()) {
      return { ok: false, status: 499, ...classifyFailure(undefined, false, true) };
    }
    const refusal = classifyFailure({ code: error?.code, message: error?.message }, call.timedOut());
    // No stack and no draft text: see diagnostics.js for why the free text is
    // dropped. What survives is enough to correlate this fault with the next
    // one and to localise it to a frame.
    logFailure(ctx.logger, `call to ${route.provider}/${route.model}`, error, {
      draft: draft.text,
      elapsedMs: elapsed()
    });
    return {
      ok: false,
      status: refusal.code === CODES.timeout ? 504 : 502,
      code: refusal.code,
      message: refusal.message,
      retryable: refusal.retryable === true
    };
  }
}
