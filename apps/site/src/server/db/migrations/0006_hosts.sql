CREATE TABLE "hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"protocol" integer,
	"version" text,
	"instance" text,
	"last_received_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "hosts_name_unique" UNIQUE("name"),
	CONSTRAINT "hosts_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "host_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE set null ON UPDATE no action;