/**
 * Skill Loader - Dynamically loads skills from /data/skills/ directory.
 *
 * Reads skill.json manifests, validates them, and converts to AgentTools
 * that can be registered in the existing ToolRegistry.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SkillManifest, SkillDefinition, SkillRegistry } from './schema';
import { AgentTool, ToolResult } from '../tools/types';
import { toolRegistry } from '../tools/registry';
import { config } from '../../config';

const SKILLS_DIR = path.join(config.dataDir, 'skills');
const REGISTRY_FILE = path.join(SKILLS_DIR, '_registry.json');

// Cache of loaded skill definitions
const loadedSkills = new Map<string, SkillDefinition>();

/**
 * Ensure the skills directory and registry file exist.
 */
export function ensureSkillsDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    console.log(`[skills] Created skills directory: ${SKILLS_DIR}`);
  }
  if (!fs.existsSync(REGISTRY_FILE)) {
    const registry: SkillRegistry = { version: 1, skills: {} };
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
    console.log(`[skills] Created skills registry: ${REGISTRY_FILE}`);
  }
}

/**
 * Read the _registry.json to know which skills are enabled/disabled.
 */
function readRegistry(): SkillRegistry {
  try {
    const data = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { version: 1, skills: {} };
  }
}

/**
 * Write the _registry.json.
 */
function writeRegistry(registry: SkillRegistry): void {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Validate a skill.json manifest.
 */
function validateManifest(manifest: unknown, dirName: string): manifest is SkillManifest {
  const m = manifest as Record<string, unknown>;
  if (!m || typeof m !== 'object') {
    console.warn(`[skills] Invalid manifest in ${dirName}: not an object`);
    return false;
  }
  if (typeof m.name !== 'string' || !m.name) {
    console.warn(`[skills] Invalid manifest in ${dirName}: missing name`);
    return false;
  }
  if (typeof m.description !== 'string') {
    console.warn(`[skills] Invalid manifest in ${dirName}: missing description`);
    return false;
  }
  if (typeof m.handler !== 'string') {
    console.warn(`[skills] Invalid manifest in ${dirName}: missing handler`);
    return false;
  }
  if (!m.inputSchema || typeof m.inputSchema !== 'object') {
    console.warn(`[skills] Invalid manifest in ${dirName}: missing inputSchema`);
    return false;
  }
  return true;
}

/**
 * Load a handler.js file and return an execute function.
 * For built-in skills, we use require(). For custom skills, we'll add sandbox later.
 */
function loadHandler(handlerPath: string, _sandbox: boolean): ((input: Record<string, unknown>) => Promise<ToolResult>) | null {
  try {
    // For now, all handlers are loaded via require/import
    // Custom skill sandboxing (isolated-vm) will be added in a later phase
    const handler = require(handlerPath);
    if (typeof handler.execute === 'function') {
      return handler.execute;
    }
    if (typeof handler.default?.execute === 'function') {
      return handler.default.execute;
    }
    if (typeof handler === 'function') {
      return handler;
    }
    console.warn(`[skills] Handler ${handlerPath} has no execute export`);
    return null;
  } catch (err) {
    console.error(`[skills] Failed to load handler ${handlerPath}:`, err);
    return null;
  }
}

/**
 * Scan /data/skills/ and load all valid skill manifests.
 * Returns the list of loaded SkillDefinitions.
 */
export function scanSkills(): SkillDefinition[] {
  ensureSkillsDir();
  const registry = readRegistry();
  const skills: SkillDefinition[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR);
  } catch (err) {
    console.error(`[skills] Cannot read skills directory:`, err);
    return [];
  }

  for (const entry of entries) {
    if (entry.startsWith('_')) continue; // skip _registry.json etc.

    const skillDir = path.join(SKILLS_DIR, entry);
    const stat = fs.statSync(skillDir);
    if (!stat.isDirectory()) continue;

    const manifestPath = path.join(skillDir, 'skill.json');
    if (!fs.existsSync(manifestPath)) {
      console.warn(`[skills] Skipping ${entry}: no skill.json`);
      continue;
    }

    try {
      const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (!validateManifest(manifestData, entry)) continue;

      const manifest = manifestData as SkillManifest;
      const isEnabled = registry.skills[manifest.name]?.enabled !== false; // default: enabled

      skills.push({
        manifest,
        dirPath: skillDir,
        builtIn: manifest.name === 'web_browse' || manifest.name === 'run_script' || manifest.name === 'http_request',
        enabled: isEnabled,
      });
    } catch (err) {
      console.warn(`[skills] Failed to parse ${manifestPath}:`, err);
    }
  }

  return skills;
}

