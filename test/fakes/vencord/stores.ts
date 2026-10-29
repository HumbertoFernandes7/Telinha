/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake Discord Flux stores and FluxDispatcher (what @webpack/common exports in the real client). Plain objects with
// writable methods: a test can set data with the helpers below or replace a single method with node:test's
// mock.method(UserStore, "getUser", ...). resetStores() puts the data back to the defaults; listeners and Flux
// subscriptions are kept, since the plugin module that registered them lives for the whole test file.

/** Ids used by default: the local user and two friends (17-20 digit snowflakes, like Discord's). */
export const ME_ID = "100000000000000001";
export const FRIEND_ID = "200000000000000002";
export const OTHER_ID = "300000000000000003";
export const GUILD_ID = "400000000000000004";
export const VOICE_CHANNEL_ID = "500000000000000005";

export class FakeStore {
    private readonly listeners = new Set<() => void>();

    addChangeListener(fn: () => void) {
        this.listeners.add(fn);
    }

    removeChangeListener(fn: () => void) {
        this.listeners.delete(fn);
    }

    /** Calls every change listener (what Discord does after a dispatch that changed the store). */
    emitChange() {
        for (const fn of [...this.listeners]) fn();
    }

    listenerCount() {
        return this.listeners.size;
    }

    /** Drops every change listener (resetStores keeps them: they belong to the code under test). */
    clearListeners() {
        this.listeners.clear();
    }
}

// #region users

export interface FakeUser {
    id: string;
    username: string;
    globalName: string | null;
    discriminator: string;
    avatar: string | null;
    bot: boolean;
    getAvatarURL(guildId?: string, size?: number): string;
}

export function makeUser(id: string, username: string, extra: Partial<Omit<FakeUser, "id" | "username">> = {}): FakeUser {
    return {
        id,
        username,
        globalName: null,
        discriminator: "0",
        avatar: null,
        bot: false,
        getAvatarURL: (_guildId?: string, size = 128) => `https://cdn.discordapp.com/embed/avatars/0.png?size=${size}&user=${id}`,
        ...extra
    };
}

class FakeUserStore extends FakeStore {
    current: FakeUser | null = makeUser(ME_ID, "eu");
    readonly users = new Map<string, FakeUser>();

    getCurrentUser() {
        return this.current ?? undefined;
    }

    getUser(id: string) {
        return this.users.get(id) ?? (this.current?.id === id ? this.current : undefined);
    }

    /** Test helper: the logged-in user (null = logged out). */
    setCurrentUser(user: FakeUser | null) {
        this.current = user;
        this.emitChange();
    }

    /** Test helper: users getUser() knows about. */
    addUsers(...users: FakeUser[]) {
        for (const u of users) this.users.set(u.id, u);
        this.emitChange();
    }

    reset() {
        this.current = makeUser(ME_ID, "eu");
        this.users.clear();
    }
}

export const UserStore = new FakeUserStore();

// #endregion

// #region channels

export interface FakeChannel {
    id: string;
    guild_id: string | null;
    name: string;
    type: number;
    getGuildId(): string | null;
}

export function makeChannel(id: string, guildId: string | null, name = "geral", type = 2): FakeChannel {
    return { id, guild_id: guildId, name, type, getGuildId: () => guildId };
}

class FakeChannelStore extends FakeStore {
    readonly channels = new Map<string, FakeChannel>();

    getChannel(id: string) {
        return this.channels.get(id);
    }

    addChannels(...channels: FakeChannel[]) {
        for (const c of channels) this.channels.set(c.id, c);
        this.emitChange();
    }

    reset() {
        this.channels.clear();
    }
}

export const ChannelStore = new FakeChannelStore();

class FakeSelectedChannelStore extends FakeStore {
    voiceChannelId: string | null = null;
    channelId: string | null = null;

    getVoiceChannelId() {
        return this.voiceChannelId;
    }

    getChannelId() {
        return this.channelId;
    }

    getLastSelectedChannelId() {
        return this.channelId;
    }

    /**
     * Test helper: joins (or leaves, with null) a voice channel. Also registers the channel in ChannelStore when
     * `guildId` is given. Emits a store change but does NOT dispatch VOICE_CHANNEL_SELECT: use
     * joinVoice() in @test/fakes/vencord for the whole Discord sequence.
     */
    setVoiceChannel(id: string | null, guildId?: string | null) {
        this.voiceChannelId = id;
        if (id && guildId !== undefined && !ChannelStore.getChannel(id)) ChannelStore.addChannels(makeChannel(id, guildId));
        this.emitChange();
    }

    reset() {
        this.voiceChannelId = null;
        this.channelId = null;
    }
}

export const SelectedChannelStore = new FakeSelectedChannelStore();

export interface FakeVoiceState {
    userId: string;
    channelId: string;
    sessionId: string;
    selfMute: boolean;
    selfDeaf: boolean;
    selfStream: boolean;
}

class FakeVoiceStateStore extends FakeStore {
    /** channelId -> userId -> state */
    readonly states = new Map<string, Map<string, FakeVoiceState>>();

