# 服务器上传清单

面向 1Panel Docker/容器编排部署，建议上传“源码 + Docker 配置”，不要上传本地依赖、构建产物和测试报告。

## 必须上传

- `src/`：前端源码
- `server/`：后端 API、工作站账号、额度、SQLite 逻辑
- `public/`：静态资源和运行时配置模板
- `docker/`：Nginx 配置和容器启动脚本
- `scripts/`：测试和校验脚本
- `package.json`、`package-lock.json`、`.npmrc`：依赖锁定，Docker 构建需要
- `Dockerfile.web`、`Dockerfile.api`、`docker-compose.yml`：1Panel 编排和镜像构建入口
- `index.html`、`manifest.json`、`vite.config.ts`、`tsconfig.json`、`vitest.config.ts`、`eslint.config.js`：构建配置
- `.env.example`：环境变量示例，不放真实密钥
- `.dockerignore`、`.gitignore`：上传/构建时的排除规则

## 建议上传

- `README.md`：项目说明
- `docs/`：部署、架构和后续维护文档
- `LICENSE`：许可证

## 不需要上传

- `node_modules/`：依赖目录，Docker 会在镜像里执行 `npm ci`
- `dist/`：前端构建产物，`Dockerfile.web` 会在容器内重新构建
- `server/dist/`：后端构建产物，`Dockerfile.api` 会在容器内重新构建
- `playwright-report/`、`test-results/`、`coverage/`：本地测试报告
- `*.log`、`*.err.log`：本地日志
- `.env`、`.env.local`、`.env.*`：真实密钥和本地环境变量，不要上传
- `.git/`：如果不是用 Git 拉取部署，打包上传时可不带

## 不能随便删

- 服务器上的 Docker 命名卷 `workspace-data` 不能删，它保存 `/app/server/data/arong-workspace.sqlite`。
- 生产环境 `.env` 或 1Panel 环境变量里如果有真实密钥，不要打包回传或发给别人。
- 后台“运维健康与数据备份”下载的 JSON 备份包含敏感数据，需要单独保管。

