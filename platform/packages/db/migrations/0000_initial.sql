CREATE TABLE "access_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"effect" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_ref" text,
	"expires_at" timestamp with time zone,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "members_email_unique" UNIQUE("email"),
	CONSTRAINT "members_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "team_members_team_id_member_id_pk" PRIMARY KEY("team_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_name_unique" UNIQUE("name"),
	CONSTRAINT "teams_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_rules_kind_idx" ON "access_rules" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "sessions_member_idx" ON "sessions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "team_members_member_idx" ON "team_members" USING btree ("member_id");