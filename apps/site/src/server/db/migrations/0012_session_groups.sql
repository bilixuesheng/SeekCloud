CREATE TABLE "session_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_key" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sort_key" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_groups" ADD CONSTRAINT "session_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_groups_user" ON "session_groups" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_group_id_session_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."session_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- 已有的会话照原来的顺序：置顶的按置顶时间（后置顶的在前），其余按最近有动静的时间
UPDATE "sessions" SET "sort_key" = floor(extract(epoch from coalesce("pinned_at", "updated_at")) * 1000);
