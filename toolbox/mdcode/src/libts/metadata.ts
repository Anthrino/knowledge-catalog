// Defines metadata objects provided by the catalog snapshot
//

export interface Aspect {
  [key: string]: any;
}

export interface Entry {
  name: string;
  type: string;
  resource: {
    name?: string;
    displayName?: string;
    description?: string;
    labels?: Record<string, string>;
    location?: string;
    parent?: string;
    ancestors?: {
      name: string;
      type: string;
    }[];
    createTime?: string;
    updateTime?: string;
  };
  aspects?: Record<string, Aspect>;
}

// The outcome of one item of a call that saves or deletes several entries.
// Results come in the order of the items. `name` is the name the item used,
// or, for an entry the call created, the name the layout gave it; `error`
// says why an item failed and is absent when it succeeded.
export interface EntryResult {
  name: string;
  ok: boolean;
  error?: string;
}
