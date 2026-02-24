/**
 * Skills Hot-Reload Watcher - Watches /data/skills/ for changes and reloads skills.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSkillsDir, scanSkills } from './loader';
import { EventEmitter } from 'events';

export const skillWatcherEvents = new EventEmitter();

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start watching the skills directory for changes.
 */
export function startSkillWatcher(): void {
  const dir = getSkillsDir();

  if (!fs.existsSync(dir)) {
    console.log('[skills-watcher] Skills directory not found, skipping watcher');
    return;
  }

  try {
    watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Ignore _registry.json changes to avoid loops
      if (filename === '_registry.json') return;
      // Only react to skill.json or handler.js changes
      if (!filename.endsWith('skill.json') && !filename.endsWith('handler.js')) return;

      // Debounce: wait 500ms after last change before reloading
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[skills-watcher] Change detected in ${filename}, reloading skills...`);
        try {
          scanSkills();
          skillWatcherEvents.emit('skills:reloaded', { trigger: filename });
          console.log('[skills-watcher] Skills reloaded successfully');
        } catch (err) {
          console.error('[skills-watcher] Reload failed:', err);
          skillWatcherEvents.emit('skills:reload-error', { error: String(err) });
        }
      }, 500);
    });

    console.log(`[skills-watcher] Watching ${dir} for changes`);
  } catch (err) {
    console.error('[skills-watcher] Failed to start watcher:', err);
  }
}

/**
 * Stop the skills watcher.
 */
export function stopSkillWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
