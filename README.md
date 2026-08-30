# AI Drama Studio - AI短剧生成工作台

## Production operations

The web and scheduled maintenance processes share one deployment artifact and
select their entry point through `PROCESS_MODE`:

```env
PROCESS_MODE=web
PROCESS_MODE=maintenance
PROCESS_MODE=mysql-restore-drill
```

Run `maintenance` as a dedicated Railway Cron service with schedule
`0 2 * * *` (02:00 UTC, 10:00 Asia/Shanghai). The job migrates legacy MySQL
Base64 assets to the configured object storage before clearing the database
copy, removes expired unreferenced assets and generated media, and creates an
encrypted database backup. A failed object upload leaves the original MySQL
asset untouched. The same job can be run once with `npm run maintenance:once`.

Use `npm run backup:mysql-drill` or the `mysql-restore-drill` process mode for
a full restore exercise. It restores the newest encrypted object-storage
backup into a randomly named temporary MySQL database, compares every restored
collection, starts the application against that database, requires an HTTP 200
health response, and then drops the temporary database. It never restores over
the production database.

Operational alerts use `ALERT_WEBHOOK_URL`, the configured Resend/SMTP mail
transport, or both. Mail recipients are the current system users plus optional
comma-separated `ALERT_EMAIL_RECIPIENTS`. Set `ALERT_TEST_ON_START=true` for a
single production delivery test, confirm `Monitoring test completed` in the
service log, and remove the variable immediately so later restarts do not send
duplicate tests. `/api/health` reports enabled channels without exposing
addresses, credentials, application data, or prompt contents.

Alert delivery is transition-based: an initially healthy service is silent,
the first unhealthy state is delivered immediately, an unchanged alert is
reminded at most once per `ALERT_REPEAT_HOURS` (24 hours by default), and a
recovery is delivered once. `ALERT_TEST_ON_START` is additionally locked to
one test message per Railway deployment, even if its container restarts.

`GET /api/health` checks the live database, object storage and queue. The
deeper `GET /api/health/operations` probe returns HTTP 503 when queue pressure,
backup freshness or restore-drill freshness is outside policy, without
exposing backup contents or credentials. Run a non-mutating production check
after every backend deployment:

```bash
SMOKE_BASE_URL=https://your-backend.example.com npm run smoke:production
```

The smoke check verifies both health probes, security and cache headers, two
different server-side captchas, and 20 concurrent health requests. Production
uses a separate `restore-drill-cron` Railway service with schedule
`0 3 1 * *` (the first day of each month at 03:00 UTC / 11:00 Asia/Shanghai).
Set `ALERT_RESTORE_DRILL_MAX_AGE_HOURS=840` on the web service so a missed or
failed monthly restore raises an operational alert independently of backups.

一个基于无限画布的 AI 短剧生成工作台，支持使用文字、图片和视频生成 AI 短剧。

## 当前架构

- React + Vite 画布前端
- Node.js + Express 服务端
- `scrypt` 密码哈希与 HttpOnly Cookie 会话
- 按账户隔离的 Skill 数据与本地项目命名空间
- 基于 Seedance 2.0 sequence workflow 的导演模式

## 本地运行

```bash
npm install
npm run dev
```

前端默认运行在 `http://localhost:3000`，服务端默认运行在 `http://127.0.0.1:8787`。

生产运行：

```bash
npm run build
npm start
```

生产服务会同时提供 `/api/*` 与 `dist/` 前端资源。服务端运行数据位于 `server/data/`，部署时应挂载持久卷并限制文件访问权限。

### Netlify 前端 + 独立 Node 后端

Netlify 只负责静态前端和同源 API 代理，不能直接保存当前基于文件的用户、会话和验证码数据库。请将 Node/Express 服务部署到带持久化磁盘的主机，然后在 Netlify 项目环境变量中设置：

```env
API_ORIGIN=https://your-node-backend.example.com
```

Node 后端环境变量应至少包含：

