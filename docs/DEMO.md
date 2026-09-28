<!-- DEMO 骨架草稿 v0.1（由 Agent 起草，待定稿） -->

# DEMO — 评委自助路径

## 1. 运行

```bash
cp .env.example .env     # 可留空
make dev                 # 首次启动请等待 1–2 分钟（Hindsight 经 hf-mirror 拉多语言模型）
# 打开 http://127.0.0.1:3080
```

零 key 路径：把 `HINDSIGHT_API_LLM_PROVIDER` 设为 `none`（Hindsight `chunks` 模式，无 LLM 成本）即可看到前几步。

## 2. 演示剧本（对应 CONCEPTS §6.5）

1. 聊几轮，埋一条信息（例：「我下周三要去见一个重要的人」）
2. **换一个会话**（证明跨会话记忆）→ 角色主动问起这件事
3. 打开审计面板：**这句话被哪条记忆驱动**
4. 让角色执行一个真实行动（产生真实副作用，非「我帮你记下了」）
5. 要求「忘掉刚才那个人」→ 展示**遗忘计划预览** → 确认 → 后续不再提起

> 第 5 步是最能拉开差距的一段：多数实现会把「忘记」做成一个 DELETE。
> 每步的预期现象、截图位、解说词待补。

## 3. 故障排查（占位）

- Hindsight 首次启动慢 / 健康检查未过 → 等待，或 `docker compose logs -f hindsight`
- 端口被占用 → `make dev PORT=3181`
- dsh 起不来（本机 Nix 环境）→ 见 `docs/research/dsh-findings.md` §3.1
