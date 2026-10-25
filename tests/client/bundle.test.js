/**
 * Client bundle tests.
 *
 * The bundle is the file DSH actually serves, so it is loaded here exactly the
 * way the browser loads it: a stub `window.__ModuleLoader__` captures the
 * registration, and a stub `require` answers only the specifiers the platform's
 * frozen module table provides. That verifies the things a client plugin can get
 * wrong fatally — requiring a module the platform does not expose, declaring a
 * service it cannot have, registering into a slot that does not exist — as well as
 * the composition and decision logic behind the button and the dialog.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "..", "lib", "client.js");

/** The platform module table the shell seeds, from `@deepseek-ai/dsh-client-modules`. */
const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit"
];

/** The two slots this plugin claims, and the scope each one lives in. */
const SLOT_SCOPES = {
  "conversation.input.right": "session",
  "conversation.input.overlay": "session",
  "shell.overlay": "root"
};

/** Slots whose kind is `list`, so `register` requires an id. */
const LIST_SLOTS = new Set(Object.keys(SLOT_SCOPES));

const EXPECTED_SLOTS = ["conversation.input.right", "conversation.input.overlay"];

/**
 * A minimal React stand-in.
 *
 * Effects run inline and their cleanups are recorded, which is what makes the
 * composer hand-off observable without a real renderer.
 */
function stubReact() {
  const effects = [];
  return {
    effects,
    Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: (callback) => {
      const cleanup = callback();
      effects.push(cleanup);
      return cleanup;
    },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial })
  };
}

/**
 * A stand-in for the component primitives.
 *
 * Every named export resolves to a marker function, so the plugin's own imports
 * are resolved without the package, while the explicit export list is what
 * `bundle: the primitives it imports all exist` checks against real names.
 */
const PRIMITIVE_EXPORTS = [
  "Button",
  "IconCopyOutlineRegular",
  "IconLoadingOutlineRegular",
  "IconRefreshOutlineRegular",
  "IconSparkleRegular",
  "IconWarningOutlineRegular",
  "Modal",
  "Toast",
  "Tooltip",
  "writeClipboard"
];

function stubPrimitives() {
  const table = {};
  for (const name of PRIMITIVE_EXPORTS) {
    table[name] = function Stub() {
      return null;
    };
  }
  table.writeClipboard = async () => true;
  return table;
}

/**
 * A faithful-enough `defineStore` for the parts the bundle uses: initial state,
 * draft-mutating actions, and snapshot/subscribe.
 */
function stubClientStore() {
  return {
    defineStore(decl) {
      return {
        spec: decl,
        create() {
          let state = decl.init();
          const listeners = new Set();
          const actions = {};
          for (const key of Object.keys(decl.actions)) {
            actions[key] = (...params) => {
              const draft = structuredClone(state);
              decl.actions[key](draft, ...params);
              state = draft;
              for (const listener of listeners) listener();
            };
          }
          return {
            actions,
            getSnapshot: () => state,
            subscribe: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            store: {},
            clearPersisted: () => {}
          };
        }
      };
    }
  };
}

/**
 * Load the bundle the way the browser does.
 *
 * @returns {Promise<{exports: object, id: string, required: string[], react: object}>} the module exports and what it required.
 */
async function loadBundle() {
  const source = await fs.readFile(BUNDLE, "utf8");
  const required = [];
  let registration = null;
  const previousWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        registration = entry;
      }
    }
  };
  try {
    // Run in this realm rather than a fresh context: `deepStrictEqual` compares
    // prototypes, so objects built inside another realm would never match the
    // literals they should equal.
    vm.runInThisContext(source, { filename: BUNDLE });
    assert.ok(registration !== null, "the bundle must call window.__ModuleLoader__.load");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  const react = stubReact();
  const modules = {
    react,
    "@deepseek-ai/dsh-client-ui-primitives": stubPrimitives(),
    "@deepseek-ai/dsh-client-store": stubClientStore()
  };
  const require = (specifier) => {
    required.push(specifier);
    if (!PLATFORM_MODULES.includes(specifier)) {
      throw new Error(`client-modules: cannot resolve "${specifier}" — it is not in the platform module table`);
    }
    if (!(specifier in modules)) throw new Error(`no stub for ${specifier}`);
    return modules[specifier];
  };
  return { exports: registration.factory(require), id: registration.id, required, react };
}

/**
 * Build the scope Cordis hands to a `ctx.inject(deps, cb)` callback.
 *
 * Property access on the scope is gated to the declared dependencies, exactly as
 * Cordis gates it on the reading fiber's inject map: reading any other service
 * throws. That is what lets these tests catch a plugin touching a service it never
 * declared — the mistake that fails DSH's whole page boot.
 */
function injectedScope(deps, provided, effect) {
  const allowed = new Set([...deps, "effect", "inject", "get", "slots"]);
  return new Proxy(
    {
      effect,
      get: (name) => provided[name],
      inject: () => () => {}
    },
    {
      get(object, property) {
        if (typeof property === "symbol" || property in object) return object[property];
        if (!allowed.has(property)) throw new Error(`cannot get property "${String(property)}" without inject`);
        return provided[property];
      }
    }
  );
}

