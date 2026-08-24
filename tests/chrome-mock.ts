/** Minimal in-memory chrome.storage stub for unit tests. */

type Store = Record<string, unknown>;

function makeArea(): {
  area: {
    get: (keys?: string | string[]) => Promise<Store>;
    set: (items: Store) => Promise<void>;
    remove: (keys: string | string[]) => Promise<void>;
  };
  data: Store;
} {
  const data: Store = {};
  return {
    data,
    area: {
      async get(keys?: string | string[]): Promise<Store> {
        if (keys === undefined) return { ...data };
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Store = {};
        for (const key of list) {
          if (key in data) out[key] = data[key];
        }
        return out;
      },
      async set(items: Store): Promise<void> {
        Object.assign(data, items);
      },
      async remove(keys: string | string[]): Promise<void> {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete data[key];
        }
      },
    },
  };
}

export function installChromeMock(): { local: Store; sync: Store } {
  const local = makeArea();
  const sync = makeArea();
  (globalThis as Record<string, unknown>)["chrome"] = {
    storage: { local: local.area, sync: sync.area },
    runtime: {
      sendMessage: async () => undefined,
    },
  };
  return { local: local.data, sync: sync.data };
}
