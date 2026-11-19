ALTER TABLE "login_sessions" ADD COLUMN "client" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD COLUMN "last_ip" text;