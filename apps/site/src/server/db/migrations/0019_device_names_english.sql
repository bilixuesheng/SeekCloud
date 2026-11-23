-- 登录设备的名字里浏览器改用英文正式名称（#136：服务端不存现成的中文）。
UPDATE "login_sessions" SET "device_name" = replace("device_name", '微信', 'WeChat') WHERE "device_name" LIKE '微信%';--> statement-breakpoint
UPDATE "login_sessions" SET "device_name" = replace("device_name", 'QQ 浏览器', 'QQ Browser') WHERE "device_name" LIKE 'QQ 浏览器%';--> statement-breakpoint
UPDATE "login_sessions" SET "device_name" = replace("device_name", 'UC 浏览器', 'UC Browser') WHERE "device_name" LIKE 'UC 浏览器%';--> statement-breakpoint
UPDATE "login_sessions" SET "device_name" = replace("device_name", '华为浏览器', 'Huawei Browser') WHERE "device_name" LIKE '华为浏览器%';
