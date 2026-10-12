// Compatibility facade; state and persistence belong to ModelCatalogStore.
import { modelCatalogStore } from "../classes/ModelCatalogStore.js";
export { MODEL_CATALOG_SCHEMA_VERSION, MODEL_CATALOG_SETTING_KEY, MODEL_CATALOG_FETCHED_AT_SETTING_KEY, normalizeRemoteModelCatalog } from "./model-catalog-normalize.js";

export const ensureRemoteCatalogLoaded = modelCatalogStore.ensureRemoteCatalogLoaded.bind(modelCatalogStore);
export const getRemoteCatalog = modelCatalogStore.getRemoteCatalog.bind(modelCatalogStore);
export const getRemoteProviderCatalog = modelCatalogStore.getRemoteProviderCatalog.bind(modelCatalogStore);
export const isProviderEnabledByCatalog = modelCatalogStore.isProviderEnabledByCatalog.bind(modelCatalogStore);
export const setRemoteCatalog = modelCatalogStore.setRemoteCatalog.bind(modelCatalogStore);
export const invalidateRemoteModelCatalog = modelCatalogStore.invalidateRemoteModelCatalog.bind(modelCatalogStore);
export const getRemotePricingMap = modelCatalogStore.getRemotePricingMap.bind(modelCatalogStore);
export const setRemoteCatalogForTest = modelCatalogStore.setRemoteCatalogForTest.bind(modelCatalogStore);
export const __resetRemoteModelCatalogStoreForTests = modelCatalogStore.__resetRemoteModelCatalogStoreForTests.bind(modelCatalogStore);
