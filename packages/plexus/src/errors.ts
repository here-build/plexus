import { PlexusModel } from "./PlexusModel.js";

abstract class PlexusError extends Error {
  name = this.constructor.name;

  protected constructor(message: string, consoleMessage: string, consoleData: object) {
    super(message);
    // Maintain proper stack trace for where error was thrown
    // some weird browsers may not have captureStackTrace so let's not crash inside crash.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    Error.captureStackTrace?.(this, this.constructor);
    setTimeout(() => {
      console.error(this, consoleMessage, {
        ...consoleData,
        stack: this.stack,
      });
    });
  }

  static invariant<T extends new (...args: any) => any>(
    this: T,
    condition: boolean,
    ...args: ConstructorParameters<T>
  ): asserts condition {
    if (!condition) throw new this(...args);
  }
}

export class PlexusSelfAdoptionError extends PlexusError {
  constructor(
    public readonly entity: PlexusModel,
    public readonly field: string,
  ) {
    super(
      `Plexus<${entity.__type__}#${entity.uuid}>: cannot adopt self (via ${field})`,
      "Self-adoption attempt detected:",
      {
        entity: `${entity.__type__}#${entity.uuid}`,
        field,
        currentParent: entity.parent ? `${entity.parent.__type__}#${entity.parent.uuid}` : null,
      },
    );
  }
}

export class PlexusCycleError extends PlexusError {
  constructor(
    public readonly child: PlexusModel,
    public readonly newParent: PlexusModel,
    public readonly field: string,
    public readonly cycleNode: PlexusModel,
  ) {
    super(
      `Plexus<${child.__type__}#${child.uuid}>: cannot be adopted by descendant ${newParent.__type__}#${newParent.uuid} (would create cycle via ${field})`,
      "Cycle detected during adoption:",
      {
        child: `${child.__type__}#${child.uuid}`,
        newParent: `${newParent.__type__}#${newParent.uuid}`,
        field,
        cycleNode: `${cycleNode.__type__}#${cycleNode.uuid}`,
        currentParent: child.parent ? `${child.parent.__type__}#${child.parent.uuid}` : null,
      },
    );
  }
}

export class PlexusDependencyError extends PlexusError {
  constructor(
    public readonly entity: PlexusModel,
    public readonly operation: "adopted" | "edited" | "orphaned" | "emancipated" | "accessed",
  ) {
    super(
      `Plexus<${entity.__type__}#${entity.uuid}>: dependency cannot be ${operation}`,
      "Dependency modification attempt:",
      {
        entity: `${entity.__type__}#${entity.uuid}`,
        operation,
        isDependency: entity.__internals__.isDependency,
      },
    );
  }
}

export class PlexusRootParentError extends PlexusError {
  constructor(
    public readonly rootEntity: PlexusModel,
    public readonly attemptedParent: PlexusModel,
  ) {
    super(
      `Plexus<${rootEntity.__type__}#root>: root entity cannot have a parent`,
      "Root entity parent assignment attempt:",
      {
        rootEntity: `${rootEntity.__type__}#${rootEntity.uuid}`,
        attemptedParent: `${attemptedParent.__type__}#${attemptedParent.uuid}`,
        isRoot: rootEntity.uuid === "root",
      },
    );
  }
}

export class PlexusDocMismatchError extends PlexusError {
  constructor(
    public readonly child: PlexusModel,
    public readonly newParent: PlexusModel,
  ) {
    super(
      `Plexus<${child.__type__}#${child.uuid}>: cannot adopt entity from different doc`,
      "Document mismatch during adoption:",
      {
        child: `${child.__type__}#${child.uuid}`,
        childDoc: child.__doc__?.clientID,
        newParent: `${newParent.__type__}#${newParent.uuid}`,
        parentDoc: newParent.__doc__?.clientID,
      },
    );
  }
}

export class PlexusDuplicateChildError extends PlexusError {
  constructor(
    public readonly parent: PlexusModel,
    public readonly field: string,
    public readonly child: PlexusModel,
    public readonly operation: string,
  ) {
    super(
      `Plexus<${parent.__type__}#${parent.uuid}.${field}>: ${operation} cannot insert the same child multiple times`,
      "Duplicate child insertion attempt:",
      {
        parent: `${parent.__type__}#${parent.uuid}`,
        field,
        child: `${child.__type__}#${child.uuid}`,
        operation,
        childCurrentParent: child.parent ? `${child.parent.__type__}#${child.parent.uuid}` : null,
      },
    );
  }

  /**
   * Checks an iterable for duplicate PlexusModel instances.
   * Throws if a duplicate is found.
   *
   * @param items Iterable of items to check for duplicates
   * @param parent Parent entity that would contain the items
   * @param field Field name where items would be stored
   * @param operation Name of the operation being performed
   */
  static uniquenessInvariant<T>(items: Iterable<T>, parent: PlexusModel, field: string, operation: string): void {
    const seen = new Set<T>();
    for (const item of items) {
      if (item instanceof PlexusModel) {
        this.invariant(!seen.has(item), parent, field, item, operation);
        seen.add(item);
      }
    }
  }
}