```env
NODE_ENV=production
APP_ORIGINS=https://lib-v1-1.netlify.app
DATA_DIR=/var/data
DATABASE_URL=${{MySQL.MYSQL_URL}}
RESEND_API_KEY=re_your_api_key
EMAIL_FROM="AI Drama Studio <register@your-verified-domain.example>"
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET=ai-drama-assets
ASSET_USER_QUOTA_BYTES=2147483648
ASSET_RETENTION_DAYS=30
ASSET_DIRECT_UPLOAD_LIMIT=300
GENERATED_VIDEO_MAX_BYTES=1073741824
VIDEO_QUEUE_GLOBAL_CONCURRENCY=20
VIDEO_QUEUE_USER_CONCURRENCY=20
VIDEO_QUEUE_API_CONCURRENCY=20
VIDEO_QUEUE_POLL_CONCURRENCY=20
VIDEO_QUEUE_MAX_PENDING_PER_USER=50
VIDEO_QUEUE_TASK_TIMEOUT_MINUTES=60
VIDEO_QUEUE_HISTORY_DAYS=7
VIDEO_QUEUE_LEASE_SECONDS=120
```

Netlify 会将 `/api/auth/*`、`/api/director/*`、`/api/skills/*` 与 `/api/projects/*` 转发到该后端，因此验证码和 HttpOnly 会话 Cookie 仍使用 Netlify 的同源地址。后端部署命令为 `npm ci && npm run build`，启动命令为 `npm start`。不要只部署 `dist/`，也不要把密钥写入 `.env.example` 或 `VITE_*` 浏览器变量。

生产环境配置 `DATABASE_URL` 后，服务端会自动创建 MySQL 表并将用户、会话、验证码、Skill 和项目写入云数据库。密码始终使用 `scrypt` 哈希保存；项目中的模型 API Key 会在写库前清空，只保留在当前浏览器会话中。未配置 `DATABASE_URL` 时仅使用本地 JSON 存储，供开发和自动测试使用。

### Cloudflare R2 素材存储

在 Cloudflare 控制台进入 `R2 Object Storage`，创建存储桶（例如 `ai-drama-assets`），然后进入 `Manage R2 API Tokens` 创建仅限该存储桶的 `Object Read & Write` Token。将页面给出的 Account ID、Access Key ID、Secret Access Key 和存储桶名称分别填写到 Railway Variables：

```env
R2_ACCOUNT_ID=你的Account ID
R2_ACCESS_KEY_ID=你的Access Key ID
R2_SECRET_ACCESS_KEY=你的Secret Access Key
R2_BUCKET=ai-drama-assets
ASSET_USER_QUOTA_BYTES=2147483648
ASSET_RETENTION_DAYS=30
```

四个 `R2_*` 变量必须同时配置。重新部署 Railway 后，新图片写入 R2，MySQL 的 `assets` 表只保存对象 Key、哈希、类型、大小和用户归属；旧 Base64 素材仍可读取，并在再次上传相同素材时迁移到 R2。未配置 R2 时保留数据库存储兼容模式。`ASSET_USER_QUOTA_BYTES` 可选，默认每个用户 2 GiB。`ASSET_RETENTION_DAYS` 默认是 30，仅自动删除超过保留期且未被项目或有效生成历史引用的素材；服务端每 6 小时检查一次，打开云端素材管理时也会立即检查。`ASSET_DIRECT_UPLOAD_LIMIT` 默认每个用户每小时 300 次（可配置范围 60-10000），只限制直传申请次数。

### 阿里云 OSS 素材存储（国内支付推荐）

不使用 R2 时，可在阿里云 OSS 创建**私有** Bucket，并创建只对该 Bucket 有读写权限的 RAM 用户 AccessKey。不要同时填写任何 `R2_*` 变量。Railway Variables 填写：

```env
OSS_REGION=cn-hangzhou
OSS_ACCESS_KEY_ID=RAM 用户的 AccessKey ID
OSS_ACCESS_KEY_SECRET=RAM 用户的 AccessKey Secret
OSS_BUCKET=ai-drama-assets
# 可留空；默认使用 https://oss-cn-hangzhou.aliyuncs.com
OSS_ENDPOINT=
```

`OSS_REGION` 必须与 Bucket 所在地域一致，例如华东 1（杭州）使用 `cn-hangzhou`。不需要开放 Bucket 公共读；应用会通过自身的受控素材接口读取文件。该配置同样用于素材、生成视频归档与加密数据库备份。数据库内的旧 Base64 素材可继续读取；如果生产环境已有 R2 对象，请先完成对象迁移，再移除 `R2_*` 配置，避免旧对象不可访问。

