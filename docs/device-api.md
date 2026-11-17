# 设备接入与 API 合同

所有业务接口以 `/api/v1` 为前缀。默认 SQLite 环境地址为 `http://127.0.0.1:3010`，PostgreSQL 示例环境为 `http://127.0.0.1:3012`，实际地址以启动窗口输出为准。完整路由说明位于运行服务的 `/docs`，OpenAPI JSON 位于 `/openapi.json`。

本交付保留已有业务、管理和设备接口。尚未在 Web 页面提供按钮的后台能力也可能是设备接入、授权导出或运行维护合同的一部分；没有将这些接口作为开发临时代码删除。

## 1. 接入前准备

使用 Node.js 24，在项目目录中运行：

```powershell
.\start.bat .env provision COLLAR-0001
```

维护命令先安装依赖并编译，然后在所选数据库预置设备，不启动 API/Worker。输出包含 `device_id`、一次性显示的 `device_token`、`claim_code` 和绑定码有效期。设备令牌供设备上报与命令通道使用，绑定码供用户认领使用，两者不能混用。数据库只保存凭证散列。

正常启动 `start.bat` 后，用户先注册、创建宠物，再在设备页填设备 ID 与绑定码完成认领。绑定码默认 30 分钟有效；绑定关系决定后续数据归属。设备预置不等于已认领。

## 2. 保留的设备接口

下表省略 `/api/v1`。用户接口使用 `Authorization: Bearer <access_token>`；设备接口使用 `x-device-token`。管理员接口还要求服务端管理员名单授权。

| 用途 | 接口 | 身份 |
| --- | --- | --- |
| 健康检查 | `GET /health` | 无需登录 |
| 接入模式与配置状态 | `GET /integrations/status` | 用户 |
| 设备原始事件上报 | `POST /ingest/events` | 设备令牌 |
| 上报处理状态 | `GET /ingest/events/:eventId` | 当前有权限的用户 |
| 供应商云事件入口 | `POST /integrations/vendor/events` | 独立 Webhook 签名，仅 API 模式 |
| 认领、状态 | `POST /devices/claim`、`GET /devices/:id` | 用户 |
| 解绑、释放所有权、重签绑定码 | `POST /devices/:id/unbind`、`release`、`claim-code` | 设备所有者 |
| 上报策略 | `GET/PUT /devices/:id/reporting-policy` | 家庭成员；写入需写权限 |
| 走失模式 | `POST /devices/:id/lost-mode` | 有写权限的家庭成员 |
| 用户查询命令状态 | `GET /devices/:id/commands/:commandId` | 用户 |
| 设备取得待执行命令 | `GET /device-ingress/:id/commands` | 设备令牌，需有效绑定 |
| 设备回执 | `POST /device-ingress/:id/commands/:commandId/ack` | 设备令牌，需有效绑定 |
| 凭证元数据、轮换、吊销 | `GET /devices/:id/credential`、`POST /devices/:id/credential/rotate`、`revoke` | 设备所有者 |
| 库存设备凭证与绑定码 | `POST /admin/devices/:id/credential/rotate`、`POST /admin/devices/:id/claim-code` | 设备管理员 |
| 位置与安全事件 | `GET /pets/:id/location/latest`、`locations`、`safety-events` | 用户 |
| 失败消息查询与重排 | `GET /pets/:id/telemetry-failures`、`POST /ingest/events/:eventId/retry` | 家庭成员；重排需写权限 |

解绑保留设备所有权，便于换宠物；释放所有权用于转让设备。凭证轮换会生成新令牌，吊销后设备不能继续上报；后端不提供找回旧设备令牌的接口。

## 3. 统一事件 Envelope

直接设备入口：

```http
POST /api/v1/ingest/events
Content-Type: application/json
x-device-token: <device_token>
```

定位消息示例，ID、时间与令牌应替换为本次实际值：

```json
{
  "schema_version": "1.0",
  "event_id": "collar-location-000001",
  "device_id": "d015b981-37e8-4cc4-9e76-5a7a2d0e98a1",
  "device_ts": "2026-11-17T12:00:00.000Z",
  "seq": 1,
  "boot_id": "boot-001",
  "firmware_version": "1.0.0",
  "transport": "cellular",
  "event_type": "location.reported",
  "payload": {
    "lat": 31.2304,
    "lon": 121.4737,
    "accuracy_m": 10,
    "source": "gnss",
    "battery_pct": 78
  }
}
```

公共必填字段为 `schema_version/event_id/device_id/device_ts/seq/boot_id/event_type/payload`。`device_id` 为预置设备 UUID，时间使用带时区的 ISO 格式；`seq` 为本次启动中的非负整数序号。`transport` 可为 `cellular/phone_gateway/vendor_cloud/simulator`，只标注来源，不建立对应网络连接。

