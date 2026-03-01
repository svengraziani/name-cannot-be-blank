/**
 * Skills module - Central skill management for Loop Gateway.
 *
 * Skills are the file-based, dynamic extension of the tool system.
 * Built-in tools are exported as skills, and custom skills can be uploaded.
 */

export type { SkillManifest, SkillDefinition, SkillRegistry } from './schema';
export {
  ensureSkillsDir,
  scanSkills,
  loadAndRegisterSkills,
  getSkillDefinitions,
  getAllSkills,
  toggleSkill,
  deleteSkill,
  installSkill,
  updateSkill,
  getSkillsDir,
} from './loader';
export { exportBuiltinSkills } from './builtin-exporter';
export { startSkillWatcher, stopSkillWatcher, skillWatcherEvents } from './watcher';
export type { CatalogEntry } from './catalog';
export { getCatalog, getCatalogEntry, getAvailableCatalogEntries, searchCatalog } from './catalog';
export {
  discoveryEvents,
  requestSkillActivation,
  respondToDiscovery,
  getPendingDiscoveries,
  getPendingDiscoveryCount,
  buildCatalogPromptSection,
} from './discovery';
export type { DiscoveryRequest, DiscoveryResult } from './discovery';
