## Querying

```typescript
// Load entity by UUID (singleton — always same instance guarantee)
const project = plexus.loadEntity<Project>(uuid);

// Get all materialized instances of a model type
const allProjects = plexus.getAllOfType(Project);

// Reverse lookup: find all parents of a node through a specific field
for (const project of plexus.parentsOf(page, Project, "pages")) {
  // yields Project instances whose .pages contains page
}
```

**`parentsOf` is a generator.** For child fields it yields at most one result (ownership is exclusive);
for reference fields it yields all matches.
