export const models = {
  key: "models",
  wellKnown: {
    root: "root",
  },
  recordFields: {
    parent: "parent", // kept as constant for test assertions; actual storage is child XmlElement
  },
} as const;

export const typeIndex = {
  key: "typeIndex",
} as const;

export const dependencies = {
  key: "dependencies",
};
