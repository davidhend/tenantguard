// JSON-file-backed data store. No database required — state lives in memory
// and is persisted (debounced) to data/state.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemoTenant } from './seed.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const STATE_FILE = join(DATA_DIR, 'state.json');

let state = null;
let saveTimer = null;

export function getState() {
  if (!state) load();
  return state;
}

function load() {
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      return;
    } catch (err) {
      console.error(`Could not parse ${STATE_FILE}, reseeding demo data:`, err.message);
    }
  }
  state = seedDemoTenant();
  saveNow();
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function saveNow() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE_FILE);
}

export function resetDemo() {
  const settings = state?.settings;
  state = seedDemoTenant();
  // Keep tenant connection settings across resets, but demo data replaces synced data.
  if (settings?.graph) state.settings.graph = settings.graph;
  saveNow();
  return state;
}

let idCounter = Date.now() % 100000;
export function newId(prefix) {
  return `${prefix}-${(++idCounter).toString(36)}`;
}

// Append to the audit trail shown on the dashboard and activity page.
export function logActivity(action, detail, actor = 'You') {
  const s = getState();
  s.activity.unshift({
    id: newId('act'),
    at: new Date().toISOString(),
    actor,
    action,
    detail,
  });
  if (s.activity.length > 500) s.activity.length = 500;
  save();
}
