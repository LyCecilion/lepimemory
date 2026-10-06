/**
 * 立绘差分清单（单一事实来源）：key → 素材文件名。
 *
 * 素材为「大肥鱼2.0」高清差分，统一命名：去掉原 `大肥鱼2.0_` 前缀与尾部日期戳，只留语义标签
 * （如 `工作(普通).gif`）。均为 256×256 GIF89a（立绘显示尺寸 128px，2× 视网膜清晰度）。
 *
 * 全量 62 帧；`AVATAR_FRAMES`（client.js）只引用其中与各状态贴切的一部分，其余留作备用。
 * `nosetouch` / `bell` 沿用高清目录里语义最接近的两帧：
 *   - nosetouch → `摸头.gif`（亲近/蹭头）
 *   - bell      → `叹号.gif`（提醒/注意）
 *
 * 路由（lib/panel.js `avatarRoute`）与测试（test/avatar.test.js）都从这里取值，
 * 保证「键名拼写」与「素材是否齐全」只有一个权威定义。
 */
export const AVATAR_ASSETS = Object.freeze({
    // —— 工作 / 打字 ——
    'work-tired': '工作(疲倦).gif',
    'work': '工作(普通).gif',
    'work-nap': '工作(小睡).gif',
    'work-angry': '工作(生气).gif',
    'type-annoyed': '打字(恼怒).gif',
    'type': '打字(普通).gif',
    'type-angry': '打字(生气).gif',
    'record': '记录 1.gif',
    // —— 情绪 / 表情 ——
    'idea': '主意.gif',
    'think': '思考(自信地).gif',
    'clueless': '六七.gif',
    'daze': '呆 1.gif',
    'blink': '眨眼.gif',
    'laugh': '笑.gif',
    'cheer': '加油.gif',
    'cheers': '干杯.gif',
    'celebrate': '庆祝.gif',
    'clown': '小丑 1.gif',
    'angry': '生气.gif',
    'cry': '哭 1.gif',
    'cry2': '哭 2.gif',
    'dead': '死亡.gif',
    'shocked': '惊吓.gif',
    'scared': '害怕 1.gif',
    'nervous': '紧张 1.gif',
    'sweat': '汗.gif',
    'dizzy': '头晕.gif',
    'shy': '害羞 2.gif',
    'lick': '舔舔.gif',
    'heart': '爱心 3.gif',
    'rose': '玫瑰.gif',
    // —— 交流 / 提示 ——
    'greet': '打招呼 1.gif',
    'nod': '点头.gif',
    'shake': '摇头.gif',
    'question': '问号.gif',
    'bell': '叹号.gif',
    'megaphone': '扩音器.gif',
    'bubble': '冒泡 1.gif',
    'expect': '期待 1.gif',
    'stop': '停止.gif',
    'arrive': '到达.gif',
    // —— 工具 / 状态 ——
    'shades': '墨镜反光.gif',
    'knock': '敲头.gif',
    'crowbar': '撬棍 3.gif',
    'press': '按钮 (拍击).gif',
    'button': '按钮.gif',
    'magic': '魔法.gif',
    'guitar': '吉他.gif',
    'cola': '摇可乐.gif',
    'drink': '喝(饮料杯).gif',
    'gift': '礼物 1.gif',
    'glowstick': '荧光棒 2.gif',
    'fan': '电风扇 2.gif',
    'loading': '加载(茶_咖啡杯).gif',
    'loading-sleep': '加载(睡觉).gif',
    'sleep': '睡觉(普通).gif',
    'idle-pngtuber': 'PNGTuber 闲置.gif',
    'cheese': '奶酪糊脸.gif',
    'jailed': '坐牢 2.gif',
    'jailed1': '坐牢 1.gif',
    'trash': '垃圾桶.gif',
    'nosetouch': '摸头.gif',
});
