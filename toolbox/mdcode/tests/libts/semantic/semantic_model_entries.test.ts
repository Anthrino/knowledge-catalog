// Tests for the SemanticModel layout's entry methods
// (src/libts/layouts/semantic-model.ts, src/libts/semantic/model_entries.ts):
// the model file shown as the entries push would write for it, plus one
// `semantic-relationship` entry per relationship, named by bare entry IDs.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';

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
