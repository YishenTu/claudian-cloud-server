import { readFileSync } from 'node:fs';

export function readEnvironmentExample(path: string): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('Malformed environment example');
    const field = line.slice(0, separator);
    if (Object.hasOwn(fields, field)) throw new Error('Duplicate environment field');
    fields[field] = line.slice(separator + 1);
  }
  return fields;
}
