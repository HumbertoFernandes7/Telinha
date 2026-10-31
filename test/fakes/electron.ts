/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `electron` for the main-process modules (native.ts). tsconfig.test.json maps the import here. Only what the
// plugin uses: desktopCapturer.getSources and a Session's setDisplayMediaRequestHandler. A test builds the IPC
// event itself:
//   const session = new FakeSession();
//   native.prepareDisplayMedia(ipcEvent(session), "screen:0:0", "Tela", false);
//   await session.requestDisplayMedia({ audioRequested: false });   // what getDisplayMedia would trigger

export interface FakeDesktopSource {
    id: string;
    name: string;
    display_id?: string;
    appIcon?: unknown;
    thumbnail: { isEmpty(): boolean; toDataURL(): string; toJPEG(quality: number): Buffer; toPNG(): Buffer; getSize(): { width: number; height: number; }; };
}

/** A desktopCapturer source; `thumbnail` null = an empty NativeImage. toJPEG returns the bytes of "jpeg:<id>". */
export function fakeSource(id: string, name: string, thumbnail: string | null = "data:image/png;base64,AAAA"): FakeDesktopSource {
    return {
        id,
        name,
        thumbnail: {
            isEmpty: () => thumbnail == null,
            toDataURL: () => thumbnail ?? "",
            toJPEG: () => Buffer.from(thumbnail == null ? "" : `jpeg:${id}`),
            toPNG: () => Buffer.from(thumbnail == null ? "" : `png:${id}`),
            getSize: () => (thumbnail ? { width: 320, height: 180 } : { width: 0, height: 0 })
        }
    };
}

export const desktopCapturer = {
    /** options of every getSources call, oldest first */
    calls: [] as unknown[],
    sources: [fakeSource("screen:0:0", "Tela 1"), fakeSource("window:1234:0", "Jogo")] as FakeDesktopSource[],
    getSourcesImpl: null as ((opts: unknown) => Promise<FakeDesktopSource[]>) | null,
    getSources(opts: unknown): Promise<FakeDesktopSource[]> {
        desktopCapturer.calls.push(opts);
        return desktopCapturer.getSourcesImpl ? desktopCapturer.getSourcesImpl(opts) : Promise.resolve(desktopCapturer.sources);
    },
    reset() {
        desktopCapturer.calls.length = 0;
        desktopCapturer.sources = [fakeSource("screen:0:0", "Tela 1"), fakeSource("window:1234:0", "Jogo")];
        desktopCapturer.getSourcesImpl = null;
    }
};

type DisplayMediaHandler = (request: { audioRequested?: boolean; videoRequested?: boolean; frame?: unknown; }, callback: (streams: unknown) => void) => unknown;

export class FakeSession {
    handler: DisplayMediaHandler | null = null;
    /** every setDisplayMediaRequestHandler argument (null = removed), oldest first */
    readonly handlerHistory: (DisplayMediaHandler | null)[] = [];

    setDisplayMediaRequestHandler(handler: DisplayMediaHandler | null) {
        this.handler = handler;
        this.handlerHistory.push(handler);
    }

    /**
     * Chromium asking for a capture (what getDisplayMedia triggers): calls the installed handler and resolves with
     * what it passed to callback ({} = denied). Like Electron, callback({}) throws synchronously.
     */
    async requestDisplayMedia(request: { audioRequested?: boolean; } = {}): Promise<{ streams: unknown; } | null> {
        if (!this.handler) return null;
        let result: { streams: unknown; } | null = null;
        await this.handler({ videoRequested: true, ...request }, streams => {
            result = { streams };
            if (streams && typeof streams === "object" && !Object.keys(streams).length) throw new TypeError("Video was requested, but no video stream was provided");
        });
        return result;
    }
}

export const session = { defaultSession: new FakeSession() };

/** The IpcMainInvokeEvent a native receives as its first argument. */
export function ipcEvent(s: FakeSession = session.defaultSession): any {
    return { sender: { session: s }, frameId: 1, processId: 1 };
}

export const app = {
    getPath: (name: string) => `C:\\fake\\${name}`,
    getVersion: () => "1.0.9002",
    /** what getGPUInfo("basic") resolves with (default: one active NVIDIA RTX 3070) */
    gpuInfo: { gpuDevice: [{ active: true, vendorId: 0x10DE, deviceId: 0x2484, driverVersion: "32.0.15.6094" }] } as unknown,
    /** replace to make getGPUInfo reject or hang */
    getGPUInfoImpl: null as ((infoType: string) => Promise<unknown>) | null,
    getGPUInfo(infoType: string): Promise<unknown> {
        return app.getGPUInfoImpl ? app.getGPUInfoImpl(infoType) : Promise.resolve(app.gpuInfo);
    },
    on() { },
    relaunch() { },
    exit() { }
};

export const ipcMain = { handle() { }, on() { }, removeHandler() { } };
