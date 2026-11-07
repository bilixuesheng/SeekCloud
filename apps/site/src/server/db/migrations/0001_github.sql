CREATE TYPE "public"."identity_provider" AS ENUM('github', 'google');--> statement-breakpoint
CREATE TABLE "github_pending_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" text NOT NULL,
	"login" text NOT NULL,
	"email" text NOT NULL,
	"access_token" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_token" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
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
ALTER TABLE "github_tokens" ADD CONSTRAINT "github_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;