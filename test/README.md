# Unit-test harness

Lets any module in `src/plugins/telinha` run in plain Node, without Discord, Vencord or a browser.

```sh
pnpm test:unit                                  # every src/**/*.test.ts(x) and test/**/*.test.ts(x)
pnpm test:file src/plugins/telinha/core/quality/controller.test.ts   # one file
pnpm test:coverage                              # unit + add-on tests with coverage (coverage/)
pnpm test:coverage:go                           # Go installer (coverage/go/)

# coverage of one area while writing its tests (only files the test loaded):
pnpm exec c8 --include "src/plugins/telinha/core/quality/**" --exclude "**/*.test.ts" --reporter text pnpm test:file src/plugins/telinha/core/quality/controller.test.ts
```

A new test file is picked up by name (`*.test.ts` / `*.test.tsx` next to the code): never edit `package.json`.
Each test file runs in its own process, so plugin module state (the core's `rt`, the store, timers) is fresh per
file but shared by the tests inside it: stop what you start (`stopSession()`, `stopStreaming()`...).

## How it works

- `tsconfig.test.json` (used only at runtime by `tsx`) maps every Vencord/Discord import to `test/fakes/`:
  `@webpack/common`, `@webpack`, `@api/*`, `@components/*`, `@utils/*`, `@main/*`, plus `trystero` and
  `electron`. Type checking still uses `tsconfig.json`, so tests are checked against the real Vencord types (cast a
  fake with `as unknown as RTCRtpSender` where the plugin wants the real type).
- `test/setup.ts` is preloaded in every test process: JSX globals (`VencordCreateElement` = React's), an empty
  `VencordNative`, `.css` imports as empty modules, **no network** (`fetch` rejects), and the core's
  `[Telinha] ...` console lines (every call whose first argument starts with `[Telinha]`) silenced (read the core's with
  `getEventLog()` from `store.ts`; `TELINHA_TEST_ECHO=1` prints them).
- Tests import the controls from `@test/...` (the same module instances the plugin gets).

## The fakes

| Import | What it gives |
|---|---|
| `@test/fakes/vencord` | Stores (`UserStore`, `ChannelStore`, `SelectedChannelStore`, `VoiceStateStore`, `RelationshipStore`, `PopoutWindowStore`) with setters, `FluxDispatcher` (sync `dispatch`, `listenerCount`), `joinVoice()` / `setVoiceMembers()` (Discord's whole sequence), `pluginSettings` (`load`/`set`/`get`, `onChange` fires like Vencord's; `load(values, { lazy: true })` = Vencord's disk, `settings.plain` has only what was written and defaults show on read), `dataStoreData`/`dataStoreImpl`, `toasts`, `modals` + `ModalHost`, `notifications`, `clipboard`, `loggerLines`, `caughtErrors` (ErrorBoundary), `webpackModules.provide*` (what `find*`/`find*Lazy` return), `resetVencordFakes()`. Ids: `ME_ID`, `FRIEND_ID`, `OTHER_ID`, `GUILD_ID`, `VOICE_CHANNEL_ID`. |
| `@test/fakes/webrtc` | `installWebRtc()` → `RTCPeerConnection` (+ senders/receivers/transceivers/DTLS, `addSendingTrack`, `setConnectionState`), `RTCCertificate`, `MediaStream`/`MediaStreamTrack` (`end()`, `setSettings()`, `emitRemoveTrack()`), `navigator.mediaDevices` (`getDisplayMediaImpl`), `navigator.mediaCapabilities` (`hwEncode`/`hwDecode`), `rtpCapabilities`. Stats: `videoSenderStats()`, `videoReceiverStats()`, and `EncoderSim` (cumulative encoder counters that follow the fake clock). |
| `@test/fakes/trystero` | `trystero.lastRoom`: `connectPeer(id, { hello })` (handshake + join), `receive(action, data, from)`, `sentOn(action, to)`, `emitStream`, `disconnectPeer`, `addStreamMode` (resolve/reject/manual + `settleStreams`), `trystero.relaySockets`. |
| `@test/fakes/clock` | `useFakeClock(t)`: mock timers + `performance.now()` in one clock (`tick`, `tickAsync`); `eventually(check)` polls until truthy, with real timers or the fake clock on (the one wait to use: no `setImmediate` loops of your own); `flushPromises()`. |
| `@test/fakes/native` | `installNative(overrides)`: `VencordNative.pluginHelpers.Telinha` (native.ts as the renderer sees it) and `TelinhaAddon` (updater); `calls`; `updateStatus()` builder. |
| `@test/fakes/audio` | `installWebAudio()`: `AudioContext`, `AudioWorkletNode` (`port.posted`/`emit`), `MediaStreamTrackGenerator` + `AudioData` (`{ generator: true }`). |
| `@test/fakes/dom` | happy-dom globals; `media` (`played`, `playImpl`, `setFrame`), `canvas2d` (`pixels`), `layout.setSize`, `resizeObservers.resize`, `fullscreen`, `resetMedia()`. |
| `@test/fakes/render` | testing-library/react (`render`, `screen`, `fireEvent`, `act`, `waitFor`, `within`...), loads the DOM, unmounts after each test; `settle()` lets the core's microtask-published state land inside `act`. Import testing-library **only from here**. |
| `@test/fakes/fetch` | `installFetch(handler)` + `jsonResponse()`; everything else is blocked. |
| `@test/fakes/childProcess` | `mockSpawn(t, onSpawn)` → `FakeChildProcess` (`writeStdout`, `exit`, `fail`) for the main-process code. |
| `@test/fakes/electron` | `desktopCapturer` (`sources`, `getSourcesImpl`), `FakeSession.requestDisplayMedia()`, `ipcEvent()`. |

Per-test overrides: every fake is a plain object or class with public fields. Replace a method with node:test's
`t.mock.method(UserStore, "getUser", ...)` / `t.mock.method(dataStoreImpl, "get", ...)`, or set the `*Impl` hooks
(`getDisplayMediaImpl`, `setParametersImpl`, `sendImpl`, `joinRoomImpl`...). The `*Impl` objects exist because a
module namespace (`import * as DataStore`) cannot be mocked directly. The same goes for the plugin's own modules:
their exports cannot be replaced (tsx compiles them to CommonJS getters), so drive them through the fakes they call.
Node built-ins can be (`t.mock.method(os, "release", ...)`, `mockSpawn`): the plugin reads them at call time.

## Patterns

```ts
// core, real timers: see test/harness.test.ts (join a call, a friend arrives, stream, approve, stop)
installWebRtc(); installNative();
startSession();
joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
const room = await eventually(() => trystero.lastRoom);
await room.connectPeer("peerA", { hello: buildHello(FRIEND_ID, "amigo") });

// fake time: see src/plugins/telinha/core/quality/controller.test.ts
const clock = useFakeClock(t);
const sim = new EncoderSim({ availableKbps: 500 });   // create after the clock

// component: see src/plugins/telinha/ui/VoiceUserTag.test.tsx
act(() => setState({ ...state, peers: [...] }));       // plugin store changes go inside act()
render(<VoiceUserTag userId={FRIEND_ID} />);
fireEvent.click(screen.getByRole("button"));
await settle();
```

- A fake-clock `tick(2000)` moves the clock first and then runs the due timers: timers due at 500, 1000 and 1500 all read
  `Date.now()` / `performance.now()` as the END of the tick (+2000). When the code measures time from inside a timer,
  use `clock.tick(2000, { stepwise: true })` (1 ms at a time: each timer sees the instant it was due) or
  `await clock.tickAsync(2000, 1)` (the same, flushing promises between steps).
- Code that calls `document`/`window` at call time (session's CSP listener, viewer windows, update notices) needs
  `@test/fakes/dom` (or `render`) loaded; import order does not matter.
- `stopSession()` / `stopStreaming()` at the end of a file; `closeAllViewers()` after UI tests that open viewers.
- Never `assert.equal` / `deepEqual` / `notEqual` DOM nodes (or an object holding one): when they differ, node:assert
  walks the whole happy-dom tree to build its message, which hangs for a minute and eats the process's memory. Compare
  identity with `assert.ok(a === b)`, or compare what you mean (`id`, `textContent`, `tagName`).
- `test/harness.test.ts` and `test/fakes.test.tsx` test the harness itself: keep them green when changing a fake.
