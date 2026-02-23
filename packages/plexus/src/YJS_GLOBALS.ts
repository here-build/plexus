export const models = {
  key: "models",
  wellKnown: {
    root: "root",
  },
  recordFields: {
    parent: "parent", // kept as constant for test assertions; actual storage is child XmlElement
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
