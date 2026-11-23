-- 取不出短标题的置顶改成存空的，界面按语言写"置顶的消息"（#136）。
UPDATE "message_pins" SET "title" = '' WHERE "title" = '置顶的消息';