/** A fake browser context that records slot registrations. */
function fakeClientCtx(services = {}, omit = []) {
  const registrations = [];
  const effects = [];
  /**
   * The scopes the real registry pins a store handle to, keyed by slot.
   *
   * `SlotCore` refuses one handle mounted under two different scopes ("one
   * handle, one scope"), which is fatal inside a `slots.inject` callback: the
   * registration never lands and the surface silently never renders. Reproducing
   * that rule here is what lets these tests catch the mistake.
   */
  const handleScopes = new Map();
  const effect = (callback) => {
    const dispose = callback();
    effects.push(dispose);
    return () => {
      if (typeof dispose === "function") dispose();
    };
  };
  const scope = {
    effect,
    slots: {
      inject: (name, callback) => {
        // The real seam only runs the callback once the owning declaration
        // exists; an unknown key never fires.
        if (!Object.hasOwn(SLOT_SCOPES, name)) return () => {};
        const returned = callback();
        if (returned !== null && typeof returned === "object" && typeof returned.next === "function") {
          for (const entry of returned) void entry;
        }
        return () => {};
      },
      register: (options, component) => {
        const slotScope = SLOT_SCOPES[options.name];
        if (slotScope === undefined) throw new Error(`unknown slot "${options.name}"`);
        if (LIST_SLOTS.has(options.name) && options.id === undefined) {
          throw new Error(`list slot "${options.name}" requires options.id`);
        }
        if (registrations.some((entry) => entry.options.name === options.name && entry.options.id === options.id)) {
          throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`);
        }
        if (options.store !== undefined) {
          const pinned = handleScopes.get(options.store);
          if (pinned !== undefined && pinned !== slotScope) {
            throw new Error(
              `store handle mounted under "${options.name}" (scope "${slotScope}") is already mounted under scope "${pinned}" — one handle, one scope`
            );
          }
          if (pinned === undefined) handleScopes.set(options.store, slotScope);
        }
        registrations.push({ options, component });
        return () => {};
      }
    }
  };
  const provided = {
    slots: scope.slots,
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
      getSnapshot: () => ({ active: "zh" }),
      subscribe: () => () => {}
    },
    ...services
  };
  for (const name of omit) delete provided[name];
  const target = {
    registrations,
    effects,
    get: (name) => provided[name],
    effect,
    inject: (deps, callback) => {
      if (!deps.every((dep) => provided[dep] !== undefined)) return () => {};
      callback(injectedScope(deps, provided, effect));
      return () => {};
    }
  };
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === "symbol" || property in object) return object[property];
      throw new Error(`cannot get property "${String(property)}" without inject`);
    }
  });
}

/** Walk a stub-React element tree into a flat list of `{type, props}` and text leaves. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.push({ text: String(node) });
    return out;
  }
  out.push({ type: node.type, props: node.props });
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

/** Props of every element built with the given tag name. */
function tagsIn(node, tag) {
  return walk(node)
    .filter((entry) => entry.type === tag)
    .map((entry) => entry.props);
}

/** Let the microtask queue drain so an unawaited fetch chain can settle. */
async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

/** Replace `globalThis.fetch` for one test and always restore it. */
async function withFetch(handler, body) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  }
}

/**
 * Build the props DSH supplies to one of this plugin's entries.
 *
 * The store instance comes from the bundle's own `defineStore`, exactly as the
 * renderer would build it, so the tests exercise the real actions.
 *
 * @param {object} loaded - the loaded bundle.
 * @param {object} store - the store instance shared by the entries under test.
 * @param {object} [overrides] - per-test prop overrides.
 * @returns {object} the entry props.
 */
function entryProps(loaded, store, overrides = {}) {
  const { draft = "", sessionId = "s-1", inputActions, t } = overrides;
  return {
    useInput: (selector) => selector({ draft }),
    inputActions: inputActions ?? { setDraft: () => {} },
    sessionId,
    useStore: (selector) => selector(store.getSnapshot()),
    actions: store.actions,
    t: t ?? ((key) => key)
  };
}

test("bundle: registers one lazy factory under the package id and requires only platform modules", async () => {
  const loaded = await loadBundle();
  assert.equal(loaded.id, "dsh-prompt-polish");
  assert.equal(typeof loaded.exports.apply, "function");
  assert.deepEqual(loaded.exports.inject, []);
  assert.equal(loaded.exports.NS, "promptPolish");
  assert.equal(loaded.exports.ROUTE, "/prompt-polish");
  assert.deepEqual([...new Set(loaded.required)].sort(), [
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-primitives",
    "react"
  ]);
});

test("bundle: every primitive it imports exists, and it imports no other client package", async () => {
  const source = await fs.readFile(BUNDLE, "utf8");
  const marker = source.indexOf("} = primitives;");
  assert.ok(marker > 0, "the bundle should destructure the primitives module");
  const start = source.lastIndexOf("const {", marker);
  const names = source
    .slice(start + "const {".length, marker)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  assert.deepEqual([...names].sort(), [...PRIMITIVE_EXPORTS].sort());

  const requests = [...source.matchAll(/require\((["'])([^"']+)\1\)/gu)].map((match) => match[2]);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((specifier) => PLATFORM_MODULES.includes(specifier)), `unexpected require: ${requests}`);
});

test("apply: registers the composer button and the overlay seat, and nothing else", async () => {
  const loaded = await loadBundle();
  const ctx = fakeClientCtx();
  loaded.exports.apply(ctx);

  assert.equal(ctx.registrations.length, 2);
  const bySlot = new Map(ctx.registrations.map((entry) => [entry.options.name, entry]));
  assert.deepEqual([...bySlot.keys()].sort(), [...EXPECTED_SLOTS].sort());
  for (const slot of EXPECTED_SLOTS) {
    const registration = bySlot.get(slot);
    assert.equal(typeof registration.component, "function", `${slot} needs a component`);
    assert.equal(registration.options.locale, "promptPolish");
    assert.ok(registration.options.id.startsWith("dsh-prompt-polish"));
    assert.equal(typeof registration.options.order, "number");
  }
  // Both seats hand the registry the SAME handle, unchanged. A per-entry clone or
  // a `create` override would either split the state or trip the registry's
  // one-handle-one-scope rule; DSH resolves the shared per-session instance from
  // the handle identity plus the entries' common scope.
  const handles = new Set(ctx.registrations.map((entry) => entry.options.store));
  assert.equal(handles.size, 1);
  assert.equal([...handles][0], loaded.exports.__test.storeHandle);
  assert.equal(typeof [...handles][0].spec, "object", "the handle must stay a defineStore handle");
});

test("apply: without a locale or slot service the entry stays inactive instead of failing boot", async () => {
  const loaded = await loadBundle();
  for (const missing of ["slots", "locale"]) {
    const ctx = fakeClientCtx({}, [missing]);
    loaded.exports.apply(ctx);
    assert.equal(ctx.registrations.length, 0, `no registration without ${missing}`);
  }
  // With both services present the entry does register, so the test above is not
  // passing for the wrong reason.
  const healthy = fakeClientCtx();
  loaded.exports.apply(healthy);
  assert.equal(healthy.registrations.length, 2);
});

test("styles: injected once, attributed to the plugin, theme-token only, and removed on unload", async () => {
  const loaded = await loadBundle();
  const injected = [];
  const fakeDocument = {
    querySelector: (selector) => injected.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
    createElement: () => {
      const tag = {
        dataset: {},
        textContent: "",
        remove: () => {
          const at = injected.indexOf(tag);
          if (at !== -1) injected.splice(at, 1);
        }
      };
      return tag;
    },
    head: {
      appendChild: (tag) => injected.push(tag)
    }
  };

  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const dispose = loaded.exports.__test.installStyles();
    assert.equal(injected.length, 1);
    assert.equal(injected[0].dataset.plugin, "dsh-prompt-polish");
    assert.equal(injected[0].dataset.pluginCss, "dsh-prompt-polish/styles.css");
    assert.ok(injected[0].textContent.includes("var(--dsw-"));
    // No literal colours: a plugin that pins a palette breaks in one of the themes.
    assert.equal(/#[0-9a-fA-F]{3,8}\b/u.test(injected[0].textContent), false);

    // A second install while the tag is live is a no-op, and its disposer must
    // not remove the tag the first install owns.
    const second = loaded.exports.__test.installStyles();
    assert.equal(injected.length, 1);
    second();
    assert.equal(injected.length, 1);

    dispose();
    assert.equal(injected.length, 0);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("store: the polish lifecycle moves through loading, ready, and closed", async () => {
  const loaded = await loadBundle();
  const store = loaded.exports.__test.createStore();
  assert.equal(store.getSnapshot().phase, "idle");
  assert.equal(store.getSnapshot().open, false);

  store.actions.start({ original: "  raw draft  " });
  assert.equal(store.getSnapshot().phase, "loading");
  assert.equal(store.getSnapshot().original, "  raw draft  ");
  assert.equal(store.getSnapshot().open, true, "the panel opens at once to show progress");

  store.actions.succeed({
    prompt: "A precise instruction.",
    changes: ["clarified the goal"],
    summary: "clearer",
    structured: true,
    unchanged: false,
    route: { provider: "p", model: "m" },
    elapsedMs: 1234
  });
  assert.equal(store.getSnapshot().phase, "ready");
  assert.equal(store.getSnapshot().open, true);
  assert.deepEqual(store.getSnapshot().changes, ["clarified the goal"]);

  store.actions.close();
  assert.equal(store.getSnapshot().open, false);

  store.actions.start({ original: "x" });
  store.actions.fail({ message: "被输出上限截断", code: "output-truncated" });
  assert.equal(store.getSnapshot().phase, "error");
  assert.equal(store.getSnapshot().open, true, "a refusal must stay readable, not fade away as a toast");
  assert.equal(store.getSnapshot().error, "被输出上限截断");
  assert.equal(store.getSnapshot().errorCode, "output-truncated");
});

test("store: a new run clears the previous refusal", async () => {
  const loaded = await loadBundle();
  const store = loaded.exports.__test.createStore();
  store.actions.start({ original: "x" });
  store.actions.fail({ message: "stale reason", code: "timeout" });
  store.actions.start({ original: "y" });
  assert.equal(store.getSnapshot().error, "");
  assert.equal(store.getSnapshot().errorCode, "");
  assert.equal(store.getSnapshot().truncated, false);
});

test("store: every session gets its own instance, so a result cannot leak across sessions", async () => {
  const loaded = await loadBundle();
  const { storeHandle } = loaded.exports.__test;
  const first = storeHandle.create("s-1");
  const second = storeHandle.create("s-1");
  const other = storeHandle.create("s-2");

  first.actions.start({ original: "draft" });
  first.actions.succeed({ prompt: "polished", structured: true });
  assert.equal(first.getSnapshot().open, true);
  // The renderer memoises per session key, so two lookups of one session agree;
  // a different session is a different instance and stays untouched.
  assert.equal(second.getSnapshot().phase, "idle");
  assert.equal(other.getSnapshot().phase, "idle");
  assert.notEqual(first, other);
});

test("store: a malformed success payload cannot put undefined text into the composer", async () => {
  const loaded = await loadBundle();
  const store = loaded.exports.__test.createStore();
  store.actions.start({ original: "x" });
  store.actions.succeed({ prompt: "ok" });
  assert.deepEqual(store.getSnapshot().changes, []);
  assert.equal(store.getSnapshot().summary, "");
  assert.equal(store.getSnapshot().structured, false);
  assert.equal(store.getSnapshot().route, null);
  assert.equal(store.getSnapshot().elapsedMs, 0);
});

test("store: banners are sequenced so a second one restarts the fade", async () => {
  const loaded = await loadBundle();
  const store = loaded.exports.__test.createStore();
  assert.equal(store.getSnapshot().notice, null);
  store.actions.publishNotice({ text: "first" });
  assert.deepEqual(store.getSnapshot().notice, { seq: 1, text: "first", tone: "success" });
  store.actions.publishNotice({ text: "second", tone: "warning" });
  assert.deepEqual(store.getSnapshot().notice, { seq: 2, text: "second", tone: "warning" });
  store.actions.clearNotice();
  assert.equal(store.getSnapshot().notice, null);
});

test("errorText: known refusal codes are localized, unknown ones keep the Host's sentence", async () => {
  const loaded = await loadBundle();
  const { errorText, dictionaries } = loaded.exports.__test;
  const t = (key) => dictionaries.zh[key] ?? key;
  assert.equal(errorText(t, "no-model-route", "server text"), dictionaries.zh["error.no-model-route"]);
  assert.equal(errorText(t, "some-new-code", "server text"), "server text");
  assert.equal(errorText(t, undefined, undefined), dictionaries.zh["error.transport-failure"]);

  const hostCodes = [
    "empty-input",
    "input-too-long",
    "disabled",
    "no-model-route",
    "provider-unavailable",
    "missing-credential",
    "timeout",
    "output-truncated",
    "empty-output",
    "malformed-output",
    "aborted",
    "transport-failure",
    "network",
    "internal"
  ];
  for (const code of hostCodes) {
    for (const locale of ["zh", "en"]) {
      assert.ok(Object.hasOwn(dictionaries[locale], `error.${code}`), `${locale} is missing error.${code}`);
    }
  }
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
});

test("button: disabled until there is a draft, and busy while a call is running", async () => {
  const loaded = await loadBundle();
  const { PolishButton, createStore } = loaded.exports.__test;
  const store = createStore();
  const buttonOf = (draft, inputActions) =>
    walk(PolishButton(entryProps(loaded, store, { draft, inputActions }))).find((entry) => entry.type === "button");

  assert.equal(buttonOf("   ").props.disabled, true);
  assert.equal(buttonOf("refactor this").props.disabled, false);
  assert.equal(buttonOf("refactor this").props["data-prompt-polish"], "button");
  assert.equal(buttonOf("refactor this").props["aria-busy"], "false");

  store.actions.start({ original: "refactor this" });
  const busy = buttonOf("refactor this");
  assert.equal(busy.props.disabled, true);
  assert.equal(busy.props["aria-busy"], "true");
  assert.ok(busy.props.className.includes("dsh-pp-buttonBusy"));

  // Without an input seat the button must not pretend it can write.
  assert.equal(buttonOf("hello", undefined).props.disabled, true);
});

test("button: renders the sparkle and the label, and keeps the composer's caret", async () => {
  const loaded = await loadBundle();
  const { PolishButton, createStore } = loaded.exports.__test;
  const tree = walk(PolishButton(entryProps(loaded, createStore(), { draft: "hi", t: (key) => key })));
  const button = tree.find((entry) => entry.type === "button");
  assert.equal(button.props.type, "button");
  assert.equal(button.props["aria-label"], "button.tooltip");
  assert.ok(tree.some((entry) => entry.text === "button.label"));
  // The icon is a primitive component, resolved through the stubbed table.
  assert.ok(tree.some((entry) => typeof entry.type === "function" && entry.type.name === "Stub"));

  let prevented = false;
  button.props.onMouseDown({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "a mousedown must not steal focus from the draft");
});

test("button: a click posts the draft, the locale, and the session to the Host route", async () => {
  const loaded = await loadBundle();
  const { PolishButton, createStore } = loaded.exports.__test;
  const store = createStore();
  const calls = [];
  // `activeLocale` reads the mounted client context, which `apply` installs.
  loaded.exports.apply(fakeClientCtx());

  await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      return {
        async json() {
          return { ok: true, value: { prompt: "Polished text.", changes: ["c"], summary: "s", structured: true, unchanged: false, route: { provider: "p", model: "m" }, elapsedMs: 5 } };
        }
      };
    },
    async () => {
      const tree = walk(PolishButton(entryProps(loaded, store, { draft: "raw draft" })));
      tree.find((entry) => entry.type === "button").props.onClick();
      assert.equal(store.getSnapshot().phase, "loading");
      await settle();
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/prompt-polish/polish");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: "raw draft", locale: "zh", sessionId: "s-1" });

  assert.equal(store.getSnapshot().phase, "ready");
  assert.equal(store.getSnapshot().open, true);
  assert.equal(store.getSnapshot().prompt, "Polished text.");
});

test("requestPolish: a Host timeout above 180s extends the client guard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const loaded = await loadBundle();
  const { requestPolish } = loaded.exports.__test;
  const calls = [];
  const controller = new AbortController();

  await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      if (url === "/prompt-polish/status") {
        return {
          async json() {
            return { ok: true, value: { timeoutMs: 300_000 } };
          }
        };
      }
      return await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    async () => {
      const pending = requestPolish({ text: "x", locale: "zh", sessionId: undefined }, controller.signal);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      assert.equal(calls.length, 1);
      t.mock.timers.tick(180_000);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      assert.equal(calls.length, 2, "the deadline asks the Host how long it waits");
      assert.equal(calls[1].url, "/prompt-polish/status");
      assert.equal(calls[0].init.signal.aborted, false, "180s must not cut off a longer Host deadline");
      t.mock.timers.tick(150_000);
      const result = await pending;
      assert.equal(calls[0].init.signal.aborted, true, "the Host deadline plus grace ends the wait");
      assert.equal(result.ok, false);
      assert.equal(result.code, "timeout");
    }
  );
});

test("requestPolish: an answered request leaves no deadline timer behind", async (t) => {
  // The deadline extension asks the Host how long it waits. When the answer
  // arrives while that probe is still in flight, the probe used to arm a fresh
  // timer afterwards — minutes later it woke up and asked the Host for a status
  // nobody was waiting for.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const loaded = await loadBundle();
  const { requestPolish } = loaded.exports.__test;
  const calls = [];
  let resolvePolish;
  let releaseProbe;
  const controller = new AbortController();

  await withFetch(
    async (url) => {
      calls.push({ url });
      if (url === "/prompt-polish/status") {
        await new Promise((resolve) => {
          releaseProbe = resolve;
        });
        return {
          async json() {
            return { ok: true, value: { timeoutMs: 300_000 } };
          }
        };
      }
      return await new Promise((resolve) => {
        resolvePolish = resolve;
      });
    },
    async () => {
      const pending = requestPolish({ text: "x", locale: "zh", sessionId: undefined }, controller.signal);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      assert.equal(calls.length, 1);

      // The client guard fires and starts the probe.
      t.mock.timers.tick(180_000);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      assert.equal(calls.length, 2, "the deadline asks the Host how long it waits");
      assert.equal(calls[1].url, "/prompt-polish/status");

      // The Host answers the polish while that probe is still in flight.
      resolvePolish({
        async json() {
          return { ok: true, value: { prompt: "ok" } };
        }
      });
      const result = await pending;
      assert.equal(result.ok, true);

      // The probe answers afterwards: the request is over, so nothing may be armed.
      releaseProbe();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      t.mock.timers.tick(600_000);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      assert.equal(calls.length, 2, "a settled request must not wake up and ask the Host again");
    }
  );
});

test("button: a refusal opens the panel and keeps the reason on screen", async () => {
  const loaded = await loadBundle();
  const { PolishButton, createStore, dictionaries } = loaded.exports.__test;
  const store = createStore();
  const zh = dictionaries.zh;

  await withFetch(
    async () => ({
      async json() {
        return { ok: false, code: "no-model-route", message: "host text" };
      }
    }),
    async () => {
      const tree = walk(
        PolishButton(entryProps(loaded, store, { draft: "raw draft", t: (key) => zh[key] ?? key }))
      );
      tree.find((entry) => entry.type === "button").props.onClick();
      await settle();
    }
  );

  assert.equal(store.getSnapshot().phase, "error");
  assert.equal(store.getSnapshot().open, true);
  assert.equal(store.getSnapshot().error, zh["error.no-model-route"]);
});

test("button: an unreachable Host opens the panel instead of leaving the button spinning", async () => {
  const loaded = await loadBundle();
  const { PolishButton, createStore, dictionaries } = loaded.exports.__test;
  const store = createStore();
  const zh = dictionaries.zh;

  await withFetch(
    async () => {
      throw new Error("Failed to fetch");
    },
    async () => {
      const tree = walk(PolishButton(entryProps(loaded, store, { draft: "raw draft", t: (key) => zh[key] ?? key })));
      tree.find((entry) => entry.type === "button").props.onClick();
      await settle();
    }
  );

  assert.equal(store.getSnapshot().phase, "error");
  assert.equal(store.getSnapshot().open, true);
  assert.equal(store.getSnapshot().error, zh["error.network"]);
});

test("dialog: shows both panes, the change list, the summary, and the meta line", async () => {
  const loaded = await loadBundle();
  const { PolishDialog, TextPane, createStore } = loaded.exports.__test;
  const store = createStore();
  const t = (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`);
  store.actions.start({ original: "帮我看看这个函数" });
  store.actions.succeed({
    prompt: "请审查 src/a.ts 中的 parse()，列出问题与修复建议。",
    changes: ["补充了目标文件", "明确了交付物"],
    summary: "范围与交付物都明确了",
    structured: true,
    unchanged: false,
    route: { provider: "deepseek-official", model: "deepseek-flash" },
    elapsedMs: 2400
  });

  const tree = walk(PolishDialog(entryProps(loaded, store, { t })));
  const panes = tree.filter((entry) => entry.type === TextPane);
  assert.equal(panes.length, 2);
  assert.equal(panes[0].props.text, "帮我看看这个函数");
  assert.equal(panes[0].props.polished, false);
  assert.equal(panes[1].props.text, "请审查 src/a.ts 中的 parse()，列出问题与修复建议。");
  assert.equal(panes[1].props.polished, true);

  const texts = tree.map((entry) => entry.text).filter(Boolean);
  assert.ok(texts.includes("补充了目标文件"));
  assert.ok(texts.includes("明确了交付物"));
  assert.ok(texts.includes("范围与交付物都明确了"));
  assert.ok(texts.some((entry) => entry.startsWith("dialog.metaElapsed")));
  assert.ok(texts.some((entry) => entry.startsWith("dialog.metaChars")));

  const modal = tree.find((entry) => entry.props?.className === "dsh-pp-dialog");
  assert.ok(modal !== undefined, "the dialog widens the shipped modal");
  assert.equal(modal.props.description, t("dialog.desc"));
  assert.ok(modal.props.footer !== undefined, "the dialog carries its own actions");
  assert.equal(modal.props.closeLabel, "dialog.close");
});

test("dialog: unchanged and unstructured results each say something different", async () => {
  const loaded = await loadBundle();
  const { PolishDialog, createStore } = loaded.exports.__test;
  const store = createStore();
  const t = (key) => key;
  const render = () => walk(PolishDialog(entryProps(loaded, store, { t })));

  store.actions.start({ original: "already clear" });
  // A running polish now holds the panel open with a progress state, because a
  // spinner confined to the button read as "nothing happened".
  const running = walk(PolishDialog(entryProps(loaded, store, { t })));
  assert.ok(running.some((entry) => entry.text === "dialog.loading"));

  store.actions.succeed({ prompt: "already clear", structured: false, unchanged: true });
  const unchanged = render();
  assert.ok(unchanged.some((entry) => entry.text === "dialog.unchanged"));
  assert.ok(unchanged.some((entry) => entry.text === "dialog.plain"));

  store.actions.succeed({ prompt: "changed", structured: true, unchanged: false, changes: ["a"] });
  const structured = render();
  assert.equal(structured.some((entry) => entry.text === "dialog.plain"), false);
  assert.equal(structured.some((entry) => entry.text === "dialog.unchanged"), false);
});

test("dialog: a closed store renders nothing at all", async () => {
  const loaded = await loadBundle();
  const { PolishDialog, createStore } = loaded.exports.__test;
  const store = createStore();
  store.actions.close();
  assert.equal(PolishDialog(entryProps(loaded, store, { t: (key) => key })), null);
});

test("dialog: closing a running panel cancels the call, and its late reply never reopens it", async () => {
  // The reported bug: a long draft takes a minute, the human closes the panel
  // while it is still working, and the panel pops itself back open when the
  // answer finally lands.
  const loaded = await loadBundle();
  const { PolishButton, PolishDialog, createStore, dictionaries } = loaded.exports.__test;
  const store = createStore();
  const zh = dictionaries.zh;
  loaded.exports.apply(fakeClientCtx());

  let release;
  let aborted = false;
  await withFetch(
    async (url, init) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
      });
      // Hold the answer open, exactly as a slow model route would.
      return await new Promise((resolve) => {
        release = () =>
          resolve({
            async json() {
              return { ok: true, value: { prompt: "late rewrite", structured: true } };
            }
          });
      });
    },
    async () => {
      walk(PolishButton(entryProps(loaded, store, { draft: "raw draft", t: (key) => zh[key] ?? key })))
        .find((entry) => entry.type === "button")
        .props.onClick();
      await settle();
      assert.equal(store.getSnapshot().phase, "loading");

      const panel = walk(PolishDialog(entryProps(loaded, store, { t: (key) => zh[key] ?? key }))).find(
        (entry) => entry.props?.className === "dsh-pp-dialog"
      );
      panel.props.onClose();
      assert.equal(store.getSnapshot().open, false, "the panel is dismissed");

      // The Host answers anyway — a dropped fetch may still settle, and a race
      // with the abort must not resurrect what the human just closed.
      release();
      await settle();
    }
  );

  assert.equal(aborted, true, "closing must cancel the call, not merely hide it");
  assert.equal(store.getSnapshot().open, false, "a dismissed panel must stay dismissed");
  assert.notEqual(store.getSnapshot().phase, "error", "a cancelled call is not a failure to report");
  assert.equal(store.getSnapshot().phase, "idle", "and the button must stop spinning");
});

