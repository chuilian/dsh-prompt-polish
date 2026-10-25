/**
 * HTTP surface of prompt polishing.
 *
 * One prefix route (`/prompt-polish`) carries the whole API, so the plugin adds
 * exactly one row to the webserver's route table and cannot collide with another
 * plugin's paths. Every response is JSON; the mutating verb is a POST.
 *
 * The client half calls this with same-origin `fetch`, which is the transport a
 * third-party DSH plugin can rely on: DSH's typed Remote namespaces are
 * assembled at build time from an explicit package list, so an out-of-tree plugin
 * cannot contribute one, while the webserver's route registry is a documented
 * public seam.
 *
 * @module dsh-prompt-polish/host/routes
 */

import { isTrustedCaller, trustedAuthorities } from "./access.js";
import { logFailure } from "./diagnostics.js";
import { polishDraft, resolveRoute } from "./polish.js";

/** Route prefix, also the client half's `ROUTE` constant. */
export const ROUTE = "/prompt-polish";

/** Request-body cap. The configured input cap is far below this; the headroom is for JSON escaping of CJK text. */
const BODY_MAX_BYTES = 256 * 1024;

/** JSON response headers. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer"
};

/**
 * Write one JSON response.
 * @param {import("node:http").ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON-serializable body.
 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Sentinel returned when a body exceeds {@link BODY_MAX_BYTES}. */
const BODY_TOO_LARGE = Symbol("body-too-large");

/**
 * Read a bounded JSON object body.
 *
 * An oversized body is *drained* rather than destroyed: destroying the request
 * mid-body resets the connection, so the caller would see a network failure
 * instead of the 413 the handler is about to write.
 *
 * @param {import("node:http").IncomingMessage} req - request.
 * @returns {Promise<object|null|typeof BODY_TOO_LARGE>} the parsed object, null when absent/invalid, or the overflow sentinel.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    if (overflow) continue;
    size += chunk.length;
    if (size > BODY_MAX_BYTES) {
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) return BODY_TOO_LARGE;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Describe whether a polish can run right now.
 *
 * @param {object} ctx - host context.
 * @param {object} live - resolved config.
 * @returns {{enabled: boolean, ready: boolean, route: object|null, reason: string|null, timeoutMs: number}} the status value.
 */
function statusOf(ctx, live) {
  // The client reads this before it aborts a slow call: a client cap below the
  // Host's own deadline would cut off work the Host was still waiting on.
  const base = { timeoutMs: live.timeoutMs };
  if (!live.enabled) return { ...base, enabled: false, ready: false, route: null, reason: "disabled" };
  // The same test `polishDraft` applies, so the status endpoint never claims a
  // readiness the polish route would refuse.
  const llm = ctx.get?.("llm");
  if (llm === undefined || llm === null) {
    return { ...base, enabled: true, ready: false, route: null, reason: "no-llm-service" };
  }
  const route = resolveRoute(ctx, live);
  if (route === undefined) return { ...base, enabled: true, ready: false, route: null, reason: "no-model-route" };
  return { ...base, enabled: true, ready: true, route, reason: null };
}

/**
 * Register the `/prompt-polish` route.
 *
 * @param {object} ctx - host context carrying `webServer`.
 * @param {object} options - wiring.
 * @param {() => object} options.config - live config thunk.
 * @returns {() => void} the route disposer.
 */
export function registerPolishRoutes(ctx, { config }) {
  const handler = async (req, res) => {
    const live = config();
    // A polish of a long draft can hold the model for a minute or two. If the human
    // closes the panel in the meantime the client aborts its `fetch`, the socket
    // closes, and `res` emits `close` with no response written yet. That is the
    // Host's only sign that the answer it is paying for is unwanted, so it is wired
    // up before any model work starts.
    const caller = new AbortController();
    let responded = false;
    let loggedDraft = "";
    const reply = (status, body) => {
      responded = true;
      writeJson(res, status, body);
    };
    res.on("close", () => {
      if (!responded) caller.abort();
    });
    if (!isTrustedCaller(req, trustedAuthorities(ctx, live.trustedHosts))) {
      reply(403, { ok: false, code: "forbidden", message: "仅允许本机或受信任的主机调用" });
      return;
    }
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const action = url.pathname.replace(/^\/prompt-polish\/?/, "").replace(/\/+$/, "");

    if (method !== "GET" && method !== "POST") {
      reply(405, { ok: false, code: "method-not-allowed", message: `${method} is not supported` });
      return;
    }
    if (method === "GET" && action !== "" && action !== "status") {
      reply(405, { ok: false, code: "method-not-allowed", message: `${action} requires POST` });
      return;
    }

    try {
      if (method === "GET") {
        reply(200, { ok: true, value: statusOf(ctx, live) });
        return;
      }
      if (action !== "polish") {
        reply(404, { ok: false, code: "unknown-action", message: `unknown action ${JSON.stringify(action)}` });
        return;
      }

      const body = await readJsonBody(req);
      if (body === BODY_TOO_LARGE) {
        reply(413, { ok: false, code: "body-too-large", message: `请求体超过 ${String(BODY_MAX_BYTES)} 字节` });
        return;
      }
      const payload = body ?? {};
      // Kept out of the try block so the failure path below can fingerprint the
      // draft. Only ever hashed, never logged verbatim.
      loggedDraft = typeof payload.text === "string" ? payload.text : "";
      const result = await polishDraft(ctx, {
        text: payload.text,
        locale: typeof payload.locale === "string" ? payload.locale : undefined,
        sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
        config: live,
        signal: caller.signal
      });
      // The socket may already be gone; writing to it would only raise.
      if (caller.signal.aborted) return;
      if (!result.ok) {
        reply(result.status, { ok: false, code: result.code, message: result.message });
        return;
      }
      reply(200, { ok: true, value: result.value });
    } catch (error) {
      if (caller.signal.aborted) return;
      logFailure(ctx.logger, `route ${method} /${action}`, error, { draft: loggedDraft });
      reply(500, { ok: false, code: "internal", message: String(error?.message ?? error) });
    }
  };

  return ctx.webServer.register({ kind: "prefix", path: ROUTE, handler });
}
