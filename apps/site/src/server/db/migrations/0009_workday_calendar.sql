CREATE TABLE "workday_overrides" (
	"date" date PRIMARY KEY NOT NULL,
	"is_off_day" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
