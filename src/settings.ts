import { getConfig } from "./config.js";
import { getStore, keys } from "./store/index.js";

/**
 * Settings that can be changed from the panel at runtime. Environment
 * variables only provide the defaults; a value saved here wins.
 */

export interface Settings {
  /** Master switch for automatic likes and offers. */
  autoActionsEnabled: boolean;
}

type Stored = Partial<Settings>;

export async function getSettings(): Promise<Settings> {
  const stored = (await getStore().get<Stored>(keys.settings())) ?? {};
  return {
    autoActionsEnabled: stored.autoActionsEnabled ?? getConfig().autoActionsEnabled,
  };
}

export async function setAutoActionsEnabled(enabled: boolean): Promise<Settings> {
  const store = getStore();
  const stored = (await store.get<Stored>(keys.settings())) ?? {};
  await store.set(keys.settings(), { ...stored, autoActionsEnabled: enabled });
  return getSettings();
}