生产环境可在已绑定 Railway 项目的本地目录执行 `npx @railway/cli run npm run backup:drill`。该命令先刷新 MySQL 全部集合，向 `backups/drills/` 写入一份新的加密备份，再下载同一对象并恢复到操作系统临时目录，逐集合核对后删除本地临时目录；它不会覆盖或修改生产数据库。成功输出只包含对象 Key、校验值和集合行数，不包含用户内容或密钥。

如果生产数据库只开放 Railway 私网且本地无法直连，可临时设置 `BACKUP_DRILL_ON_START=true` 并重新部署后端。服务启动后会在后台执行同一套隔离演练并把脱敏结果写入部署日志；确认 `Backup drill completed` 后必须删除该变量并再次部署，避免以后每次重启重复生成演练备份。

数据库备份使用 `ai-drama-studio-backup-v2`：原始 JSON 先 gzip 压缩，再使用独立的 `BACKUP_ENCRYPTION_KEY` 进行 AES-GCM 加密；恢复代码继续兼容旧 v1 对象。维护任务默认使用 30 分钟数据库共享锁，避免多实例或反复触发产生重复备份；对象上传和下载各有 15 分钟超时。建议在 Railway Variables 明确配置：

```env
BACKUP_ENCRYPTION_KEY=与其他密钥不同的高强度随机值
MAINTENANCE_LOCK_MINUTES=30
BACKUP_RETENTION_DAYS=30
BACKUP_MINIMUM_COPIES=7
ALERT_BACKUP_MAX_AGE_HOURS=12
```

系统用户可以在“系统管理控制台 → 生产备份与恢复演练”查看对象 Key、大小、时间、保留策略和脱敏事件。手动演练必须再次输入当前系统账号密码，接口立即返回仅表示后台任务已接受；只有出现“恢复演练验证完成”事件才算成功。该页面不会返回备份正文、数据库内容、下载地址或任何密钥。

生产环境应使用 Railway Cron 或独立 maintenance service 定时执行维护，不要依赖前端访问触发。欧洲 Railway 到北京 OSS 的首次真实演练中，约 4.57 MB 的旧 v1 对象上传耗时约 394.8 秒；本轮 v2 生产对象由 `4,572,108` 降至 `4,542,417` bytes（约 0.65%），上传约 188.2 秒、下载约 4.27 秒，19 个集合恢复一致。生产数据包含大量已压缩素材，gzip 收益有限；跨境延迟仍然明显。若持续使用北京 OSS，应评估 OSS 传输加速或把后端迁移到更接近中国大陆的区域，并保留 15 分钟传输超时与失败告警。

### 持久化视频任务队列

系统视频模型请求会先写入 MySQL `generation_jobs` 表，再由 Railway 后端按全站、用户和 API 三层并发限制公平提交。浏览器关闭后任务仍会继续，成功结果由后端写入三天生成历史，失败任务只退款一次。临时 `429` 和 `5xx` 会延迟重试；终态队列记录默认保留 7 天。

默认限制为全站同时生成 20 条、单用户最多突发 20 条、单 API 20 条，每个用户最多保留 50 条待处理任务。同一调度批次按用户轮转，MySQL 部署通过 worker 租约避免多个 Replica 重复认领同一任务；上游提交同时携带任务 ID 作为幂等键。可通过上方 `VIDEO_QUEUE_*` 环境变量调整。系统用户可在“系统管理控制台 → 视频任务队列”查看实时状态和当前限制。

## 认证、导演模式与 Skill

- 注册、登录、退出和会话恢复均由服务端验证，密码只保存为带随机盐的 `scrypt` 哈希。
- 会话令牌通过 HttpOnly、SameSite Cookie 传递，数据库只保存令牌摘要。
- 每个用户最多保留 4 个有效登录会话；同一浏览器的普通标签页共享一个会话，不重复计数。超过上限时，新登录会淘汰最早的会话。
- 注册要求发送到注册邮箱的 6 位邮箱验证码；验证码有效期 10 分钟、60 秒内不可重复发送，并限制失败尝试次数。登录使用服务端生成的 5 位数字图片验证码，不发送登录邮件，图片验证码 5 分钟有效且只能使用一次。
- Skill 支持在线创建、编辑以及导入带 frontmatter 的 `SKILL.md`；导入内容只作为创作指令，不执行代码。
- 导演模式采用“全局规划、局部编译”，生成故事终点、场景、连续性锁、镜头合同和 Seedance 自然语言提示词。
- 导演方案支持按镜头顺序一键批量生成视频，每段强制限制为 5-15 秒；生成状态和结果会同步写入画布，并可按分镜顺序连续预览。
- 导演模式可通过选择或拖拽导入 TXT、Markdown、Fountain、JSON、DOC 和 DOCX 剧本文件，单文件上限 10 MB，并支持复制完整导演方案或单个镜头提示词。

