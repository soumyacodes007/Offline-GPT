CREATE TABLE "mcp_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"url" text NOT NULL,
	"header_name" text,
	"header_value_sealed" text,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connections_slug_unique" UNIQUE("slug")
);
