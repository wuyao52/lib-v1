# Production operations

## Railway deployment

Use one Railway service for this Node application, one Railway MySQL service, and one private Cloudflare R2 bucket. Set `DATABASE_URL` from the MySQL service reference and keep `APP_ENCRYPTION_KEY` unchanged after the first production deployment. Changing that key makes previously stored system and user API credentials unreadable.

The application creates and migrates its MySQL tables during startup. After deploying, verify `GET /api/health`. A `503` means the database or configured object storage probe failed.

Netlify needs `API_ORIGIN` set to the public Railway HTTPS origin. GitHub pushes trigger the existing Netlify deployment; no manual deployment is required.

## Online payments

Payment callbacks must target Railway directly. Set `PAYMENT_NOTIFY_BASE_URL` to the Railway HTTPS origin, not the Netlify site. Configure at least one complete channel:

- Alipay computer website payment: `ALIPAY_APP_ID`, `ALIPAY_PRIVATE_KEY`, `ALIPAY_PUBLIC_KEY`, `ALIPAY_SELLER_ID`, `ALIPAY_RETURN_URL`.
- WeChat Pay H5 API v3: `WECHAT_PAY_APP_ID`, `WECHAT_PAY_MCH_ID`, `WECHAT_PAY_SERIAL_NO`, `WECHAT_PAY_PRIVATE_KEY`, `WECHAT_PAY_PLATFORM_CERT`, `WECHAT_PAY_API_V3_KEY`.

Use production merchant-platform keys and certificates only in Railway Variables. Multiline PEM values may use literal newlines or escaped `\n`. The WeChat API v3 key must be exactly 32 bytes. Configure the callback URLs and H5 payment domain in the corresponding merchant console.

The site enables a payment button only when that channel has a complete server-side configuration. Balance is credited only after a verified successful callback whose application, merchant, order number, and amount match. Repeated callbacks are idempotent.

System users can inspect `/api/admin/payment-reconciliation`. Any non-empty difference list requires investigation before manual balance adjustment.

## Encrypted backups

Set a dedicated `BACKUP_ENCRYPTION_KEY` of at least 24 characters. Do not reuse `APP_ENCRYPTION_KEY` and do not store the backup key beside backup files.

Create a backup:

```powershell
node scripts/backup-database.mjs --output=D:\secure-backups\ai-drama-2026-08-09.json
```

Restore during a maintenance window after taking a fresh backup:

```powershell
node scripts/restore-database.mjs --input=D:\secure-backups\ai-drama-2026-08-09.json --confirm-restore
```

Restore validates AES-GCM authentication and the plaintext SHA-256 checksum before changing data. Keep Railway application replicas stopped during restore, then restart and verify `/api/health`, login, balances, projects, and `/api/admin/payment-reconciliation`.

## Routine checks

- Monitor `/api/admin/metrics` as a system user for queue depth, failures, refunds, completion time, and video archive fallbacks.
- Review `/api/admin/audit-logs` for system API key reveal attempts and configuration changes.
- Run an encrypted backup daily and perform a restore drill into a separate database at least monthly.
- Rotate any credential that has appeared in chat, logs, screenshots, source history, or browser-visible environment variables.
