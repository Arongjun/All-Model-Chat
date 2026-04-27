# 1Panel Docker 部署指南

## 推荐方式

在 1Panel 的“容器编排”里使用仓库根目录的 `docker-compose.yml`。当前 compose 会构建两个服务：

- `web`：Nginx 托管前端，并反向代理 `/api/*` 到 `api`。
- `api`：Node 服务，负责模型代理、多用户、额度、兑换码、充值订单和 SQLite 数据库。

## 环境变量与后台配置

1Panel 里真正必填的只有前端端口等运行参数。模型 API Key 可以先作为环境变量兜底，也可以部署成功后由管理员在“工作站 -> 模型 API 配置”里填写。后台配置会写入 SQLite，并且优先于环境变量立即生效。

```env
WEB_PORT=28080
```

可选兜底配置：

```env
GEMINI_API_KEY=你的 Gemini Key
OPENAI_API_KEY=你的 OpenAI 或兼容网关 Key
ANTHROPIC_API_KEY=你的 Anthropic 或兼容网关 Key
GEMINI_API_BASE=https://generativelanguage.googleapis.com
OPENAI_API_BASE=https://api.openai.com/v1
ANTHROPIC_API_BASE=https://api.anthropic.com
WORKSPACE_DATABASE_FILE=server/data/arong-workspace.sqlite
WORKSPACE_LEGACY_JSON_FILE=server/data/arong-workspace.json
WORKSPACE_SESSION_TTL_HOURS=336
```

后台支持“一键从环境变量导入”：导入动作发生在服务端，只会在浏览器显示来源和密钥尾号，不会回显完整密钥。程序不会反向修改 Docker/1Panel 的环境变量；运行时实际使用的是“后台 SQLite 配置优先，环境变量兜底”。

Claude 官方或 Anthropic-compatible 网关走 `ANTHROPIC_API_BASE` / `/api/anthropic/v1/messages`。如果你的中转网关把 Claude 做成 OpenAI-compatible 格式，则把模型 ID 写成 `openai:claude-...`，让它走 `OPENAI_API_BASE` / `/api/openai/v1/chat/completions`。

## 数据持久化

工作站账号、积分、模型次数包、兑换码、充值订单和审计记录都保存在 SQLite：

```text
/app/server/data/arong-workspace.sqlite
```

`docker-compose.yml` 已经把 `/app/server/data` 挂到 `workspace-data` 命名卷。不要删除这个卷，否则会丢失工作站数据。升级镜像或重建容器不会删除这个卷。

管理员也可以在前端“工作站”设置里的“运维健康与数据备份”下载完整 JSON 备份。这个备份包含账号密码哈希、积分、模型次数包、订单和审计记录，但不会导出当前登录会话。建议在升级镜像、迁移服务器或调整 1Panel 编排前先下载一次。

## 反向代理

如果你用 1Panel 给域名配置反向代理，只需要把域名转发到 `web` 服务暴露的端口，例如：

```text
http://服务器IP:28080
```

前端访问后端使用同源 `/api/*`，正常不需要额外暴露 `api` 容器端口，也不需要把 API Key 放到浏览器端。

## 上线冒烟测试

部署成功后建议按顺序检查：

1. 打开域名或 `http://服务器IP:WEB_PORT`，页面能正常加载。
2. 进入“工作站”设置，初始化管理员账号。
3. 在“模型 API 配置”里填写 Key/Base，或点击“从环境变量导入”。
4. 创建一个普通用户并给少量积分。
5. 创建兑换码并用普通用户兑换。
6. 创建充值订单，确认到账后检查积分/次数包是否增加。
7. 发起一次 Gemini 普通请求、一次 OpenAI-compatible 聊天请求、一次 Anthropic-compatible 聊天请求和一次生图请求，确认额度会扣减。
8. 在“运维健康与数据备份”里确认 SQLite 状态为已持久化，并下载一次备份。
9. 重启容器后再次登录，确认用户、API 配置和额度仍然存在。

## 常见问题

- 如果页面能打开但模型请求失败，优先检查“模型 API 配置”的来源/状态，再看 `api` 容器日志和环境变量兜底值。
- 如果重建后账号消失，检查 `workspace-data` 卷是否被删除，或 `/app/server/data` 是否被错误覆盖。
- 如果 `web` 容器日志出现 `/docker-entrypoint.d/40-runtime-config.sh: not found`，通常是 Windows 上传导致脚本带 CRLF 换行，或 1Panel 仍在使用旧镜像。当前 `Dockerfile.web` 已在构建时自动清理换行，遇到此问题请重新上传最新文件并强制重新构建 `web` 镜像，而不是只点重启容器。
- 如果 1Panel 构建很慢，这是前端在 Docker 内执行生产构建，属于正常现象；后续可以接镜像仓库预构建来提速。
