CREATE TABLE "message_pins" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"title" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "message_pins_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "message_pins_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;