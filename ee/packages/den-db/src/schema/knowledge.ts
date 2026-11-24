import { index, int, mediumtext, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * The org knowledge base. A document is split into chunks; who can read a
 * document, and any one chunk of it, is decided by access policy rules of kind
 * `knowledge_document` and `knowledge_chunk`, so the same principals (member,
 * team, role, org), deny-wins order, expiry and audit apply.
 *
 * Like qm's memory records, each chunk carries a sensitivity label:
 * - `ordinary`: readable by everyone who can read the document;
 * - `sensitive`: the same audience, but results are labelled and reads audited;
 * - `restricted`: readable only through an allow rule on the chunk itself.
 * Search runs over the chunks a member may read, never over everything first.
 */
export const knowledgeSensitivityValues = ["ordinary", "sensitive", "restricted"] as const

export const KnowledgeDocumentTable = mysqlTable(
  "knowledge_document",
  {
    id: denTypeIdColumn("knowledgeDocument", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    sourceName: varchar("source_name", { length: 300 }),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
  },
  (table) => [index("knowledge_document_org").on(table.organizationId, table.removedAt)],
)

export const KnowledgeChunkTable = mysqlTable(
  "knowledge_chunk",
  {
    id: denTypeIdColumn("knowledgeChunk", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    documentId: denTypeIdColumn("knowledgeDocument", "document_id").notNull(),
    ordinal: int("ordinal").notNull(),
    heading: varchar("heading", { length: 300 }),
    text: mediumtext("text").notNull(),
    sensitivity: mysqlEnum("sensitivity", knowledgeSensitivityValues).notNull().default("ordinary"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("knowledge_chunk_document").on(table.documentId, table.ordinal)],
)
