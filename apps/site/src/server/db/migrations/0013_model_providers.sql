CREATE TABLE "provider_models" (
	"provider_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"name" text,
	"context_window" integer,
	"max_tokens" integer,
	"input" jsonb NOT NULL,
	"reasoning_efforts" jsonb,
	"compat" jsonb,
	"position" integer NOT NULL,
	CONSTRAINT "provider_models_provider_id_model_id_pk" PRIMARY KEY("provider_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "base_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "kind" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "api" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "api_key_env" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "position" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "custom_models" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 内置的 DeepSeek 官方（#113）：原来填 key 时才建这一行，现在总是有；地址为空就是官方的默认地址。
INSERT INTO "model_providers" ("slug", "name", "kind", "base_url", "created_at")
VALUES ('deepseek', 'DeepSeek 官方', 'deepseek', NULL, now())
ON CONFLICT ("slug") DO UPDATE SET "kind" = 'deepseek', "base_url" = NULL;--> statement-breakpoint
-- 会话、排队的消息、设置里记的模型改成"提供方/模型"；原来的都是 DeepSeek 官方的。
UPDATE "sessions" SET "model" = 'deepseek/' || "model" WHERE position('/' in "model") = 0;--> statement-breakpoint
UPDATE "queued_messages" SET "model" = 'deepseek/' || "model" WHERE "model" IS NOT NULL AND position('/' in "model") = 0;--> statement-breakpoint
UPDATE "settings" SET "value" = to_jsonb('deepseek/' || ("value" #>> '{}'))
WHERE "key" = 'platform_model' AND jsonb_typeof("value") = 'string'
  AND "value" #>> '{}' <> 'auto' AND position('/' in "value" #>> '{}') = 0;
