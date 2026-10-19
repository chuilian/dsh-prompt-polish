/**
 * `dsh-prompt-polish` — host half.
 *
 * The DSH composer accepts a draft and sends it; nothing in the product rewrites
 * that draft before it becomes the agent's instruction. This plugin adds that
 * missing step: a sparkle button in the composer calls `/prompt-polish/polish`,
 * the Host runs one auxiliary model call against the profile's own model route,
 * and the rewrite is offered back for review before it replaces the draft.
 *
 * The host half owns the model call and every safety decision (who may call, how
 * long the call may take, how large the draft may be, whether the profile has a
 * route at all); the client half (`./client`, served by DSH's client module
 * system) owns the button and the before/after panel.
 *
 * Config (all optional, read from this plugin row's `config:` block; the whole
 * block is replaced by a later patch layer rather than merged, so restate any key
 * you keep):
 *
 * | Key | Default | Meaning |
 * |---|---|---|
 * | `enabled` | `true` | Answer the routes at all |
 * | `provider` / `model` | unset | Pin an explicit model route; unset uses the profile's default model |
 * | `maxInputChars` | `8000` | Longest draft accepted, in characters |
 * | `maxOutputTokens` | `16384` | Output cap for the polishing call |
 * | `timeoutMs` | `150000` | Deadline for one polishing call |
 * | `trustedHosts` | `[]` | Extra non-loopback authorities allowed to call the routes |
 *
 * @module dsh-prompt-polish
 */

import { effectiveConfig } from "./host/prompt.js";
import { polishDraft } from "./host/polish.js";
import { ROUTE, registerPolishRoutes } from "./host/routes.js";

/** Package id; also the browser module id the client bundle registers under. */
export const name = "dsh-prompt-polish";

/**
 * Mount the routes.
 *
 * `webServer` is the only hard requirement, so it is the only name in `inject`:
 * without a transport the plugin stays dormant instead of half-mounting, and
 * `llm` is resolved per request so a deployment that mounts the model service
 * later starts working without a remount.
 *
 * The route is registered unconditionally and `enabled` is read per request, so
 * turning the plugin off in the profile takes effect immediately instead of
 * requiring a remount. A disabled plugin answers 404 with a reason rather than
 * silently having no route.
 *
 * @param {object} ctx - host context.
 * @param {object} [config] - this plugin row's config.
 */
export function apply(ctx, config) {
  const live = () => effectiveConfig(config);

  ctx.inject(["webServer"], (scope) => {
    scope.effect(
      () => registerPolishRoutes(scope, { config: live }),
      "dsh-prompt-polish: /prompt-polish routes"
    );
  });
}

export { ROUTE, polishDraft };
