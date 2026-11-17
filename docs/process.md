# 交付整理与验证记录

日期：2026-11-17。

## 交付范围

本目录是从原开发工作区生成的独立交付副本。保留 Web 客户端、NestJS API、Worker、SQLite/PostgreSQL 增量迁移及必要运行工具。原工作区的源码、配置、数据库、历史备份和测试套件均未修改或删除。

保留的功能包括账号和家庭共享、宠物档案、设备认领与换绑、定位轨迹、围栏和安全事件、通知、活动汇总与观察、照护及附件、位置分享后端接口、客服与诊断、授权导出、账号注销、数据保留以及双数据库备份恢复。SQLite/PostgreSQL 和 offline/API 四种组合继续使用同一业务接口。

## 文件整理

交付包不包含：

- 原 `test/` 开发测试套件及测试运行命令。
- `scripts/test-postgres.ts`、`scripts/postgres-performance.ts`、旧 `scripts/demo.ts` 和仅供旧验证使用的 `fixtures/walk.json`。
- 依赖已删除测试命令的旧 CI、历史需求草案、逐轮开发日志、验收截图、压测和迁移报告。
- 原 `.git/`、真实环境配置、账号数据、业务数据库、备份和访问令牌。
- 验证阶段安装的 `node_modules/`、编译生成的 `dist/` 和合成数据 `data/`。首次运行会重新安装、编译并生成本地数据。

`scripts/` 保留 17 个运行文件，包含启动、设备预置、离线文件接入、离线回执、演示初始化、导出、数据维护、迁移、备份恢复及其内部依赖。Worker 自动备份会调用其中的脚本，不能整目录删除。`start-demo.bat` 和 `scripts/mvp-demo.ts` 属于当前可用的离线样例入口，继续保留。

## 接口处理

已核对 Controller、Web 调用、脚本调用和设备接入合同，没有发现仅供开发测试使用的 debug/reset/seed/手动 Worker HTTP 接口。因此本轮没有删除已实现的业务路由。无主 Web 页面入口的分享、反馈、诊断等接口仍有实际业务用途，保留其合同。

设备遥测、供应商 Webhook、设备认领与所有权管理、上报策略、走失模式、命令轮询、执行回执、凭证维护和失败重试均保留。三种实际启动时读取的 OpenAPI 都包含 86 个路径；详情见 [device-api.md](device-api.md)。

## 配置与启动

- 普通环境默认 `127.0.0.1:3010`，SQLite 数据保存到本目录的 `data/doogy.db`。
- PostgreSQL 配置默认 API 端口 `3012`、数据库端口 `55433`。Compose 项目名 `doggy-clean`，正式运行使用独立 volume `doggy-clean-runtime`，与原项目及本次验证数据隔离。
- `.env.example` / `.env.postgres.example` 可提交；本地 `.env` / `.env.postgres` 与模板相同，使用公开本地开发默认值并由 Git 忽略。
- `start.bat` 仅移除压测分支，其余编译、数据库准备、API/Worker 启停和维护入口保留。依赖锁文件没有改变版本。
- `tsconfig.json` 不再包含测试目录；TypeScript 构建依赖保留。

## 本次实际验证

测试在交付目录之外运行，复用原开发套件，通过外部目录关联到本交付副本的 `dist/src`、`dist/scripts`、`node_modules`，并以本目录为工作目录读取实际 `web/` 与 `db/`。最终包不保留验证脚本和测试文件。

| 检查 | 实际结果 |
| --- | --- |
| 依赖安装 | `npm ci --include=dev --prefer-offline --no-audit --no-fund` 成功 |
| 最新源码构建 | TypeScript 编译及三个前端模块语法检查成功 |
| 外部默认回归 | 260 项定义，245 通过、15 项 PostgreSQL 专项跳过、0 失败，约 20.295 秒 |
| 外部 PostgreSQL 回归 | 44 项定义，44 通过、0 跳过/失败，约 35.212 秒 |
| 普通 `start.bat` | 真实安装、构建、数据库准备、API/Worker 就绪；health 为 SQLite/offline；Web HTTP 200；注册、建宠、体重照护和概览读取成功；Enter 停止自有进程 |
| `start.bat .env.postgres` | 使用独立 Compose 数据库，真实构建和迁移后 API/Worker 就绪；health 为 PostgreSQL/offline；Web HTTP 200；同一注册/建宠/照护主流程成功；Enter 停止自有进程 |
| `start-demo.bat` | 真实双角色登录成功，两只宠物、五条照护、九个位置、三个安全事件；viewer 修改被拒绝；Enter 停止自有进程 |
| 设备合同 | 三种实际启动的 OpenAPI 均保留设备上报、供应商 Webhook、命令轮询和回执路径 |
| 文件一致性 | Web 5/5、数据库迁移 31/31 与原文件一致；后端 28 个文件中只有 Swagger 文档路径调整，业务逻辑保持 |
| 文档与 Git | 本地链接、代码围栏、示例事件和配置模板检查通过；真实配置、数据、依赖和编译结果被忽略；未暂存或提交 |

默认回归排除两个已删除开发工具的用例文件：依赖旧 walk fixture 的 `e2e.test.js`，以及测试已删压测统计工具的 `performance-metrics.test.js`；PostgreSQL 同样排除旧 walk 用例。现有实际客户端、设备、附件、分享、生命周期、备份恢复等其余用例保留外部验证。以上数量对应本次执行，不引用原项目以前的测试数量。

验证结束后，本次 API/Worker 和独立 Compose 服务均停止。批量删除验证产物被自动审批拦截，改为将合成 SQLite 数据、依赖和编译产物可恢复地移到交付目录外的临时验证目录。验证用 PostgreSQL volume `doggy-clean_doogy-postgres` 保留；最终 Compose 改用全新 `doggy-clean-runtime`，重新检查数据库健康并确认业务表为空后停止，后续首次启动不会读取验证账号。原项目的 Compose 和 volume 不受影响。Git 仓库已初始化为 `main`，没有创建提交或远程地址。

## 验证边界

本轮没有修改业务模型或扩展功能，没有进行真实项圈、厂商云、手机推送送达、Android App 或生产部署验收。页面与接口是本地 Web MVP，演示数据为合成数据。删除交付包中的测试套件不改变原开发工作区的测试，后续功能开发应在保留测试的开发工作区继续验证。
