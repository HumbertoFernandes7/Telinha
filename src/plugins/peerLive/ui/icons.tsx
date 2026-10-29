/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Tiny inline SVG icons. They only use currentColor and inline sizes, so they render the same inside Discord's
// pop-out windows (which don't get Vencord's stylesheet).

import type { ReactNode } from "react";

interface IconProps {
    size?: number;
    className?: string;
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode; }) {
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
            {children}
        </svg>
    );
}

/** Broadcast "antenna": PeerLive's mark on the start button and on the voice list tag */
export function BroadcastIcon(props: IconProps) {
    return (
        <Svg {...props}>
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
            <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="M7.76 7.76a6 6 0 0 0 0 8.48M16.24 7.76a6 6 0 0 1 0 8.48" />
            <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="M4.93 4.93a10 10 0 0 0 0 14.14M19.07 4.93a10 10 0 0 1 0 14.14" />
        </Svg>
    );
}

export function EyeIcon(props: IconProps) {
    return (
        <Svg {...props}>
            <path fill="currentColor" d="M12 5C6.5 5 2.7 9.1 1.5 12c1.2 2.9 5 7 10.5 7s9.3-4.1 10.5-7C21.3 9.1 17.5 5 12 5Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z" />
        </Svg>
    );
}

export function StopIcon(props: IconProps) {
    return (
        <Svg {...props}>
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </Svg>
    );
}

export function VolumeIcon({ muted, ...props }: IconProps & { muted: boolean; }) {
    return (
        <Svg {...props}>
            <path fill="currentColor" d="M3 9.5v5h3.5L11 19V5L6.5 9.5H3Z" />
            {muted
                ? <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="m15 9 6 6m0-6-6 6" />
                : <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M14.5 8.5a5 5 0 0 1 0 7M17.5 5.5a9 9 0 0 1 0 13" />}
        </Svg>
    );
}

export function FullscreenIcon({ exit, ...props }: IconProps & { exit: boolean; }) {
    return (
        <Svg {...props}>
            <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                d={exit
                    ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
                    : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"}
            />
        </Svg>
    );
}

export function CloseIcon(props: IconProps) {
    return (
        <Svg {...props}>
            <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
        </Svg>
    );
}

export function WarningIcon(props: IconProps) {
    return (
        <Svg {...props}>
            <path fill="currentColor" d="M12 2.5 1.5 21h21L12 2.5Zm-1.1 6.5h2.2l-.3 6.5h-1.6L10.9 9Zm1.1 10a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Z" />
        </Svg>
    );
}
