# 开发日志 — 蝶忆 Lepimemory

过程记录与踩坑台账。想知道系统现在怎么工作，读 `README.md` 和 `docs/ARCHITECTURE.md`；本文记的是"怎么走过来的、在哪里栽过跟头"。

---

## 1. 里程碑

### Phase 0–2：选型与验证

三个核心决定：dsh 当运行骨架、Hindsight 当记忆服务、状态机自研。Hindsight 默认抽取模型不支持中文，换多语言模型解决。另验证了"状态注入 → 语气变化"这条链路可行。

### Phase 3：状态与记忆闭环（`exp/state-persistence` → `develop`）

- **状态持久化**：状态从配置常量改为落盘存储，每轮 prompt 组装时实时读取、校验失败报错到字段路径，不静默回落。
- **事件接入 spike 推翻一个假设**：out-of-tree 插件不能往会话日志追加自定义事件（写侧成功、重载整档拒绝），审计改为插件自有存储。
- **状态机 v1**：结构事件 → 数据化规则 → 状态 + 前后值审计；心境 6 小时半衰期衰减。
- **人设注入**：preset persona 行换成正式文本，治"coding-agent 口吻泄漏"。
- **记忆召回竖切**：pre-step 里检索 → 归因 → 注入，带退避与降级。
- **写路径 v1**：对话 → retain；随后修掉过度写入（疑问句、请求句被存成事实），加排除与去重。
- **遗忘 v1**：计划预览 → 确认 → 作废；再进化为工具化（`forget` + 审批），正则识别意图的两类误判从根上消失。
- **行动工具 `write_note`**：真实落盘 + 审批 + 失败进状态。
- **状态面板**：面板路由 + 客户端 + 历史分页（审计/召回/写入/遗忘/行动）。

### Phase 4：补齐 Lv1/Lv2 缺口（`develop`）

- **上下文管理**：启用压缩与工具结果裁剪（preset 的 isolate realm），自动与手动 `/compact` 两条路径都实测过。
- **记忆更新与冲突**：召回取最新 observation（supersede），记录 type/trust/superseded。
- **三档信任 + 差异衰减**：fact / experience 不衰减，inference 14 天半衰期；角色可用 `remember` 主动记推断。

### Phase 5：运行时收敛与 Web 演示（`exp/runtime-convergence`）

- **固定工具链**：Node 24.20.0 / pnpm 10.28.2 / dsh 0.1.7-rc.2 全锁定，frozen install，profile 由 launcher 生成并拒绝外来同名目录。
- **两个记忆服务镜像按 digest / revision 固定**，不拉浮动模型；完全断网实测能加载模型。
- **11 项运行时实现全部落地**：单 SQLite 写入、不可变快照、必经控制、逐候选准入、敏感授权确认、可核对写入、政策召回、有效历史隔离、真实行动记录、状态结算与审计。
- **真实 Web 演示 D0–D7** 逐步跑通并留下截图与审计记录；其间暴露并修掉一批真实问题（范围匹配过宽、来源伪装、隔离 fence 顺序、异步丢失回执恢复等）。D8 完整独立演示与额外后端比较按用户要求不再继续。
- **机制导览**：面向观众的 `docs/MECHANISM.md`。

### Phase 6：可持续维护（`refactor/sustainable-maintenance`）

- 全量 TypeScript / TSX 迁移，手写源码与生成物分离（`lib/`、`client.js`、`scripts/dist/` 不再提交）；固定 devDependencies（TS 5.9.3、esbuild 0.25.12、prettier 3.6.2、eslint 10.12.0）。
- 记忆协调拆分：`memory.ts` 门面 + supervisor / pipeline / authorization + 具名 SQL owner，依赖图保持无环。
- 文档收敛：架构说明合并为单一的 `docs/ARCHITECTURE.md`，中间草稿删除。
- `make verify` 行为测试 + SQLite smoke 全绿；数字以每次命令输出为准。

---

## 2. 踩坑台账

每条：现象 → 根因 → 处置。

### 交付与构建

