ALTER TABLE "session_repos" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "session_repos" ADD COLUMN "pr_state" text;--> statement-breakpoint
ALTER TABLE "session_repos" ADD COLUMN "pr_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "session_repos_branch" ON "session_repos" USING btree ("branch");