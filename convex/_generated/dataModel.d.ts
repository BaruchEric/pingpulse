/* eslint-disable */
/**
 * Generated data model types.
 *
 * Normally produced by `npx convex dev`. Committed here because this environment
 * cannot reach Convex's deployment host to run codegen. Regenerate with
 * `npx convex dev` once connected to a deployment.
 */
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;

export type TableNames = TableNamesInDataModel<DataModel>;

export type Doc<TableName extends TableNames> = DocumentByName<
  DataModel,
  TableName
>;

export type Id<TableName extends TableNames | SystemTableNames> =
  GenericId<TableName>;
