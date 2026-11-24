-- 内置的 DeepSeek 存的名字改成空的，界面按语言写"DeepSeek 官方"/"DeepSeek"（#136）。只改没被改过名字的。
UPDATE "model_providers" SET "name" = '' WHERE "slug" = 'deepseek' AND "name" = 'DeepSeek 官方';
