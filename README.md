# 蝶忆 Lepimemory

蝶忆（Lepimemory）是面向极创工作室第二次面试题（[CHALLENGE.md](CHALLENGE.md)）实现的角色 Agent 系统。

系统在底层大语言模型之外，独立维护了状态机、受控记忆生命周期与真实系统行动能力：

- 显式状态机：心境与关系参数由 SQLite 持久化管理，随真实交互事件更新并按 6 小时半衰期自然衰减，根据偏离基线程度翻译为语气提示注入模型上下文；
- 受控记忆生命周期：用户输入经历意图解析、事实候选抽取、Laya 准入评估、权限检查与不可变快照对账；生成回复前经由策略门禁过滤并附带来源标签；
- 真实系统行动：角色调用工具（如写便签）必须在磁盘实际创建实体文件并通过哈希对账，明确区分语言表达与系统行为；
- 全程可观测：右侧状态面板提供心境指标、任务队列进度、8 个 History 审计选项卡与单轮引用的具体记忆来源。

当前进度：已完成 Lv1/Lv2 核心闭环与 Lv3 状态驱动立绘。自动化检查（行为测试、SQLite 冒烟测试、TypeScript 类型检查与 ESLint 规范）全部通过。已知边界与未实现项详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 7 节。

---

## 快速开始

### 前置要求

- Docker（含 Docker Compose v2）
- make、Bash、curl、tar、OpenSSL、shasum

系统入口由项目固定的工具链驱动，无需在全局安装 Node、pnpm 或 dsh。`make bootstrap` 会自动下载并校验固定的 Node 24.20.0 与 pnpm 10.28.2，dsh 锁定为 0.1.7-rc.2。

### 启动步骤

```bash
# 1. 准备固定工具链
make bootstrap

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填写 LEPI_LLM_BASE_URL 与 LEPI_LLM_API_KEY

# 3. 安装并生成 profile
make install-profile DSH_HOME=/tmp/lepimemory-home

# 4. 启动开发服务器
DSH_HOME=/tmp/lepimemory-home PORT=3181 LEPI_BANK=lepimemory-demo make dev
```

### 运行说明

- 依赖锁定安装：构建过程采用 frozen install，不重新解析依赖，无需全局安装包管理器。
- Profile 生成：`make install-profile` 将预设 profile 复制至指定的 `$DSH_HOME`，并自动建立插件软链接。
- 服务容器：首次运行 `make dev` 时会通过 Docker 构建并启动 Hindsight 与 Laya 两个记忆服务镜像。
- 只读模式：若未配置大模型连接凭据，系统将以只读（unconfigured）状态启动，前端可查看状态但无法发起对话，且不会回落至任何默认官方端点。
- 访问界面：启动成功后，终端将输出带认证参数的访问 URL，通过浏览器打开即可进入。

---

## 环境变量配置

系统运行配置统一通过 `LEPI_*` 环境变量管理（样例见 [.env.example](.env.example)），真实凭据仅保存在本地 `.env`（已被 gitignore）：

- 共享大模型连接：`LEPI_LLM_BASE_URL` 与 `LEPI_LLM_API_KEY`（需成对填写）。
- 独立路由覆盖：`LEPI_ROLE_*`（角色主模型）、`LEPI_PROCESS_*`（处理模型）、`LEPI_CONTROL_FALLBACK_*`（备用路由）、`LEPI_HINDSIGHT_*`（记忆后端模型），支持单独指定不同端点。
- 记忆库标识：`LEPI_BANK`，指定长期记忆的存储库标识（默认为 lepimemory-v2）。

---

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `Makefile` · `scripts/` | 统一运行入口与构建脚本（bootstrap / build / install-profile / dev / verify / check） |
| `package.json` · `pnpm-lock.yaml` | 根工作区配置，锁定 Node、pnpm 及 dsh 版本依赖 |
| `dsh/profiles/lepimemory/` | profile 源配置：角色人设、能力面裁剪与压缩策略 |
| `dsh/plugins/dsh-lepimemory-state/` | 自研角色运行时插件源码（服务端 TypeScript、共享定义与浏览器 TSX 客户端） |
| `deploy/hindsight/` · `deploy/laya/` | 记忆检索（Hindsight）与准入评估（Laya）服务的镜像定义 |
| `docker-compose.yml` | 记忆服务编排配置（仅绑定本地 loopback 端口） |
| `docs/` | 机制导览、架构说明与开发日志 |
| `.env.example` | 环境变量模板 |

---

## 文档索引

- [docs/MECHANISM.md](docs/MECHANISM.md) — 机制与页面导览：系统工作原理、页面区域说明与推荐演示路线
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构说明：模块职责划分、数据流转机制、设计取舍与已知边界
- [docs/DEVLOG.md](docs/DEVLOG.md) — 开发日志：演进里程碑与踩坑记录
- [dsh/README.md](dsh/README.md) — 开发者指南：构建命令、源码阅读顺序与事务边界
- [LOCAL_HANDOFF.md](LOCAL_HANDOFF.md) — 本地开发运行备忘
- [CHALLENGE.md](CHALLENGE.md) — 面试题目原文
