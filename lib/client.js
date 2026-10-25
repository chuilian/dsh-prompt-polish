/**
 * `dsh-prompt-polish` — browser half.
 *
 * Loaded by DSH's client module system, which serves this file under `/plugins`
 * and executes the `load({id, factory})` call below. The factory body runs lazily
 * on first materialization, so the module registers a factory and nothing here
 * runs at parse time.
 *
 * The bundle is hand-written in DSH's lazy-CJS dialect rather than produced by a
 * bundler, which keeps the plugin dependency-free and reviewable:
 *
 * - `require` resolves only the frozen platform table, whose seeded names are
 *   exactly `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 *   `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
 *   `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-dockkit`, and
 *   `@deepseek-ai/dsh-client-ui-primitives`. Those are exactly the specifiers used
 *   below.
 * - The module exports `apply` (the Cordis plugin body) and `inject`. `inject` is
 *   deliberately `[]`: services are acquired reactively inside `apply` with
 *   `ctx.inject`, so this entry can never leave the page boot waiting on a
 *   service it names, and a deployment missing an optional service degrades
 *   instead of failing the whole GUI's boot audit.
 *
 * Surface it contributes:
 *
 * | Slot | Scope | Purpose |
 * |---|---|---|
 * | `conversation.input.right` | session | the sparkle button, beside the model seat in the composer's control row |
 * | `conversation.input.overlay` | session | the before/after comparison panel and the result banners |
 *
 * Why those two seats:
 *
 * - The composer's own contract calls `conversation.input.right` "compact controls
 *   before the composer submit action", and it is a seat the composer itself lays
 *   out. A *persistent* button in `conversation.input.overlay` would sit on top of
 *   the draft's first line, because the composer allocates no trailing inset for
 *   text; a control that is always there belongs in a seat that already has room.
 * - The panel uses the overlay seat instead, which is what an on-demand surface is
 *   for: `Modal` and `Toast` portal into `document.body`, so it still looks
 *   frame-wide while its seat stays inside the composer card.
 * - Both seats are in the **session** scope and carry the **same store handle**, so
 *   DSH resolves one store instance per session for the pair. Sharing a handle
 *   across two *different* scopes is refused by the slot registry, and that
 *   refusal happens inside a `slots.inject` callback where it would drop the
 *   registration silently.
 *
 * @module dsh-prompt-polish/client
 */

