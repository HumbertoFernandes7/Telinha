/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@api/Notifications`: records every showNotification call. The real promise resolves when the notification
// closes; here it resolves right away unless notificationsImpl.show is replaced (mock.method) to reject or hang.

export interface NotificationRecord {
    title: string;
    body: string;
    richBody?: unknown;
    icon?: string;
    image?: string;
    onClick?(): void;
    onClose?(): void;
    color?: string;
    permanent?: boolean;
    noPersist?: boolean;
    dismissOnClick?: boolean;
}

/** Every notification shown, oldest first. Click one with notifications[i].onClick?.(). */
export const notifications: NotificationRecord[] = [];

export const notificationsImpl = {
    async show(data: NotificationRecord): Promise<void> {
        notifications.push(data);
    },
    async requestPermission(): Promise<boolean> {
        return true;
    }
};

export function showNotification(data: NotificationRecord): Promise<void> {
    return notificationsImpl.show(data);
}

export function requestPermission(): Promise<boolean> {
    return notificationsImpl.requestPermission();
}

export function resetNotifications() {
    notifications.length = 0;
}
