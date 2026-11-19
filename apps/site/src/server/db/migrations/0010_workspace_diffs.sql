CREATE TABLE "workspace_diffs" (
	"session_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"turn" integer NOT NULL,
	"body" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_diffs_session_id_repo_pk" PRIMARY KEY("session_id","repo")
);
--> statement-breakpoint
ALTER TABLE "workspace_diffs" ADD CONSTRAINT "workspace_diffs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;