// Tests for the SemanticModel layout's entry methods
// (src/libts/layouts/semantic-model.ts, src/libts/semantic/model_entries.ts,
// src/libts/semantic/model_edits.ts): the model file shown as the entries push
// would write for it, plus one `semantic-relationship` entry per relationship,
// named by bare entry IDs, and saves that edit the model file.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';
import {diffLines} from '../../../src/libts/semantic/text_merge';

const SCOPE = {project: 'test-project', location: 'us'};
const ORDERS_TABLE =
    '//bigquery.googleapis.com/projects/test-project/datasets/sales/tables/orders';
const CUSTOMERS_TABLE =
    'bigquery.googleapis.com/projects/test-project/datasets/sales/tables/customers';
const GRAPH =
    '//bigquery.googleapis.com/projects/test-project/datasets/sales/propertyGraphs/commerce';

// One model with two entities, a metric, and three relationships push would
// not all link: two between the same pair, and one from an entity to itself
// with no join columns.
const MODEL = `version: "0.2.0.dev0/google"
# The commerce model.
semantic_model:
  - name: commerce
    description: Orders and customers.
    ai_context:
      instructions: Use for order questions.
    deployments:
      - name: graph
        target: ${GRAPH}
    entities:
      - name: orders
        source: ${ORDERS_TABLE}
        primary_key: [order_id]
        description: One row per order.
        fields:
          # The order key.
          - name: order_id
            expression: order_id
            datatype: Integer
          - name: customer_id
            expression: customer_id
            datatype: Integer
          - name: amount
            expression: amount
            datatype: Float
          - name: order_date
            expression: order_date
            datatype: Date
            dimension:
              is_time: true
      - name: customers
        source: ${CUSTOMERS_TABLE}
        primary_key: [customer_id]
        fields:
          - name: customer_id
            expression: customer_id
            datatype: Integer
          - name: name
            expression: name
            datatype: String
            label: Customer name
    relationships:
      - name: orders_to_customers
        from: orders
        to: customers
        from_columns: [customer_id]
        to_columns: [customer_id]
      - name: orders_to_customers_again
        from: orders
        to: customers
        from_columns: [customer_id]
        to_columns: [customer_id]
      - name: orders_self
        from: orders
        to: orders
    metrics:
      - name: revenue
        expression: SUM(orders.amount)
        datatype: Float
        description: Total order revenue.
`;

const ANCHOR_ONLY = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    description: Orders and customers.
    ai_context: Use for order questions.
    entities: []
