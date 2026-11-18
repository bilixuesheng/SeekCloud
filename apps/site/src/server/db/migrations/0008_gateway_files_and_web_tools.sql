CREATE TABLE "model_files" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"user_id" uuid,
	"session_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_tool_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"session_id" uuid,
	"turn_id" uuid,
	"tool" text NOT NULL,
	"provider" text,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_files" ADD CONSTRAINT "model_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_files" ADD CONSTRAINT "model_files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_tool_usage" ADD CONSTRAINT "web_tool_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_tool_usage" ADD CONSTRAINT "web_tool_usage_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_files_session" ON "model_files" USING btree ("session_id","uploaded_at");--> statement-breakpoint
CREATE INDEX "web_tool_usage_session" ON "web_tool_usage" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "web_tool_usage_at" ON "web_tool_usage" USING btree ("created_at");