/**
 * Load all skills from /data/skills/ and register them in the ToolRegistry.
 * This is called at startup after built-in tools are exported.
 */
export function loadAndRegisterSkills(): number {
  const skills = scanSkills();
  let registered = 0;

  for (const skill of skills) {
    if (!skill.enabled) {
      console.log(`[skills] Skipping disabled skill: ${skill.manifest.name}`);
      continue;
    }

    const handlerPath = path.resolve(skill.dirPath, skill.manifest.handler);
    if (!fs.existsSync(handlerPath)) {
      console.warn(`[skills] Handler not found for ${skill.manifest.name}: ${handlerPath}`);
      continue;
    }

    const execute = loadHandler(handlerPath, skill.manifest.sandbox === true);
    if (!execute) continue;

    // Only register if not already registered (built-in tools take precedence)
    if (!toolRegistry.get(skill.manifest.name)) {
      const tool: AgentTool = {
        name: skill.manifest.name,
        description: skill.manifest.description,
        inputSchema: skill.manifest.inputSchema as AgentTool['inputSchema'],
        execute,
      };
      toolRegistry.register(tool);
      registered++;
    }

    loadedSkills.set(skill.manifest.name, skill);
  }

  console.log(`[skills] Loaded ${registered} skill(s) from ${SKILLS_DIR}`);
  return registered;
}

/**
 * Get all loaded skill definitions (for API).
 */
export function getSkillDefinitions(): SkillDefinition[] {
  return Array.from(loadedSkills.values());
}

/**
 * Get all skills including unloaded ones (for API listing).
 */
export function getAllSkills(): Array<{
  name: string;
  description: string;
  version: string;
  builtIn: boolean;
  enabled: boolean;
  containerCompatible: boolean;
}> {
  const skills = scanSkills();
  return skills.map(s => ({
    name: s.manifest.name,
    description: s.manifest.description,
    version: s.manifest.version || '1.0.0',
    builtIn: s.builtIn,
    enabled: s.enabled,
    containerCompatible: s.manifest.containerCompatible || false,
  }));
}

/**
 * Toggle a skill on/off in the registry.
 */
export function toggleSkill(name: string, enabled: boolean): boolean {
  const registry = readRegistry();
  if (!registry.skills[name]) {
    registry.skills[name] = { enabled };
  } else {
    registry.skills[name].enabled = enabled;
  }
  writeRegistry(registry);
  return true;
}

/**
 * Delete a custom skill (not built-in).
 */
export function deleteSkill(name: string): boolean {
  const skill = loadedSkills.get(name);
  if (!skill) return false;
  if (skill.builtIn) {
    throw new Error(`Cannot delete built-in skill: ${name}`);
  }

  // Remove directory
  fs.rmSync(skill.dirPath, { recursive: true, force: true });

  // Remove from registry
  const registry = readRegistry();
  delete registry.skills[name];
  writeRegistry(registry);

  loadedSkills.delete(name);
  return true;
}

/**
 * Install a new skill from a manifest + handler content.
 */
export function installSkill(manifest: SkillManifest, handlerContent: string): void {
  ensureSkillsDir();

  const skillDir = path.join(SKILLS_DIR, manifest.name);
  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill ${manifest.name} already exists. Delete it first or use update.`);
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(skillDir, 'handler.js'), handlerContent);

  // Add to registry as enabled
  const registry = readRegistry();
  registry.skills[manifest.name] = { enabled: true };
  writeRegistry(registry);

  console.log(`[skills] Installed skill: ${manifest.name}`);
}

/**
 * Update an existing skill's manifest and/or handler.
 */
export function updateSkill(name: string, updates: { manifest?: Partial<SkillManifest>; handlerContent?: string }): void {
  const skill = loadedSkills.get(name);
  if (!skill) {
    // Try to find it on disk
    const skillDir = path.join(SKILLS_DIR, name);
    if (!fs.existsSync(skillDir)) {
      throw new Error(`Skill ${name} not found`);
    }
  }

  const skillDir = skill?.dirPath || path.join(SKILLS_DIR, name);

  if (updates.manifest) {
    const manifestPath = path.join(skillDir, 'skill.json');
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const merged = { ...existing, ...updates.manifest };
    fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2));
  }

  if (updates.handlerContent) {
    const handlerFile = skill?.manifest.handler || './handler.js';
    const handlerPath = path.resolve(skillDir, handlerFile);
    fs.writeFileSync(handlerPath, updates.handlerContent);
  }
}

/**
 * Get the skills directory path (for container volume mounts).
 */
export function getSkillsDir(): string {
  return SKILLS_DIR;
}
