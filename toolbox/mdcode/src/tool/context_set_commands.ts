// The `kcmd context-set` command: reads and sets the workspace's context set
// (`EntryGroup`) description in the local `_context_set.overview.yaml` sidecar.
//
// Like `kcmd entry`, `kcmd context-set` touches only the local workspace and
// makes no network calls; `kcmd pull` populates the file from Knowledge Catalog
// and `kcmd push` publishes changes back to the EntryGroup.

import * as fs from 'node:fs';
import * as yaml from 'yaml';

import * as kcmd from '../libts';
import * as context from '../libts/gcp/context';
import {SemanticModelLayout} from '../libts/layouts/semantic-model';
import {withWorkspaceLock} from '../libts/lock';
import {YAML_OPTIONS} from '../libts/semantic/yaml_options';
import {Sources} from '../libts/source';
import {SemanticModelSource} from '../libts/sources/semantic-model';
import {printJson} from './entry_commands';


export interface ContextSetOptions {
  // context-set set: path to the file holding the new description, or `-` to
  // read standard input.
  descriptionFile?: string|boolean;
}

const ACTIONS = ['get', 'set'];


// Runs `kcmd context-set <action> [args...]` and returns the process exit code.
export async function contextSet(
    action: string, args: string[] = [],
    options: ContextSetOptions = {}): Promise<number> {
  const usage = usageError(action, args, options);
  if (usage) {
    console.error(`Error: ${usage}`);
    return 1;
  }

  let newDescription = '';
  if (action === 'set') {
    const file = options.descriptionFile as string;
    const read = readDescriptionInput(file);
    if ('error' in read) {
      console.error(`Error: ${read.error}`);
      return 1;
    }
    newDescription = read.description;
  }

  if (isNonSemanticModelManifest('catalog.yaml')) {
    console.error(
        'Error: `kcmd context-set` applies only to a semantic-model scope.');
    return 1;
  }

  const snapshot =
      await kcmd.CatalogSnapshot.fromPath('.', context.ApiContext.deferred());
  if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
    console.error(
        'Error: `kcmd context-set` applies only to a semantic-model scope.');
    return 1;
  }

  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;
  const fullName = `${source.project}.${source.location}.${source.entryGroup}`;

  if (action === 'get') {
    const overview = layout.readContextSetOverview();
    printJson({
      name: fullName,
      description: overview?.description ?? '',
    });
    return 0;
  }

  await withWorkspaceLock(snapshot.basePath, async () => {
    const existing = layout.readContextSetOverview();
    await layout.writeContextSetOverview({
      description: newDescription,
      ...(existing?.baseDescription !== undefined ?
              {baseDescription: existing.baseDescription} :
              {}),
      ...(existing?.etag !== undefined ? {etag: existing.etag} : {}),
    });
  });

  printJson({
    name: fullName,
    description: newDescription,
  });
  return 0;
}


function usageError(
    action: string, args: string[],
    options: ContextSetOptions): string|undefined {
  if (!ACTIONS.includes(action)) {
    return `unknown context-set action '${action}'; use get or set`;
  }
  if (args.length > 0) {
    return `context-set ${action} takes no positional arguments`;
  }
  if (action === 'get' && options.descriptionFile !== undefined) {
    return '--description-file applies only to context-set set';
  }
  if (action === 'set' &&
      (typeof options.descriptionFile !== 'string' ||
       options.descriptionFile === '')) {
    return 'context-set set requires --description-file <file|->';
  }
  return undefined;
}


function readDescriptionInput(file: string):
    {description: string}|{error: string} {
  try {
    const description = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    return {description};
  } catch (err: any) {
    return {
      error: `cannot read ${file === '-' ? 'standard input' : `'${file}'`}: ${
          err?.message ?? err}`,
    };
  }
}


// True when `manifestPath` exists, parses, and declares a scope other than
// `semantic-model.*`, so `contextSet` can reject it before `CatalogSnapshot`
// attempts to resolve an `entryGroup`, `kb`, or `bq-dataset` source over the
// network.
function isNonSemanticModelManifest(manifestPath: string): boolean {
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const doc = yaml.parse(fs.readFileSync(manifestPath, 'utf8'), YAML_OPTIONS);
    const scope = doc?.scope;
    return scope !== undefined &&
        (typeof scope !== 'string' || !scope.startsWith('semantic-model.'));
  } catch {
    return false;
  }
}
