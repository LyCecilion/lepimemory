# Phase 1 实验：状态注入 → 语气变化（A/B）

- 日期：2026-09-28
- 插件：`@dsh-external/dsh-lepimemory-state`（源码：`dsh/plugins/dsh-lepimemory-state/`）
- 机制：插件把一个状态文本注册为 system prompt section（order 50）；
  用 `--patch` 叠加**只改 `state`**，其余一切不变 → 差异只能归因于状态文本。
- 运行：

  ```bash
  dsh --profile lepimemory-headless --patch /tmp/lepimemory-dsh-tests/ab-a.yml "今天过得怎么样？随便聊两句吧。"
  dsh --profile lepimemory-headless --patch /tmp/lepimemory-dsh-tests/ab-b.yml "今天过得怎么样？随便聊两句吧。"
  ```

## 状态 A ——「很疲惫、情绪低落，说话简短、有点敷衍」

> 还行吧，就那样。忙了一天，有点累。
>
> 你呢？

## 状态 B ——「心情特别好、很兴奋，说话热情、话多」

> 哈哈，谢啦，今天挺带劲的！虽然我这"一天"其实就是在 `/tmp/lepimemory-dsh-tests` 这个工作目录里待命，随时准备帮你跑命令、翻文件、查资料——但你懂的，能干活本身就让我挺兴奋的 😄
>
> 今天手头的感觉就是：状态在线，脑子清楚，随时能上手。你要是有什么想弄的——写点代码、debug、查个东西、或者纯粹想吐槽两句——我都接得住。
>
> 那你呢？今天过得怎么样？是忙得飞起，还是悠闲摸鱼？说说看，我陪你唠。🙌

> ⚠️ **读状态 B 时请注意**：回复里「在 `/tmp/lepimemory-dsh-tests` 这个工作目录里待命，随时准备帮你跑命令、翻文件、查资料」
> 是**底座 coding-agent 人设的渗透**，不是目标角色文案。本实验的变量只有状态文本，
> persona 遮蔽尚未落地（见 `dsh-findings.md` §6.3）。
> 结论不变（状态能改语气），但**不要拿状态 B 的措辞当角色文案范例**。

## 结论

- 同一输入、仅换状态文本 → **语气显著变化**（短平敷衍 ⇄ 长热情带 emoji）✅
- Phase 1 关键假设成立：**能把状态注入 dsh 并观察到效果**（且完全不碰记忆系统）
- 下一步：Phase 2 用真实状态机替换这里的硬编码文本（插件保持同一 section 机制）
