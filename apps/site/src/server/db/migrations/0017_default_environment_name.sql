-- 默认环境的名字改成存空的，界面按语言显示"默认环境"（#136）。只改没被改过名字的。
UPDATE "environments" SET "name" = '' WHERE "is_default" = true AND "name" = '默认环境';
