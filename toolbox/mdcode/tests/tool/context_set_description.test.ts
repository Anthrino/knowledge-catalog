// Tests for KR20: managing the context set's (`EntryGroup`) description via
// `_context_set.overview.yaml`, `kcmd context-set get/set`, `kcmd pull`,
// `kcmd push`, and `kcmd init --semantic-model --description`.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient, EntryGroup} from '../../src/libts/gcp/dataplex';
import {CONTEXT_SET_OVERVIEW_FILE, SemanticModelLayout} from '../../src/libts/layouts/semantic-model';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import {init, pull, push} from '../../src/tool/commands';
import {contextSet} from '../../src/tool/context_set_commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const OP = 'projects/test-project/locations/us/operations/op-eg-1';

const MODEL_YAML = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
`;

const DEPLOY_OK = {
  success: true,
  created: 1,
  updated: 0,
  deleted: 0,
  linked: 0,
  unlinked: 0,
  warnings: [],
  plan: [],
};

let dir = '';
let cwd = '';
let savedEnv: string|undefined;

function entryGroupDir(): string {
  return path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
}

function overviewFile(): string {
  return path.join(entryGroupDir(), CONTEXT_SET_OVERVIEW_FILE);
}

function writeWorkspace(withModel = true): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  fs.mkdirSync(entryGroupDir(), {recursive: true});
  if (withModel) {
    fs.writeFileSync(path.join(entryGroupDir(), 'commerce.yaml'), MODEL_YAML);
  }
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-context-set-'));
  process.chdir(dir);
  savedEnv = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  spyOn(CatalogClient.prototype, 'getEntryType')
      .mockResolvedValue({status: 200, result: {}} as any);
  spyOn(CatalogClient.prototype, 'getAspectType')
      .mockResolvedValue({status: 200, result: {}} as any);
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.KC_V2_ASPECTS;
  } else {
    process.env.KC_V2_ASPECTS = savedEnv;
  }
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

describe('CatalogClient.updateEntryGroup', () => {
  test('sends PATCH with updateMask=description and body {description, etag}',
       async () => {
         let calledUrl = '';
         let calledMethod = '';
         let calledBody: any;
         spyOn(globalThis, 'fetch')
             .mockImplementation((async (url: string, opts: any) => {
               calledUrl = url;
               calledMethod = opts.method;
               calledBody = JSON.parse(opts.body);
               return new Response(
                   JSON.stringify({name: OP, done: true}), {status: 200});
             }) as any);

         const client = new CatalogClient(CTX);
         const res = await client.updateEntryGroup(
             'test-project', 'us', 'commerce_eg',
             {description: 'Commerce semantic model', etag: 'etag-123'});

         expect(res.status).toBe(200);
         expect(calledMethod).toBe('PATCH');
         expect(calledUrl).toContain(
             '/v1/projects/test-project/locations/us/entryGroups/commerce_eg?updateMask=description');
         expect(calledBody).toEqual({
           description: 'Commerce semantic model',
           etag: 'etag-123',
         });
       });
});

describe('kcmd pull: context set description and etag', () => {
  test('pull writes description and etag; a second pull with no KC change ' +
           'leaves the file unchanged',
       async () => {
         writeWorkspace();
         spyOn(pullKc, 'pullKnowledgeCatalog')
             .mockResolvedValue({models: [], warnings: []});
         spyOn(CatalogClient.prototype, 'getEntryGroup')
             .mockResolvedValue({
               status: 200,
               result: {
                 name: 'projects/test-project/locations/us/entryGroups/commerce_eg',
                 description: 'Initial context set description',
                 etag: 'etag-v1',
               },
             });

         expect(await pull()).toBe(0);
         expect(fs.existsSync(overviewFile())).toBe(true);
         const firstContent = fs.readFileSync(overviewFile(), 'utf8');
         expect(yaml.parse(firstContent)).toEqual({
           description: 'Initial context set description',
           baseDescription: 'Initial context set description',
           etag: 'etag-v1',
         });

         // Backdate mtime so a rewrite is detectable.
         const past = new Date(Date.now() - 10_000);
         fs.utimesSync(overviewFile(), past, past);

         expect(await pull()).toBe(0);
         expect(fs.statSync(overviewFile()).mtimeMs).toBe(past.getTime());

         // Sidecar is ignored by SemanticModelLayout model/entry discovery.
         const layout = new SemanticModelLayout(
             path.join(dir, 'catalog'), 'commerce_eg',
             {project: 'test-project', location: 'us'});
         await layout.init();
         expect(layout.modelDocuments().map(d => d.name)).toEqual(['commerce']);
       });

  test('pull --dry-run reports the change without writing the overview file',
       async () => {
         writeWorkspace();
         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         spyOn(pullKc, 'pullKnowledgeCatalog')
             .mockResolvedValue({models: [], warnings: []});
         spyOn(CatalogClient.prototype, 'getEntryGroup')
             .mockResolvedValue({
               status: 200,
               result: {
                 name: 'projects/test-project/locations/us/entryGroups/commerce_eg',
                 description: 'Dry run description',
                 etag: 'etag-v1',
               },
             });

         expect(await pull({dryRun: true})).toBe(0);
         expect(fs.existsSync(overviewFile())).toBe(false);
         expect(logSpy.mock.calls.map(c => String(c[0])).join('\n'))
             .toContain(`would create ${path.join('catalog', 'EntryGroups', 'commerce_eg', CONTEXT_SET_OVERVIEW_FILE)}`);
       });
});

describe('kcmd context-set get and set', () => {
  test('get returns empty description before pull and updated description ' +
           'after set, preserving pulled baseDescription and etag',
       async () => {
         writeWorkspace();
         const outputs: any[] = [];
         spyOn(console, 'log').mockImplementation((m: any) => {
           outputs.push(JSON.parse(String(m)));
         });

         expect(await contextSet('get')).toBe(0);
         expect(outputs.pop()).toEqual({
           name: 'test-project.us.commerce_eg',
           description: '',
         });

         // Simulate a pulled overview file with baseDescription and etag.
         const layout = new SemanticModelLayout(
             path.join(dir, 'catalog'), 'commerce_eg');
         await layout.writeContextSetOverview({
           description: 'Original description',
           baseDescription: 'Original description',
           etag: 'etag-abc',
         });

         expect(await contextSet('get')).toBe(0);
         expect(outputs.pop()).toEqual({
           name: 'test-project.us.commerce_eg',
           description: 'Original description',
         });

         const descFile = path.join(dir, 'new_desc.txt');
         fs.writeFileSync(
             descFile,
             'Original description\n\nSemantic model `commerce`: Customer entities.');

         expect(await contextSet('set', [], {descriptionFile: descFile}))
             .toBe(0);
         expect(outputs.pop()).toEqual({
           name: 'test-project.us.commerce_eg',
           description:
               'Original description\n\nSemantic model `commerce`: Customer entities.',
         });

         expect(layout.readContextSetOverview()).toEqual({
           description:
               'Original description\n\nSemantic model `commerce`: Customer entities.',
           baseDescription: 'Original description',
           etag: 'etag-abc',
         });
       });

  test('rejects invalid usage and non-semantic-model scopes', async () => {
    writeWorkspace();
    expect(await contextSet('invalid')).toBe(1);
    expect(await contextSet('get', ['extra'])).toBe(1);
    expect(await contextSet('get', [], {descriptionFile: 'a.txt'})).toBe(1);
    expect(await contextSet('set', [], {})).toBe(1);
    expect(await contextSet('set', [], {descriptionFile: 'missing.txt'}))
        .toBe(1);

    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'), 'scope: entry-group.p.us.eg\n');
    expect(await contextSet('get')).toBe(1);
  });
});

describe('kcmd push: context set description', () => {
  test('skips description update silently when overview file is missing',
       async () => {
         writeWorkspace();
         spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(DEPLOY_OK);
         const updateSpy = spyOn(CatalogClient.prototype, 'updateEntryGroup');

         expect(await push({profile: false})).toBe(0);
         expect(updateSpy).not.toHaveBeenCalled();
       });

  test('pull then push with no change sends no PATCH; set then push sends ' +
           'one PATCH with updateMask=description and etag',
       async () => {
         writeWorkspace();
         spyOn(pullKc, 'pullKnowledgeCatalog')
             .mockResolvedValue({models: [], warnings: []});
         spyOn(CatalogClient.prototype, 'getEntryGroup')
             .mockResolvedValue({
               status: 200,
               result: {
                 name: 'projects/test-project/locations/us/entryGroups/commerce_eg',
                 description: 'Before edit',
                 etag: 'etag-before',
               },
             });
         spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(DEPLOY_OK);
         const updateSpy =
             spyOn(CatalogClient.prototype, 'updateEntryGroup')
                 .mockResolvedValue({
                   status: 200,
                   result: {
                     name: OP,
                     done: false,
                   },
                 });
         const opSpy =
             spyOn(CatalogClient.prototype, 'getOperation')
                 .mockResolvedValue({
                   status: 200,
                   result: {name: OP, done: true},
                 });

         // 1. Pull, then push with no description change -> 0 PATCH calls.
         expect(await pull()).toBe(0);
         expect(await push({profile: false})).toBe(0);
         expect(updateSpy).not.toHaveBeenCalled();

         // 2. Set a new description, then push -> 1 PATCH call with etag.
         const descFile = path.join(dir, 'desc.txt');
         fs.writeFileSync(descFile, 'After edit: Semantic model commerce');
         expect(await contextSet('set', [], {descriptionFile: descFile}))
             .toBe(0);

         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         expect(await push({profile: false})).toBe(0);
         expect(updateSpy).toHaveBeenCalledTimes(1);
         expect(updateSpy.mock.calls[0]).toEqual([
           'test-project',
           'us',
           'commerce_eg',
           {
             description: 'After edit: Semantic model commerce',
             etag: 'etag-before',
           },
           ['description'],
         ]);
         expect(opSpy).toHaveBeenCalledWith(OP);
         expect(logSpy.mock.calls.map(c => String(c[0])).join('\n'))
             .toContain('updated the context set description');

         // 3. Push again with no further edits -> 0 additional PATCH calls.
         expect(await push({profile: false})).toBe(0);
         expect(updateSpy).toHaveBeenCalledTimes(1);
       });

  test('--validate-only sends nothing and reports the pending description change',
       async () => {
         writeWorkspace();
         spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(DEPLOY_OK);
         const updateSpy = spyOn(CatalogClient.prototype, 'updateEntryGroup');

         const descFile = path.join(dir, 'desc.txt');
         fs.writeFileSync(descFile, 'Pending description');
         expect(await contextSet('set', [], {descriptionFile: descFile}))
             .toBe(0);

         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         expect(await push({profile: false, validateOnly: true})).toBe(0);
         expect(updateSpy).not.toHaveBeenCalled();
         const logs = logSpy.mock.calls.map(c => String(c[0])).join('\n');
         expect(logs).toContain('would update the context set description');
         expect(logs).toContain('Validation complete; no changes applied.');
       });

  test('stale etag reports a conflict error and still reports what else was pushed',
       async () => {
         writeWorkspace();
         spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(DEPLOY_OK);
         const layout = new SemanticModelLayout(
             path.join(dir, 'catalog'), 'commerce_eg');
         await layout.writeContextSetOverview({
           description: 'Conflicting description',
           baseDescription: 'Old description',
           etag: 'stale-etag',
         });
         spyOn(CatalogClient.prototype, 'updateEntryGroup')
             .mockResolvedValue({
               status: 412,
               message: 'Precondition failed: etag mismatch',
             });

         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         const errSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(1);
         expect(logSpy.mock.calls.map(c => String(c[0])).join('\n'))
             .toContain('Wrote 1 new and 0 updated Knowledge Catalog entry.');
         const errors = errSpy.mock.calls.map(c => String(c[0])).join('\n');
         expect(errors).toContain('etag conflict');
         expect(errors).toContain('kcmd pull');
       });

  test('missing permission names dataplex.entryGroups.update and still reports ' +
           'what else was pushed',
       async () => {
         writeWorkspace();
         spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue(DEPLOY_OK);
         const layout = new SemanticModelLayout(
             path.join(dir, 'catalog'), 'commerce_eg');
         await layout.writeContextSetOverview({
           description: 'New description',
           baseDescription: 'Old description',
           etag: 'etag-1',
         });
         spyOn(CatalogClient.prototype, 'updateEntryGroup')
             .mockResolvedValue({
               status: 403,
               message: 'Permission denied',
             });

         const logSpy = spyOn(console, 'log').mockImplementation(() => {});
         const errSpy = spyOn(console, 'error').mockImplementation(() => {});

         expect(await push({profile: false})).toBe(1);
         expect(logSpy.mock.calls.map(c => String(c[0])).join('\n'))
             .toContain('Wrote 1 new and 0 updated Knowledge Catalog entry.');
         const errors = errSpy.mock.calls.map(c => String(c[0])).join('\n');
         expect(errors).toContain('dataplex.entryGroups.update');
       });
});

describe('kcmd init --semantic-model --description', () => {
  beforeEach(() => {
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockResolvedValue({status: 200, result: {name: OP, done: true}} as any);
    spyOn(CatalogClient.prototype, 'createEntryType')
        .mockResolvedValue({status: 200, result: {name: OP, done: true}} as any);
    spyOn(CatalogClient.prototype, 'getOperation')
        .mockResolvedValue({status: 200, result: {name: OP, done: true}} as any);
  });

  test('passes description on creation and never modifies an existing group',
       async () => {
         const createSpy =
             spyOn(CatalogClient.prototype, 'createEntryGroup')
                 .mockResolvedValue({
                   status: 200,
                   result: {
                     name: 'projects/test-project/locations/us/entryGroups/commerce_eg',
                     type: 'context-set',
                     description: 'Created description',
                     etag: 'etag-init',
                   } as EntryGroup,
                 });
         const updateSpy = spyOn(CatalogClient.prototype, 'updateEntryGroup');

         expect(await init({
           semanticModel: 'test-project.us.commerce_eg',
           description: 'Created description',
         })).toBe(0);

         expect(createSpy).toHaveBeenCalledWith(
             'test-project', 'us', 'commerce_eg',
             {type: 'context-set', description: 'Created description'});
         expect(yaml.parse(fs.readFileSync(overviewFile(), 'utf8'))).toEqual({
           description: 'Created description',
           baseDescription: 'Created description',
           etag: 'etag-init',
         });

         // Re-running init when the group already exists (409) never calls
         // updateEntryGroup and does not overwrite the local overview file.
         createSpy.mockResolvedValue({status: 409, message: 'already exists'});
         expect(await init({
           semanticModel: 'test-project.us.commerce_eg',
           description: 'Different description on re-init',
         })).toBe(0);
         expect(updateSpy).not.toHaveBeenCalled();
         expect(yaml.parse(fs.readFileSync(overviewFile(), 'utf8')).description)
             .toBe('Created description');
       });
});