test("dialog: a cancelled call that rejects with AbortError reports nothing", async () => {
  const loaded = await loadBundle();
  const { PolishButton, PolishDialog, createStore } = loaded.exports.__test;
  const store = createStore();
  loaded.exports.apply(fakeClientCtx());

  await withFetch(
    async (url, init) =>
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    async () => {
      walk(PolishButton(entryProps(loaded, store, { draft: "raw draft" })))
        .find((entry) => entry.type === "button")
        .props.onClick();
      await settle();
      walk(PolishDialog(entryProps(loaded, store, { t: (key) => key })))
        .find((entry) => entry.props?.className === "dsh-pp-dialog")
        .props.onClose();
      await settle();
    }
  );

  assert.equal(store.getSnapshot().open, false, "the abort must not raise an error panel");
  assert.equal(store.getSnapshot().error, "");
  assert.equal(store.getSnapshot().phase, "idle");
});

test("dialog: a stale answer cannot overwrite the run that replaced it", async () => {
  const loaded = await loadBundle();
  const { PolishButton, createStore } = loaded.exports.__test;
  const store = createStore();
  loaded.exports.apply(fakeClientCtx());

  const gates = [];
  await withFetch(
    async (url, init) =>
      await new Promise((resolve, reject) => {
        gates.push(resolve);
        // Abort-aware, so a request the fixed code cancels leaves nothing pending.
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    async () => {
      const click = () =>
        walk(PolishButton(entryProps(loaded, store, { draft: "raw draft" })))
          .find((entry) => entry.type === "button")
          .props.onClick();
      click();
      await settle();
      // Close, then start again before the first call has answered.
      store.actions.close();
      click();
      await settle();
      assert.equal(gates.length, 2, "the second run must actually start");
      // The FIRST run answers last, which is the ordering that used to clobber.
      gates[1]({
        async json() {
          return { ok: true, value: { prompt: "second", structured: true } };
        }
      });
      await settle();
      gates[0]({
        async json() {
          return { ok: true, value: { prompt: "first", structured: true } };
        }
      });
      await settle();
    }
  );

  assert.equal(store.getSnapshot().prompt, "second", "the newest run owns the panel");
  assert.equal(store.getSnapshot().open, true);
});

test("dialog: a provider that aborts is still reported, because the panel is still open", async () => {
  // `cancelled` (this human closed the panel) must stay distinct from the Host's own
  // `aborted` refusal (the provider gave up): the first is dropped, the second is
  // something the waiting human needs to read.
  const loaded = await loadBundle();
  const { PolishButton, createStore } = loaded.exports.__test;
  const store = createStore();
  loaded.exports.apply(fakeClientCtx());

  await withFetch(
    async () => ({
      async json() {
        return { ok: false, code: "aborted", message: "美化已取消" };
      }
    }),
    async () => {
      walk(PolishButton(entryProps(loaded, store, { draft: "raw draft" })))
        .find((entry) => entry.type === "button")
        .props.onClick();
      await settle();
    }
  );

  assert.equal(store.getSnapshot().phase, "error", "a provider abort is a refusal, not a dismissal");
  assert.equal(store.getSnapshot().open, true);
  assert.equal(store.getSnapshot().errorCode, "aborted");
});

test("dialog: replace-draft writes into the composer of the same session", async () => {
  const loaded = await loadBundle();
  const { PolishDialog, createStore, dictionaries } = loaded.exports.__test;
  const store = createStore();
  const written = [];
  const zh = dictionaries.zh;

  store.actions.start({ original: "raw" });
  store.actions.succeed({ prompt: "polished", structured: true });

  const props = entryProps(loaded, store, {
    inputActions: { setDraft: (text) => written.push(text) },
    t: (key) => zh[key] ?? key
  });
  const footer = walk(PolishDialog(props)).find((entry) => entry.props?.className === "dsh-pp-dialog").props.footer;
  const applyButton = walk(footer).filter((entry) => entry.type && entry.props?.variant === "primary").pop();
  assert.ok(applyButton !== undefined, "the footer carries the primary apply action");

  applyButton.props.onClick();
  assert.deepEqual(written, ["polished"]);
  assert.equal(store.getSnapshot().open, false);
  assert.equal(store.getSnapshot().notice.text, zh["notice.applied"]);
});

test("dialog: polish-again re-runs the same original through the Host", async () => {
  const loaded = await loadBundle();
  const { PolishDialog, createStore } = loaded.exports.__test;
  const store = createStore();
  const calls = [];
  loaded.exports.apply(fakeClientCtx());
  store.actions.start({ original: "the original draft" });
  store.actions.succeed({ prompt: "first rewrite", structured: true });

  await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      return { async json() { return { ok: true, value: { prompt: "second rewrite", structured: true } }; } };
    },
    async () => {
      const footer = walk(PolishDialog(entryProps(loaded, store, { t: (key) => key }))).find(
        (entry) => entry.props?.className === "dsh-pp-dialog"
      ).props.footer;
      // The first ghost action is retry, the second is copy.
      const retry = walk(footer).filter((entry) => entry.type && entry.props?.variant === "ghost" && entry.props?.icon !== undefined)[0];
      retry.props.onClick();
      assert.equal(store.getSnapshot().phase, "loading");
      assert.equal(store.getSnapshot().open, true, "the panel stays open showing progress");
      await settle();
    }
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body).text, "the original draft");
  assert.equal(store.getSnapshot().prompt, "second rewrite");
  assert.equal(store.getSnapshot().open, true);
});