1. **`.gitignore` 吞掉插件源码**：模板里 `lib/` 没有前导斜杠，匹配任意层级，插件产物被忽略、克隆后起不来。→ 收窄为 `/lib/` 并给插件生成物留显式出口。
2. **`make dev` 没传 `DSH_HOME`**：`DSH_HOME ?=` 只是 make 变量、没 export，本机碰巧有旧 profile 掩盖了问题，换机即崩。→ `export DSH_HOME`。
3. **全新 home 的相对 link 坑**：仓库 profile 的相对 `link:` 只在特定目录成立；解析不到的模块 cordis 只记日志不崩，插件静默缺席。→ 外部 home 一律物化绝对 link。
4. **构建期拉模型的端点和代理不能混用**：`HF_ENDPOINT=hf-mirror.com` 再配上 `HTTP(S)_PROXY` 时，镜像把经代理的请求重定向回 `huggingface.co`，resolve 响应因此没有 `X-Repo-Commit`，固定 revision 的 `snapshot_download` 直接报 `FileMetadataError: Distant resource does not seem to be on huggingface.co`（同一个 URL 直连时反而正常）。→ 端点按出口选：有代理走官方 `huggingface.co`（构建期用 host 网络够到本机代理），直连才用镜像；未显式设置 `HF_ENDPOINT` 时由启动器判定并打印实际端点。模型仍按 revision 固定。

### dsh 机制

1. **stock bundle 没有 console exporter**：`ctx.logger.error` 在 web stdout 看不到。→ 审计改走自有持久化。
2. **out-of-tree 不能追加自定义会话事件**：`Session.append` 写入成功，但读侧按静态白名单准入，重载整档直接拒绝；冷路径写句柄又被单写者挡住。→ 不加事件，审计自存；"状态生效了"用系统消息的 Prompt Diff 证明。
3. **pre-step 每步都触发**：一次工具调用等于多步，天真实现会重复注入召回。→ 每 turn 只注入一次（只认真实用户输入）。
4. **host 注册的工具会到达每个 agent**：工具注册表是"全局层 + per-scope 层"合并；`--dump-config` 里"有某行"不等于"会话能用它"，能力面由 preset 的 plugins 列表 + disabled 共同决定。
5. **`tool/result` 的 `isError` / `toolCallId` 在 message 顶层**（会话格式 V4）：磁盘上的旧 V2 文件是另一种嵌套形状，差点照它实现。→ 按顶层读，核对一律用 v4 文件或源码类型。
6. **工具结果只有 `output.render` 对模型可见**：候选 id 放进 `value` 模型拿不到，两段式工具第二段发不出来。→ 模型要用的字段必须写进 render。
7. **`webServer` 在插件 apply 时可能未就绪**：`ctx.get('webServer')` 是即时读取，拿到 `undefined` 就静默 404。→ 用 `ctx.inject(['webServer'], …)` 延迟到服务可用再注册。
8. **个人端点差点写进仓库草稿**：该 provider 的 baseURL 会回落官方端点，只填 key 时 key 会被发到错误的地方；配置补丁的 `disabled` 又不支持条件表达式。→ 仓库草稿保持注释掉的 opt-in，个人端点只放本机独立 patch 层。
9. **pre-step 的 `reject` 会吞掉已 claim 的用户消息**：checker 识别记忆请求后直接 reject，发生在 dsh 提交 `user/message` 之前；网页撤去当轮临时消息后，聊天和轨迹都只剩空 `blocked` turn。→ 纯保留照常进入角色并附真实回执；破坏性请求先提交用户消息，再让历史隔离窗口覆盖本轮命令，清理后用新原生回合回应安全回执。控制检查失败保留安全输入并显示原生错误，重试不重复提交；旧隔离正文仍不得复活。原生 Session / JSONL / provider 回归覆盖保存、删除和检查失败三条路径。
10. **未打开状态面板时立绘掉到页面底部**：定位 CSS 由 `Panel` 挂载时注入，而立绘独立 portal 到 `document.body`。→ 共享样式改由客户端插件 effect 拥有；关闭面板和冷刷新都保持视口右下角定位。
11. **历史上执行过遗忘后，新会话连首句问候都被吞掉**：迟到的会话 enrollment 使用 `session.seq - 1`，将刚 splice/claim 的第一条新输入也包含进旧输入 fence；有效历史为空虽已完成隔离证明，证据读取仍返回 `LEPI_INPUT_RESUBMIT_REQUIRED`。→ 迟到接入只隔离不可变的原生恢复/种子前缀（`firstLiveSeq - 1`），不使用移动的日志尾部。新增原生回归覆盖「旧会话遗忘完成 → 新会话首句」，同时保持冷恢复旧 inbox 和 fork 前缀的隔离测试。
12. **输入撞上并发政策变化仍消失**：检查已读取合法新输入，但等待期间其他操作推进 epoch；直接 `reject` 会消费原生 claim，不留消息。单纯重检再 `next()` 也不安全，因为角色 assembly 已在旧 epoch 形成。→ 原生新输入先关闭读取门并记录，回合明确记为需重新提交/政策中止；追加材料由 sweeper 重新隔离。回归覆盖检查期变更、无遗忘的授权变更、其他 agent 的遗忘取消，以及下游 pre-step 变更，验证独立输入保留、目标不再进入后续请求。