### 邮件服务配置

Railway Trial/Hobby 不开放 SMTP 出站连接，应使用 Resend 的 HTTPS API。邮箱验证码不会在未配置邮件服务时降级为控制台输出。在 Resend 验证发件域名、创建 API Key 后，在 Railway Variables 中配置：

```env
RESEND_API_KEY=re_your_api_key
EMAIL_FROM="AI Drama Studio <register@your-verified-domain.example>"
```

`EMAIL_FROM` 必须属于 Resend 中已验证的发件域名。API Key 只填写在 Railway，不能放入 Git、聊天内容或任何 `VITE_*` 变量。修改变量后应重新部署服务。

若部署平台允许 SMTP，也可不设置 `RESEND_API_KEY`，改用以下回退配置：

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_app_password
SMTP_FROM="AI Drama Studio <no-reply@example.com>"
```

使用 QQ 邮箱、163 邮箱等服务时，`SMTP_PASS` 通常应填写邮箱服务商生成的授权码，而不是邮箱登录密码。生产环境必须使用 HTTPS，否则启用 Secure Cookie 后浏览器不会保存会话。

## ✨ 功能特点

### 🎬 项目管理系统
- 创建、打开、删除项目
- 所有视频生成必须在项目中进行
- **自动保存**：项目内容实时自动保存到本地存储
- 支持导出项目为 JSON 文件

### ↩️ 撤销/重做（新功能）
- **撤销**：`Ctrl+Z` 或点击撤销按钮
- **重做**：`Ctrl+Shift+Z` 或 `Ctrl+Y` 或点击重做按钮
- 支持最多 50 步历史记录
- 添加/删除节点、连接边等操作都可撤销

### 🎨 无限画布
- 自由拖拽、缩放，创建你的短剧流程
- 支持框选多个节点进行批量操作
- 自动连接生成的节点

### 🤖 AI 驱动
- 默认使用 DeepSeek V4 Pro 模型
- 支持 Seedance 2.0、Runway、Pika 等多种 AI 模型
- 点击 AI 生成后自动创建新节点并连接
- 实时显示生成进度百分比
- 动画效果展示生成过程
- **视频预览**：生成的视频可直接在节点内播放预览
- **全屏预览**：点击放大按钮可全屏观看视频

### 🎯 智能生成（新功能）
- **拖拽生成**：从节点连接点拖拽到空白区域，弹出生成类型选择
- **视频生成**：根据文字描述生成视频
- **图片生成**：根据文字描述生成图片
- **图生图**：基于原图生成新的图片（需源图片节点）
- **反向提示词**：指定不想出现的内容

### 🧹 去水印功能（新功能）
- 点击右上角「去水印」按钮打开
- 支持图片和视频去水印
- 智能检测并去除水印区域
- AI 自动填充修复

### 🔗 节点引用（新功能）
- 在内容描述或 AI 提示词中使用 `@` 引用其他节点
- 点击「添加引用」按钮选择要引用的节点
- 引用格式：`@[节点名称](节点ID)`
- 点击引用可快速跳转到对应节点

### 📥 下载功能（新功能）
- 视频节点悬停显示**下载按钮**
- 图片节点悬停显示**下载按钮**
- 全屏预览时也有下载按钮
- 一键下载生成的素材

### ⏩ 播放速度控制（新功能）
- 视频节点悬停显示**速度控制按钮**
- 支持 0.5x / 0.75x / 1x / 1.25x / 1.5x / 2x
- 实时调整播放速度

### 📁 文件拖放
- 直接从电脑拖入图片/视频文件到画布
- 支持 JPG、PNG、GIF、MP4、MOV 等格式
- 自动创建对应类型的场景节点

### ⚙️ 灵活配置
- 自定义分辨率、帧率、风格等参数
- 支持多种风格：电影感、动漫风、写实风等
- 配置镜头、光照、情绪等细节

## 🚀 快速开始

### 安装依赖

```bash
npm install
# 或
yarn install
# 或
pnpm install
```

### 启动开发服务器

```bash
npm run dev
# 或
yarn dev
# 或
pnpm dev
```

访问 http://localhost:3000 即可使用。

## 📖 使用指南

### 1. 项目管理

**创建新项目**
1. 在主界面点击「创建新项目」
2. 输入项目名称和描述
3. 点击「创建」进入项目编辑器

**打开已有项目**
- 在主界面点击项目卡片即可打开

**返回项目列表**
- 点击左上角的返回按钮

### 2. 添加场景

**方式一：工具栏添加**
- 点击顶部工具栏的场景类型按钮（文本/图片/视频/音频/转场）

**方式二：文件拖放**
- 直接从电脑文件管理器拖拽图片或视频文件到画布
- 支持格式：JPG、PNG、GIF、MP4、MOV、WebM 等

### 3. AI 生成

**方式一：点击按钮生成**
1. 点击场景节点上的「AI 生成」按钮
2. 系统会自动创建新节点并显示进度

**方式二：拖拽生成（新功能）**
1. 从节点的连接点（右侧圆点）拖拽到空白区域
2. 弹出生成类型选择窗口
3. 选择：视频生成 / 图片生成 / 图生图
4. 输入提示词和设置参数
5. 点击生成按钮

**生成类型说明**
- **视频生成**：根据文字描述生成视频
- **图片生成**：根据文字描述生成图片
- **图生图**：基于原图生成新风格的图片（需要图片节点）

### 4. 去水印（新功能）

1. 点击右上角「去水印」按钮
2. 上传带水印的图片或视频
3. 点击「开始去水印」
4. 等待 AI 处理完成
5. 下载处理后的结果

### 5. 使用@引用

**在节点中引用其他节点：**
1. 点击节点选择
2. 在右侧属性面板中，点击「添加引用」按钮
3. 选择要引用的节点
4. 引用会以 `@[节点名]` 格式插入

**引用的作用：**
- 在内容描述中建立节点间的关联
- 点击引用可快速跳转到被引用的节点
- 便于构建复杂的剧情关系

### 6. 视频播放控制

**播放速度：**
- 鼠标悬停在视频节点上
- 点击速度按钮（显示当前速度）
- 选择所需播放速度

**下载素材：**
- 鼠标悬停在视频/图片节点上
- 点击下载按钮（↓图标）
- 文件会自动下载到本地

### 7. 框选多选

- 点击右上角「框选模式」按钮切换到框选模式
- 在画布上拖拽鼠标创建虚线框选区
- 框选多个节点后可批量操作
- 按住 `Shift` 键点击可添加/移除单个节点

### 5. 连接场景

- 从一个场景的右侧连接点拖拽到另一个场景的左侧连接点
- 创建场景之间的流程关系

### 6. 保存导出

- 点击顶部「保存」按钮保存项目
- 点击「导出」按钮导出为 JSON 文件

## ⚙️ AI 模型配置

支持以下 AI 模型：

| 模型 | 提供商 | 说明 |
|------|--------|------|
| DeepSeek V4 Pro | DeepSeek | 默认模型，高质量文本/视频生成 |
| Seedance 2.0 | Seedance | 高质量视频生成 |
| Runway Gen-3 | Runway | 专业级视频生成 |
| Pika Labs | Pika | 快速视频生成 |
| Kling | Kuaishou | 快手旗下视频生成 |
| Sora | OpenAI | OpenAI 视频生成 |
| 自定义 | Custom | 自定义 API 接口 |

### 配置步骤

1. 点击右上角 CPU 图标打开模型配置面板
2. 选择模型或使用自定义配置
3. 输入 API Key
4. 配置 API 地址（如需要）
5. 点击 "测试连接" 验证配置

### 自动保存功能

项目内容会**自动保存**到浏览器本地存储：
- 添加/删除节点时自动保存
- 修改节点内容时自动保存
- 连接节点时自动保存
- 2 秒防抖延迟，避免频繁保存
- 顶部显示最后保存时间

### 演示模式

如果未配置 API Key，系统会自动使用演示模式：
- 使用示例视频/图片进行生成演示
- 模拟真实的生成进度
- 生成完成后可预览示例内容

## 🎯 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Z` | 撤销 |
| `Ctrl+Shift+Z` | 重做 |
| `Ctrl+Y` | 重做（备用） |
| `Ctrl+S` | 保存项目 |
| `Shift` + 点击 | 多选节点 |
| `Shift` + 拖拽 | 框选模式下框选节点 |
| 滚轮 | 缩放画布 |
| 右键拖拽 | 平移画布 |

