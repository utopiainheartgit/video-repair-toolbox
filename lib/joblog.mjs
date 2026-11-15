import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// One append-only JSONL line per processed file per job, so an agent can later
// read every failure (problems / tried strategies / reasons) and improve repair.
const DIR = join(import.meta.dirname, '..', 'logs');
export const LOG_FILE = join(DIR, 'repair-history.jsonl');

export async function appendJobLog(record) {
  try {
    await mkdir(DIR, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Logging must never break or delay a repair.
  }
}