window.__ModuleLoader__.load({
  id: "dsh-prompt-polish",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const clientStore = require("@deepseek-ai/dsh-client-store");

    const h = React.createElement;
    const { Fragment, useCallback } = React;
    const {
      Button,
      Modal,
      Tooltip,
      Toast,
      writeClipboard,
      IconSparkleRegular,
      IconLoadingOutlineRegular,
      IconCopyOutlineRegular,
      IconRefreshOutlineRegular,
      IconWarningOutlineRegular
    } = primitives;

    //#region constants

    /** Dictionary namespace owned by this plugin. */
    const NS = "promptPolish";
    /** Host route prefix, matching `ROUTE` in lib/host/routes.js. */
    const ROUTE = "/prompt-polish";
    /** The composer seat the button occupies. */
    const SLOT_BUTTON = "conversation.input.right";
    /** The floating composer seat the comparison panel and the banners occupy. */
    const SLOT_OVERLAY = "conversation.input.overlay";
    /** Button order: after any shipped compact control, before the model seat's own group. */
    const BUTTON_ORDER = 20;
    /** Overlay order: above the shipped floating composer entries. */
    const OVERLAY_ORDER = 60;
    /** Client-side guard so a wedged Host request cannot leave the button spinning forever. */
    const REQUEST_TIMEOUT_MS = 180_000;
    /** Teardown headroom past the Host's own deadline, so its readable refusal arrives first. */
    const CLIENT_TIMEOUT_GRACE_MS = 30_000;
    /** How long the deadline extension may spend asking the Host for its `timeoutMs`. */
    const HOST_TIMEOUT_PROBE_MS = 5_000;
    /**
     * Client-only refusal code for "the human dismissed this panel".
     *
     * Kept apart from the Host's `aborted` code on purpose: that one is a real
     * refusal the human should read, while this one means there is nobody left to
     * read it.
     */
    const CANCELLED = "cancelled";
    /** How many `changes` rows the dialog lists before it stops. */
    const MAX_LISTED_CHANGES = 12;

    //#endregion

    //#region styles

    /**
     * Stylesheet for this plugin's surfaces.
     *
     * Every colour comes from a `--dsw-*` design token, so the button and the
     * dialog follow the app's theme (including dark mode) instead of pinning a
     * palette. Attributed with `data-plugin` so DSH's module system can retire it
     * when the plugin unloads, and keyed with `data-plugin-css` so a
     * re-materialization cannot double-inject.
     *
     * `box-sizing: border-box` on the button is what makes the 28px compact
     * variant a true 28px circle: without it the declared height excludes the
     * border and the padding would have to be tuned around a 14px icon by hand.
     */
    const CSS = `
.dsh-pp-seat { display: inline-flex; align-items: center; flex: none; }

.dsh-pp-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px 0 9px;
  border: 1px solid var(--dsw-alias-state-business-primary);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font-family: var(--dsw-font-family);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .1s, opacity .1s;
}
/* The accent tint is declared twice: the token fallback first, so a browser
   without color-mix keeps the neutral hover the shell already uses. */
.dsh-pp-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
}
.dsh-pp-button:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
}
/* Disabled reads as "standing by", not "broken": the stroke retires while the
   label stays legible, instead of fading the whole control into nothing. */
.dsh-pp-button:disabled { cursor: default; border-color: transparent; }
.dsh-pp-button:disabled .dsh-pp-buttonIcon,
.dsh-pp-button:disabled .dsh-pp-label { opacity: .4; }
/* Busy is the one disabled state that is NOT standby — work is happening, so it
   keeps its full stroke and contrast and only the label yields. A spinner that
   looks weaker than the idle button reads as "nothing is running". */
.dsh-pp-buttonBusy:disabled { border-color: var(--dsw-alias-state-business-primary); }
.dsh-pp-buttonBusy:disabled .dsh-pp-buttonIcon { opacity: 1; }
.dsh-pp-buttonBusy:disabled .dsh-pp-label { opacity: .55; }
.dsh-pp-button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.dsh-pp-buttonIcon { display: inline-flex; flex: none; }
.dsh-pp-buttonBusy .dsh-pp-buttonIcon { animation: dsh-pp-spin 1s linear infinite; }

/* Compact: symmetric padding plus the icon's own 14px and the 1px stroke on each
   side fills exactly the declared 28px box, so the pill collapses to a circle
   that matches the composer's other round controls. */
@container (width<=560px) {
  .dsh-pp-label { display: none; }
  .dsh-pp-button { width: 28px; padding: 0 6px; }
}

@keyframes dsh-pp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-pp-buttonBusy .dsh-pp-buttonIcon { animation: none; } }

/* The shipped modal is 380px wide; a side-by-side comparison needs the room.
   The doubled class keeps this ahead of the primitive's own single-class rule
   regardless of stylesheet order. */
.dsh-pp-dialog.dsh-pp-dialog { width: min(940px, 100%); max-height: 100%; }
.dsh-pp-dialog .dsh-pp-content { min-height: 0; }
.dsh-pp-dialog .dsh-pp-body { overflow-y: auto; min-height: 0; }
.dsh-pp-body { display: flex; flex-direction: column; gap: 16px; }
.dsh-pp-stack { display: flex; flex-direction: column; gap: 16px; }
.dsh-pp-progress { display: flex; align-items: flex-start; gap: 10px; }
.dsh-pp-progressIcon { display: inline-flex; flex: none; color: var(--dsw-alias-state-business-primary); animation: dsh-pp-spin 1s linear infinite; }
.dsh-pp-progressText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-pp-progressTitle { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.dsh-pp-progressHint { font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-tertiary); }
.dsh-pp-error { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-primary); }
.dsh-pp-errorIcon { display: inline-flex; flex: none; color: var(--dsw-alias-state-warning); }
.dsh-pp-truncated { color: var(--dsw-alias-state-warning); }
.dsh-pp-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-pp-chip {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-pp-chipAccent { color: var(--dsw-alias-state-business-primary); }
/* Both panes take the height of the taller one, so the pair reads as one table
   rather than two ragged blocks. */
.dsh-pp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: stretch; }
@media (max-width: 900px) { .dsh-pp-grid { grid-template-columns: 1fr; } }
.dsh-pp-pane { display: flex; flex-direction: column; gap: 6px; min-width: 0; height: 100%; }
.dsh-pp-paneLabel { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dsh-pp-text {
  margin: 0;
  padding: 12px;
  min-height: 108px;
  max-height: 40vh;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  /* The draft is context, not the answer: it stays legible but recedes. */
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
/* The rewrite is the reason the panel is open, so it keeps full contrast and
   takes the accent edge. */
.dsh-pp-textPolished {
  border-left: 2px solid var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary);
}
.dsh-pp-unchanged { color: var(--dsw-alias-label-tertiary); font-style: normal; }
.dsh-pp-section { display: flex; flex-direction: column; gap: 6px; }
.dsh-pp-changes { margin: 0; padding: 0 0 0 18px; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dsh-pp-changes li::marker { color: var(--dsw-alias-state-business-primary); }
.dsh-pp-note { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-tertiary); }
`;

    /**
     * Install {@link CSS} once per document.
     * @returns {() => void} the remover for this stylesheet.
     */
    function installStyles() {
      if (typeof document === "undefined") return () => {};
      const tagId = "dsh-prompt-polish/styles.css";
      const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`);
      if (existing !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-prompt-polish";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    //#endregion

    //#region dictionaries

    const zh = {
      "button.label": "美化",
      "button.tooltip": "优化您的输入",
      "button.tooltipEmpty": "先在输入框里写下提示词，再点美化",
      "button.tooltipBusy": "正在美化，请稍候",
      "dialog.title": "提示词美化",
      "dialog.desc": "改写只调整表达与结构，不改变你的意图与关键信息。确认无误后再替换输入框。",
      "dialog.close": "关闭",
      "dialog.cancel": "取消美化",
      "dialog.loading": "正在分析结构并改写提示词…",
      "dialog.loadingHint": "长提示词在推理型模型上通常需要 30–60 秒；关掉本面板会同时取消这次调用，结果不会再自动弹回来。",
      "dialog.truncated": "输出触及上限，以上是被截断后恢复出的结果，建议仍可核对后再替换。",
      "dialog.original": "原始提示词",
      "dialog.polished": "美化后",
      "dialog.changes": "改动说明",
      "dialog.unchanged": "模型认为当前提示词已经足够清晰，没有值得改动的地方。",
      "dialog.plain": "模型未返回结构化的改动说明，以下为改写结果。",
      "dialog.metaRoute": "模型 {provider} / {model}",
      "dialog.metaElapsed": "用时 {seconds} 秒",
      "dialog.metaChars": "{before} → {after} 字符",
      "dialog.retry": "重新美化",
      "dialog.copy": "复制",
      "dialog.apply": "替换输入框",
      "notice.copied": "已复制到剪贴板",
      "notice.copyFailed": "复制失败，请手动选中文本复制",
      "notice.applied": "已替换输入框内容",
      "notice.empty": "输入框是空的，先写点什么再美化",
      "error.empty-input": "输入框是空的，先写点什么再美化",
      "error.input-too-long": "提示词太长，超过了插件配置的上限",
      "error.disabled": "插件已在配置中关闭",
      "error.no-model-route": "无法确定使用哪个模型，请先在设置里选好默认模型",
      "error.provider-unavailable": "没有可用的模型适配器",
      "error.missing-credential": "模型凭据缺失或无效，请先在设置里完成模型配置",
      "error.timeout": "美化超时，可以重试或调大插件配置里的 timeoutMs",
      "error.output-truncated": "改写结果被输出上限截断，请缩短提示词或调大 maxOutputTokens",
      "error.empty-output": "模型没有返回内容，请重试",
      "error.malformed-output": "模型返回的结构无法解析，请重试",
      "error.aborted": "美化已取消",
      "error.transport-failure": "模型调用失败，请重试",
      "error.network": "无法连接美化服务，请确认插件已启用并已重启 DSH",
      "error.internal": "美化服务内部错误"
    };

    const en = {
      "button.label": "Polish",
      "button.tooltip": "Polish your input",
      "button.tooltipEmpty": "Type a prompt first, then polish it",
      "button.tooltipBusy": "Polishing, please wait",
      "dialog.title": "Prompt polish",
      "dialog.desc": "The rewrite adjusts wording and structure only; your intent and key facts stay put. Replace the draft once you are happy with it.",
      "dialog.close": "Close",
      "dialog.cancel": "Cancel polish",
      "dialog.loading": "Analysing the structure and rewriting your prompt…",
      "dialog.loadingHint": "A long prompt usually takes 30–60s on a reasoning model. Closing this panel cancels the call, and no result will come back on its own.",
      "dialog.truncated": "The reply hit the output cap; what follows was recovered from the cut-off text. Check it before replacing your draft.",
      "dialog.original": "Original",
      "dialog.polished": "Polished",
      "dialog.changes": "What changed",
      "dialog.unchanged": "The model found nothing worth changing in this prompt.",
      "dialog.plain": "The model returned no structured notes; the rewrite is shown as-is.",
      "dialog.metaRoute": "Model {provider} / {model}",
      "dialog.metaElapsed": "{seconds}s",
      "dialog.metaChars": "{before} → {after} characters",
      "dialog.retry": "Polish again",
      "dialog.copy": "Copy",
      "dialog.apply": "Replace draft",
      "notice.copied": "Copied to the clipboard",
      "notice.copyFailed": "Copy failed; select the text and copy it manually",
      "notice.applied": "Draft replaced",
      "notice.empty": "The composer is empty; type something first",
      "error.empty-input": "The composer is empty; type something first",
      "error.input-too-long": "The prompt is longer than this plugin's configured limit",
      "error.disabled": "The plugin is disabled in configuration",
      "error.no-model-route": "No model route could be resolved; select a default model first",
      "error.provider-unavailable": "No model adapter is available",
      "error.missing-credential": "The model credential is missing or invalid; finish the model setup first",
      "error.timeout": "Polishing timed out; retry or raise timeoutMs in the plugin config",
      "error.output-truncated": "The rewrite hit the output cap; shorten the prompt or raise maxOutputTokens",
      "error.empty-output": "The model returned nothing; please retry",
      "error.malformed-output": "The model's reply could not be parsed; please retry",
      "error.aborted": "Polishing was cancelled",
      "error.transport-failure": "The model call failed; please retry",
      "error.network": "Cannot reach the polish service; make sure the plugin is enabled and DSH was restarted",
      "error.internal": "The polish service hit an internal error"
    };

    //#endregion

    //#region shared state

    /** The live client context, used only for ungated `ctx.get(service)` lookups. */
    let ctxRef = null;

    /**
     * The plugin's store, keyed by DSH on the Session scope.
     *
     * Both of this plugin's entries live in the `session` scope, so the renderer
     * hands them the *same* instance for one session and a fresh instance for the
     * next: a polish belongs to the draft it rewrote, and switching sessions
     * cannot carry a result across.
     *
     * The handle is passed to `slots.register` unchanged. It must NOT be
     * re-created per entry or pinned to one instance: the slot registry records
     * the scope a handle is first mounted under and refuses the same handle under
     * a different one ("one handle, one scope"), and that refusal happens inside
     * the `slots.inject` callback — where it would silently drop the registration
     * instead of surfacing anywhere a user could see.
     */
    const storeHandle = clientStore.defineStore({
      init: () => ({
        phase: "idle",
        open: false,
        original: "",
        prompt: "",
        changes: [],
        summary: "",
        structured: false,
        unchanged: false,
        truncated: false,
        route: null,
        elapsedMs: 0,
        error: "",
        errorCode: "",
        notice: null,
        noticeSeq: 0
      }),
      actions: {
        start: (draft, payload) => {
          draft.phase = "loading";
          // Open immediately. A long draft can take a minute on a reasoning route,
          // and a spinner confined to a 28px button read as "nothing happened".
          draft.open = true;
          draft.original = payload.original;
          draft.prompt = "";
          draft.changes = [];
          draft.summary = "";
          draft.structured = false;
          draft.unchanged = false;
          draft.truncated = false;
          draft.route = null;
          draft.elapsedMs = 0;
          draft.error = "";
          draft.errorCode = "";
        },
        succeed: (draft, value) => {
          draft.phase = "ready";
          draft.open = true;
          draft.prompt = value.prompt;
          draft.changes = Array.isArray(value.changes) ? value.changes : [];
          draft.summary = typeof value.summary === "string" ? value.summary : "";
          draft.structured = value.structured === true;
          draft.unchanged = value.unchanged === true;
          draft.truncated = value.truncated === true;
          draft.route = value.route ?? null;
          draft.elapsedMs = Number(value.elapsedMs) || 0;
        },
        // A refusal is worth more than a banner: a minute of waiting followed by a
        // four-second toast reads as "nothing happened". The failure therefore
        // opens the panel, where it stays until the human closes it or retries.
        fail: (draft, refusal) => {
          draft.phase = "error";
          draft.open = true;
          draft.error = typeof refusal?.message === "string" ? refusal.message : "";
          draft.errorCode = typeof refusal?.code === "string" ? refusal.code : "";
        },
        close: (draft) => {
          // Closing while the call is still in flight is a decision about the
          // answer, and the run that produces it is cancelled by `closePanel`.
          // The phase must go back to idle here as well: leaving it "loading"
          // would keep the button spinning for a request the human has disowned.
          if (draft.phase === "loading") {
            draft.phase = "idle";
            draft.error = "";
            draft.errorCode = "";
          }
          draft.open = false;
        },
        publishNotice: (draft, notice) => {
          draft.noticeSeq += 1;
          draft.notice = { seq: draft.noticeSeq, text: notice.text, tone: notice.tone ?? "success" };
        },
        clearNotice: (draft) => {
          draft.notice = null;
        }
      }
    });

    //#endregion

    //#region helpers

    /**
     * The active locale tag, read per request so it always matches what the user
     * currently sees.
     * @returns {string|undefined} a tag such as `zh` or `en`.
     */
    function activeLocale() {
      try {
        return ctxRef?.get?.("locale")?.getSnapshot?.().active;
      } catch {
        return undefined;
      }
    }

    /**
     * Localize a refusal by its stable code, falling back to the Host's own text
     * (which is written for a human, not for a machine).
     *
     * @param {(key: string, vars?: object) => string} t - the bound translator.
     * @param {string|undefined} code - the refusal's stable code.
     * @param {string|undefined} fallback - the Host's message.
     * @returns {string} the text to show.
     */
    function errorText(t, code, fallback) {
      if (typeof code === "string" && code !== "") {
        const key = `error.${code}`;
        const text = t(key);
        if (text !== key) return text;
      }
      return typeof fallback === "string" && fallback !== "" ? fallback : t("error.transport-failure");
    }

    /** Seconds with one decimal, for the dialog's meta line. */
    function secondsOf(ms) {
      const value = Number(ms) / 1000;
      return Number.isFinite(value) && value > 0 ? value.toFixed(1) : "0.0";
    }

    /**
     * Read the Host's own deadline, so this client never aborts a call the Host
     * was still willing to run.
     *
     * Asked only when the 180s guard fires: old configs keep exactly the
     * historical deadline, and the common path pays no extra status request. A
     * probe failure (older Host, network hiccup) leaves the default in force.
     *
     * @param {AbortSignal|undefined} signal - the caller's cancellation.
     * @returns {Promise<number|undefined>} the Host `timeoutMs`, when readable.
     */
    async function hostTimeoutMs(signal) {
      if (signal?.aborted === true) return undefined;
      const controller = new AbortController();
      const forward = () => controller.abort();
      if (signal !== undefined) signal.addEventListener("abort", forward, { once: true });
      const timer = setTimeout(() => controller.abort(), HOST_TIMEOUT_PROBE_MS);
      try {
        const response = await fetch(`${ROUTE}/status`, {
          method: "GET",
          credentials: "same-origin",
          signal: controller.signal
        });
        const body = await response.json();
        const value = body?.value?.timeoutMs;
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
      } catch {
        return undefined;
      } finally {
        clearTimeout(timer);
        if (signal !== undefined && !signal.aborted) signal.removeEventListener("abort", forward);
      }
    }

    /**
     * Call the Host route.
     *
     * A timeout is added on the client as well: the Host's own deadline produces a
     * readable refusal, but a request that never settles must not leave the button
     * spinning for the rest of the session.
     *
     * @param {{text: string, locale: string|undefined, sessionId: string|undefined}} payload - the request.
     * @param {AbortSignal} signal - the caller's signal, driven by panel dismissal.
     * @returns {Promise<{ok: true, value: object}|{ok: false, code: string|undefined, message: string|undefined}>} the decoded envelope.
     */
    async function requestPolish(payload, signal) {
      const controller = new AbortController();
      let timedOut = false;
      // Whether this request has already been answered. The deadline extension
      // must not outlive it: a timer left armed after the answer arrived wakes up
      // minutes later and asks the Host for a status nobody is waiting for.
      let settled = false;
      const startedAt = Date.now();
      let timer = null;
      const armTimer = (delayMs) => {
        if (settled) return;
        timer = setTimeout(extendDeadline, Math.max(0, delayMs));
      };
      /**
       * The 180s default fires first; before giving up, ask whether the Host was
       * configured to wait longer. A configured `timeoutMs` above the default
       * extends the guard, so the client never cuts off a live Host call.
       */
      async function extendDeadline() {
        if (settled || controller.signal.aborted) return;
        const hostTimeout = await hostTimeoutMs(signal);
        if (settled || controller.signal.aborted || signal?.aborted === true) return;
        const remaining =
          (hostTimeout === undefined ? 0 : hostTimeout + CLIENT_TIMEOUT_GRACE_MS) - (Date.now() - startedAt);
        if (hostTimeout !== undefined && remaining > 0) {
          armTimer(remaining);
          return;
        }
        timedOut = true;
        controller.abort();
      }
      armTimer(REQUEST_TIMEOUT_MS);
      // The caller's signal and the timeout are both aborts of one request, so the
      // timeout controller is the only thing `fetch` ever sees.
      const forward = () => controller.abort();
      if (signal?.aborted === true) controller.abort();
      else if (signal !== undefined) signal.addEventListener("abort", forward, { once: true });
      try {
        const response = await fetch(`${ROUTE}/polish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          signal: controller.signal,
          body: JSON.stringify(payload)
        });
        let body;
        try {
          body = await response.json();
        } catch {
          return { ok: false, code: "network", message: undefined };
        }
        if (body !== null && typeof body === "object" && body.ok === true && body.value !== undefined) {
          return { ok: true, value: body.value };
        }
        return {
          ok: false,
          code: typeof body?.code === "string" ? body.code : undefined,
          message: typeof body?.message === "string" ? body.message : undefined
        };
      } catch {
        // A request the human cancelled is not a failure to report: the panel it
        // would have opened is gone, and so is the reason to mention it. The
        // sentinel is deliberately NOT the Host's own `aborted` code — that one
        // means the *provider* aborted, which the human still needs to be told.
        if (signal?.aborted === true) return { ok: false, code: CANCELLED, message: undefined };
        return { ok: false, code: timedOut ? "timeout" : "network", message: undefined };
      } finally {
        settled = true;
        clearTimeout(timer);
        if (signal !== undefined && !signal.aborted) signal.removeEventListener("abort", forward);
      }
    }

    /**
     * The seat a run belongs to.
     *
     * The store is Session-scoped, so one session has at most one composer and one
     * panel; keying by session is what keeps a run from being cancelled by another
     * session's dismissal.
     *
     * @param {string|undefined} sessionId - the seat's session id.
     * @returns {string} the key.
     */
    function runKey(sessionId) {
      return typeof sessionId === "string" && sessionId !== "" ? sessionId : "default";
    }

    /**
     * End the in-flight run for one seat, if there is one.
     *
     * The ticket is removed BEFORE the abort, so the run's own settle can see that
     * it no longer owns the seat and stay out of the store.
     *
     * @param {string|undefined} sessionId - the seat's session id.
     * @returns {void}
     */
    function cancelRun(sessionId) {
      const ticket = inflight.get(runKey(sessionId));
      if (ticket === undefined) return;
      inflight.delete(runKey(sessionId));
      ticket.controller.abort();
    }

    //#endregion

    //#region run registry

    /**
     * The run that currently owns each seat, if any.
     *
     * Identity is the ticket object itself: `runPolish` compares by reference, so a
     * superseded run recognises that it lost without any counter to keep in step.
     *
     * Held outside the store on purpose: a ticket carries an `AbortController`, and
     * the store's state is cloned by the client runtime, so anything with a live
     * handle in it would break the store.
     *
     * @type {Map<string, {controller: AbortController}>}
     */
    const inflight = new Map();

    //#endregion

    //#region components

    /**
     * Run one polish and settle the store from its outcome.
     *
     * Shared by the button and the panel's retry action so the two entry points
     * cannot drift: progress, success, and failure are handled in exactly one
     * place.
     *
     * A polish of a long draft takes a minute, and the panel the human is looking
     * at may be dismissed — or a retry started — long before the answer lands. Every
     * run therefore holds a ticket, and only the ticket that still owns its seat may
     * write to the store. Without that check a late answer reopens a panel the human
     * closed, which reads as the app acting on its own.
     *
     * @param {object} actions - the session store's actions.
     * @param {{text: string, locale: string|undefined, sessionId: string|undefined}} payload - the request.
     * @param {(key: string, vars?: object) => string} t - the bound translator.
     * @returns {Promise<void>} fulfillment once the store has settled.
     */
    async function runPolish(actions, payload, t) {
      // A retry replaces the run it follows; the older one is no longer wanted.
      cancelRun(payload.sessionId);
      const ticket = { controller: new AbortController() };
      const key = runKey(payload.sessionId);
      inflight.set(key, ticket);

      const result = await requestPolish(payload, ticket.controller.signal);

      // Cancelled or overtaken: this answer belongs to nobody, so it stays out of
      // the store entirely — no panel, no banner, no error.
      if (inflight.get(key) !== ticket) return;
      inflight.delete(key);
      if (result.code === CANCELLED) return;

      if (result.ok) {
        actions.succeed(result.value);
        return;
      }
      actions.fail({ message: errorText(t, result.code, result.message), code: result.code });
    }

    /**
     * Dismiss the panel and end the run behind it.
     *
     * Every way out of the panel goes through here — the modal's own close affordance,
     * the footer's button, the overlay, and "replace draft" — so closing always means
     * the same thing: this answer is not wanted, and neither is the request that
     * would deliver it.
     *
     * @param {object} actions - the session store's actions.
     * @param {string|undefined} sessionId - the seat's session id.
     * @returns {void}
     */
    function closePanel(actions, sessionId) {
      cancelRun(sessionId);
      actions.close();
    }

    /**
     * The composer seat: a sparkle pill that polishes the current draft.
     *
     * The disabled state is derived from the draft rather than from a click
     * handler, so the control never looks available when it cannot work, and the
     * tooltip explains the state instead of leaving the user guessing.
     *
     * @param {object} props - slot props: the input hooks, the session store, and `t`.
     * @returns {any} the button.
     */
    function PolishButton(props) {
      const { useInput, inputActions, sessionId, useStore, actions, t } = props;
      // A deployment whose composer stopped supplying the input hooks, or whose
      // store failed to resolve, would otherwise take this slot entry down with a
      // throw. There is nothing useful to draw without them, so draw nothing.
      if (typeof useInput !== "function" || typeof useStore !== "function" || actions === undefined) return null;
      const draft = useInput((s) => s?.draft ?? "");
      const phase = useStore((s) => s.phase);
      const busy = phase === "loading";

      const ready = typeof draft === "string" && draft.trim() !== "";
      const disabled = busy || !ready || typeof inputActions?.setDraft !== "function";

      const onPolish = useCallback(() => {
        if (disabled) return;
        const text = draft;
        actions.start({ original: text });
        runPolish(actions, { text, locale: activeLocale(), sessionId }, t).catch(() => {
          // `runPolish` folds every transport failure into a banner; this arm only
          // exists so a rejected promise can never become an unhandled rejection.
          actions.fail({ message: t("error.transport-failure"), code: "transport-failure" });
        });
      }, [actions, disabled, draft, sessionId, t]);

      const tooltip = busy ? t("button.tooltipBusy") : ready ? t("button.tooltip") : t("button.tooltipEmpty");

      return h(
        Tooltip,
        { label: tooltip, side: "top", delayMs: 300 },
        h(
          "span",
          { className: "dsh-pp-seat" },
          h(
            "button",
            {
              type: "button",
              className: `dsh-pp-button${busy ? " dsh-pp-buttonBusy" : ""}`,
              "aria-label": t("button.tooltip"),
              "aria-busy": busy ? "true" : "false",
              "data-prompt-polish": "button",
              disabled,
              // Keep the caret in the composer: a mousedown that moves focus
              // would end the user's editing session for a control that only reads.
              onMouseDown: (event) => {
                event.preventDefault();
              },
              onClick: onPolish
            },
            h(
              "span",
              { className: "dsh-pp-buttonIcon", "aria-hidden": "true" },
              h(busy ? IconLoadingOutlineRegular : IconSparkleRegular, { size: 14 })
            ),
            h("span", { className: "dsh-pp-label" }, t("button.label"))
          )
        )
      );
    }

    /** One labelled, read-only text pane of the comparison. */
    function TextPane({ label, text, polished }) {
      return h(
        "div",
        {
          className: "dsh-pp-pane",
          // The visible label is a plain span, so a screen reader would announce
          // the text with no way to tell the draft from the rewrite.
          role: "group",
          "aria-label": label
        },
        h("span", { className: "dsh-pp-paneLabel" }, label),
        h("pre", { className: `dsh-pp-text${polished ? " dsh-pp-textPolished" : ""}`, tabIndex: 0 }, text)
      );
    }

    /**
     * The before/after panel.
     *
     * Three states, all of which are reachable and all of which stay on screen
     * until the human closes them:
     *
     * - **loading** — a long draft can take a minute on a reasoning route, and a
     *   spinner confined to a 28px button read as "nothing happened". The panel
     *   opens immediately and shows the draft being worked on.
     * - **error** — the reason and a retry, rather than a toast that fades while
     *   the user is still reading.
     * - **ready** — the two panes, which are the answer to "show me what changed":
     *   the left one is the exact text the user typed, the right one is what would
     *   replace it, and the change list names the edits so the user can check that
     *   nothing was invented rather than re-reading the whole prompt.
     *
     * @param {object} props - `{useStore, actions, inputActions, sessionId, t}`.
     * @returns {any} the dialog, or null while it is closed.
     */
    function PolishDialog({ useStore, actions, inputActions, sessionId, t }) {
      if (typeof useStore !== "function" || actions === undefined) return null;
      const open = useStore((s) => s.open);
      const phase = useStore((s) => s.phase);
      const original = useStore((s) => s.original);
      const prompt = useStore((s) => s.prompt);
      const changes = useStore((s) => s.changes);
      const summary = useStore((s) => s.summary);
      const structured = useStore((s) => s.structured);
      const unchanged = useStore((s) => s.unchanged);
      const truncated = useStore((s) => s.truncated);
      const error = useStore((s) => s.error);
      const route = useStore((s) => s.route);
      const elapsedMs = useStore((s) => s.elapsedMs);

      if (!open) return null;

      const close = () => {
        closePanel(actions, sessionId);
      };

      const onCopy = () => {
        writeClipboard(prompt).then((done) => {
          actions.publishNotice({
            text: done ? t("notice.copied") : t("notice.copyFailed"),
            tone: done ? "success" : "warning"
          });
        });
      };

      const onRetry = () => {
        // The draft survives a failure, so retrying re-runs the same input rather
        // than asking the user to retype it.
        actions.start({ original });
        runPolish(actions, { text: original, locale: activeLocale(), sessionId }, t).catch(() => {
          actions.fail({ message: t("error.transport-failure"), code: "transport-failure" });
        });
      };

      const onApply = () => {
        // The panel and the button share one Session-scoped store, so the store
        // this panel reads is the store of the composer it is standing on: there
        // is no second composer a rewrite could reach.
        inputActions?.setDraft(prompt);
        close();
        actions.publishNotice({ text: t("notice.applied"), tone: "success" });
      };

      const body =
        phase === "loading"
          ? h(
              "div",
              { className: "dsh-pp-stack" },
              h(
                "div",
                { className: "dsh-pp-progress", role: "status", "aria-live": "polite" },
                h(
                  "span",
                  { className: "dsh-pp-progressIcon", "aria-hidden": "true" },
                  h(IconLoadingOutlineRegular, { size: 16 })
                ),
                h(
                  "span",
                  { className: "dsh-pp-progressText" },
                  h("span", { className: "dsh-pp-progressTitle" }, t("dialog.loading")),
                  h("span", { className: "dsh-pp-progressHint" }, t("dialog.loadingHint"))
                )
              ),
              h(TextPane, { label: t("dialog.original"), text: original, polished: false })
            )
          : phase === "error"
            ? h(
                "div",
                { className: "dsh-pp-stack" },
                h(
                  "div",
                  { className: "dsh-pp-error", role: "alert" },
                  h(
                    "span",
                    { className: "dsh-pp-errorIcon", "aria-hidden": "true" },
                    h(IconWarningOutlineRegular, { size: 16 })
                  ),
                  h("span", null, error === "" ? t("error.transport-failure") : error)
                )
              )
            : h(
                Fragment,
                null,
                h(
                  "div",
                  { className: "dsh-pp-grid" },
                  h(TextPane, { label: t("dialog.original"), text: original, polished: false }),
                  h(TextPane, { label: t("dialog.polished"), text: prompt, polished: true })
                ),
                truncated ? h("p", { className: "dsh-pp-note dsh-pp-truncated" }, t("dialog.truncated")) : null,
                unchanged ? h("p", { className: "dsh-pp-note dsh-pp-unchanged" }, t("dialog.unchanged")) : null,
                changes.length > 0
                  ? h(
                      "div",
                      { className: "dsh-pp-section" },
                      h("span", { className: "dsh-pp-paneLabel" }, t("dialog.changes")),
                      h(
                        "ul",
                        { className: "dsh-pp-changes" },
                        changes
                          .slice(0, MAX_LISTED_CHANGES)
                          .map((entry, index) => h("li", { key: `${String(index)}:${entry}` }, entry))
                      )
                    )
                  : null,
                summary !== "" ? h("p", { className: "dsh-pp-note" }, summary) : null,
                structured ? null : h("p", { className: "dsh-pp-note" }, t("dialog.plain"))
              );

      const meta =
        phase === "ready" && route !== null && typeof route === "object"
          ? h(
              "div",
              { className: "dsh-pp-meta" },
              h(
                "span",
                { className: "dsh-pp-chip" },
                t("dialog.metaRoute", { provider: String(route.provider ?? ""), model: String(route.model ?? "") })
              ),
              h("span", { className: "dsh-pp-chip" }, t("dialog.metaElapsed", { seconds: secondsOf(elapsedMs) })),
              h(
                "span",
                { className: "dsh-pp-chip dsh-pp-chipAccent" },
                t("dialog.metaChars", { before: String(original.length), after: String(prompt.length) })
              )
            )
          : null;

      const footer =
        phase === "ready"
          ? h(
              Fragment,
              null,
              h(
                Button,
                { variant: "ghost", onClick: onRetry, icon: h(IconRefreshOutlineRegular, { size: 14 }) },
                t("dialog.retry")
              ),
              h(
                Button,
                { variant: "ghost", onClick: onCopy, icon: h(IconCopyOutlineRegular, { size: 14 }) },
                t("dialog.copy")
              ),
              h(Button, { variant: "primary", onClick: onApply }, t("dialog.apply"))
            )
          : phase === "error"
            ? h(
                Fragment,
                null,
                h(
                  Button,
                  { variant: "ghost", onClick: onRetry, icon: h(IconRefreshOutlineRegular, { size: 14 }) },
                  t("dialog.retry")
                ),
                h(Button, { variant: "primary", onClick: close }, t("dialog.close"))
              )
            : // While the call is in flight this button ends the call, so it says so
              // rather than offering a "close" that only hid a result already paid for.
              h(Button, { variant: "ghost", onClick: close }, t("dialog.cancel"));

      return h(
        Modal,
        {
          open: true,
          onClose: close,
          title: t("dialog.title"),
          closeLabel: t("dialog.close"),
          description: t("dialog.desc"),
          className: "dsh-pp-dialog",
          contentClassName: "dsh-pp-content",
          footer
        },
        h("div", { className: "dsh-pp-body" }, meta, body)
      );
    }

    /**
     * The `conversation.input.overlay` seat: the comparison panel and the result
     * banners.
     *
     * It shares the Session scope with the button, which is what makes "Replace
     * draft" write into the composer this panel belongs to. Both surfaces portal
     * out of the composer card (`Modal` and `Toast` render into `document.body`),
     * so the panel looks frame-wide without owning frame-wide state — and a
     * session switch that unmounts the composer takes the panel with it, which is
     * exactly right: a rewrite belongs to the draft it rewrote.
     *
     * @param {object} props - slot props: the session store, the input actions, and the locale seat.
     * @returns {any} the panel and any banner, or null.
     */
    function PolishOverlay(props) {
      const { useStore, actions, inputActions, sessionId, t } = props;
      if (typeof useStore !== "function" || actions === undefined) return null;
      const notice = useStore((s) => s.notice);
      return h(
        Fragment,
        null,
        h(PolishDialog, { useStore, actions, inputActions, sessionId, t }),
        notice === null
          ? null
          : h(Toast, {
              key: String(notice.seq),
              text: notice.text,
              tone: notice.tone === "success" ? "success" : undefined,
              icon: notice.tone === "success" ? undefined : h(IconWarningOutlineRegular, {}),
              onDone: () => {
                actions.clearNotice();
              }
            })
      );
    }

    //#endregion

    //#region plugin body

    /** Whether the dictionaries were registered already (`register()` rejects repeats). */
    let dictionariesInstalled = false;

    /**
     * Register this plugin's dictionaries.
     *
     * This must run inside a scope that declares `locale`: Cordis gates service
     * *property* access on the reading fiber's inject map, so touching
     * `ctx.locale` from an entry whose exported `inject` is `[]` throws. The
     * registration still asks for `locale` through `ctx.inject` below, which is
     * also what supplies the `t` seat to every slot entry.
     *
     * @param {object} scope - a context with `locale` injected.
     */
    function installDictionaries(scope) {
      if (dictionariesInstalled) return;
      dictionariesInstalled = true;
      scope.effect(() => scope.locale.register(NS, { zh, en }), "dsh-prompt-polish: dictionaries");
    }

    /**
     * Client plugin body: install the stylesheet, then the two surfaces.
     *
     * @param {object} ctx - browser plugin context.
     */
    function apply(ctx) {
      ctxRef = ctx;
      ctx.effect(() => installStyles(), "dsh-prompt-polish: stylesheet");

      ctx.inject(["slots", "locale"], (scope) => {
        installDictionaries(scope);
        // Both entries carry the SAME store handle and both live in the `session`
        // scope, so DSH resolves one instance per session for the pair. Sharing a
        // handle across two scopes is refused by the slot registry ("one handle,
        // one scope") — and that refusal lands inside this callback, where it
        // would drop the registration instead of failing loudly.
        scope.slots.inject(SLOT_BUTTON, () =>
          scope.slots.register(
            {
              name: SLOT_BUTTON,
              id: "dsh-prompt-polish.polish",
              order: BUTTON_ORDER,
              locale: NS,
              store: storeHandle
            },
            PolishButton
          )
        );
        scope.slots.inject(SLOT_OVERLAY, () =>
          scope.slots.register(
            {
              name: SLOT_OVERLAY,
              id: "dsh-prompt-polish.overlay",
              order: OVERLAY_ORDER,
              locale: NS,
              store: storeHandle
            },
            PolishOverlay
          )
        );
      });
    }

    /**
     * Exported `[]` on purpose: every service this module needs is acquired with
     * `ctx.inject` inside {@link apply}, so this entry always reaches the active
     * state and can never stall the shell's boot audit on a missing service.
     */
    const inject = [];

    exports.apply = apply;
    exports.inject = inject;
    exports.NS = NS;
    exports.ROUTE = ROUTE;
    exports.SLOT_BUTTON = SLOT_BUTTON;
    exports.SLOT_OVERLAY = SLOT_OVERLAY;
    // Test-only surface: pure helpers and the store definition, so the client
    // logic can be exercised without a browser.
    exports.__test = {
      errorText,
      secondsOf,
      createStore: () => storeHandle.create(),
      storeHandle,
      installStyles,
      requestPolish,
      runPolish,
      cancelRun,
      PolishButton,
      PolishDialog,
      TextPane,
      PolishOverlay,
      dictionaries: { zh, en }
    };

    return module.exports;
  }
});
