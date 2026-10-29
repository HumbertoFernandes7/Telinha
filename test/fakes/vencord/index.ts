/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Test-side controls for the fake Vencord/Discord modules. The plugin imports `@webpack/common`, `@api/...`, etc.;
// tsconfig.test.json resolves those to the files next to this one, so what a test sets here is what the plugin sees.
//   import { FluxDispatcher, joinVoice, resetVencordFakes, toasts, UserStore } from "@test/fakes/vencord";

import { resetContextMenus } from "./api/ContextMenu";
import { resetDataStore } from "./api/DataStore";
import { resetNotifications } from "./api/Notifications";
import { pluginSettings } from "./api/Settings";
import { resetErrorBoundaries } from "./components/ErrorBoundary";
import { ChannelStore, FluxDispatcher, GUILD_ID, makeChannel, ME_ID, resetStores, SelectedChannelStore, VoiceStateStore } from "./stores";
import { resetUi } from "./ui";
import { resetClipboard } from "./utils/clipboard";
import { resetLogger } from "./utils/Logger";
import { webpackModules } from "./webpack";

export { addContextMenuPatch, navPatches, removeContextMenuPatch } from "./api/ContextMenu";
export { dataStoreData, dataStoreImpl } from "./api/DataStore";
export { type NotificationRecord, notifications, notificationsImpl } from "./api/Notifications";
export { pluginSettings } from "./api/Settings";
export { type CaughtError, caughtErrors } from "./components/ErrorBoundary";
export * from "./stores";
export { Menu, Modal, ModalHost, modals, OAuth2AuthorizeModal, type OpenModal, Select, type ToastRecord, toasts, Tooltip } from "./ui";
export { clipboard, clipboardImpl } from "./utils/clipboard";
export { type LoggerLine, loggerLines } from "./utils/Logger";
export { webpackModules } from "./webpack";

/**
 * Discord's sequence when the local user joins (or leaves, with null) a voice channel: the selected channel, the
 * channel in ChannelStore, who is in it (VoiceStateStore, always including ME_ID) and the VOICE_CHANNEL_SELECT +
 * VOICE_STATE_UPDATES dispatches. The plugin reacts in a setTimeout(0): advance timers / await a macrotask after.
 */
export function joinVoice(channelId: string | null, opts: { guildId?: string | null; users?: string[]; } = {}) {
    const previous = SelectedChannelStore.getVoiceChannelId();
    if (channelId) {
        const guildId = opts.guildId === undefined ? GUILD_ID : opts.guildId;
        if (!ChannelStore.getChannel(channelId)) ChannelStore.addChannels(makeChannel(channelId, guildId));
        VoiceStateStore.setUsersInChannel(channelId, [...new Set([ME_ID, ...(opts.users ?? [])])]);
    }
    if (previous && previous !== channelId) {
        const left = Object.keys(VoiceStateStore.getVoiceStatesForChannel(previous)).filter(id => id !== ME_ID);
        VoiceStateStore.setUsersInChannel(previous, left);
    }
    SelectedChannelStore.setVoiceChannel(channelId);
    void FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId, guildId: channelId ? ChannelStore.getChannel(channelId)?.guild_id ?? null : null });
    void FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [{ userId: ME_ID, channelId }] });
}

/**
 * Someone else joins/leaves the local user's voice channel (VoiceStateStore + VOICE_STATE_UPDATES). The plugin
 * re-evaluates admission in a setTimeout(0).
 */
export function setVoiceMembers(channelId: string, userIds: string[]) {
    VoiceStateStore.setUsersInChannel(channelId, [...new Set(userIds)]);
    void FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: userIds.map(userId => ({ userId, channelId })) });
}

/**
 * Puts every fake Vencord/Discord module back to its defaults: stores (listeners and Flux subscriptions stay, they
 * belong to the plugin code), settings (defaults, no onChange), DataStore, toasts, modals, notifications, clipboard,
 * Logger lines, ErrorBoundary errors and webpack-provided modules. Plugin module state is NOT reset (each test file
 * runs in its own process; within a file, stop what you started).
 */
export function resetVencordFakes() {
    resetStores();
    pluginSettings.reset();
    resetDataStore();
    resetUi();
    resetNotifications();
    resetClipboard();
    resetLogger();
    resetErrorBoundaries();
    resetContextMenus();
    webpackModules.reset();
}
