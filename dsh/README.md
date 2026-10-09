# dsh/ — Lepimemory 的 DeepSeek Harness 资产

本目录包含 Lepimemory 在 DeepSeek Harness (dsh) 体系下的相关资产：包括角色的 Profile 预设源与自研角色运行时插件 `@dsh-external/dsh-lepimemory-state`。

项目总览请参考根目录 [README.md](../README.md)，机制与架构说明见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

---

## 目录组成

| 路径 | 说明 |
| --- | --- |
| `profiles/lepimemory/` | Profile 预设源：包含人设定义（`@deepseek-ai/dsh-persona`）、工具能力面裁剪（仅保留受控搜索，禁用无关会话/本地文件引用）与有效历史压缩策略。 |
| `plugins/dsh-lepimemory-state/` | 自研角色运行时插件，负责状态机、记忆生命周期、策略召回、历史隔离与行动验证。 |

`profiles/` 目录为配置模板源，运行时通过 `make install-profile` 复制并实例化至指定的 `$DSH_HOME/profiles/lepimemory`。

---

## 构建与验证命令

项目统一使用仓库内锁定的工具链（Node 24.20.0 / pnpm 10.28.2 / dsh 0.1.7-rc.2），无需在全局安装相关工具：

```bash
# 1. 校验并安装固定运行时工具链
make bootstrap

# 2. 构建产物并将 profile 安装至指定 DSH_HOME
make install-profile DSH_HOME=/tmp/lepimemory-home

# 3. 启动开发环境
DSH_HOME=/tmp/lepimemory-home make dev

# 编译与质量检查
make build          # 编译服务端 TypeScript、客户端 TSX 与脚本
make typecheck      # 执行全量静态类型检查
make verify         # 运行 103 个行为测试与 SQLite 冒烟测试
make lint           # 执行 ESLint 规范检查
make format-check   # 执行 Prettier 格式检查
make check          # 综合门禁（verify -> lint -> format-check）
```

---

## 源码与构建生成物

```text
plugins/dsh-lepimemory-state/
  src/                  手写服务端 TypeScript 源码
  src/shared/           浏览器安全的跨端共享定义（无 node: 内置依赖）
  src/client/           手写前端 React/TSX 源码及样式
  lib/                  编译生成物（由 make build 生成，已被 gitignore）
  client.js             前端打包生成物（由 make build 生成，已被 gitignore）
  test/                 基于 node:test 的行为测试套件
```

运行时直接加载构建产物（`lib/index.js` 与 `client.js`），日常开发修改 `src/` 源码后执行 `make build` 重新生成即可。

---

## 源码推荐阅读顺序

1. 配置与入口：`config.ts`（环境变量解析） -> `index.ts`（插件装配入口）。
2. 存储与基础契约：`store.ts`（SQLite 事务与审计） -> `contracts.ts`（JSON Schema 契约与封闭枚举）。
3. 前置控制：`control.ts`（`agent/pre-step` 意图拦截） -> `processor.ts`（处理模型结构化输出通道）。
4. 准入与记忆生命周期：`admission.ts`（Laya 价值判定） -> `memory.ts`（记忆门面） -> `memory-pipeline.ts`（任务流水线） -> `memory-authorization.ts`（授权检查与原子提交） -> `write-worker.ts`（Hindsight 异步写入与对账）。
5. 读路径与召回：`recall.ts`（策略门禁过滤） -> `recall-source.ts`（来源核验） -> `hindsight.ts`（上下文格式化渲染）。
6. 状态机、行动与历史：`machine.ts` / `state-runtime.ts`（心境衰减与回合结算） -> `action.ts`（`write_note` 磁盘写入校验） -> `history.ts`（遗忘打码隔离）。
7. 前端与交互：`shared/`（跨端模型） -> `client/`（面板与立绘 UI 组件）。

---

## 插件运行时与 API 路由

插件在 `$DSH_HOME/lepimemory/runtime.sqlite` 维护独立数据库（`journal_mode=DELETE` / `foreign_keys=ON`），状态变更与前后值审计在同一同步事务内提交。

### HTTP 路由清单

除健康检查接口外，其余操作者接口均需通过会话鉴权（未通过直接返回 401/403）：

| 路由 | 方法 | 鉴权要求 | 说明 |
| --- | --- | --- | --- |
| `/lepimemory/health` | GET | 公开只读 | 运行时就绪状态检查（Node、dsh、SQLite schema 及服务就绪状态） |
| `/lepimemory/state` | GET | 操作者 | 查询当前有效状态（含心境衰减视图）与状态元数据 |
| `/lepimemory/state` | POST | 操作者 | 操作者显式调整数值（支持 `?preview=1` 演练），原子提交前后值审计 |
| `/lepimemory/history` | GET | 操作者 | 审计与历史记录分页查询（支持 `?grouped=1` 按主体分组） |
| `/lepimemory/candidate` | GET | 操作者 | 查看已获准记忆快照、生命周期状态与来源链路（`?reveal=1` 显示审计原文） |
| `/lepimemory/retry` | POST | 操作者 | 唤醒并重试既有的后台任务与请求（沿用既有身份） |
| `/lepimemory/avatar` | GET | 操作者 | 获取指定 key（`?key=`）的立绘静态 GIF 资源文件 |
