// The `kcmd entry` command: lists and reads the workspace's catalog entries
// as JSON, through the catalog snapshot, so the CLI applies the same rules as
// the library and the MCP server.
//
// stdout carries exactly one JSON value. A command that fails as a whole
// prints its error on stderr, prints nothing on stdout and exits 1.

import * as kcmd from '../libts';
import * as context from '../libts/gcp/context';
import * as md from '../libts/metadata';


export interface EntryOptions {
  // entry list: only the entries of this type, as a full type reference
  // (dataplex-types.global.semantic-entity) or its last part (semantic-entity).
  type?: string;
  // entry list: print the full entries instead of their names and types.
  content?: boolean;
}

const ACTIONS = ['list', 'get'];


// Runs `kcmd entry <action> [names...]` and returns the process exit code.
export async function entry(
    action: string, names: string[] = [],
    options: EntryOptions = {}): Promise<number> {
  const usage = usageError(action, names, options);
  if (usage) {
    console.error(`Error: ${usage}`);
    return 1;
  }

  // A deferred context: opening a workspace whose scope needs no request, such
  // as a semantic-model scope, then runs no gcloud command.
  const snapshot =
      await kcmd.CatalogSnapshot.fromPath('.', context.ApiContext.deferred());

  return action === 'list' ? await list(snapshot, options) :
                             await get(snapshot, names);
}


function usageError(
    action: string, names: string[], options: EntryOptions): string|undefined {
  if (!ACTIONS.includes(action)) {
    return `unknown entry action '${action}'; use ${ACTIONS.join(' or ')}`;
  }
  if (action !== 'list' && (options.type !== undefined || options.content)) {
    return '--type and --content apply only to entry list';
  }
  if (action === 'list' && names.length) {
    return 'entry list takes no entry names';
  }
  if (action === 'get' && !names.length) {
    return 'entry get needs at least one entry name';
  }
  return undefined;
}


// Prints every entry, sorted by name: `{name, type}` for each, or the full
// entries with --content.
async function list(
    snapshot: kcmd.CatalogSnapshot, options: EntryOptions): Promise<number> {
  const names = [...await snapshot.listEntries()].sort();
  const entries: md.Entry[] = [];
  for (const name of names) {
    const entry = await snapshot.lookupEntry(name);
    if (options.type === undefined || matchesType(entry.type, options.type)) {
      entries.push(entry);
    }
  }
  printJson(
      options.content ? entries :
                        entries.map(e => ({name: e.name, type: e.type})));
  return 0;
}


// Prints the named entries, in the order given. One that cannot be read fails
// the command; the error names every such entry.
async function get(
    snapshot: kcmd.CatalogSnapshot, names: string[]): Promise<number> {
  const entries: md.Entry[] = [];
  const failures: string[] = [];
  for (const name of names) {
    try {
      entries.push(await snapshot.lookupEntry(name));
    } catch (err: any) {
      failures.push(`${name}: ${err?.message ?? err}`);
    }
  }
  if (failures.length) {
    console.error(
        `Error: cannot read ${failures.length} of the entries:\n  ` +
        failures.join('\n  '));
    return 1;
  }
  printJson(entries);
  return 0;
}


// Whether an entry type reference matches a --type filter: the same
// reference, or a filter that is its last dot-separated parts.
export function matchesType(type: string|undefined, filter: string): boolean {
  if (!type) return false;
  return type === filter || type.endsWith(`.${filter}`);
}


export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
