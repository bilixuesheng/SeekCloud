CREATE TYPE "public"."session_status" AS ENUM('queued', 'running', 'waiting', 'dormant', 'archived', 'failed');--> statement-breakpoint
CREATE TYPE "public"."turn_status" AS ENUM('running', 'completed', 'stopped', 'failed', 'paused');--> statement-breakpoint
CREATE TABLE "session_events" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"turn" integer,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "session_repos" (
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"full_name" text NOT NULL,
	"base_branch" text NOT NULL,
	"branch" text NOT NULL,
	"access" text NOT NULL,
	CONSTRAINT "session_repos_session_id_position_pk" PRIMARY KEY("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "session_status" NOT NULL,
	"status_detail" text,
	"environment_id" uuid,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_short_id_unique" UNIQUE("short_id")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"input" text NOT NULL,
	"status" "turn_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "turns_session_number" UNIQUE("session_id","number")
);
--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_repos" ADD CONSTRAINT "session_repos_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_updated_idx" ON "sessions" USING btree ("user_id","updated_at");