    getVoiceStatesForChannel(channelId: string): Record<string, FakeVoiceState> {
        return Object.fromEntries(this.states.get(channelId) ?? []);
    }

    getVoiceStateForUser(userId: string): FakeVoiceState | undefined {
        for (const users of this.states.values()) {
            const s = users.get(userId);
            if (s) return s;
        }
        return undefined;
    }

    /** Test helper: exactly these users are in `channelId` now (replaces the previous list). */
    setUsersInChannel(channelId: string, userIds: string[]) {
        const users = new Map<string, FakeVoiceState>();
        for (const userId of userIds) {
            users.set(userId, { userId, channelId, sessionId: `session-${userId}`, selfMute: false, selfDeaf: false, selfStream: false });
        }
        this.states.set(channelId, users);
        this.emitChange();
    }

    reset() {
        this.states.clear();
    }
}

export const VoiceStateStore = new FakeVoiceStateStore();

// #endregion

class FakeRelationshipStore extends FakeStore {
    readonly friends = new Set<string>();

    isFriend(userId: string) {
        return this.friends.has(userId);
    }

    getFriendIDs() {
        return [...this.friends];
    }

    setFriends(...userIds: string[]) {
        this.friends.clear();
        for (const id of userIds) this.friends.add(id);
        this.emitChange();
    }

    reset() {
        this.friends.clear();
    }
}

export const RelationshipStore = new FakeRelationshipStore();

// #region pop-out windows

/** What PopoutWindowStore.getWindow returns: enough of a Window for the plugin (focus, close, document). */
export interface FakePopoutWindow {
    key: string;
    focused: number;
    closed: boolean;
    focus(): void;
    close(): void;
    document?: Document;
}

class FakePopoutWindowStore extends FakeStore {
    readonly windows = new Map<string, FakePopoutWindow>();

    getWindow(key: string) {
        return this.windows.get(key);
    }

    getWindowOpen(key: string) {
        return this.windows.has(key);
    }

    getWindowKeys() {
        return [...this.windows.keys()];
    }

    /** Test helper: Discord reports the pop-out `key` open (or closed, with open=false). */
    setOpen(key: string, open: boolean) {
        if (open && !this.windows.has(key)) {
            const win: FakePopoutWindow = {
                key,
                focused: 0,
                closed: false,
                focus() {
                    win.focused++;
                },
                close() {
                    win.closed = true;
                    PopoutWindowStore.setOpen(key, false);
                }
            };
            this.windows.set(key, win);
        } else if (!open) {
            this.windows.delete(key);
        }
        this.emitChange();
    }

    reset() {
        this.windows.clear();
    }
}

export const PopoutWindowStore = new FakePopoutWindowStore();

export interface PopoutOpenCall {
    key: string;
    render: () => unknown;
    features: unknown;
}

/** PopoutActions.open/close. `autoOpen` (default true): open() immediately reports the window open in the store. */
export const PopoutActions = {
    autoOpen: true,
    opened: [] as PopoutOpenCall[],
    closed: [] as string[],
    open(key: string, render: () => unknown, features?: unknown) {
        PopoutActions.opened.push({ key, render, features });
        if (PopoutActions.autoOpen) PopoutWindowStore.setOpen(key, true);
    },
    close(key: string) {
        PopoutActions.closed.push(key);
        PopoutWindowStore.setOpen(key, false);
    },
    reset() {
        PopoutActions.autoOpen = true;
        PopoutActions.opened.length = 0;
        PopoutActions.closed.length = 0;
    }
};

// #endregion

// #region FluxDispatcher

export interface FluxAction {
    type: string;
    [key: string]: unknown;
}

type FluxListener = (action: any) => unknown;

class FakeFluxDispatcher {
    private readonly subs = new Map<string, Set<FluxListener>>();
    /** every action dispatched through the fake, oldest first */
    readonly dispatched: FluxAction[] = [];

    subscribe(type: string, fn: FluxListener) {
        let set = this.subs.get(type);
        if (!set) this.subs.set(type, set = new Set());
        set.add(fn);
    }

    unsubscribe(type: string, fn: FluxListener) {
        this.subs.get(type)?.delete(fn);
    }

    /** Calls the subscribers of action.type synchronously (like Discord's dispatcher). */
    dispatch(action: FluxAction): Promise<void> {
        this.dispatched.push(action);
        for (const fn of [...(this.subs.get(action.type) ?? [])]) fn(action);
        return Promise.resolve();
    }

    listenerCount(type: string) {
        return this.subs.get(type)?.size ?? 0;
    }

    /** Forgets the dispatched log. Subscriptions stay: they belong to the code under test (see clearSubscriptions). */
    reset() {
        this.dispatched.length = 0;
    }

    clearSubscriptions() {
        this.subs.clear();
    }
}

export const FluxDispatcher = new FakeFluxDispatcher();

// #endregion

export function resetStores() {
    UserStore.reset();
    ChannelStore.reset();
    SelectedChannelStore.reset();
    VoiceStateStore.reset();
    RelationshipStore.reset();
    PopoutWindowStore.reset();
    PopoutActions.reset();
    FluxDispatcher.reset();
}
