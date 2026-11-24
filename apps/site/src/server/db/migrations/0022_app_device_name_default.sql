-- App 登录时没给设备名，以前存的是中文的默认名，改存空的，界面按语言显示（#205）。
UPDATE "login_sessions" SET "device_name" = NULL WHERE "client" = 'app' AND "device_name" = '安卓设备';
