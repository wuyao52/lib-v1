# 外部监控与微信支付上线

## 1. 外部可用性监控

在 Better Stack、UptimeRobot 或 Railway Healthcheck 创建一个 HTTPS 检查：

- URL：`https://你的 Railway 域名/api/health`
- 期望状态：`200`
- 间隔：5 分钟
- 失败通知：配置为你的邮箱、钉钉或企业微信机器人。

当数据库或对象存储异常时，此接口会返回 `503`，不会泄露连接字符串、密钥或用户数据。

## 2. 主动告警 Webhook

部署到 Railway 的 Variables：

```text
ALERT_WEBHOOK_URL=https://你的告警平台/webhook
ALERT_WEBHOOK_SECRET=至少24位随机字符串
MONITORING_INTERVAL_MINUTES=5
ALERT_QUEUE_BACKLOG=25
ALERT_FAILURE_RATE=0.2
ALERT_FAILURE_MIN_COUNT=2
```

服务会在队列积压或失败率首次跨过阈值时发送 `operations.alert`；恢复后发送 `operations.recovered`。请求头 `x-ai-drama-signature` 是对原始 JSON body 的 `HMAC-SHA256`，接收端必须验证它。相同状态不会反复推送。

## 3. 微信支付 H5 上线

你需要先完成微信支付商户平台开户、开通 H5 支付并绑定你的真实业务域名。然后在 Railway Variables 添加以下值，值只保存在 Railway，绝不能发送到前端、GitHub 或聊天窗口：

```text
PAYMENT_NOTIFY_BASE_URL=https://你的 Railway 公网域名
WECHAT_PAY_APP_ID=微信公众号或移动应用 AppID
WECHAT_PAY_MCH_ID=微信支付商户号
WECHAT_PAY_SERIAL_NO=商户 API 证书序列号
WECHAT_PAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
WECHAT_PAY_PLATFORM_SERIAL_NO=微信支付平台证书序列号
WECHAT_PAY_PLATFORM_CERT="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
WECHAT_PAY_API_V3_KEY=恰好32个字符的APIv3密钥
```

在微信商户平台配置通知地址：

```text
https://你的 Railway 公网域名/api/payments/callback/wechat
https://你的 Railway 公网域名/api/payments/callback/wechat-refund
```

商户 API 证书序列号和平台证书序列号不是同一个值。配置后先使用微信支付沙箱或小额真实订单验证：创建 H5 订单、支付、等待回调、确认用户余额仅增加一次，再在管理后台做一次退款验证。

## 4. 支付宝底座

支付宝实现保持关闭，直到配置完整的 `ALIPAY_APP_ID`、应用私钥、支付宝公钥、卖家账号、通知地址和同步跳转地址。缺少任一值时前端不会允许创建支付宝订单。
