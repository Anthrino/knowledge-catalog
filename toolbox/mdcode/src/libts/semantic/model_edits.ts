// Saves `kcmd entry save` items into a model file. Each item creates or
// updates one element of the one model in the file. The edited file must load
// and pass the local checks `kcmd push --no-profile` runs, and each element
// must come back as its item sent it. An item that adds an error, or whose
// element would come back changed, fails on its own and is not written.
//

import * as dataplex from '../gcp/dataplex';
import type {Aspect, Entry} from '../gcp/dataplex';
import * as md from '../metadata';
import {Entity, SemanticModel} from './ir';
import {aspectDataOf, readAiContext, readDeploymentTargets, readEntity, readMetric} from './kc_converter';
import {readRelationshipEntry, RELATIONSHIP_TYPE} from './kc_relationships';
import {deploymentProfileError, LoadedModel} from './loader';
import {ModelDocument} from './model_document';
import {ElementKind, loadModelFile, ModelFile, modelEntries, ModelScope, ViewEntry} from './model_entries';
import {NameKind, nameProblem} from './names';
import {validatePushRequirements} from './validate';

// What a save does to the model file.
export interface SaveOutcome {
  // One result per item, in the order given.
  results: md.EntryResult[];
  // The model file's new text, or undefined when the file does not change.
  text?: string;
  // The name of the model the file holds after the save.
  model?: string;
}

// The entry types an item may create, by the last part of the type.
const CREATABLE: Record<string, ElementKind> = {
  'semantic-model': 'model',
  'semantic-entity': 'entity',
  'semantic-metric': 'metric',
  [RELATIONSHIP_TYPE]: 'relationship',
};

// One item that passed planning: the change it makes to the model file.
interface Edit {
  index: number;
  item: md.Entry;
  kind: ElementKind;
  element: string;
  // Makes the change to `doc`, which it may modify, and returns the result.
  // Throws when the change cannot be made.
  apply(doc: ModelDocument|undefined): ModelDocument;
}

// The model file before the save, as each step needs it.
interface Base {
  file?: ModelFile;
  doc?: ModelDocument;
  model?: SemanticModel;
  view: ViewEntry[];
  errors: string[];
}


// Saves `items` into the model file `file` (undefined when the entry group
// has none yet). Throws when the file as it is does not load, which fails the
// whole call.
export function saveModelEntries(
    file: ModelFile|undefined, items: md.Entry[],
    scope: ModelScope): SaveOutcome {
  const base = readBase(file, scope);
  const results: Array<md.EntryResult|undefined> =
      new Array(items.length).fill(undefined);
  const planner = new Planner(base);
  const edits: Edit[] = [];
  items.forEach((item, index) => {
    const planned = planner.plan(item);
    if (typeof planned === 'string') {
      results[index] = {name: item.name, ok: false, error: planned};
    } else {
      edits.push({...planned, index});
    }
  });

  const checker = new Checker(base, scope);
  const accepted = checker.applyAll(edits, results) ??
      checker.applyEach(edits, results);
  const text = accepted && accepted !== base.doc ? accepted.text() : undefined;
  return {
    results: results as md.EntryResult[],
    text: text !== undefined && text !== file?.text ? text : undefined,
    model: accepted?.modelName,
  };
}


function readBase(file: ModelFile|undefined, scope: ModelScope): Base {
  if (!file) return {view: [], errors: []};
  const model = loadModelFile(file, scope.project);
  return {
    file,
    doc: ModelDocument.parse(file.text),
    model,
    view: modelEntries(model, scope),
    errors: checkErrors(model, file.name),
  };
}


// Turns items into edits, one at a time, keeping track of what the earlier
// items of the call create.
class Planner {
  private readonly _byName: Map<string, ViewEntry>;
  // The model's name, once the file holds a model or an item creates one.
  private _model?: string;
  // The elements the model has, or that earlier items create, by kind.
  private readonly _names = new Map<ElementKind, Set<string>>();

  constructor(base: Base) {
    this._byName = new Map(base.view.map(v => [v.entry.name, v]));
    this._model = base.model?.name;
    for (const v of base.view) this._namesOf(v.kind).add(v.element);
  }

  // The edit an item makes, or why it fails.
  plan(item: md.Entry): Omit<Edit, 'index'>|string {
    const existing = this._byName.get(item.name);
    if (existing) {
      return `updating an existing ${existing.kind} is not supported yet`;
    }
    if (/[./]/.test(item.name)) {
      return `'${item.name}' is not an entry of the model; to create an ` +
          `element, name its entry by the element's own name, such as ` +
          `'orders'`;
    }
    const typeId = item.type.split('.').pop() ?? '';
    const kind = CREATABLE[typeId];
    if (!kind) {
      return typeId === 'semantic-action' || typeId === 'semantic-constraint' ?
          `saving ${typeId} entries is not supported yet` :
          `type '${item.type}' is not a type of semantic model entry`;
    }
    return this._create(item, kind);
  }