test("dialog: copy reports the clipboard outcome through a banner", async () => {
  const loaded = await loadBundle();
  const { PolishDialog, createStore, dictionaries } = loaded.exports.__test;
  const store = createStore();
  const zh = dictionaries.zh;
  store.actions.start({ original: "raw" });
  store.actions.succeed({ prompt: "polished", structured: true });

  const footerOf = () =>
    walk(PolishDialog(entryProps(loaded, store, { t: (key) => zh[key] ?? key }))).find(
      (entry) => entry.props?.className === "dsh-pp-dialog"
    ).props.footer;
  const copyButton = () =>
    walk(footerOf()).filter((entry) => entry.type && entry.props?.variant === "ghost" && entry.props?.icon !== undefined);

  // The bundled primitives stub resolves `writeClipboard` to a successful write.
  copyButton()[1].props.onClick();
  await settle();
  assert.equal(store.getSnapshot().notice.text, zh["notice.copied"]);
});

test("overlay: the panel seat is always mounted, and a banner is transient", async () => {
  const loaded = await loadBundle();
  const { PolishOverlay, PolishDialog, createStore } = loaded.exports.__test;
  const store = createStore();
  const toastsIn = (tree) => tree.filter((entry) => entry.props?.text !== undefined && entry.type !== undefined);

  const quiet = walk(PolishOverlay(entryProps(loaded, store, { t: (key) => key })));
  assert.equal(quiet.filter((entry) => entry.type === PolishDialog).length, 1);
  assert.equal(toastsIn(quiet).length, 0, "no banner while there is nothing to report");

  store.actions.publishNotice({ text: "first", tone: "success" });
  const banner = walk(PolishOverlay(entryProps(loaded, store, { t: (key) => key })));
  assert.equal(toastsIn(banner).length, 1);
  assert.equal(toastsIn(banner)[0].props.text, "first");
  assert.equal(toastsIn(banner)[0].props.key, "1", "the banner is keyed by its sequence");
});

