/**
 * Host route tests.
 *
 * The route is the plugin's whole security and cost surface: it is reachable from
 * a page, it spends the deployment's model quota, and it must answer predictably
 * whatever the model does. These tests drive the real handler — the same function
 * the webserver calls — with a fake request, a fake response, and a fake LLM
 * service, so every branch a user can reach is exercised without a live provider.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { effectiveConfig } from "../../lib/host/prompt.js";
import { registerPolishRoutes } from "../../lib/host/routes.js";

/** A minimal `IncomingMessage`. */
function fakeRequest({ method = "POST", url = "/prompt-polish/polish", body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")];
  return {
    method,
    url,
    headers: { host: "127.0.0.1:19387", ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

/** A minimal `ServerResponse` that records what the handler wrote. */
function fakeResponse() {
  const listeners = new Map();
  return {
    status: 0,
    headers: undefined,
    payload: "",
    listeners,
    on(event, handler) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return this;
    },
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      this.payload = chunk ?? "";
    },
    json() {
      return JSON.parse(this.payload);
    }
  };
}

/** A fake LLM service that replays one scripted stream and records its options. */
function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return script(options);
    }
  };
}

/**
 * A fake host context.
 *
 * `get` is the ungated lookup the plugin uses for optional services, and the
 * webserver records the route it was handed so the tests can call it directly.
 * `services.logger` is merged over the no-op default, so a test can collect
 * what the plugin logs.
 */
function fakeHostCtx(services = {}) {
  const routes = [];
  const provided = { connection: { trustedHosts: [] }, ...services };
  return {
    routes,
    logger: { error() {}, info() {}, warn() {}, ...services.logger },
    get: (name) => provided[name],
    effect: (callback) => {
      const dispose = callback();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    inject: (deps, callback) => {
      if (!deps.every((dep) => provided[dep] !== undefined)) return () => {};
      callback({
        get: (name) => provided[name],
        effect: (callback2) => {
          const dispose = callback2();
          return () => {
            if (typeof dispose === "function") dispose();
          };
        }
      });
      return () => {};
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      }
    }
  };
}

/** Script one happy-path stream. */
function replyStream(text) {
  return async function* stream() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: "stop" } };
  };
}

/** Drive the registered handler once. */
async function call(ctx, request, response = fakeResponse()) {
  await ctx.routes[0].handler(request, response);
  return response;
}

