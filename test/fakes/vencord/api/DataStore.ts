/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@api/DataStore` (Vencord's IndexedDB key-value store) over a Map. Values are kept as given (IndexedDB clones;
// RTCCertificate is "serializable", so the identity code stores the object itself). Every exported function goes
// through `dataStoreImpl`, so a test can make one operation fail or hang:
//   mock.method(dataStoreImpl, "get", async () => { throw new Error("IndexedDB travado"); });

export const dataStoreData = new Map<string, unknown>();

export const dataStoreImpl = {
    async get(key: string): Promise<any> {
        return dataStoreData.get(key);
    },
    async set(key: string, value: unknown): Promise<void> {
        dataStoreData.set(key, value);
    },
    async update(key: string, updater: (old: any) => any): Promise<void> {
        dataStoreData.set(key, updater(dataStoreData.get(key)));
    },
    async del(key: string): Promise<void> {
        dataStoreData.delete(key);
    },
    async keys(): Promise<string[]> {
        return [...dataStoreData.keys()];
    },
    async clear(): Promise<void> {
        dataStoreData.clear();
    }
};

export function get<T = any>(key: string): Promise<T | undefined> {
    return dataStoreImpl.get(key);
}

export function set(key: string, value: unknown): Promise<void> {
    return dataStoreImpl.set(key, value);
}

export function update<T = any>(key: string, updater: (old: T | undefined) => T): Promise<void> {
    return dataStoreImpl.update(key, updater);
}

export function del(key: string): Promise<void> {
    return dataStoreImpl.del(key);
}

export function keys(): Promise<string[]> {
    return dataStoreImpl.keys();
}

export function clear(): Promise<void> {
    return dataStoreImpl.clear();
}

export async function getMany(list: string[]): Promise<unknown[]> {
    return Promise.all(list.map(k => get(k)));
}

export async function setMany(entries: [string, unknown][]): Promise<void> {
    for (const [k, v] of entries) await set(k, v);
}

export async function delMany(list: string[]): Promise<void> {
    for (const k of list) await del(k);
}

export function resetDataStore() {
    dataStoreData.clear();
}
