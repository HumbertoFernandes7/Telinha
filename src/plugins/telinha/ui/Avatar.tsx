/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { avatarUrl, cl } from "./common";
import { BroadcastIcon } from "./icons";

/** Discord avatar of the (announced) user id, or the Telinha icon when Discord doesn't know the user */
export function Avatar({ userId }: { userId: string | undefined; }) {
    const url = avatarUrl(userId, 64);
    return url
        ? <img className={cl("avatar")} src={url} alt="" />
        : <span className={cl("avatar", "avatar-empty")}><BroadcastIcon size={18} /></span>;
}