/** Let pending microtasks and one macrotask turn run. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("cancellation: a caller that hangs up ends the model call and answers nobody", async () => {
  // The client aborts its fetch when the human closes the panel, so the socket
  // closes while a long polish is still running. The Host must stop paying for
  // that call, and must not write to the socket that is already gone.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const llm = fakeLlm(async function* stream() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "改写后的提示词" };
    await held;
    yield { type: "finish", reason: { kind: "stop" } };
  });
  const ctx = fakeHostCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  const response = fakeResponse();
  const pending = ctx.routes[0].handler(fakeRequest({ body: { text: "帮我优化这段提示词" } }), response);

  await tick();
  assert.equal(llm.calls.length, 1, "the model call starts");
  assert.equal(llm.calls[0].signal.aborted, false);

  response.emit("close"); // the human closed the panel mid-flight
  assert.equal(llm.calls[0].signal.aborted, true, "the model call is cancelled, not merely abandoned");

  release();
  await pending;
  assert.equal(response.status, 0, "nothing is written to a socket that is already gone");
  assert.equal(response.payload, "");
});

test("registration: one prefix route, so the plugin adds one row to the route table", () => {
  const ctx = fakeHostCtx();
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].kind, "prefix");
  assert.equal(ctx.routes[0].path, "/prompt-polish");
});

test("status: reports the profile's default model as a ready route", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream("x")),
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  const response = await call(ctx, fakeRequest({ method: "GET", url: "/prompt-polish/status" }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    value: {
      enabled: true,
      ready: true,
      route: { provider: "deepseek-official", model: "deepseek-flash", source: "agent-default-model" },
      reason: null,
      timeoutMs: 150_000
    }
  });
});

test("status: exposes the Host timeout so a client can outwait it", async () => {
  const ctx = fakeHostCtx({ llm: fakeLlm(replyStream("x")) });
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ timeoutMs: 300_000 }) });
  const response = await call(ctx, fakeRequest({ method: "GET", url: "/prompt-polish/status" }));
  assert.equal(response.json().value.timeoutMs, 300_000);
});

test("status: names the reason when no polish can run", async () => {
  const noLlm = fakeHostCtx();
  registerPolishRoutes(noLlm, { config: () => effectiveConfig(undefined) });
  const first = await call(noLlm, fakeRequest({ method: "GET", url: "/prompt-polish/status" }));
  assert.deepEqual(first.json().value, {
    enabled: true,
    ready: false,
    route: null,
    reason: "no-llm-service",
    timeoutMs: 150_000
  });

  const noRoute = fakeHostCtx({ llm: fakeLlm(replyStream("x")) });
  registerPolishRoutes(noRoute, { config: () => effectiveConfig(undefined) });
  const second = await call(noRoute, fakeRequest({ method: "GET", url: "/prompt-polish/status" }));
  assert.deepEqual(second.json().value, {
    enabled: true,
    ready: false,
    route: null,
    reason: "no-model-route",
    timeoutMs: 150_000
  });

  const disabled = fakeHostCtx({ llm: fakeLlm(replyStream("x")) });
  registerPolishRoutes(disabled, { config: () => effectiveConfig({ enabled: false }) });
  const third = await call(disabled, fakeRequest({ method: "GET", url: "/prompt-polish/status" }));
  assert.deepEqual(third.json().value, {
    enabled: false,
    ready: false,
    route: null,
    reason: "disabled",
    timeoutMs: 150_000
  });
});

test("status: a model service that is present but empty is not a ready route", async () => {
  // `polishDraft` refuses a null model service, so the status endpoint must not
  // claim a readiness the polish route would refuse.
  const ctx = fakeHostCtx({ llm: null, agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) } });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  const response = await call(ctx, fakeRequest({ method: "GET", url: "/prompt-polish/status" }));
  assert.equal(response.json().value.ready, false);
  assert.equal(response.json().value.reason, "no-llm-service");

  const polish = await call(ctx, fakeRequest({ body: { text: "hi" } }));
  assert.equal(polish.status, 503);
});

test("polish: returns the rewrite, the edits, and the route it used", async () => {
  const llm = fakeLlm(replyStream('{"prompt":"Rewrite this properly.","changes":["tightened"],"summary":"clearer"}'));
  const ctx = fakeHostCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  const response = await call(ctx, fakeRequest({ body: { text: "  rewrite this  ", locale: "en", sessionId: "s-1" } }));

  assert.equal(response.status, 200);
  const value = response.json().value;
  assert.equal(value.original, "rewrite this");
  assert.equal(value.prompt, "Rewrite this properly.");
  assert.deepEqual(value.changes, ["tightened"]);
  assert.equal(value.structured, true);
  assert.equal(value.unchanged, false);
  assert.deepEqual(value.route, {
    provider: "deepseek-official",
    model: "deepseek-flash",
    source: "agent-default-model"
  });
  assert.equal(typeof value.elapsedMs, "number");
  assert.deepEqual(value.usage, { inputChars: 12, outputChars: 22 });

  // The call itself: route, English instruction, request-only user message, cap,
  // auxiliary purpose, and a live cancellation signal.
  const options = llm.calls[0];
  assert.equal(options.provider, "deepseek-official");
  assert.equal(options.model, "deepseek-flash");
  assert.equal(options.maxTokens, 16384);
  assert.equal(options.purpose, "prompt-polish");
  assert.equal(options.sessionId, "s-1");
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(options.system.includes("senior prompt engineer"));
  assert.equal(options.messages.length, 1);
  assert.equal(options.messages[0].role, "user");
  assert.equal(options.messages[0].content[0].type, "text");
  assert.ok(options.messages[0].content[0].text.includes('"prompt":"rewrite this"'));
});

test("polish: the instruction language follows the draft when the caller reports none", async () => {
  const llm = fakeLlm(replyStream('{"prompt":"改写完成"}'));
  const ctx = fakeHostCtx({ llm, agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) } });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  await call(ctx, fakeRequest({ body: { text: "帮我把这个函数重构一下，顺便加测试" } }));
  assert.ok(llm.calls[0].system.includes("资深提示词工程师"));

  const llm2 = fakeLlm(replyStream('{"prompt":"done"}'));
  const ctx2 = fakeHostCtx({ llm: llm2, agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) } });
  registerPolishRoutes(ctx2, { config: () => effectiveConfig(undefined) });
  await call(ctx2, fakeRequest({ body: { text: "refactor this please", locale: "en-US" } }));
  assert.ok(llm2.calls[0].system.includes("senior prompt engineer"));
});

test("polish: a pinned route wins over the profile default", async () => {
  const llm = fakeLlm(replyStream('{"prompt":"ok"}'));
  const ctx = fakeHostCtx({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: "default", model: "default" }) }
  });
  registerPolishRoutes(ctx, {
    config: () => effectiveConfig({ provider: "minimax-cn", model: "MiniMax-M3" })
  });
  const response = await call(ctx, fakeRequest({ body: { text: "hi" } }));
  assert.equal(response.status, 200);
  assert.equal(llm.calls[0].provider, "minimax-cn");
  assert.equal(llm.calls[0].model, "MiniMax-M3");
  assert.equal(response.json().value.route.source, "config");
});

test("polish: refusals carry a stable code, not just a sentence", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream('{"prompt":"ok"}')),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ maxInputChars: 20 }) });

  const empty = await call(ctx, fakeRequest({ body: { text: "   " } }));
  assert.equal(empty.status, 400);
  assert.equal(empty.json().code, "empty-input");

  const missing = await call(ctx, fakeRequest({ body: {} }));
  assert.equal(missing.status, 400);
  assert.equal(missing.json().code, "empty-input");

  const tooLong = await call(ctx, fakeRequest({ body: { text: "x".repeat(21) } }));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json().code, "input-too-long");
});

test("polish: a disabled plugin answers instead of vanishing", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream('{"prompt":"ok"}')),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ enabled: false }) });
  const response = await call(ctx, fakeRequest({ body: { text: "hello" } }));
  assert.equal(response.status, 404);
  assert.equal(response.json().code, "disabled");
});

test("polish: a deployment without the model service is told apart from one without a route", async () => {
  const noLlm = fakeHostCtx();
  registerPolishRoutes(noLlm, { config: () => effectiveConfig(undefined) });
  const first = await call(noLlm, fakeRequest({ body: { text: "hello" } }));
  assert.equal(first.status, 503);
  assert.equal(first.json().code, "no-model-route");

  const noRoute = fakeHostCtx({ llm: fakeLlm(replyStream("x")) });
  registerPolishRoutes(noRoute, { config: () => effectiveConfig(undefined) });
  const second = await call(noRoute, fakeRequest({ body: { text: "hello" } }));
  assert.equal(second.status, 503);
  assert.equal(second.json().code, "no-model-route");
});

test("access: a cross-site caller cannot spend the deployment's quota", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream('{"prompt":"ok"}')),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });

  const crossSite = await call(ctx, fakeRequest({ body: { text: "hi" }, headers: { "sec-fetch-site": "cross-site" } }));
  assert.equal(crossSite.status, 403);

  const foreignOrigin = await call(
    ctx,
    fakeRequest({ body: { text: "hi" }, headers: { origin: "https://evil.example" } })
  );
  assert.equal(foreignOrigin.status, 403);

  const rebound = await call(ctx, fakeRequest({ body: { text: "hi" }, headers: { host: "evil.example" } }));
  assert.equal(rebound.status, 403);

  const sameOrigin = await call(
    ctx,
    fakeRequest({ body: { text: "hi" }, headers: { origin: "http://127.0.0.1:19387", "sec-fetch-site": "same-origin" } })
  );
  assert.equal(sameOrigin.status, 200);
});

test("access: a declared deployment authority is allowed through the host fence", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream('{"prompt":"ok"}')),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ trustedHosts: ["nas.local"] }) });
  const response = await call(ctx, fakeRequest({ body: { text: "hi" }, headers: { host: "nas.local:19387" } }));
  assert.equal(response.status, 200);
});

test("transport: methods, unknown actions, and oversized bodies are refused explicitly", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream('{"prompt":"ok"}')),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });

  const put = await call(ctx, fakeRequest({ method: "PUT", body: { text: "hi" } }));
  assert.equal(put.status, 405);

  const getPolish = await call(ctx, fakeRequest({ method: "GET", url: "/prompt-polish/polish" }));
  assert.equal(getPolish.status, 405);

  const unknown = await call(ctx, fakeRequest({ url: "/prompt-polish/nope", body: { text: "hi" } }));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().code, "unknown-action");

  const huge = await call(ctx, fakeRequest({ body: { text: "x".repeat(300 * 1024) } }));
  assert.equal(huge.status, 413);
  assert.equal(huge.json().code, "body-too-large");

  const malformed = await call(ctx, fakeRequest({ body: "{not json" }));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json().code, "empty-input");
});

test("capacity: a busy route is re-asked before the human is told anything", async () => {
  const attempts = [];
  const ctx = fakeHostCtx({
    llm: fakeLlm(() => {
      attempts.push(1);
      if (attempts.length === 1) {
        return (async function* busy() {
          yield {
            type: "finish",
            reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "concurrent_request_limit" } }
          };
        })();
      }
      return replyStream('{"prompt":"美化后的文本"}')({});
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  // Zero-delay schedule: the retry logic is what is under test, not the wall clock.
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ retryDelaysMs: [0, 0] }) });

  const response = await call(ctx, fakeRequest({ body: { text: "hi" } }));
  assert.equal(response.status, 200);
  assert.equal(response.json().value.prompt, "美化后的文本");
  assert.equal(attempts.length, 2);
});

test("capacity: exhausted retries end in the busy refusal, not a generic one", async () => {
  const attempts = [];
  const ctx = fakeHostCtx({
    llm: fakeLlm(() => {
      attempts.push(1);
      return (async function* busy() {
        yield { type: "finish", reason: { kind: "error", failure: { code: "HTTP_429", message: "too many requests" } } };
      })();
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ retryDelaysMs: [0, 0] }) });

  const response = await call(ctx, fakeRequest({ body: { text: "hi" } }));
  assert.equal(response.status, 502);
  assert.equal(response.json().code, "model-busy");
  assert.equal(attempts.length, 3);
});

test("model outcomes: every finish reason becomes an actionable refusal", async () => {
  const build = (script, config) => {
    const ctx = fakeHostCtx({
      llm: fakeLlm(script),
      agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
    });
    registerPolishRoutes(ctx, { config: () => effectiveConfig(config) });
    return ctx;
  };

  // A capacity refusal reports itself as such, and never leaks the internal
  // retry flag into the HTTP body. Retrying is switched off here so the refusal
  // surfaces on the first attempt (its own test covers the re-asking).
  const errored = build(
    async function* stream() {
      yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "slow down" } } };
    },
    { retryDelaysMs: [] }
  );
  const errorResponse = await call(errored, fakeRequest({ body: { text: "hi" } }));
  assert.equal(errorResponse.status, 502);
  assert.deepEqual(Object.keys(errorResponse.json()).sort(), ["code", "message", "ok"]);
  assert.equal(errorResponse.json().code, "model-busy");
  assert.match(errorResponse.json().message, /模型正忙/u);

  const noAdapter = build(async function* stream() {
    yield { type: "finish", reason: { kind: "error", failure: { code: "NO_ADAPTER", message: "no adapter" } } };
  });
  assert.equal((await call(noAdapter, fakeRequest({ body: { text: "hi" } }))).json().code, "provider-unavailable");

  const credential = build(async function* stream() {
    yield { type: "finish", reason: { kind: "error", failure: { code: "MISSING_CREDENTIAL", message: "no key" } } };
  });
  assert.equal((await call(credential, fakeRequest({ body: { text: "hi" } }))).json().code, "missing-credential");

  // A cut-off reply used to be thrown away entirely, which turned a long draft
  // into a dead button after a minute of waiting. The completed part is now kept.
  const truncated = build(async function* stream() {
    yield {
      type: "text-delta",
      index: 0,
      text: '{"prompt":"先在 B 站检索零基础 AI 小说教学，再整理成可执行的学习路径。"}'
    };
    yield { type: "finish", reason: { kind: "max-tokens" } };
  });
  const truncatedResponse = await call(truncated, fakeRequest({ body: { text: "hi" } }));
  assert.equal(truncatedResponse.status, 200);
  assert.equal(truncatedResponse.json().value.truncated, true);
  assert.equal(truncatedResponse.json().value.prompt, "先在 B 站检索零基础 AI 小说教学，再整理成可执行的学习路径。");

  // A cut that stops mid-sentence is still refused rather than pasted.
  const unrecovable = build(async function* stream() {
    yield { type: "text-delta", index: 0, text: '{"prompt":"先在 B 站检索零基础 AI 小说' };
    yield { type: "finish", reason: { kind: "max-tokens" } };
  });
  const unrecovableResponse = await call(unrecovable, fakeRequest({ body: { text: "hi" } }));
  assert.equal(unrecovableResponse.status, 502);
  assert.equal(unrecovableResponse.json().code, "output-truncated");

  const empty = build(replyStream(""));
  const emptyResponse = await call(empty, fakeRequest({ body: { text: "hi" } }));
  assert.equal(emptyResponse.status, 502);
  assert.equal(emptyResponse.json().code, "empty-output");

  const toolCall = build(async function* stream() {
    yield { type: "finish", reason: { kind: "tool-calls" } };
  });
  assert.equal((await call(toolCall, fakeRequest({ body: { text: "hi" } }))).status, 502);

  const noFinish = build(async function* stream() {
    yield { type: "text-delta", index: 0, text: "orphan" };
  });
  assert.equal((await call(noFinish, fakeRequest({ body: { text: "hi" } }))).json().code, "transport-failure");
});

test("model outcomes: a cut prose reply is refused, not pasted as a finished rewrite", async () => {
  // The output cap cuts whatever the model was writing, and what it was writing
  // is usually prose. Handing that cut prose back as the rewrite put half a
  // sentence into the user's composer, so the route refuses it the same way it
  // refuses a cut JSON envelope.
  const cut = fakeHostCtx({
    llm: fakeLlm(async function* stream() {
      yield { type: "text-delta", index: 0, text: "先在 B 站检索零基础 AI 小说教学，然后整理成学习路径，并列出每天的" };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(cut, { config: () => effectiveConfig(undefined) });
  const cutResponse = await call(cut, fakeRequest({ body: { text: "hi" } }));
  assert.equal(cutResponse.status, 502);
  assert.equal(cutResponse.json().code, "output-truncated");

  // A prose reply that ends on a sentence is still recovered.
  const whole = fakeHostCtx({
    llm: fakeLlm(async function* stream() {
      yield { type: "text-delta", index: 0, text: "先在 B 站检索零基础 AI 小说教学，然后整理成学习路径。" };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(whole, { config: () => effectiveConfig(undefined) });
  const wholeResponse = await call(whole, fakeRequest({ body: { text: "hi" } }));
  assert.equal(wholeResponse.status, 200);
  assert.equal(wholeResponse.json().value.truncated, true);
  assert.equal(wholeResponse.json().value.prompt, "先在 B 站检索零基础 AI 小说教学，然后整理成学习路径。");
});

test("model outcomes: the plugin's own deadline is reported as a timeout", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(async function* stream(options) {
      yield { type: "text-delta", index: 0, text: "thinking" };
      await new Promise((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", resolve, { once: true });
      });
      yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "aborted" } } };
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ timeoutMs: 1000 }) });
  const response = await call(ctx, fakeRequest({ body: { text: "hi" } }));
  assert.equal(response.status, 504);
  assert.equal(response.json().code, "timeout");
});

test("failures: a throwing model service is a refusal, never a crashed route", async () => {
  const ctx = fakeHostCtx({
    llm: {
      stream() {
        throw new Error("socket exploded");
      }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  const response = await call(ctx, fakeRequest({ body: { text: "hi" } }));
  assert.equal(response.status, 502);
  assert.equal(response.json().code, "transport-failure");
  assert.ok(response.json().message.includes("socket exploded"));
});

test("a route-level failure is logged without the draft or the provider's message", async () => {
  // The second path to the same claim the diagnostics unit tests make: this one
  // goes through the real route handler and a model service that fails the way
  // adapters actually fail — quoting the offending input back at us.
  const lines = [];
  const draft = "用户的手机号是 FAKE-PHONE-00000000000，请帮我把这条催款短信改得体面一些";
  const ctx = fakeHostCtx({
    logger: { error: (line) => lines.push(line), info() {}, warn() {} },
    llm: {
      stream() {
        throw Object.assign(new Error(`upstream rejected input: ${draft}`), { code: "invalid_request" });
      }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  await call(ctx, fakeRequest({ body: { text: draft } }));
  assert.equal(lines.length, 1);
  for (const fragment of ["手机号", "FAKE-PHONE-00000000000", "催款短信", "upstream rejected"]) {
    assert.equal(lines[0].includes(fragment), false, `log leaked ${JSON.stringify(fragment)}: ${lines[0]}`);
  }
  // …and it is still a usable record: which route, which class, which input size.
  assert.match(lines[0], /^prompt-polish: call to p\/m failed: name=Error code=invalid_request/);
  assert.match(lines[0], /draft=\d+ch\/[0-9a-f]{12}/);
  assert.match(lines[0], /elapsed=\d+ms$/);
});

test("configuration is read per request, so flipping it takes effect without a remount", async () => {
  let enabled = true;
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream('{"prompt":"ok"}')),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig({ enabled }) });
  assert.equal((await call(ctx, fakeRequest({ body: { text: "hi" } }))).status, 200);
  enabled = false;
  assert.equal((await call(ctx, fakeRequest({ body: { text: "hi" } }))).status, 404);
});

test("responses never forbid caching twice: JSON, no-store, and no referrer", async () => {
  const ctx = fakeHostCtx({
    llm: fakeLlm(replyStream('{"prompt":"ok"}')),
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }
  });
  registerPolishRoutes(ctx, { config: () => effectiveConfig(undefined) });
  const response = await call(ctx, fakeRequest({ body: { text: "hi" } }));
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
});