test("text pane: renders the exact text with no reformatting", async () => {
  const loaded = await loadBundle();
  const { TextPane } = loaded.exports.__test;
  const text = "line one\n\n  indented\n```js\ncode()\n```";
  const tree = walk(TextPane({ label: "Original", text, polished: false }));
  const pre = tree.find((entry) => entry.type === "pre");
  assert.equal(pre.props.className, "dsh-pp-text");
  assert.equal(pre.props.tabIndex, 0);
  assert.ok(tree.some((entry) => entry.text === text));

  const polished = walk(TextPane({ label: "Polished", text, polished: true }));
  assert.ok(polished.find((entry) => entry.type === "pre").props.className.includes("dsh-pp-textPolished"));
});

test("text pane: names itself for assistive tech, not only for the eye", async () => {
  const loaded = await loadBundle();
  const { TextPane } = loaded.exports.__test;
  for (const [label, polished] of [
    ["Original", false],
    ["Polished", true]
  ]) {
    const pane = walk(TextPane({ label, text: "x", polished })).find((entry) => entry.type === "div");
    // A bare <span> label is invisible to a screen reader, so the pane itself has
    // to carry the name that tells the draft from the rewrite.
    assert.equal(pane.props.role, "group");
    assert.equal(pane.props["aria-label"], label);
  }
});