## 🛠️ 技术栈

- **前端框架**: React 18 + TypeScript
- **构建工具**: Vite
- **样式**: Tailwind CSS
- **无限画布**: @xyflow/react (React Flow)
- **状态管理**: Zustand
- **动画**: Framer Motion
- **图标**: Lucide React
- **本地存储**: localStorage

## 📁 项目结构

```
ai-drama-studio/
├── public/              # 静态资源
├── src/
│   ├── components/      # React 组件
│   │   ├── Canvas.tsx           # 无限画布（支持文件拖放、框选、拖拽生成）
│   │   ├── SceneNode.tsx        # 场景节点（带进度条、视频预览）
│   │   ├── Toolbar.tsx          # 工具栏
│   │   ├── SettingsPanel.tsx    # 设置面板
│   │   ├── ModelConfigPanel.tsx # AI模型配置
│   │   ├── NodePropertiesPanel.tsx # 节点属性
│   │   ├── ProjectSelector.tsx  # 项目选择界面
│   │   ├── GenerationModal.tsx  # 生成类型选择弹窗
│   │   └── RemoveWatermarkModal.tsx # 去水印弹窗
│   ├── services/        # AI 服务
│   │   └── aiService.ts         # AI API 调用服务
│   ├── store/           # 状态管理
│   │   └── useProjectStore.ts   # 项目状态（含项目管理）
│   ├── types/           # TypeScript 类型
│   │   └── index.ts             # 类型定义
│   ├── App.tsx          # 主应用（项目管理/编辑器切换）
│   ├── main.tsx         # 入口文件
│   └── index.css        # 全局样式
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── .env.example         # 环境变量示例
└── README.md
```

