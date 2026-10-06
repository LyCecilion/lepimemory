/**
 * 立绘差分清单（单一事实来源）：key → 素材文件名。
 *
 * 素材为「大肥鱼2.0」高清差分，统一命名：去掉原 `大肥鱼2.0_` 前缀与尾部日期戳，只留语义标签
 * （如 `工作(普通).gif`）。均为 256×256 GIF89a（立绘显示尺寸 128px，2× 视网膜清晰度）。
 *
 * `nosetouch` / `bell` 在高清源里没有同名差分，改用语义最接近的两帧：
 *   - nosetouch → `摸头.gif`（亲近/蹭头）
 *   - bell      → `叹号.gif`（提醒/注意）
 *
 * 路由（lib/panel.js `avatarRoute`）与测试（test/avatar.test.js）都从这里取值，
 * 保证「键名拼写」与「素材是否齐全」只有一个权威定义。
 */
export const AVATAR_ASSETS = Object.freeze({
    'work-tired': '工作(疲倦).gif',
    'work': '工作(普通).gif',
    'work-angry': '工作(生气).gif',
    'type-annoyed': '打字(恼怒).gif',
    'type': '打字(普通).gif',
    'trash': '垃圾桶.gif',
    'shades': '墨镜反光.gif',
    'sleep': '睡觉(普通).gif',
    'clueless': '六七.gif',
    'question': '问号.gif',
    'megaphone': '扩音器.gif',
    'bubble': '冒泡 1.gif',
    'loading': '加载(茶_咖啡杯).gif',
    'jailed': '坐牢 2.gif',
    'idea': '主意.gif',
    'greet': '打招呼 1.gif',
    'daze': '呆 1.gif',
    'dead': '死亡.gif',
    'cry': '哭 1.gif',
    'clown': '小丑 1.gif',
    'cheers': '干杯.gif',
    'cheer': '加油.gif',
    'celebrate': '庆祝.gif',
    'press': '按钮 (拍击).gif',
    'button': '按钮.gif',
    'knock': '敲头.gif',
    'angry': '生气.gif',
    'nosetouch': '摸头.gif',
    'bell': '叹号.gif',
});
