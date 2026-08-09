# AI Drama Studio - AI短剧生成工作台

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
VIDEO_QUEUE_GLOBAL_CONCURRENCY=20
VIDEO_QUEUE_USER_CONCURRENCY=20
VIDEO_QUEUE_API_CONCURRENCY=20
VIDEO_QUEUE_POLL_CONCURRENCY=20
VIDEO_QUEUE_MAX_PENDING_PER_USER=50
VIDEO_QUEUE_TASK_TIMEOUT_MINUTES=60
VIDEO_QUEUE_HISTORY_DAYS=7
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

四个 `R2_*` 变量必须同时配置。重新部署 Railway 后，新图片写入 R2，MySQL 的 `assets` 表只保存对象 Key、哈希、类型、大小和用户归属；旧 Base64 素材仍可读取，并在再次上传相同素材时迁移到 R2。未配置 R2 时保留数据库存储兼容模式。`ASSET_USER_QUOTA_BYTES` 可选，默认每个用户 2 GiB。`ASSET_RETENTION_DAYS` 默认是 30，仅自动删除超过保留期且未被项目或有效生成历史引用的素材；服务端每 6 小时检查一次，打开云端素材管理时也会立即检查。

### 持久化视频任务队列

系统视频模型请求会先写入 MySQL `generation_jobs` 表，再由 Railway 后端按全站、用户和 API 三层并发限制公平提交。浏览器关闭后任务仍会继续，成功结果由后端写入三天生成历史，失败任务只退款一次。临时 `429` 和 `5xx` 会延迟重试；终态队列记录默认保留 7 天。

默认限制为全站同时生成 20 条、单用户 20 条、单 API 20 条，每个用户最多保留 50 条待处理任务。可通过上方 `VIDEO_QUEUE_*` 环境变量调整。当前调度器面向 Railway 单应用副本；不要将应用服务横向扩展为多个 Replica，否则需要先接入 Redis/BullMQ 或数据库分布式锁。系统用户可在“系统管理控制台 → 视频任务队列”查看实时状态和当前限制。

## 认证、导演模式与 Skill

- 注册、登录、退出和会话恢复均由服务端验证，密码只保存为带随机盐的 `scrypt` 哈希。
- 会话令牌通过 HttpOnly、SameSite Cookie 传递，数据库只保存令牌摘要。
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
