/**
 * @dsh-external/dsh-lepimemory-state
 *
 * Phase 1 最小「状态注入」实验插件：
 *   把一个硬编码的状态文本注册为 system prompt 的一个 section。
 *   改 config.state（profile 补丁 / --patch 叠加）即可改变模型看到的状态 → 观察语气变化。
 *
 * 之后（Phase 2）这里会换成状态机提供的动态状态。
 *
 * 关于 section 的 order（重要，不要当魔数改）：
 *   dsh 的中央分配表（dsh-system-prompt 的 SECTION_ORDERS）中，与人设相关的只有两个槽位：
 *   DEPLOYMENT_PERSONA_PREFIX = 0、DEPLOYMENT_PERSONA_SUFFIX = 10200
 *   （见 packages/preset/persona/src/index.ts:64-71——persona 包的 prefix/suffix 即这两个槽位）。
 *
 *   本插件是 out-of-tree 贡献，上游 README 明确「External contributions may use any finite
 *   order」；且这两个常量**不在** published exports 里（@deepseek-ai/dsh 只导出
 *   ./profile-boot 与 ./lib/*），无法 import，只能自持。
 *
 *   STATE_SECTION_ORDER = 50 的实际位置是 (0, 500) 区间：人设 prefix 之后、PLAN_POLICY(500)
 *   之前。注意 (0, 10200) 之间全是工具/策略段，**没有更「正统」的槽位可选**——
 *   所以此处只做一件事：给魔数命名并写清依据，不假装挪动了位置。
 */
export const name = "lepimemory-state";

/**
 * 状态 section 的排序值：人设 prefix(order 0) 之后、策略段(500) 之前。
 * 依据见文件头注释。改动前请确认 dsh 上游 SECTION_ORDERS 未变。
 */
export const STATE_SECTION_ORDER = 50;

/** 需要 prompt 注册表就绪后才 apply。 */
export const inject = ["systemPrompt"];

/**
 * 注册状态 section。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ state?: string }} [config]
 */
export function apply(ctx, config) {
    const state =
        config && typeof config.state === "string" && config.state.length > 0
            ? config.state
            : "（未设置）";
    ctx.effect(
        () =>
            ctx.systemPrompt.section({
                name: "lepimemory:state",
                order: STATE_SECTION_ORDER,
                text: `【内部状态（实验）】${state}`,
            }),
        "lepimemory-state.section()",
    );
}
