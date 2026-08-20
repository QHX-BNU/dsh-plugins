/**
 * 时间计算单元测试：验证 computeNextRun / parseClock / wallTimeToEpoch。
 * 运行：node test/time.test.mjs
 */
import { computeNextRun, parseAtInput, parseClock } from '../lib/scheduler.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

// parseClock
check('parseClock valid', parseClock('09:30'), { hour: 9, minute: 30 });
check('parseClock invalid', parseClock('9:30'), null);
check('parseClock invalid2', parseClock('25:00'), null);

// 固定基准时间：2026-08-20T04:00:00Z = Asia/Shanghai 2026-08-20 12:00
const base = Date.parse('2026-08-20T04:00:00Z');

// once：未来时间
const onceTask = { mode: 'once', at: '2026-08-20T05:00:00Z', timeZone: 'Asia/Shanghai' };
check('once future', computeNextRun(onceTask, base), Date.parse('2026-08-20T05:00:00Z'));

// once：已过期 → null
const oncePast = { mode: 'once', at: '2026-08-20T03:00:00Z', timeZone: 'Asia/Shanghai' };
check('once past -> null', computeNextRun(oncePast, base), null);

// daily：Asia/Shanghai 今天 09:00（本地已是 12:00，今天 09:00 已过 → 明天 09:00 = 01:00Z）
const daily = { mode: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
check('daily today-past -> tomorrow', computeNextRun(daily, base), Date.parse('2026-08-21T01:00:00Z'));

// daily：本地今天 13:00（未到 → 今天 13:00 = 05:00Z）
const daily2 = { mode: 'daily', time: '13:00', timeZone: 'Asia/Shanghai' };
check('daily today-future', computeNextRun(daily2, base), Date.parse('2026-08-20T05:00:00Z'));

// weekly：周三（2026-08-20 是周四）。选周一/周三/周五 10:00 → 周五 2026-08-21T02:00Z
const weekly = { mode: 'weekly', time: '10:00', weekdays: [1, 3, 5], timeZone: 'Asia/Shanghai' };
check('weekly next friday', computeNextRun(weekly, base), Date.parse('2026-08-21T02:00:00Z'));

// weekly：只有周一 → 2026-08-24（周一）10:00 = 02:00Z
const weekly2 = { mode: 'weekly', time: '10:00', weekdays: [1], timeZone: 'Asia/Shanghai' };
check('weekly only monday', computeNextRun(weekly2, base), Date.parse('2026-08-24T02:00:00Z'));

// interval：每 30 分钟，lastRunAt = base-10min → 下一个自然点 = base+20min
const interval = { mode: 'interval', intervalMinutes: 30, lastRunAt: base - 10 * 60000, createdAt: base - 10 * 60000 };
check('interval next natural point', computeNextRun(interval, base), base + 20 * 60000);

// interval：从未运行，createdAt = base-70min → 下一个 k 使 base-70min + k*30min > base → k=3 → base+20min
const interval2 = { mode: 'interval', intervalMinutes: 30, lastRunAt: null, createdAt: base - 70 * 60000 };
check('interval skip missed', computeNextRun(interval2, base), base + 20 * 60000);

// interval：lastRunAt = base+5min（未来，理论上不会发生）→ base+35min
const interval3 = { mode: 'interval', intervalMinutes: 30, lastRunAt: base + 5 * 60000, createdAt: base };
check('interval future base', computeNextRun(interval3, base), base + 35 * 60000);

// DST：美国洛杉矶 2026-03-08 02:00 切 DST（2026-03-08 01:59 PST → 03:00 PDT）。
// daily 01:30 在 2026-03-08 当天：01:30 PST 存在 → 返回当天 01:30 PST = 09:30Z
const dstBase = Date.parse('2026-03-08T00:00:00Z'); // 洛杉矶 03-07 16:00 PST
const dstDaily = { mode: 'daily', time: '01:30', timeZone: 'America/Los_Angeles' };
// 03-08 01:30 PST 实际是 09:30Z（在 03-08 00:00Z 之后）→ 应返回当天
check('dst daily', computeNextRun(dstDaily, dstBase), Date.parse('2026-03-08T09:30:00Z'));

// DST：洛杉矶 daily 02:30 在 2026-03-08（02:00-03:00 不存在）→ 映射到时钟跳变后 03:30 PDT = 10:30Z
const dstDaily2 = { mode: 'daily', time: '02:30', timeZone: 'America/Los_Angeles' };
check('dst daily gap hour', computeNextRun(dstDaily2, dstBase), Date.parse('2026-03-08T10:30:00Z'));

// 负偏移时区：纽约（EDT = UTC-4），2026-08-20 03:00Z = 纽约 08-19 23:00
// daily 23:30 → 纽约今天（08-19）23:30 未到（现在 23:00）→ 今天 23:30 = 08-20T03:30Z
const nyBase = Date.parse('2026-08-20T03:00:00Z'); // 纽约 08-19 23:00 EDT
const nyDaily = { mode: 'daily', time: '23:30', timeZone: 'America/New_York' };
check('ny daily today-future', computeNextRun(nyDaily, nyBase), Date.parse('2026-08-20T03:30:00Z'));

// 纽约 daily 22:00 → 今天已过 → 明天 22:00 EDT = 08-21T02:00Z
const nyDaily2 = { mode: 'daily', time: '22:00', timeZone: 'America/New_York' };
check('ny daily tomorrow', computeNextRun(nyDaily2, nyBase), Date.parse('2026-08-21T02:00:00Z'));

// ===== 起止日期范围 =====
// daily 09:00 上海，base = 2026-08-20 04:00Z（上海 12:00）；endDate = 今天 → 今天 09:00 已过且无明天 → null
const range1 = { mode: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', endDate: '2026-08-20' };
check('range daily end today past -> null', computeNextRun(range1, base), null);

// daily 09:00 上海，startDate = 2026-08-25 → 下次 = 08-25 09:00 = 08-25T01:00Z
const range2 = { mode: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', startDate: '2026-08-25' };
check('range daily start future', computeNextRun(range2, base), Date.parse('2026-08-25T01:00:00Z'));

// daily 13:00 上海（今天 13:00 未到），范围 08-20 ~ 08-22 → 今天 13:00 = 05:00Z
const range3 = { mode: 'daily', time: '13:00', timeZone: 'Asia/Shanghai', startDate: '2026-08-20', endDate: '2026-08-22' };
check('range daily within window', computeNextRun(range3, base), Date.parse('2026-08-20T05:00:00Z'));

// weekly 一三五 10:00，范围 08-24（周一）~ 08-30（周日）→ 08-24 10:00 = 02:00Z
const range4 = { mode: 'weekly', time: '10:00', weekdays: [1, 3, 5], timeZone: 'Asia/Shanghai', startDate: '2026-08-24', endDate: '2026-08-30' };
check('range weekly start monday', computeNextRun(range4, base), Date.parse('2026-08-24T02:00:00Z'));

// weekly 周一 10:00，endDate = 2026-08-23（周日，在下一个周一之前）→ null
const range5 = { mode: 'weekly', time: '10:00', weekdays: [1], timeZone: 'Asia/Shanghai', endDate: '2026-08-23' };
check('range weekly end before next monday -> null', computeNextRun(range5, base), null);

// interval 30 分钟，base = 2 小时前，endDate = 昨天（2026-08-19）→ 下一个自然点已超范围 → null
const range6 = { mode: 'interval', intervalMinutes: 30, lastRunAt: base - 120 * 60000, createdAt: base - 120 * 60000, timeZone: 'Asia/Shanghai', endDate: '2026-08-19' };
check('range interval past end -> null', computeNextRun(range6, base), null);

// interval 30 分钟，startDate = 明天（2026-08-21）→ 从明天 00:00（上海 = 08-20T16:00Z）起对齐：第一个自然点 08-21 00:30 = 08-20T16:30Z
const range7 = { mode: 'interval', intervalMinutes: 30, lastRunAt: base, createdAt: base, timeZone: 'Asia/Shanghai', startDate: '2026-08-21' };
const r7 = computeNextRun(range7, base);
check('range interval start future', r7, Date.parse('2026-08-20T16:30:00Z'));

// 范围 + DST：洛杉矶 daily 01:30，范围 03-07 ~ 03-09（跨越 DST 切换日）→ 03-08 01:30 PST = 09:30Z
const range8 = { mode: 'daily', time: '01:30', timeZone: 'America/Los_Angeles', startDate: '2026-03-07', endDate: '2026-03-09' };
check('range dst crossing', computeNextRun(range8, dstBase), Date.parse('2026-03-08T09:30:00Z'));

// ===== parseAtInput（Agent 工具的一次性时间解析）=====
// 带偏移 ISO → 直接转换
check('at with offset', parseAtInput('2026-08-21T09:00:00+08:00'), '2026-08-21T01:00:00.000Z');
// UTC Z
check('at with Z', parseAtInput('2026-08-21T09:00:00Z'), '2026-08-21T09:00:00.000Z');
// 无偏移 + 时区解释
check('at local + tz', parseAtInput('2026-08-21T09:00', 'Asia/Shanghai'), '2026-08-21T01:00:00.000Z');
// 空格分隔
check('at space separated', parseAtInput('2026-08-21 09:00', 'Asia/Shanghai'), '2026-08-21T01:00:00.000Z');
// 无偏移 + 非法时区 → 回退 UTC
check('at local fallback tz', parseAtInput('2026-08-21T09:00', 'Mars/Olympus'), '2026-08-21T09:00:00.000Z');
// 带秒
check('at with seconds', parseAtInput('2026-08-21T09:00:30+08:00'), '2026-08-21T01:00:30.000Z');
// 非法输入抛错
let threw = false;
try { parseAtInput('not a date'); } catch { threw = true; }
check('at rejects garbage', threw, true);
threw = false;
try { parseAtInput(''); } catch { threw = true; }
check('at rejects empty', threw, true);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