### Hindsight（记忆服务）

1. **retain 的 3 秒预算假报超时**：LLM 抽取比读慢得多，其实写成功了。→ 读 3s、写 30s 分开预算。
2. **retain 非幂等，不能重试**：网络错误后重试等于写两条重复记忆。→ 写路径 `maxRetries: 0`；只有幂等读才退避重试。

### 意图与判断

1. **过度写入**："我下周要见谁来着？"这类疑问句被存成事实，召回候选膨胀出近重复。→ 按长度/疑问/请求/寒暄排除 + 去重。
2. **正则识别意图会误判**："我永远不会忘记你"被当成遗忘请求，"嗯……对了"被当成确认，可能误删。→ 改为注册工具让模型调用 + 原生审批卡，两类误判从根上消失。顺带踩了两个 schema 坑：`output.schema` 的 `required` 必须是对象级数组；`parameters` 必须显式 object 节点，裸属性表会被判 `type: null`。

### 验证环境

1. **headless 环境不干净**：没有 preset registry，编码向工具还在，模型自己 `curl` 直连记忆服务绕过注入，"模型提到了记忆"不算证据。→ 干净验证一律用 web profile + 结构性判据（读日志/文件/wire）。
2. **浏览器自动化脆弱**：欢迎弹窗挡点击、ARIA 引用每次快照重编号。→ 用 `page.evaluate` + 键盘操作；跨会话冒烟是加分项，别在上面耗轮次。

### 上下文与记忆更新

1. **preset 挂压缩服务必须放进 isolate realm**：直接列进 plugins 会被 preset registry 拒绝。→ 照上游 standard preset 用 `cordis:group` + `isolate` 包住。
2. **Hindsight 抽取按"用户视角"读第一人称**：角色写"我猜她压力大"被重写成"用户猜测她压力大"。→ 让角色用第三人称成句（"蝶忆觉得…"），抽取就忠实了。
3. **observation 会丢 metadata、但继承 tags**：不能依赖 metadata 传信任档。→ 语义上按当前版本的事实处理，信任档只对原始推断生效。
4. **`prefer_observations` 在遗忘取候选时必须关掉**：否则看不到被综合观察覆盖的原始事实，抑制不完整。→ 读路径开启，遗忘内部召回关闭。

---

## 3. 已知未决

- "关于 A"与"A 参与"的区分仍是"机器候选 + 用户确认"，没有自动切分。
- "值不值得写"是启发式 + 判定后端，不是纯工具化。教训：让模型主动调写入工具会系统性漏调（记忆静默不落库），所以自动写保留为兜底，工具只作显式强化。
- checker（控制模型）本身不可用/超时时仍走"登记 request、把已 claim 的输入 steer 回 inbox、结束当轮"的停车路径：消息不会入库丢失，但在操作者 retry 之前不会落回会话面，用户看到的是空 turn。是否也改成"降级继续对话"需要一次产品决定；当前保留停车与 `/lepimemory/retry` 工作流。

---

## 4. 方法与纪律

- **先探最大风险**：状态注入、事件/审计、写入——都用小实验先证伪/证真，再铺开。
- **假设被推翻就改文档，不硬撑实现**。比如"加会话事件"被 spike 推翻后，审计改为插件自己存储。
- **意图判定交给模型**（注册工具让模型调用），不从用户消息里猜。
- **承诺必须兑现**：说"可恢复"就得有恢复入口。
- **规则写成显式数据**，每条配"为什么存在"的注释与用例。
- **失败降级、不阻断对话**，并落自有审计。
- **验证要结构性**：能读日志/文件的，别只靠"模型这么说"；能查数据库的，别只看 UI。
- **脱敏**：测试全用合成数据；`.env`、凭据、真实记忆永不入库。
- **小步提交**：gitmoji + conventional commit。
