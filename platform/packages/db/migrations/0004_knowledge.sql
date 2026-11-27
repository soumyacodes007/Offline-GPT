CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"position" integer NOT NULL,
	"heading" text NOT NULL,
	"body" text NOT NULL,
	"sensitivity" text DEFAULT 'ordinary' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', heading || ' ' || body)) STORED NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_sections" ADD CONSTRAINT "knowledge_sections_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_sections_document_idx" ON "knowledge_sections" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_sections_search_idx" ON "knowledge_sections" USING gin ("search");