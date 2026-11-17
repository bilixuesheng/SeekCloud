CREATE TABLE "example_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"body" text NOT NULL
);
