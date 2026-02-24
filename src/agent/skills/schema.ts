/**
 * Skill Schema - TypeScript types for the skill system.
 *
 * Skills are the new abstraction layer over tools.
 * Each skill lives in /data/skills/<name>/ with a skill.json manifest.
 */

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      default?: unknown;
    }>;
    required?: string[];
  };
  handler: string; // relative path to handler.js (e.g. "./handler.js")
  containerCompatible: boolean;
  sandbox?: boolean; // if true, handler runs in isolated-vm (for custom skills)
}

export interface SkillDefinition {
  manifest: SkillManifest;
  dirPath: string; // absolute path to skill directory
  builtIn: boolean; // true = shipped with gateway, false = user-uploaded
  enabled: boolean;
}

export interface SkillRegistry {
  version: number;
  skills: Record<string, { enabled: boolean }>;
}