  private _create(item: md.Entry, kind: ElementKind): Omit<Edit, 'index'>|
      string {
    const name = item.name;
    const problem = nameProblem(kind as NameKind, name);
    if (problem) return problem;
    const displayName = item.resource?.displayName;
    if (displayName !== undefined && displayName !== name) {
      return `resource.displayName '${displayName}' must equal the entry ` +
          `name '${name}'; renaming is not supported`;
    }
    let entry: Entry;
    try {
      entry = toServiceEntry(item, name);
    } catch (err: any) {
      return err?.message ?? String(err);
    }

    if (kind === 'model') {
      if (this._model !== undefined) {
        return `the entry group already holds model '${this._model}'; ` +
            `kcmd entry commands work on one model per entry group`;
      }
      this._model = name;
      const anchor = {
        name,
        description: entry.entrySource?.description,
        aiContext: readAiContext(entry),
        deployments: readDeploymentTargets(entry, name, [])?.deployments,
      };
      return {item, kind, element: name, apply: () => ModelDocument.create(anchor)};
    }

    if (this._model === undefined) {
      return `save the model's anchor entry (type semantic-model) before ` +
          `any other entry of the model`;
    }
    if (this._namesOf(kind).has(name)) {
      return `model '${this._model}' already has ${kind} '${name}'`;
    }
    const warnings: string[] = [];
    let add: (doc: ModelDocument) => void;
    if (kind === 'entity') {
      const entity = readEntity(entry, warnings);
      readStringFields(entity, entry);
      add = doc => doc.addEntity(entity);
    } else if (kind === 'metric') {
      const metric = readMetric(entry, [...this._namesOf('entity')], warnings);
      add = doc => doc.addMetric(metric);
    } else {
      const problems: string[] = [];
      const rel = readRelationshipEntry(entry, problems);
      if (!rel || problems.length) return problems.join('; ');
      add = doc => doc.addRelationship(rel);
    }
    this._namesOf(kind).add(name);
    return {
      item,
      kind,
      element: name,
      apply: doc => {
        if (!doc) {
          throw new Error(
              `the model's anchor entry was not saved, so its ${kind} ` +
              `cannot be either`);
        }
        add(doc);
        return doc;
      },
    };
  }

  private _namesOf(kind: ElementKind): Set<string> {
    let names = this._names.get(kind);
    if (!names) {
      names = new Set();
      this._names.set(kind, names);
    }
    return names;
  }
}


// Applies edits and checks the results.
class Checker {
  private readonly _base: Base;
  private readonly _scope: ModelScope;

  constructor(base: Base, scope: ModelScope) {
    this._base = base;
    this._scope = scope;
  }

  // Applies every edit at once. Returns the edited document, after recording
  // a result for each edit, when the edits add no error and each element
  // comes back as sent; otherwise undefined, recording nothing.
  applyAll(edits: Edit[], results: Array<md.EntryResult|undefined>):
      ModelDocument|undefined {
    if (!edits.length) return this._base.doc;
    let doc = this._base.doc?.clone();
    try {
      for (const edit of edits) doc = edit.apply(doc);
    } catch {
      return undefined;
    }
    const checked = this._check(doc!, this._base.errors);
    if (checked.errors.length) return undefined;
    const saved = edits.map(edit => this._saved(edit, checked.view!));
    if (saved.some(s => s.error !== undefined)) return undefined;
    edits.forEach((edit, k) => {
      results[edit.index] = {name: saved[k].name!, ok: true};
    });
    return doc;
  }

  // Applies the edits one at a time, each to the result of the edits before
  // it that succeeded, and records a result for each. An edit fails when it
  // adds an error or its element does not come back as sent. Returns the
  // last document that succeeded.
  applyEach(edits: Edit[], results: Array<md.EntryResult|undefined>):
      ModelDocument|undefined {
    let accepted = this._base.doc;
    let known = this._base.errors;
    for (const edit of edits) {
      const name = edit.item.name;
      let trial: ModelDocument;
      try {
        trial = edit.apply(accepted?.clone());
      } catch (err: any) {
        results[edit.index] = {name, ok: false, error: err?.message ?? String(err)};
        continue;
      }
      const checked = this._check(trial, known);
      const saved = checked.view ? this._saved(edit, checked.view) : undefined;
      const error = checked.errors.length ? checked.errors.join('\n') : saved?.error;
      if (error !== undefined) {
        results[edit.index] = {name, ok: false, error};
        continue;
      }
      accepted = trial;
      known = checked.all;
      results[edit.index] = {name: saved!.name!, ok: true};
    }
    return accepted;
  }

