# DOOGY Web MVP 与后端

智能项圈与宠物照护的本地可运行 MVP。包含账号和家庭协作、宠物档案、设备绑定、定位与围栏、活动趋势、照护记录及附件、通知、数据导出与生命周期管理。浏览器页面和 API 由同一个 NestJS 服务提供，Worker 处理设备消息、通知和后台维护。

本目录是独立交付副本，保留运行源码、数据库迁移、设备接入合同及必要运维工具。开发测试、压测、旧验证脚本、历史验收报告和原业务数据未随包交付。离线演示入口继续保留，用于无真实设备时展示 MVP；它不是测试套件。

## 快速运行

安装 **Node.js 24.x**（包含 npm），在本目录运行。默认只监听本机。

### 直接体验演示

双击 [start-demo.bat](start-demo.bat)。等待构建完成后，打开窗口打印的 `/app/` 地址，点击「主人演示登录」或「只读演示登录」。演示自动选择空闲端口，每次生成独立 SQLite/offline 合成数据，不使用普通库。

需要手工输入时，账号为 `owner@doogy-demo.example.invalid` / `viewer@doogy-demo.example.invalid`，密码均为 `Doogy-MVP-demo-2026!`。这些是公开合成演示凭据，只适用于演示库。演示数据保存在 `data/mvp-demo-<随机标识>/`，保留其中的 `demo.env` 可继续上次数据：

```powershell
.\start.bat data\mvp-demo-实际标识\demo.env
```

### 使用自己的数据

双击 [start.bat](start.bat)。它同步安装构建依赖、编译最新源码、准备数据库，然后启动 API 和 Worker。`.env` 缺失时从 [.env.example](.env.example) 创建；已有配置不会被覆盖。按 Enter 或 Ctrl+C 停止本次启动的服务。

默认地址：

