// Tests for `kcmd entry` (src/tool/entry_commands.ts): listing and reading
// entries as JSON. Each test runs in a temp workspace. The standard-layout
// workspace names a custom entry group, so opening it looks the group up; the
// lookup is stubbed, every other network call fails the test, and no gcloud
// command may run, since `kcmd entry` uses a deferred API context.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as cp from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {entry, matchesType} from '../../src/tool/entry_commands';

const MAIN = path.join(process.cwd(), 'src', 'tool', 'main.ts');

const ORDERS = {
  name: 'orders',
  type: 'test-project.us.table',
  resource: {displayName: 'orders', description: 'One row per order.'},
  aspects: {'test-project.us.notes': {text: 'hello'}},
};
const REFUNDS = {
  name: 'sub/refunds',
  type: 'dataplex-types.global.generic',
  resource: {description: 'One row per refund.'},
};

const MODEL_YAML = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
`;

let dir = '';
let cwd = '';
let out: string[] = [];
let err: string[] = [];

function writeStandardWorkspace(
    scope = 'entryGroup.test-project.us.test_eg'): void {
  fs.writeFileSync('catalog.yaml', `scope: ${scope}\n`);
  fs.mkdirSync(path.join('catalog', 'sub'), {recursive: true});
  fs.writeFileSync(path.join('catalog', 'orders.yaml'), yaml.stringify(ORDERS));
  fs.writeFileSync(
      path.join('catalog', 'sub', 'refunds.yaml'), yaml.stringify(REFUNDS));
}

function writeSemanticWorkspace(): void {
  fs.writeFileSync(
      'catalog.yaml', 'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join('catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), MODEL_YAML);
}

function printed(): any {
  return JSON.parse(out.join('\n'));
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-entry-'));
  process.chdir(dir);
  out = [];
  err = [];
  spyOn(console, 'log').mockImplementation((...args: any[]) => {
    out.push(args.join(' '));
  });
  spyOn(console, 'error').mockImplementation((...args: any[]) => {
    err.push(args.join(' '));
  });
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  spyOn(cp, 'execSync').mockImplementation((() => {
    throw new Error('a test ran a gcloud command');
  }) as any);
  spyOn(CatalogClient.prototype, 'getEntryGroup')
      .mockImplementation((async (p: string, l: string, id: string) => ({
                             status: 200,
                             result: {
                               name: `projects/${p}/locations/${
                                   l}/entryGroups/${id}`
                             },
                           })) as any);
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, {recursive: true, force: true});
  mock.restore();
});

describe('kcmd entry list', () => {
  test('prints each entry\'s name and type, sorted by name', async () => {
    writeStandardWorkspace();
    expect(await entry('list')).toBe(0);
    expect(printed()).toEqual([
      {name: 'orders', type: 'test-project.us.table'},
      {name: 'sub/refunds', type: 'dataplex-types.global.generic'},
    ]);
    expect(err).toEqual([]);
  });

  test('--content prints the full entries', async () => {
    writeStandardWorkspace();
    expect(await entry('list', [], {content: true})).toBe(0);
    expect(printed()).toEqual([ORDERS, REFUNDS]);
  });

  test('--type matches the last part of the type or the full reference',
       async () => {
         writeStandardWorkspace();
         expect(await entry('list', [], {type: 'generic'})).toBe(0);
         expect(printed().map((e: any) => e.name)).toEqual(['sub/refunds']);

         out = [];
         expect(await entry('list', [], {type: 'test-project.us.table'}))
             .toBe(0);
         expect(printed().map((e: any) => e.name)).toEqual(['orders']);

         out = [];
         expect(await entry('list', [], {type: 'table-x'})).toBe(0);
         expect(printed()).toEqual([]);
       });

  test('an empty workspace lists nothing', async () => {
    fs.writeFileSync('catalog.yaml', 'scope: entryGroup.test-project.us.eg\n');
    expect(await entry('list')).toBe(0);
    expect(printed()).toEqual([]);
  });
});

describe('kcmd entry get', () => {
  test('prints the named entries in the order given', async () => {
    writeStandardWorkspace();
    expect(await entry('get', ['sub/refunds', 'orders'])).toBe(0);
    expect(printed()).toEqual([REFUNDS, ORDERS]);
  });

  test('fails naming every entry it cannot read, and prints nothing',
       async () => {
         writeStandardWorkspace();
         expect(await entry('get', ['orders', 'nope', 'gone'])).toBe(1);
         expect(out).toEqual([]);
         const message = err.join('\n');
         expect(message).toContain('cannot read 2 of the entries');
         expect(message).toContain('nope: Entry not found: nope');
         expect(message).toContain('gone: Entry not found: gone');
       });
});

describe('kcmd entry usage', () => {
  const cases: [string, string, string[], object, string][] = [
    ['an unknown action', 'show', [], {}, 'unknown entry action \'show\''],
    ['get without names', 'get', [], {}, 'needs at least one entry name'],
    ['list with names', 'list', ['orders'], {}, 'takes no entry names'],
    ['--type on get', 'get', ['orders'], {type: 'x'}, 'apply only to entry list'],
    ['--content on get', 'get', ['orders'], {content: true},
     'apply only to entry list'],
  ];
  for (const [label, action, names, options, message] of cases) {
    test(`${label} fails before opening the workspace`, async () => {
      expect(await entry(action, names, options)).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain(message);
    });
  }

  test('a folder with no catalog.yaml fails', async () => {
    await expect(entry('list')).rejects.toThrow('Cannot find catalog manifest');
  });
});

describe('kcmd entry on a semantic-model workspace', () => {
  // Until the semantic-model layout exposes entries, it lists none and
  // reading one fails with the layout's own message.
  test('lists nothing, with no request and no gcloud command', async () => {
    writeSemanticWorkspace();
    expect(await entry('list')).toBe(0);
    expect(printed()).toEqual([]);
  });

  test('get reports that the layout does not expose entries yet', async () => {
    writeSemanticWorkspace();
    expect(await entry('get', ['commerce'])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n'))
        .toContain('does not expose per-entry Knowledge Catalog files yet');
  });
});

describe('matchesType', () => {
  test('matches the full reference and its trailing parts only', () => {
    const type = 'dataplex-types.global.semantic-entity';
    expect(matchesType(type, type)).toBe(true);
    expect(matchesType(type, 'semantic-entity')).toBe(true);
    expect(matchesType(type, 'global.semantic-entity')).toBe(true);
    expect(matchesType(type, 'entity')).toBe(false);
    expect(matchesType(undefined, 'semantic-entity')).toBe(false);
  });
});

describe('kcmd entry, as a process', () => {
  // main.ts runs on import, so these spawn it. A semantic-model workspace
  // opens without a request, so the child needs neither network nor gcloud.
  function run(...args: string[]): {code: number; stdout: string; stderr: string} {
    const p = Bun.spawnSync({
      cmd: ['bun', MAIN, 'entry', ...args],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: p.exitCode ?? -1,
      stdout: p.stdout.toString(),
      stderr: p.stderr.toString(),
    };
  }

  test('prints one JSON value on stdout and exits 0', () => {
    writeSemanticWorkspace();
    const {code, stdout} = run('list', '--type', 'semantic-model');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  }, 30000);

  test('exits 1 with nothing on stdout when an entry cannot be read', () => {
    writeSemanticWorkspace();
    const {code, stdout, stderr} = run('get', 'commerce');
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('cannot read 1 of the entries');
  }, 30000);
});
