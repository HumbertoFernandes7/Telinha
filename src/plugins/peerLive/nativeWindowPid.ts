/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";

/**
 * Resolves the process that owns a window picked through Electron's desktopCapturer
 * (source ids like `window:<HWND>:0`), without any native addon. Used to start a
 * per-process loopback audio capture (`applicationLoopback:<pid>`) for a single window.
 *
 * Main process (Node) only. Windows only.
 */

export interface WindowProcessInfo {
    /** PID of the process that should be captured (the real app for UWP windows) */
    pid: number;
    /** Process image name without the `.exe` extension, e.g. `chrome` */
    processName: string;
    /** The window belongs to ApplicationFrameHost, i.e. it is a UWP / packaged app window */
    isUwpFrameHost: boolean;
}

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_HWND = 0xFFFFFFFFFFFFFFFFn;
const SOURCE_ID_RE = /^window:(\d{1,20}):\d+$/;
const RESULT_RE = /PEERLIVE\|(\d+)\|([01])\|([^\r\n]*)/;

// C# 5 only: Windows PowerShell 5.1 compiles Add-Type with the .NET Framework csc.
const CSHARP_SOURCE = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class PeerLiveWin
{
    private const string CoreWindowClass = "Windows.UI.Core.CoreWindow";

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWndParent, EnumProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    private static IntPtr ToHandle(ulong hwnd)
    {
        return new IntPtr(unchecked((long)hwnd));
    }

    private static string ClassOf(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string TitleOf(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    // 0 when the window does not exist
    public static uint OwnerPid(ulong hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(ToHandle(hwnd), out pid);
        return pid;
    }

    // PID of the real app behind an ApplicationFrameHost window, or 0 when it cannot be told.
    public static uint UwpAppPid(ulong hwnd, uint hostPid)
    {
        IntPtr frame = ToHandle(hwnd);
        uint pid = FromChildWindows(frame, hostPid);
        return pid != 0 ? pid : FromDetachedCoreWindow(frame, hostPid);
    }

    // While the UWP window is shown, the app's CoreWindow is a child of the frame window.
    private static uint FromChildWindows(IntPtr frame, uint hostPid)
    {
        uint preferred = 0;
        uint fallback = 0;

        EnumProc callback = delegate(IntPtr child, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(child, out pid);
            if (pid == 0 || pid == hostPid) return true;

            if (ClassOf(child) == CoreWindowClass)
            {
                preferred = pid;
                return false;
            }

            if (fallback == 0) fallback = pid;
            return true;
        };

        EnumChildWindows(frame, callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return preferred != 0 ? preferred : fallback;
    }

    // When the window is minimized / cloaked the CoreWindow is detached and becomes a top-level window
    // with the same title as the frame. Only trusted when every match belongs to a single process.
    private static uint FromDetachedCoreWindow(IntPtr frame, uint hostPid)
    {
        string title = TitleOf(frame);
        if (title.Length == 0) return 0;

        uint found = 0;
        bool ambiguous = false;

        EnumProc callback = delegate(IntPtr window, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == 0 || pid == hostPid) return true;
            if (ClassOf(window) != CoreWindowClass || TitleOf(window) != title) return true;

            if (found == 0)
            {
                found = pid;
            }
            else if (found != pid)
            {
                ambiguous = true;
                return false;
            }
            return true;
        };

        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return ambiguous ? 0 : found;
    }
}
`;

/** Extracts the HWND from an Electron window source id (`window:<HWND>:<n>`). Null for screens or malformed ids. */
export function parseWindowSourceId(sourceId: string): bigint | null {
    if (typeof sourceId !== "string") return null;

    const match = SOURCE_ID_RE.exec(sourceId);
    if (!match) return null;

    const hwnd = BigInt(match[1]);
    if (hwnd === 0n || hwnd > MAX_HWND) return null;

    return hwnd;
}

function buildPowerShellScript(hwnd: bigint) {
    // hwnd is a bigint (so it can only stringify to digits) in the range 1..2^64-1
    const hwndDigits = hwnd.toString(10);
    if (!/^\d{1,20}$/.test(hwndDigits)) throw new Error("Invalid HWND");

    return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    Add-Type -TypeDefinition @'
${CSHARP_SOURCE}
'@
    function Get-ProcName([uint32]$id) {
        try { return [System.Diagnostics.Process]::GetProcessById([int]$id).ProcessName } catch { return '' }
    }
    $hwnd = [uint64]::Parse('${hwndDigits}')
    $ownerPid = [PeerLiveWin]::OwnerPid($hwnd)
    if ($ownerPid -eq 0) { exit 3 }
    $name = Get-ProcName $ownerPid
    $uwp = 0
    $resultPid = $ownerPid
    if ($name -ieq 'ApplicationFrameHost') {
        $uwp = 1
        $childPid = [PeerLiveWin]::UwpAppPid($hwnd, $ownerPid)
        if ($childPid -ne 0) {
            $childName = Get-ProcName $childPid
            if ($childName) {
                $resultPid = $childPid
                $name = $childName
            }
        }
    }
    [Console]::Out.WriteLine('PEERLIVE|' + $resultPid + '|' + $uwp + '|' + $name)
    exit 0
} catch {
    exit 1
}
`;
}

function getPowerShellPath() {
    const systemRoot = process.env.SystemRoot || process.env.windir;
    return systemRoot
        ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : "powershell.exe";
}

function runPowerShell(script: string): Promise<string | null> {
    return new Promise(resolve => {
        let settled = false;
        let stdout = "";
        let timer: NodeJS.Timeout | undefined;

        const finish = (result: string | null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };

        try {
            // -EncodedCommand takes UTF-16LE base64, so there is no quoting to get wrong
            const encoded = Buffer.from(script, "utf16le").toString("base64");

            const child = spawn(getPowerShellPath(), [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-EncodedCommand", encoded
            ], {
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"]
            });

            timer = setTimeout(() => {
                try { child.kill(); } catch { }
                finish(null);
            }, TIMEOUT_MS);

            child.stdout!.setEncoding("utf8");
            child.stdout!.on("data", (chunk: string) => {
                if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
            });
            child.on("error", () => finish(null));
            child.on("close", code => finish(code === 0 ? stdout : null));
        } catch {
            finish(null);
        }
    });
}

/**
 * Looks up the process that owns the window behind an Electron `window:<HWND>:<n>` source id.
 * For UWP windows (hosted by ApplicationFrameHost) it returns the real app's process when it can be found.
 * Resolves to null on any failure, on non-Windows platforms, or when the window does not exist.
 */
export async function getWindowProcessInfo(sourceId: string): Promise<WindowProcessInfo | null> {
    if (process.platform !== "win32") return null;

    try {
        const hwnd = parseWindowSourceId(sourceId);
        if (hwnd == null) return null;

        const output = await runPowerShell(buildPowerShellScript(hwnd));
        if (!output) return null;

        const match = RESULT_RE.exec(output);
        if (!match) return null;

        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) return null;

        return {
            pid,
            processName: match[3].trim(),
            isUwpFrameHost: match[2] === "1"
        };
    } catch {
        return null;
    }
}
