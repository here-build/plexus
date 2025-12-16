export const models = {
  key: "models",
  wellKnown: {
    root: "root",
  },
  recordFields: {
    type: "type",
    parent: "parent",
    fields: "fields",
  },
} as const;

export const metadata = {
  key: "metadata",
  wellKnown: {
    documentId: "id",
    version: "version",
  },
} as const;

export const dependencies = {
  key: "dependencies",
};