## 📝 License

MIT License

## Production verification

### Balance error contract

- User balance failures remain `错误：余额不足` and are handled by the user billing path.
- Provider/API account balance failures, including precharge/quota wording such as `预扣费额度失败`, are normalized at every managed API entry point to `错误：99`. New API integrations must use the shared provider-balance matcher rather than exposing provider-specific balance text.

- GitHub Actions runs tests, type checking, the production build, and dependency auditing on every push and pull request.
- `Production Watch` probes Railway every 30 minutes and verifies that a push reached the exact Git commit before accepting the deployment.
- `SMOKE_BASE_URL=https://your-backend.example npm run smoke:production` runs the same health, operations, captcha, security-header, and concurrency checks locally.
- System users can read `/api/admin/storage-usage` for sanitized object counts and byte totals grouped by storage prefix. Set `OBJECT_STORAGE_WARNING_BYTES` to enable a capacity warning.
- `npm run drill:resilience` injects local database and object-storage outages, verifies recovery under concurrent health checks, and exercises maintenance cleanup without touching production data.
- Maintenance removes expired sessions, verification records, rate-limit buckets, and audit logs older than `AUDIT_LOG_RETENTION_DAYS`.
- The system console shows database/object-storage usage plus API P95/P99 and managed-AI gateway error rates; raw request paths and bodies are not retained in these metrics.
- MySQL deployments aggregate sanitized minute-level request metric buckets across replicas and retain them for `REQUEST_METRIC_RETENTION_DAYS`; graceful shutdown flushes the final buffered batch.
- Database upgrades are recorded in `schema_migrations` and protected by a MySQL advisory lock, so schema-altering migrations run once across concurrent replicas.
- System users can preview object-storage cleanup without seeing object keys. Execution requires the current system password and only removes stale `healthchecks/` objects after reconciling database references.
- `npm run fixture:browser` starts an isolated local browser fixture on port 8790. It uses a temporary JSON database and never connects to production services.