| 事件类型 | payload |
| --- | --- |
| `state.reported` | 可选 `battery_pct`、`signal` |
| `location.reported` | 必填 `lat/lon/accuracy_m/source`；source 为 `gnss/wifi/cellular/ble/vendor`；可附电量和信号 |
| `activity.reported` | 必填 `start_at/end_at`；至少一个实际测得指标 `steps/active_seconds/distance_m/sleep_seconds`，可附 `estimated/source/raw_metrics`、电量和信号 |

活动区间必须为正且不超过一天，活动与睡眠时长之和不能超过区间。未提供的指标应留空，不能用零冒充实际测量。

API 先持久化至 `device_events`，成功返回 HTTP `202` 与 `event_id/status/duplicate`。`pending` 表示等待 Worker 投影，不代表位置和活动页面已更新。相同 `event_id` 或相同 `device_id/boot_id/seq` 的同内容重传会去重，不同内容会冲突。

Worker 把消息转换为设备状态、位置、活动样本、围栏判定、安全事件和通知。接收时保存绑定快照，旧绑定消息不会写入后来认领者的宠物状态。`GET /ingest/events/:eventId` 可查询处理状态；Worker 停止时消息可能继续积压。

## 4. 供应商 Webhook

仅在 `DATA_MODE=api` 且设置 `VENDOR_WEBHOOK_SECRET` 后启用：

```http
POST /api/v1/integrations/vendor/events
Content-Type: application/json
x-doogy-timestamp: <Unix秒时间戳>
x-doogy-signature: <64位十六进制HMAC>
```

请求体仍为统一 Envelope。供应商私有字段须先在供应商侧或适配层映射；本项目没有自动识别任意厂商协议。

签名算法：

```text
hex(HMAC-SHA256(VENDOR_WEBHOOK_SECRET, timestamp + "." + 原始请求体字节))
```

服务端允许时间戳与当前时间相差最多 5 分钟。签名后不要重新格式化 JSON，否则原始字节不同会验签失败。供应商入口使用独立签名认证，但消息中的设备仍须已预置且凭证状态有效。

## 5. 下行策略与执行回执

用户提交普通策略示例：

```http
PUT /api/v1/devices/:id/reporting-policy
Authorization: Bearer <access_token>
Content-Type: application/json
Idempotency-Key: <本次操作唯一键>
```

```json
{
  "mode": "home_active",
  "interval_seconds": 120,
  "expires_in_seconds": 300
}
```

`mode` 支持 `home_idle/home_active/boundary_watch/alert/low_power`，上报间隔为 15–86400 秒。`expires_in_seconds` 是本次命令有效期，普通策略命令允许 30–3600 秒。走失模式使用 `POST /devices/:id/lost-mode`，正文为 `{"enabled":true,"expires_in_seconds":3600}`，会产生 alert 策略命令。

设备轮询 `GET /device-ingress/:id/commands`，读取 `items` 中命令的 `id/version/policy/expires_at`。执行后提交：

```http
POST /api/v1/device-ingress/:id/commands/:commandId/ack
Content-Type: application/json
x-device-token: <device_token>
```

```json
{
  "status": "applied",
  "applied_version": 1
}
```

失败时提交 `status: "failed"`，可带 `error`。回执版本必须与命令匹配；被新命令替代、已到期、取消或绑定变化后的命令不能再作为当前命令确认。重复相同回执可重试。

用户请求成功只更新期望策略和待执行命令；收到回执才更新 `applied_version`。offline 回执标为 `simulator`，API 回执标为 `device`，模拟成功不代表真实项圈执行。

## 6. 离线与外部接入边界

- `DB_DRIVER=sqlite/postgres` 决定存储，`DATA_MODE=offline/api` 决定外部接入，两者独立。
- offline 下浏览器仍调用本地 API；通知模拟发送，不访问外部业务服务。可用离线文件导入和设备模拟回执推进开发。
- API 模式启用供应商签名入口；推送只有配置 `PUSH_WEBHOOK_URL/PUSH_WEBHOOK_TOKEN` 后才向外发送，未配置时保持待发送。提供方接受不证明手机送达。
- Web 当前在操作后、切换标签或手动刷新时重新请求，没有 WebSocket/SSE 实时刷新。
- 现有设备协议承载方式是 HTTP；未包含 MQTT 服务、特定厂商私有映射、固件烧录、OTA 或 APNs/FCM 原生 SDK。

数据库表、队列及备份操作见 [数据库说明](database.md)。
