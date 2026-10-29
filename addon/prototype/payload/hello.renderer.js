/*
 * PeerLive addon prototype - renderer side of the trivial PeerLiveAddonHello plugin (plain JS, no build step).
 * The loader prepends loader/register.js, which provides globalThis.__PeerLiveAddonRegister.
 * One setting (definePluginSettings), two patches, a toolbox action, natives via VencordNative.pluginHelpers.
 */
(() => {
    "use strict";

    const NAME = "PeerLiveAddonHello";
    const TAG = "[PeerLiveAddon]";
    const V = globalThis.Vencord;
    if (!V?.Api?.Settings?.definePluginSettings || !globalThis.__PeerLiveAddonRegister) return;

    const settings = V.Api.Settings.definePluginSettings({
        greeting: {
            type: 0, // OptionType.STRING (const enum in src/utils/types.ts:243)
            description: "Texto devolvido pelo patch de teste",
            default: "Olá do PeerLive (addon)!",
            onChange: value => console.log(TAG, "greeting changed to", value)
        }
    });

    // Bridge picked by the loader: Vencord's pluginHelpers (IPC-map hook) or window.PeerLiveNative (fallback preload)
    const native = () => globalThis.VencordNative?.pluginHelpers?.[NAME] ?? globalThis.PeerLiveNative ?? null;

    globalThis.__PeerLiveAddonRegister({
        name: NAME,
        description: "Protótipo: plugin injetado no Vencord oficial pelo instalador do PeerLive.",
        authors: [{ name: "PeerLive", id: 0n }],
        enabledByDefault: true,
        settings,

        patches: [
            // Offline probe: matched by the fake Discord webpack module in addon/prototype/test.
            {
                find: "PEERLIVE_ADDON_PROBE",
                replacement: { match: /"PROBE_ORIGINAL"/, replace: "$self.probeValue()" }
            },
            // Real-Discord marker: the account panel call site PeerLive v1 already patches. Passes userTag through
            // an identity function, so nothing visible changes but accountPanelRenders counts up once applied
            // (production Vencord builds don't record getFactoryPatchedBy, that is IS_DEV only).
            {
                find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
                replacement: { match: /userTag:(\i),occluded:/, replace: "userTag:$self.seenUserTag($1),occluded:" }
            }
        ],

        toolboxActions: {
            "PeerLive addon: ping main"() {
                const n = native();
                if (!n) return console.error(TAG, "natives not available");
                n.ping("toolbox").then(r => console.log(TAG, "main answered", r), e => console.error(TAG, "ping failed", e));
            }
        },

        probeValue() {
            return settings.store.greeting;
        },

        seenUserTag(userTag) {
            this.accountPanelRenders = (this.accountPanelRenders ?? 0) + 1;
            return userTag;
        },

        start() {
            this.startedAt = Date.now();
            console.log(TAG, "started; natives:", native() ? Object.keys(native()) : null);
            native()?.ping("start").then(
                r => { this.lastPing = r; console.log(TAG, "main answered", r); },
                e => console.error(TAG, "ping failed", e)
            );
        },

        stop() {
            this.startedAt = null;
        }
    });
})();
