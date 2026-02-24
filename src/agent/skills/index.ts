/**
 * Skills module - Central skill management for Loop Gateway.
 *
 * Skills are the file-based, dynamic extension of the tool system.
 * Built-in tools are exported as skills, and custom skills can be uploaded.
 */

export { SkillManifest, SkillDefinition, SkillRegistry } from './schema';
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