  // Loads `doc` and runs push's local checks on it. `errors` are the errors
  // not in `known`; `all` are every error; `view` is the entry view, absent
  // when the document does not load.
  private _check(doc: ModelDocument, known: string[]):
      {errors: string[]; all: string[]; view?: ViewEntry[]} {
    const document = this._base.file?.name ?? doc.modelName;
    let model: SemanticModel;
    try {
      model = loadModelFile({name: document, text: doc.render()}, this._scope.project);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      return {errors: [message], all: [message]};
    }
    const all = checkErrors(model, document);
    return {
      errors: all.filter(e => !known.includes(e)),
      all,
      view: modelEntries(model, this._scope),
    };
  }

  // The bare entry ID of the edit's element after the edit, or why the
  // element does not come back as its item sent it.
  private _saved(edit: Edit, view: ViewEntry[]): {name?: string; error?: string} {
    const found = view.find(v => v.kind === edit.kind && v.element === edit.element);
    if (!found) {
      return {error: `the ${edit.kind} '${edit.element}' is not in the model after the save`};
    }
    const error = firstDifference(edit.item.type, found.entry.type, 'type') ??
        firstDifference(edit.item.resource ?? {}, found.entry.resource, 'resource') ??
        firstDifference(edit.item.aspects ?? {}, found.entry.aspects ?? {}, 'aspects');
    return error ? {error} : {name: found.entry.name};
  }
}


// The errors `kcmd push --no-profile` gives for the model from its local
// checks: a deployment that names a profile, then validatePushRequirements as
// a catalog-only push runs it. The checks of named profiles are left to push.
function checkErrors(model: SemanticModel, document: string): string[] {
  const models: LoadedModel[] = [{document, model}];
  const errors: string[] = [];
  const profileError = deploymentProfileError(models);
  if (profileError) errors.push(profileError);
  errors.push(...validatePushRequirements(models, {
    targetOptional: true,
    fieldsPruned: false,
    warnings: [],
    liftedExclusions: [],
  }));
  return [...new Set(errors)];
}


// Types each field the `schema` aspect gives as STRING with metadataType
// STRING as String. readEntity reads such a field as untyped, as pull does,
// and the view shows an untyped field as Opaque (metadataType OTHER), so the
// field would not come back as sent.
function readStringFields(entity: Entity, entry: Entry): void {
  const records = aspectDataOf(entry.aspects, 'schema').fields;
  if (!Array.isArray(records)) return;
  for (const field of entity.fields) {
    const record = records.find((r: any) => r?.name === field.name);
    if (field.type === undefined && record?.dataType === 'STRING' &&
        record?.metadataType === 'STRING') {
      field.type = 'String';
    }
  }
}


// An item as the Dataplex entry the converters read: each aspect keyed and
// typed by its type reference, `resource` as the entry source.
function toServiceEntry(item: md.Entry, name: string): Entry {
  const aspects: Record<string, Aspect> = {};
  for (const [key, data] of Object.entries(item.aspects ?? {})) {
    let aspectType: string;
    try {
      aspectType = dataplex._typeRefToName(key, 'aspect');
    } catch {
      throw new Error(
          `aspect '${key}' is not keyed by an aspect type reference ` +
          `(project.location.type)`);
    }
    aspects[key] = {aspectType, data};
  }
  return {
    name,
    entryType: dataplex._typeRefToName(item.type, 'entry'),
    entrySource: {
      displayName: item.resource?.displayName ?? name,
      ...(item.resource?.description !== undefined ?
              {description: item.resource.description} :
              {}),
    },
    aspects,
  };
}


// Where `saved` does not hold what `sent` holds, as a message naming the
// path, or undefined when it does. A value `sent` leaves out is not compared,
// so a value the view derives may be left out.
function firstDifference(sent: unknown, saved: unknown, at: string): string|
    undefined {
  if (sent === undefined) return undefined;
  if (Array.isArray(sent)) {
    if (!Array.isArray(saved) || saved.length !== sent.length) {
      return differs(at, sent, saved);
    }
    for (let i = 0; i < sent.length; i++) {
      const d = firstDifference(sent[i], saved[i], `${at}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (sent !== null && typeof sent === 'object') {
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
      return differs(at, sent, saved);
    }
    for (const [key, value] of Object.entries(sent)) {
      const d = firstDifference(
          value, (saved as Record<string, unknown>)[key], `${at}.${key}`);
      if (d) return d;
    }
    return undefined;
  }
  return sent === saved ? undefined : differs(at, sent, saved);
}


function differs(at: string, sent: unknown, saved: unknown): string {
  return `${at}: ${JSON.stringify(sent)} would be saved as ${
      saved === undefined ? 'nothing' : JSON.stringify(saved)}`;
}
