// @ts-check
// Owns the remote catalog, pricing cache, persistence state and lazy settings load.
import { isMainThread } from "node:worker_threads";
import { normalizeName, reviveStoredCatalog, MODEL_CATALOG_SETTING_KEY, MODEL_CATALOG_FETCHED_AT_SETTING_KEY, MAX_PERSISTED_JSON_BYTES } from "../functions/model-catalog-normalize.js";

export class ModelCatalogStore {
  _remoteCatalog;
  _persistedCatalogVersion = null;
  _pricingMap = null;
  _settingsApi = null;
  _settingsApiPromise = null;

  ensureSettingsApiLoading() {
    if (!isMainThread) return null;
    if (this._settingsApi || this._settingsApiPromise) return this._settingsApiPromise;
    this._settingsApiPromise = import("../../settings/functions/account-settings.js")
      .then((mod) => {
        this._settingsApi = mod;
        return mod;
      })
      .catch(() => {
        this._settingsApiPromise = null;
        return null;
      });
    return this._settingsApiPromise;
  }

  loadFromSettings() {
    if (!this._settingsApi) return;
    try {
      const json = this._settingsApi.getAccountSetting(MODEL_CATALOG_SETTING_KEY);
      this._remoteCatalog = json ? reviveStoredCatalog(JSON.parse(json)) : null;
      this._persistedCatalogVersion = this._remoteCatalog?.catalogVersion ?? null;
    } catch {
      this._remoteCatalog = null;
      this._persistedCatalogVersion = null;
    }
    this._pricingMap = null;
  }

  async ensureRemoteCatalogLoaded() {
    if (this._remoteCatalog !== undefined) return this._remoteCatalog;
    await this.ensureSettingsApiLoading();
    if (this._remoteCatalog === undefined) this.loadFromSettings();
    return this._remoteCatalog ?? null;
  }

  getRemoteCatalog() {
    if (this._remoteCatalog !== undefined) return this._remoteCatalog;
    if (this._settingsApi) {
      this.loadFromSettings();
      return this._remoteCatalog;
    }
    const pending = this.ensureSettingsApiLoading();
    if (pending) pending.then(() => { if (this._remoteCatalog === undefined) this.loadFromSettings(); });
    return null;
  }

  getRemoteProviderCatalog(provider) {
    const catalog = this.getRemoteCatalog();
    if (!catalog) return null;
    return catalog.providers[normalizeName(provider)] || null;
  }

  isProviderEnabledByCatalog(provider) {
    const normalized = normalizeName(provider);
    const entry = this.getRemoteProviderCatalog(normalized);
    if (entry?.enabled === true) return true;
    if (entry?.enabled === false) return false;
    return normalized !== "posse-local";
  }

  setRemoteCatalog(normalized, { persist = true, fetchedAt = null } = {}) {
    this._remoteCatalog = normalized ?? null;
    this._pricingMap = null;
    if (!persist || !normalized) return { persisted: false };
    if (!this._settingsApi) {
      this.ensureSettingsApiLoading();
      if (!this._settingsApi) return { persisted: false };
    }
    try {
      const timestamp = fetchedAt || new Date().toISOString();
      if (normalized.catalogVersion !== this._persistedCatalogVersion) {
        const json = JSON.stringify(normalized);
        if (Buffer.byteLength(json, "utf8") > MAX_PERSISTED_JSON_BYTES) return { persisted: false };
        this._settingsApi.setAccountSetting(MODEL_CATALOG_SETTING_KEY, json);
        this._persistedCatalogVersion = normalized.catalogVersion;
      }
      this._settingsApi.setAccountSetting(MODEL_CATALOG_FETCHED_AT_SETTING_KEY, timestamp);
      return { persisted: true };
    } catch {
      return { persisted: false };
    }
  }

  invalidateRemoteModelCatalog() {
    this._remoteCatalog = undefined;
    this._pricingMap = null;
  }

  getRemotePricingMap() {
    const catalog = this.getRemoteCatalog();
    if (!catalog) return null;
    if (this._pricingMap) return this._pricingMap;
    const map = new Map();
    for (const [provider, entry] of Object.entries(catalog.providers)) {
      for (const model of [...entry.textModels, ...entry.imageModels]) {
        if (!model.pricing) continue;
        map.set(`${provider}:${model.id}`, model.pricing);
        for (const alias of model.aliases) {
          const key = `${provider}:${alias}`;
          if (!map.has(key)) map.set(key, model.pricing);
        }
      }
    }
    this._pricingMap = map;
    return this._pricingMap;
  }

  setRemoteCatalogForTest(catalog = null) {
    this._remoteCatalog = catalog;
    this._pricingMap = null;
  }

  __resetRemoteModelCatalogStoreForTests() {
    this._remoteCatalog = undefined;
    this._persistedCatalogVersion = null;
    this._pricingMap = null;
    this._settingsApi = null;
    this._settingsApiPromise = null;
  }
}

export const modelCatalogStore = new ModelCatalogStore();
