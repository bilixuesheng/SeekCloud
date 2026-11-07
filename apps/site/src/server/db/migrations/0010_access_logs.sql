CREATE TYPE "public"."access_event" AS ENUM('register', 'login', 'session_start', 'message');--> statement-breakpoint
CREATE TABLE "access_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"deleted_account" uuid,
	"event" "access_event" NOT NULL,
	"network" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_logs_user" ON "access_logs" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "access_logs_at" ON "access_logs" USING btree ("at");