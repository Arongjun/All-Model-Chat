# ADR-0003: 工作站默认使用 SQLite 替代 JSON

## Status
Accepted

## Context

阿荣AI工作站已经从单用户聊天工具扩展到多用户、额度、兑换码、充值订单和审计流水。继续使用 JSON 文件会带来几个问题：写入原子性弱、后续查询能力差、数据边界不清晰，也不利于真实运营时备份和迁移。

PostgreSQL 更适合公开 SaaS 和高并发场景，但当前阶段更需要“部署简单、比 JSON 稳、容易备份、能逐步演进”。因此本阶段选择 SQLite 作为默认服务端工作站数据库。

## Decision

- 默认工作站数据文件改为 `server/data/arong-workspace.sqlite`。
- 服务端使用 SQLite 文件保存工作站状态，不再写入旧 JSON 文件。
- 如果 `WORKSPACE_LEGACY_JSON_FILE` 指向旧 JSON 快照，首次启动会自动读取并写入 SQLite，避免老数据丢失。
- Docker Compose 挂载 `workspace-data` 卷，保证容器重建后 SQLite 文件仍然保留。
- 使用结构化 SQLite 表保存 `users`、`sessions`、`model_policies`、`redeem_codes`、`redemptions`、`recharge_orders` 和 `usage_records`，不再使用 JSON 文件作为主存储。

## Consequences

### Positive

- 不再依赖 JSON 作为主存储，数据文件更适合备份、迁移和单机部署。
- 不需要 PostgreSQL 运维，个人服务器、NAS、轻量云主机都能直接跑。
- 已经具备基础表结构，不阻塞支付流水、订单查询和审计能力继续升级。

### Negative

- 当前还是单机数据库，不适合多 API 实例同时写入同一个文件。
- 查询层仍主要通过服务端状态模型完成，只为高频用户订单和使用记录预留了基础索引。
- 如果未来做公开 SaaS，需要继续迁移到关系表结构，必要时再上 PostgreSQL/MySQL。

## Next

- 增加 `payment_transactions` 表。
- 为使用审计、充值订单、支付流水继续补充更细索引。
- 增加数据库备份/恢复脚本。
- 接真实支付时增加 `payment_transactions` 表和幂等键。