`;

let root: string;
let catalogPath: string;
let savedV2: string|undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-entries-'));
  catalogPath = path.join(root, 'catalog');
  savedV2 = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
  if (savedV2 === undefined) {
    delete process.env.KC_V2_ASPECTS;
  } else {
    process.env.KC_V2_ASPECTS = savedV2;
  }
});

function groupDir(): string {
  return path.join(catalogPath, 'EntryGroups', 'eg');
}

function writeModel(text: string, file = 'commerce.yaml'): string {
  fs.mkdirSync(groupDir(), {recursive: true});
  const p = path.join(groupDir(), file);
  fs.writeFileSync(p, text);
  return p;
}

async function layout(scope = SCOPE): Promise<SemanticModelLayout> {
  const l = new SemanticModelLayout(catalogPath, 'eg', scope);
  await l.init();
  return l;
}

describe('SemanticModelLayout entry view', () => {
  test('lists the entries push writes, and every relationship', async () => {
    writeModel(MODEL);
    const l = await layout();
    expect(l.listEntries()).toEqual([
      'commerce',
      'commerce.entities.orders',
      'commerce.entities.customers',
      'commerce.metrics.revenue',
      'commerce.relationships.orders_to_customers',
      'commerce.relationships.orders_to_customers_again',
      'commerce.relationships.orders_self',
    ]);
    expect(l.entryExists('commerce.entities.orders')).toBe(true);
    expect(l.entryExists('orders')).toBe(false);
  });

  test('names entries with the second-generation layout', async () => {
    process.env.KC_V2_ASPECTS = '1';
    writeModel(MODEL);
    const l = await layout();
    expect(l.listEntries()).toEqual([
      'commerce',
      'commerce/entities/orders',
      'commerce/entities/customers',
      'commerce/metrics/revenue',
      'commerce/relationships/orders_to_customers',
      'commerce/relationships/orders_to_customers_again',
      'commerce/relationships/orders_self',
    ]);
  });

  test('reads the anchor', async () => {
    writeModel(MODEL);
    const l = await layout();
    expect(await l.loadEntry('commerce')).toEqual({
      name: 'commerce',
      type: 'dataplex-types.global.semantic-model',
      resource: {displayName: 'commerce', description: 'Orders and customers.'},
      aspects: {
        'dataplex-types.global.semantic-model': {deploymentTargets: [GRAPH]},
        'dataplex-types.global.guidelines':
            {instructions: 'Use for order questions.', userManaged: true},
      },
    });
  });

  test('reads an entity with its field expressions', async () => {
    writeModel(MODEL);
    const l = await layout();
    const entity = await l.loadEntry('commerce.entities.customers');
    expect(entity).toEqual({
      name: 'commerce.entities.customers',
      type: 'dataplex-types.global.semantic-entity',
      resource: {displayName: 'customers', parent: 'commerce'},
      aspects: {
        'dataplex-types.global.semantic-entity':
            {source: {resources: [CUSTOMERS_TABLE]}},
        'dataplex-types.global.schema': {
          fields: [
            {
              name: 'customer_id',
              dataType: 'INT64',
              metadataType: 'NUMBER',
              semantics: {expression: 'customer_id', role: 'DEFAULT'},
            },
            {
              name: 'name',
              dataType: 'STRING',
              metadataType: 'STRING',
              annotations: {label: 'Customer name'},
              semantics: {expression: 'name', role: 'DEFAULT'},
            },
          ],
          primaryKey: {fields: ['customer_id']},
        },
      },
    });
  });

  test('reads a metric with its expression', async () => {
    writeModel(MODEL);
    const l = await layout();
    expect(await l.loadEntry('commerce.metrics.revenue')).toEqual({
      name: 'commerce.metrics.revenue',
      type: 'dataplex-types.global.semantic-metric',
      resource: {
        displayName: 'revenue',
        description: 'Total order revenue.',
        parent: 'commerce',
      },
      aspects: {
        'dataplex-types.global.semantic-metric': {
          entity: 'orders',
          dataType: 'FLOAT64',
          expression: 'SUM(orders.amount)',
        },
      },
    });
  });

  test('reads relationships, bound and unbound', async () => {
    writeModel(MODEL);
    const l = await layout();
    const aspect = 'dataplex-types.global.semantic-relationship';
    const bound = await l.loadEntry('commerce.relationships.orders_to_customers');
    expect(bound.type).toBe(aspect);
    expect(bound.resource).toEqual(
        {displayName: 'orders_to_customers', parent: 'commerce'});
    expect(bound.aspects?.[aspect]).toEqual({
      source: {name: 'orders', fields: ['customer_id']},
      target: {name: 'customers', fields: ['customer_id']},
    });
    const self = await l.loadEntry('commerce.relationships.orders_self');
    expect(self.aspects?.[aspect])
        .toEqual({source: {name: 'orders'}, target: {name: 'orders'}});
  });

  test('gives a copy, so a caller cannot change the view', async () => {
    writeModel(MODEL);
    const l = await layout();
    const first = await l.loadEntry('commerce');
    first.resource.description = 'changed';
    expect((await l.loadEntry('commerce')).resource.description)
        .toBe('Orders and customers.');
  });

  test('reads the model file again when it changes', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    expect(l.entryExists('commerce.metrics.order_count')).toBe(false);
    fs.writeFileSync(
        p,
        MODEL + '      - name: order_count\n' +
            '        expression: COUNT(orders.order_id)\n');
    expect(l.entryExists('commerce.metrics.order_count')).toBe(true);
  });

  test('an unknown name fails to load', async () => {
    writeModel(MODEL);
    const l = await layout();
    await expect(l.loadEntry('orders')).rejects.toThrow(/does not exist/);
  });

  test('an anchor-only model file shows its anchor alone', async () => {
    writeModel(ANCHOR_ONLY);
    const l = await layout();
    expect(l.listEntries()).toEqual(['commerce']);
    expect(await l.loadEntry('commerce')).toEqual({
      name: 'commerce',
      type: 'dataplex-types.global.semantic-model',
      resource: {displayName: 'commerce', description: 'Orders and customers.'},
      aspects: {
        'dataplex-types.global.semantic-model': {},
        'dataplex-types.global.guidelines':
            {instructions: 'Use for order questions.', userManaged: true},
      },
    });
  });

  test('an empty entry group has no entries', async () => {
    const l = await layout();
    expect(l.listEntries()).toEqual([]);
    expect(l.entryExists('commerce')).toBe(false);
  });

  test('a model file that does not load fails with the loader message',
       async () => {
         writeModel(MODEL.replace('to: customers\n', 'to: suppliers\n'));
         const l = await layout();
         expect(() => l.listEntries()).toThrow(/suppliers/);
       });

  test('two model files in the entry group fail', async () => {
    writeModel(MODEL);
    writeModel(MODEL.replace('name: commerce', 'name: other'), 'other.yaml');
    const l = await layout();
    expect(() => l.listEntries()).toThrow(/2 model files \(commerce, other\)/);
  });

  test('without a scope, the entry methods cannot name entries', async () => {
    writeModel(MODEL);
    const l = new SemanticModelLayout(catalogPath, 'eg');
    await l.init();
    expect(() => l.listEntries()).toThrow(/cannot name entries/);
  });
});

// Entries for new elements, as `kcmd entry get` prints them.
const SYS = 'dataplex-types.global';
const ANCHOR = {
  name: 'commerce',
  type: `${SYS}.semantic-model`,
  resource: {displayName: 'commerce', description: 'Orders and customers.'},
  aspects: {[`${SYS}.guidelines`]: {instructions: 'Use for order questions.'}},
};

function entityEntry(
    name: string, table: string, fields: string[], description?: string) {
  return {
    name,
    type: `${SYS}.semantic-entity`,
    resource: {displayName: name, ...(description ? {description} : {})},
    aspects: {
      [`${SYS}.semantic-entity`]: {source: {resources: [table]}},
      [`${SYS}.schema`]: {
        fields: fields.map(f => ({
                             name: f,
                             dataType: 'INT64',
                             semantics: {expression: f},
                           })),
        primaryKey: {fields: [fields[0]]},
      },
    },
  };
}

function metricEntry(name: string, expression: string) {
  return {
    name,
    type: `${SYS}.semantic-metric`,
    resource: {},
    aspects: {[`${SYS}.semantic-metric`]: {expression, dataType: 'INT64'}},
  };
}

function joinEntry(name: string, from: string, to: string, column: string) {
  return {
    name,
    type: `${SYS}.semantic-relationship`,
    resource: {},
    aspects: {
      [`${SYS}.semantic-relationship`]: {
        source: {name: from, fields: [column]},
        target: {name: to, fields: [column]},
      },
    },
  };
}

const TABLES = '//bigquery.googleapis.com/projects/test-project/datasets/sales/tables';
const ORDERS = entityEntry(
    'orders', `${TABLES}/orders`, ['order_id', 'customer_id', 'amount'],
    'One row per order.');
const CUSTOMERS =
    entityEntry('customers', `${TABLES}/customers`, ['customer_id']);
const PRODUCTS = entityEntry('products', `${TABLES}/products`, ['product_id']);
const REVENUE = metricEntry('revenue', 'SUM(orders.amount)');
const ORDER_COUNT = metricEntry('order_count', 'COUNT(orders.order_id)');
const JOIN = joinEntry('orders_to_customers', 'orders', 'customers', 'customer_id');

describe('SemanticModelLayout saveEntries: new elements', () => {
  test('creates a model in an empty entry group in one call', async () => {
    const l = await layout();
    expect(await l.saveEntries([ANCHOR, ORDERS, CUSTOMERS, REVENUE, JOIN]))
        .toEqual([
          {name: 'commerce', ok: true},
          {name: 'commerce.entities.orders', ok: true},
          {name: 'commerce.entities.customers', ok: true},
          {name: 'commerce.metrics.revenue', ok: true},
          {name: 'commerce.relationships.orders_to_customers', ok: true},
        ]);
    const text = fs.readFileSync(path.join(groupDir(), 'commerce.yaml'), 'utf8');
    expect(text.startsWith('version: "0.2.0.dev0/google"\n')).toBe(true);

    const reopened = await layout();
    expect(reopened.listEntries()).toEqual([
      'commerce',
      'commerce.entities.orders',
      'commerce.entities.customers',
      'commerce.metrics.revenue',
      'commerce.relationships.orders_to_customers',
    ]);
    // Each entry comes back as sent, with what the view adds.
    const orders = await reopened.loadEntry('commerce.entities.orders');
    expect(orders.resource).toEqual(
        {displayName: 'orders', description: 'One row per order.', parent: 'commerce'});
    expect(orders.aspects?.[`${SYS}.schema`].fields[0]).toEqual({
      name: 'order_id',
      dataType: 'INT64',
      metadataType: 'NUMBER',
      semantics: {expression: 'order_id', role: 'DEFAULT'},
    });
    expect((await reopened.loadEntry('commerce.metrics.revenue')).aspects)
        .toEqual({
          [`${SYS}.semantic-metric`]: {
            entity: 'orders',
            dataType: 'INT64',
            expression: 'SUM(orders.amount)',
          },
        });
  });

  test('the anchor alone makes an anchor-only model file', async () => {
    const l = await layout();
    expect(await l.saveEntries([ANCHOR])).toEqual([{name: 'commerce', ok: true}]);
    const reopened = await layout();
    expect(reopened.listEntries()).toEqual(['commerce']);
    expect(await reopened.saveEntries([ORDERS])).toEqual(
        [{name: 'commerce.entities.orders', ok: true}]);
  });

  test('appends to a model and keeps the rest of the file as written', async () => {
    const original = MODEL.replace(
        'primary_key: [order_id]', 'primary_key: [ order_id ]  # the grain');
    const p = writeModel(original);
    const l = await layout();
    expect(await l.saveEntries([PRODUCTS, ORDER_COUNT])).toEqual([
      {name: 'commerce.entities.products', ok: true},
      {name: 'commerce.metrics.order_count', ok: true},
    ]);
    const text = fs.readFileSync(p, 'utf8');
    // Lines were only added.
    expect(diffLines(original.split('\n'), text.split('\n'))
               .every(h => h.start === h.end))
        .toBe(true);
    expect(l.listEntries()).toContain('commerce.entities.products');
  });

  test('a failed item is not written and the others are', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const results = await l.saveEntries([
      PRODUCTS,
      joinEntry('orders_to_suppliers', 'orders', 'suppliers', 'customer_id'),
      ORDER_COUNT,
    ]);
    expect(results[0]).toEqual({name: 'commerce.entities.products', ok: true});
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain("'suppliers'");
    expect(results[2]).toEqual({name: 'commerce.metrics.order_count', ok: true});
    const text = fs.readFileSync(p, 'utf8');
    expect(text).toContain('name: products');
    expect(text).toContain('name: order_count');
    expect(text).not.toContain('orders_to_suppliers');
  });

  test('an item that needs a failed item fails too, and nothing is written',
       async () => {
         const p = writeModel(MODEL);
         const before = fs.readFileSync(p, 'utf8');
         const l = await layout();
         const badEntity = entityEntry('suppliers', `${TABLES}/suppliers`, []);
         const results = await l.saveEntries([
           badEntity,
           joinEntry('orders_to_suppliers', 'orders', 'suppliers', 'customer_id'),
         ]);
         expect(results.map(r => r.ok)).toEqual([false, false]);
         expect(fs.readFileSync(p, 'utf8')).toBe(before);
       });

  test('an item that adds a push check error fails', async () => {
    writeModel(MODEL);
    const l = await layout();
    const [result] = await l.saveEntries([
      entityEntry('products', `${TABLES}/products`, ['product_id'], 'x'.repeat(2001)),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2000');
  });

  test('a model that already fails a push check takes a save that does not touch it',
       async () => {
         writeModel(MODEL.replace(
             'description: One row per order.',
             `description: ${'x'.repeat(2001)}`));
         const l = await layout();
         expect(await l.saveEntries([PRODUCTS])).toEqual(
             [{name: 'commerce.entities.products', ok: true}]);
       });

  test('an element that would not come back as sent fails, naming the value',
       async () => {
         writeModel(MODEL);
         const l = await layout();
         const typo = structuredClone(PRODUCTS);
         typo.aspects[`${SYS}.schema`].fields[0].dataType = 'INTEGER';
         const extra = structuredClone(PRODUCTS) as any;
         extra.name = extra.resource.displayName = 'items';
         extra.aspects[`${SYS}.overview`] = {content: 'hello'};
         const results = await l.saveEntries([typo, extra]);
         expect(results[0].error).toBe(
             `aspects.${SYS}.schema.fields[0].dataType: "INTEGER" would be ` +
             'saved as "STRING"');
         expect(results[1].error).toBe(
             `aspects.${SYS}.overview: {"content":"hello"} would be saved as nothing`);
       });

  test('a name that is not an entry and not an element name fails', async () => {
    writeModel(MODEL);
    const l = await layout();
    const [dotted, invalid] = await l.saveEntries([
      {...PRODUCTS, name: 'commerce.entities.products'},
      {...PRODUCTS, name: 'my-products', resource: {}},
    ]);
    expect(dotted.error).toContain('is not an entry of the model');
    expect(invalid.error).toContain("Entity name 'my-products' is not valid");
  });

  test('an existing element, a second model and a child before its anchor fail',
       async () => {
         writeModel(MODEL);
         const l = await layout();
         const [twin, second] = await l.saveEntries([
           {...ORDERS, name: 'customers', resource: {displayName: 'customers'}},
           {...ANCHOR, name: 'other', resource: {displayName: 'other'}},
         ]);
         expect(twin.error).toBe("model 'commerce' already has entity 'customers'");
         expect(second.error).toContain("already holds model 'commerce'");

         fs.rmSync(groupDir(), {recursive: true});
         const empty = await layout();
         const [orphan] = await empty.saveEntries([ORDERS]);
         expect(orphan.error).toContain("save the model's anchor entry");
       });

  test('a renaming display name, an action and an update fail', async () => {
    writeModel(MODEL);
    const l = await layout();
    const results = await l.saveEntries([
      {...PRODUCTS, resource: {displayName: 'items'}},
      {name: 'refund', type: 'test-project.global.semantic-action', resource: {}},
      await l.loadEntry('commerce.entities.orders'),
    ]);
    expect(results[0].error).toContain('renaming is not supported');
    expect(results[1].error).toContain('semantic-action entries is not supported');
    expect(results[2].error).toContain('not supported yet');
  });

  test('names created entries with the second-generation layout', async () => {
    process.env.KC_V2_ASPECTS = '1';
    writeModel(MODEL);
    const l = await layout();
    expect(await l.saveEntries([PRODUCTS])).toEqual(
        [{name: 'commerce/entities/products', ok: true}]);
  });

  test('appends an entity to a vanilla model file under datasets', async () => {
    const p = writeModel(`version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    datasets:
      - name: orders
        source: ${ORDERS_TABLE}
        primary_key: [order_id]
        fields:
          - name: order_id
            expression:
              dialects:
                - dialect: ANSI_SQL
                  expression: order_id
`);
    const l = await layout();
    expect(await l.saveEntries([PRODUCTS])).toEqual(
        [{name: 'commerce.entities.products', ok: true}]);
    const text = fs.readFileSync(p, 'utf8');
    expect(text).not.toContain('entities:');
    expect(text).toContain('      - name: products');
  });
});
