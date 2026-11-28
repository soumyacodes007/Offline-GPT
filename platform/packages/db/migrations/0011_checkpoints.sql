CREATE TABLE "workspace_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"file" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_checkpoints_file_unique" UNIQUE("file")
);
--> statement-breakpoint
ALTER TABLE "workspace_checkpoints" ADD CONSTRAINT "workspace_checkpoints_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_checkpoints_member_idx" ON "workspace_checkpoints" USING btree ("member_id","created_at");