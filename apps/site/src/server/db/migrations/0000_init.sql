CREATE TYPE "public"."access_event" AS ENUM('register', 'login', 'session_start', 'message');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('pending', 'building', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."identity_provider" AS ENUM('github');--> statement-breakpoint
CREATE TYPE "public"."network_access" AS ENUM('none', 'default', 'custom', 'full');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('queued', 'running', 'waiting', 'dormant', 'archived', 'failed');--> statement-breakpoint
CREATE TYPE "public"."turn_status" AS ENUM('running', 'completed', 'stopped', 'failed');--> statement-breakpoint
CREATE TABLE "access_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"event" "access_event" NOT NULL,
	"network" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "export_status" DEFAULT 'pending' NOT NULL,
	"size_bytes" integer,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"network_access" "network_access" NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_token" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"subject" text NOT NULL,
	"login" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "identities_provider_subject" UNIQUE("provider","subject"),
	CONSTRAINT "identities_user_provider" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone,
	"used_by" uuid,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invite_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "login_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "pending_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"subject" text NOT NULL,
	"login" text NOT NULL,
	"email" text,
	"github_tokens" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queued_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "queued_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"text" text NOT NULL,
	"model" text,
	"effort" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
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
	"pr_number" integer,
	"pr_state" text,
	"pr_updated_at" timestamp with time zone,
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD CONSTRAINT "login_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queued_messages" ADD CONSTRAINT "queued_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_repos" ADD CONSTRAINT "session_repos_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_logs_user" ON "access_logs" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "access_logs_at" ON "access_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "data_exports_user" ON "data_exports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "login_codes_email_idx" ON "login_codes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "queued_messages_session" ON "queued_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "session_repos_branch" ON "session_repos" USING btree ("branch");--> statement-breakpoint
CREATE INDEX "sessions_user_updated_idx" ON "sessions" USING btree ("user_id","updated_at");