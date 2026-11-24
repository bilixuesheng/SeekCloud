-- 目录里几个提供方的名字改存英文正式名称，中文界面由浏览器换回中文名（#136）。只改没被改过名字的。
UPDATE "model_providers" SET "name" = 'Kimi (Moonshot)' WHERE "slug" = 'moonshotai' AND "name" = 'Kimi（Moonshot）';--> statement-breakpoint
UPDATE "model_providers" SET "name" = 'Kimi (Moonshot China)' WHERE "slug" = 'moonshotai-cn' AND "name" = 'Kimi（Moonshot 中国）';--> statement-breakpoint
UPDATE "model_providers" SET "name" = 'Zhipu GLM (Z.ai)' WHERE "slug" = 'zai' AND "name" = '智谱 GLM（Z.ai）';--> statement-breakpoint
UPDATE "model_providers" SET "name" = 'Zhipu GLM (China)' WHERE "slug" = 'zai-coding-cn' AND "name" = '智谱 GLM（中国）';--> statement-breakpoint
UPDATE "model_providers" SET "name" = 'MiniMax (China)' WHERE "slug" = 'minimax-cn' AND "name" = 'MiniMax（中国）';--> statement-breakpoint
UPDATE "model_providers" SET "name" = 'Xiaomi MiMo' WHERE "slug" = 'xiaomi' AND "name" = '小米 MiMo';
