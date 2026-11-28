CREATE TABLE "library_plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"version" text,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_plugins_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "library_skills" ADD COLUMN "plugin_slug" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "plugin_slug" text;--> statement-breakpoint
ALTER TABLE "library_skills" ADD CONSTRAINT "library_skills_plugin_slug_library_plugins_slug_fk" FOREIGN KEY ("plugin_slug") REFERENCES "public"."library_plugins"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_plugin_slug_library_plugins_slug_fk" FOREIGN KEY ("plugin_slug") REFERENCES "public"."library_plugins"("slug") ON DELETE cascade ON UPDATE no action;