- Web：[http://127.0.0.1:3010/app/](http://127.0.0.1:3010/app/)
- API：`http://127.0.0.1:3010/api/v1`
- Swagger：[http://127.0.0.1:3010/docs](http://127.0.0.1:3010/docs)
- SQLite：`data/doogy.db`，相对于本目录。

普通库从空数据库开始，请在页面注册账号、创建宠物；固定演示账号和样例不会自动写入普通库。端口占用时，在当前 PowerShell 临时设置 `$env:PORT='3011'` 后再启动，或修改自己的 `.env`。

手工运行可使用以下命令；API 与 Worker 需要两个终端，使用同一份环境配置：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run db:prepare
npm.cmd start
# 第二个终端
npm.cmd run worker
```

`start.bat` 会自动完成上述准备和双进程管理。保留 `devDependencies` 是因为 TypeScript 源码需要编译，不要在首次构建前只安装生产依赖。

## 数据库与运行模式

`DB_DRIVER=sqlite/postgres` 决定存储位置；`DATA_MODE=offline/api` 决定外部业务接入方式，两者独立，共四种组合。

- **offline**：Web 仍请求本地 API，通知模拟投递；可用离线文件导入和设备回执模拟工具，不访问外部业务服务。
- **api**：启用供应商 Webhook 和已配置的推送适配通道。需要按[设备接口说明](docs/device-api.md)完成凭证、字段映射和签名配置；切换模式不会自动连接任意厂商云。
- 两种数据库不自动同步或双写。SQLite 与 PostgreSQL 的增量迁移均完整保留，启动时按已应用版本升级。

### PostgreSQL / PostGIS

需要可用的 Docker Engine，或自备 PostgreSQL/PostGIS 服务。本副本使用独立 Compose 项目 `doggy-clean`，默认数据库端口 `55433`，与原开发项目分离。

```powershell
npm.cmd run postgres:up
# 若文件不存在，才从模板创建；本交付目录已提供安全本地默认值。
if (!(Test-Path .env.postgres)) { Copy-Item .env.postgres.example .env.postgres }
.\start.bat .env.postgres
```

默认 PostgreSQL Web 地址为 [http://127.0.0.1:3012/app/](http://127.0.0.1:3012/app/)。模板中的 `doogy/doogy-local-dev` 是公开的本机开发凭据；共享部署前同时修改数据库服务凭据和 `DATABASE_URL`。`npm.cmd run postgres:stop` 只停止本副本的 Compose 服务，不删除 volume。

数据库结构、备份恢复和 SQLite 导入 PostgreSQL 的约束见 [数据库说明](docs/database.md)。已有数据升级前先备份；导入目标必须为空，恢复使用新文件或新数据库。

## 配置

可提交模板为 [.env.example](.env.example) 与 [.env.postgres.example](.env.postgres.example)。本地 `.env` / `.env.postgres` 已列入 Git 忽略规则，随包提供的是模板相同的公开本地默认值，不含原项目密钥或账号数据。

| 配置 | 默认值或用途 |
| --- | --- |
| `HOST`、`PORT` | 普通 `127.0.0.1:3010`，PostgreSQL 配置 `127.0.0.1:3012` |
| `DB_DRIVER`、`DB_PATH`、`DATABASE_URL` | 按指定驱动使用 SQLite 文件或 PostgreSQL 连接 |
| `DATA_MODE` | 默认 `offline` |
| `FRESH_SECONDS`、`OFFLINE_SECONDS` | 默认 300 秒，位置新鲜度和设备离线判断基础阈值 |
| `LOW_BATTERY_PCT` | 默认 20 |
| `IDEMPOTENCY_TTL_HOURS` | 默认 24 小时，业务请求幂等缓存期限 |
| `MANAGED_BACKUP_*` | 自动托管备份默认关闭，目录、保留数量、检查间隔可配 |
| `DEVICE_ADMIN_USER_IDS`、`SUPPORT_ADMIN_USER_IDS` | 对应管理员用户 UUID 白名单，默认空 |
| `VENDOR_WEBHOOK_SECRET` | API 模式供应商共享密钥，至少 24 字符；使用时在本地配置 |
| `PUSH_WEBHOOK_URL`、`PUSH_WEBHOOK_TOKEN` | API 模式推送适配地址与令牌；未配置则保留待发送状态 |
| `PG_TOOLS` | PostgreSQL 备份恢复默认 `docker`，也支持已安装工具的 `native` |

`DEVICE_TOKEN`（离线导入/回执）和 `DOOGY_ACCESS_TOKEN`（账号导出）通过临时终端环境变量传入，不写进模板或 Git。`DOOGY_DEMO` 由独立演示启动器设置，普通配置不启用。

## 运行与维护命令

以下命令从本目录执行。除 `start.bat` 和明确包含构建步骤的 npm 命令外，直接使用脚本前先执行 `npm.cmd run build`。

| 用途 | 命令示例 |
| --- | --- |
| 最新源码构建 | `npm.cmd run build` |
| 普通 / 指定配置启动 | `start.bat` / `start.bat .env.postgres` |
| 独立离线展示 | `start-demo.bat` 或 `npm.cmd run demo:mvp` |
| 设备预置 | `start.bat .env provision 项圈序列号` |
| 离线事件导入 | 设置临时 `DEVICE_TOKEN` 后，`npm.cmd run import:offline -- 事件文件.json` |
| 离线设备命令回执 | 设置临时 `DEVICE_TOKEN` 后，`npm.cmd run simulate:device -- 设备UUID` |
| SQLite 备份 | `npm.cmd run db:backup -- ./data/backups/manual.db` |
| SQLite 恢复到新文件 | `npm.cmd run db:restore -- ./data/backups/manual.db ./data/restored.db` |
| PostgreSQL 备份 | `start.bat .env.postgres backup ./data/backups/manual.dump` |
| PostgreSQL 恢复到新库 | `start.bat .env.postgres restore ./data/backups/manual.dump doogy_restored` |
| 托管备份预览 / 执行 | `start.bat .env backup-plan` / `start.bat .env backup-managed` |
| 授权账号导出 | 设置临时 `DOOGY_ACCESS_TOKEN` 后，`start.bat .env export-account ./data/account.jsonl` |
| 保留策略预览 | `start.bat .env privacy retention-preview` |
| 幂等缓存清理预览 | `start.bat .env privacy idempotency-preview` |

设备预置会输出一次性设备凭证与认领信息，请由设备接入方妥善保存。维护命令与后台自动备份是运行能力，保留在 `scripts/`；测试、压测与旧自检入口已从交付包中移除。

## 目录与接口

```text
src/                  后端业务、API、Worker 和数据库适配
web/                  浏览器客户端
db/                   SQLite 增量迁移
db/postgres/          PostgreSQL/PostGIS 增量迁移
scripts/              启动、离线接入、设备预置及备份等运行工具
docs/                 设备接口、数据库及交付说明
start.bat             Windows 普通启动/维护入口
start-demo.bat        独立合成数据展示入口
.env*.example         可提交的环境模板
```

[设备接口说明](docs/device-api.md)包含遥测、供应商 Webhook、命令轮询与回执。现有业务、运维和设备预留路由继续保留；核查未发现纯开发测试 HTTP 路由。无页面入口的设备与业务合同不会因为暂未接入前端而失效。

## 提交到 Git

提交源码、SQL 迁移、运行脚本、README、文档、环境模板和 `package-lock.json`。`.gitignore` 排除 `node_modules/`、`dist/`、`data/`、本地 `.env*`、数据库、备份和日志。安装依赖及运行后生成的文件不进入提交。

```powershell
git init -b main
git status --short
git add .
git diff --cached --stat
# 核对暂存清单后再提交
git commit -m "Initial DOOGY MVP"
```

交付范围和本次实际验证记录见 [process.md](docs/process.md)。本项目目前为本地 Web MVP；真实设备、厂商云、手机推送送达及生产部署仍需独立联调验收。
