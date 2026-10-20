// A model file as an editable YAML document. Edits change the document's
// nodes, so every comment survives, and text() keeps the formatting of every
// line an edit did not change (see text_merge.ts).
//

import * as yaml from 'yaml';

import {AiContext, DeploymentSpec, Entity, Metric, Relationship} from './ir';
import {FormatVersion, GOOGLE_VERSION, OSSIE_VERSION} from './loader';
import {aiContextDoc, datasetDoc, metricDoc, relationshipDoc} from './osi_converter';
import {mergeFormatting} from './text_merge';
import {YAML_OPTIONS} from './yaml_options';

// How a model document is rendered: no padding inside flow collections and no
// folded lines, as kcmd's compact serializer writes them.
const RENDER_OPTIONS = {flowCollectionPadding: false, lineWidth: 0} as const;

// A scalar list at most this wide is written in flow style, as in
// `primary_key: [id]`.
const FLOW_WIDTH = 80;

// The model-level keys of a new model file.
export interface ModelAnchor {
  name: string;
  description?: string;
  aiContext?: AiContext;
  deployments?: DeploymentSpec[];
}

// The lists of a model that hold its elements.
type ElementList = 'entities'|'metrics'|'relationships';


export class ModelDocument {
  private readonly _doc: yaml.Document;
  // The file as written and as rendered unedited, when the document was
  // parsed from one.
  private readonly _source?: {text: string; rendered: string};

  private constructor(
      doc: yaml.Document, source?: {text: string; rendered: string}) {
    this._doc = doc;
    this._source = source;
  }

  // Parses a model file. Throws when it is not valid YAML or does not hold
  // exactly one model.
  static parse(text: string): ModelDocument {
    const doc = yaml.parseDocument(text, YAML_OPTIONS);
    if (doc.errors.length) {
      throw new Error(
          `the model file is not valid YAML: ${doc.errors[0].message}`);
    }
    modelNodeOf(doc);
    return new ModelDocument(
        doc, {text, rendered: doc.toString(RENDER_OPTIONS)});
  }

  // A new Google-flavor model file holding one model with no entities yet.
  static create(anchor: ModelAnchor): ModelDocument {
    const model = compact({
      name: anchor.name,
      description: anchor.description,
      ai_context: aiContextDoc(anchor.aiContext, true),
      deployments: anchor.deployments?.length ?
          anchor.deployments.map(d => compact({
                                   name: d.name,
                                   target: d.target,
                                   profile: d.profile,
                                 })) :
          undefined,
      entities: [],
    });
    const doc =
        new yaml.Document({version: GOOGLE_VERSION, semantic_model: [model]});
    // Quoted, as the guides write it.
    const version = doc.get('version', true);
    if (yaml.isScalar(version)) version.type = yaml.Scalar.QUOTE_DOUBLE;
    flowShortLists(doc.contents);
    return new ModelDocument(doc);
  }

  clone(): ModelDocument {
    return new ModelDocument(
        this._doc.clone(), this._source && {...this._source});
  }

  // The document rendered by the YAML library.
  render(): string {
    return this._doc.toString(RENDER_OPTIONS);
  }

  // The document as file text: the rendering, with every line no edit changed
  // as the file wrote it.
  text(): string {
    const edited = this.render();
    if (!this._source) return edited;
    const merged =
        mergeFormatting(this._source.text, this._source.rendered, edited);
    // The merge only moves formatting; check that it kept every value.
    return merged === edited || sameValues(merged, edited) ? merged : edited;
  }

  get isGoogleVersion(): boolean {
    return this._doc.get('version') === GOOGLE_VERSION;
  }

  get modelName(): string {
    return String(this._modelNode().get('name') ?? '');
  }

  // Whether the model has an element of this name in the list.
  has(list: ElementList, name: string): boolean {
    return this._items(list).some(item => item.get('name') === name);
  }

  addEntity(entity: Entity): void {
    this._append(
        this._entitiesKey(), datasetDoc(entity, [], true, this._version));
  }

  addMetric(metric: Metric): void {
    this._append('metrics', metricDoc(metric, [], this._version));
  }

  addRelationship(rel: Relationship): void {
    this._append('relationships', relationshipDoc(rel, [], this._version));
  }

  private get _version(): FormatVersion {
    return this.isGoogleVersion ? GOOGLE_VERSION : OSSIE_VERSION;
  }

  private _modelNode(): yaml.YAMLMap {
    return modelNodeOf(this._doc);
  }

  // The key of the entity list: the one the file uses, else `entities` in a
  // Google-flavor file and `datasets` in a vanilla one.
  private _entitiesKey(): string {
    const model = this._modelNode();
    if (model.has('entities')) return 'entities';
    if (model.has('datasets')) return 'datasets';
    return this.isGoogleVersion ? 'entities' : 'datasets';
  }

  private _items(list: ElementList): yaml.YAMLMap[] {
    const key = list === 'entities' ? this._entitiesKey() : list;
    const seq = this._modelNode().get(key);
    return yaml.isSeq(seq) ? seq.items.filter(yaml.isMap) as yaml.YAMLMap[] :
                             [];
  }

  // Appends `value` to the model's list `key`, creating the list if needed.
  // An empty flow list (`entities: []`) becomes a block list.
  private _append(key: string, value: Record<string, unknown>): void {
    const model = this._modelNode();
    let seq = model.get(key);
    if (!yaml.isSeq(seq)) {
      seq = this._doc.createNode([]);
      model.set(key, seq);
    }
    const list = seq as yaml.YAMLSeq;
    if (!list.items.length) list.flow = false;
    const node = this._doc.createNode(value);
    flowShortLists(node);
    list.items.push(node);
  }
}


// The one model a model document holds. Throws when it holds another number.
function modelNodeOf(doc: yaml.Document): yaml.YAMLMap {
  const models = doc.get('semantic_model');
  if (!yaml.isSeq(models) || models.items.length !== 1 ||
      !yaml.isMap(models.items[0])) {
    throw new Error('the model file must hold exactly one model');
  }
  return models.items[0] as yaml.YAMLMap;
}


// Writes each short list of scalars under `node` in flow style.
function flowShortLists(node: unknown): void {
  yaml.visit(node as yaml.Node, {
    Seq(_, seq) {
      if (!seq.items.length || !seq.items.every(i => yaml.isScalar(i))) return;
      const width = seq.items.reduce(
          (n, i) => n + String((i as yaml.Scalar).value ?? '').length + 2, 2);
      if (width <= FLOW_WIDTH) seq.flow = true;
    },
  });
}


// Whether two YAML texts hold the same values.
function sameValues(a: string, b: string): boolean {
  try {
    return JSON.stringify(yaml.parse(a, YAML_OPTIONS)) ===
        JSON.stringify(yaml.parse(b, YAML_OPTIONS));
  } catch {
    return false;
  }
}


function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
