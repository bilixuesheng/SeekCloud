package cn.seekcloud.app.net

/**
 * App 发给主站的每个请求带的 User-Agent（#123）：App 的标记、版本和系统版本，主站据此认出是 App。
 * 不带设备型号、不带别的能认出人的信息。
 */
fun userAgent(appVersion: String, sdkInt: Int): String = "SeekCloudAndroid/$appVersion (Android API $sdkInt)"