test("styles: each confirmed measure is present in the stylesheet", async () => {
  const loaded = await loadBundle();
  const injected = [];
  const fakeDocument = {
    querySelector: (selector) => injected.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
    createElement: () => ({ dataset: {}, textContent: "", remove: () => {} }),
    head: { appendChild: (tag) => injected.push(tag) }
  };
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument;
  let css;
  try {
    loaded.exports.__test.installStyles();
    css = injected[0].textContent;
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  assert.ok(typeof css === "string");

  // 1) compact variant collapses to a true 28px circle
  assert.match(css, /box-sizing: border-box;[\s\S]*?\.dsh-pp-button \{ width: 28px; padding: 0 6px; \}/u);
  // 2) disabled retires the stroke but keeps the label legible
  assert.match(css, /\.dsh-pp-button:disabled \{ cursor: default; border-color: transparent; \}/u);
  assert.equal(css.includes(".dsh-pp-button:disabled { opacity:"), false);
  // Busy is work in progress, so it must not inherit the standby treatment.
  assert.match(
    css,
    /\.dsh-pp-buttonBusy:disabled \{ border-color: var\(--dsw-alias-state-business-primary\); \}/u
  );
  assert.match(css, /\.dsh-pp-buttonBusy:disabled \.dsh-pp-buttonIcon \{ opacity: 1; \}/u);
  // 3) hover/active converge on the accent, with the token fallback declared first
  const hover = /\.dsh-pp-button:hover:not\(:disabled\) \{([^}]*)\}/u.exec(css);
  assert.ok(hover !== null);
  assert.ok(
    hover[1].indexOf("var(--dsw-alias-interactive-bg-hover)") < hover[1].indexOf("color-mix("),
    "the fallback declaration must precede the color-mix one"
  );
  assert.match(css, /color-mix\(in srgb, var\(--dsw-alias-state-business-primary\) 22%, transparent\)/u);
  // 4) panes share the taller height, and the draft recedes behind the rewrite
  assert.match(css, /\.dsh-pp-grid \{[^}]*align-items: stretch; \}/u);
  assert.match(css, /\.dsh-pp-pane \{[^}]*height: 100%; \}/u);
  assert.match(css, /\.dsh-pp-text \{[\s\S]*?color: var\(--dsw-alias-label-tertiary\);/u);
  assert.match(css, /\.dsh-pp-textPolished \{[\s\S]*?color: var\(--dsw-alias-label-primary\);/u);
  // 5) change bullets carry the accent marker
  assert.match(css, /\.dsh-pp-changes li::marker \{ color: var\(--dsw-alias-state-business-primary\); \}/u);
  // 6) meta row is chips, no dot separators
  assert.match(css, /\.dsh-pp-chip \{/u);
  assert.match(css, /\.dsh-pp-chipAccent \{ color: var\(--dsw-alias-state-business-primary\); \}/u);
  assert.equal(css.includes("dsh-pp-metaDot"), false);
  // House rule: no pinned colours survive any of it.
  assert.equal(/#[0-9a-fA-F]{3,8}\b/u.test(css), false);
});

test("meta row: three chips, no dot separators, and the size delta carries the accent", async () => {
  const loaded = await loadBundle();
  const { PolishDialog, createStore } = loaded.exports.__test;
  const store = createStore();
  const t = (key) => key;
  store.actions.start({ original: "raw" });
  store.actions.succeed({
    prompt: "polished",
    structured: true,
    route: { provider: "p", model: "m" },
    elapsedMs: 1500
  });

  const tree = walk(PolishDialog(entryProps(loaded, store, { t })));
  const chips = tree.filter((entry) => entry.props?.className?.includes("dsh-pp-chip"));
  assert.equal(chips.length, 3);
  assert.equal(chips[2].props.className, "dsh-pp-chip dsh-pp-chipAccent");
  const texts = tree.map((entry) => entry.text).filter(Boolean);
  assert.equal(texts.includes("·"), false, "the dot separators are gone");
  assert.ok(texts.some((entry) => entry.startsWith("dialog.metaChars")));
});

test("secondsOf: formats the elapsed time the panel shows", async () => {
  const loaded = await loadBundle();
  const { secondsOf } = loaded.exports.__test;
  assert.equal(secondsOf(2400), "2.4");
  assert.equal(secondsOf(0), "0.0");
  assert.equal(secondsOf(undefined), "0.0");
  assert.equal(secondsOf(Number.NaN), "0.0");
});
