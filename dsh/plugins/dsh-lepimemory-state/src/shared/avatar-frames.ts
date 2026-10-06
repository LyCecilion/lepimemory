/**
 * 立绘差分候选表（活动 → 基调 → 候选 key）与预热清单。
 *
 * 从客户端 `client.js` 抽出为共享模块，服务端/浏览器两侧共用同一份键序列；
 * 所有 key 必须存在于 `avatar-assets.ts` 的 `AVATAR_ASSETS` 清单（由 `AvatarKey` 静态约束）。
 */
import type { AvatarKey } from "./avatar-assets.js";

/** 立绘活动（由会话信号推导）。 */
export type AvatarActivity = "idle" | "think" | "speak" | "tool" | "approval" | "question" | "error";
/** 立绘基调（由状态快照推导）。 */
export type AvatarTone = "bright" | "plain" | "low";

interface AvatarFrameTable {
    bright: readonly AvatarKey[];
    plain: readonly AvatarKey[];
    low: readonly AvatarKey[];
    /** 仅 idle 使用的「关系亲近」候选组。 */
    near?: readonly AvatarKey[];
}

/**
 * 立绘差分候选表：活动 → 基调 → 候选 key（按序：首选加载失败才取下一个）。
 * idle 另有 `near`（关系亲近）候选组。所有 key 必须存在于 host 的 AVATAR_ASSETS 清单。
 */
export const AVATAR_FRAMES: Record<AvatarActivity, AvatarFrameTable> = {
    idle: {
        bright: ['laugh', 'celebrate', 'cheers'],
        plain: ['idle-pngtuber', 'work', 'blink'],
        low: ['daze', 'sleep', 'sweat'],
        near: ['nosetouch', 'heart', 'greet', 'rose', 'lick'],
    },
    think: {
        bright: ['think', 'idea', 'cheer'],
        plain: ['think', 'idea', 'loading'],
        low: ['clueless', 'dizzy', 'question'],
    },
    speak: {
        bright: ['glowstick', 'megaphone', 'bubble'],
        plain: ['type', 'megaphone', 'nod'],
        low: ['type-annoyed', 'type-angry', 'type'],
    },
    tool: {
        bright: ['magic', 'shades', 'knock'],
        plain: ['record', 'work', 'shades'],
        low: ['work-tired', 'work-angry', 'crowbar'],
    },
    approval: {
        bright: ['expect', 'press', 'bell'],
        plain: ['question', 'expect', 'button'],
        low: ['jailed', 'jailed1', 'nervous'],
    },
    question: {
        bright: ['expect', 'press', 'question'],
        plain: ['question', 'expect', 'button'],
        low: ['clueless', 'shocked', 'shy'],
    },
    error: {
        bright: ['clown', 'cheese'],
        plain: ['stop', 'angry', 'dead'],
        low: ['cry', 'cry2', 'trash'],
    },
};

/** 活动 → 候选 key 列表；idle 且关系亲近时，把近亲候选置顶。 */
export function avatarCandidates(activity: string, tone: string, near: boolean): readonly AvatarKey[] {
    const table = (AVATAR_FRAMES as Partial<Record<string, AvatarFrameTable>>)[activity] ?? AVATAR_FRAMES.idle;
    const toneTable: Record<string, readonly AvatarKey[]> = { bright: table.bright, plain: table.plain, low: table.low };
    const toneList = toneTable[tone] ?? table.plain;
    return activity === "idle" && near === true ? [...(table.near ?? []), ...toneList] : toneList;
}

/** 预热每个 (活动, 基调) 的首选帧（含 idle 的 near 首选）；列表其余项是加载失败回退，按需再取。 */
export const AVATAR_PRELOAD_KEYS: readonly AvatarKey[] = Array.from(
    new Set(
        Object.values(AVATAR_FRAMES).flatMap((table) =>
            Object.values(table).map((list) => list?.[0]),
        ),
    ),
).filter((key): key is AvatarKey => key !== undefined);
