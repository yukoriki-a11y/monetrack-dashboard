// 日本の祝日判定。
//
// 外部APIに頼ると通信が増えるうえ落ちたときに壊れるので、法律の規則から計算する。
// 2007年以降の現行ルールが対象（それより前は対応していない）。
// 春分・秋分は近似式（1980〜2099年で実用上一致する）。

const NAMES = {
  newYear: '元日',
  comingOfAge: '成人の日',
  foundation: '建国記念の日',
  emperor: '天皇誕生日',
  vernal: '春分の日',
  showa: '昭和の日',
  constitution: '憲法記念日',
  greenery: 'みどりの日',
  children: 'こどもの日',
  sea: '海の日',
  mountain: '山の日',
  respect: '敬老の日',
  autumnal: '秋分の日',
  sports: 'スポーツの日',
  culture: '文化の日',
  labor: '勤労感謝の日',
  substitute: '振替休日',
  citizens: '国民の休日',
};

const cache = new Map();

const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// その月の n 番目の月曜日
function nthMonday(year, month, nth) {
  const first = new Date(year, month - 1, 1).getDay();      // 0=日
  const offset = (8 - first) % 7;                            // 最初の月曜までの日数
  return 1 + offset + (nth - 1) * 7;
}

// 春分・秋分の近似式
const vernalDay = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnalDay = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

function build(year) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const set = (m, d, name) => map.set(key(year, m, d), name);

  set(1, 1, NAMES.newYear);
  set(1, nthMonday(year, 1, 2), NAMES.comingOfAge);
  set(2, 11, NAMES.foundation);
  if (year >= 2020) set(2, 23, NAMES.emperor);
  set(3, vernalDay(year), NAMES.vernal);
  set(4, 29, NAMES.showa);
  set(5, 3, NAMES.constitution);
  set(5, 4, NAMES.greenery);
  set(5, 5, NAMES.children);
  set(7, nthMonday(year, 7, 3), NAMES.sea);
  if (year >= 2016) set(8, 11, NAMES.mountain);
  set(9, nthMonday(year, 9, 3), NAMES.respect);
  set(9, autumnalDay(year), NAMES.autumnal);
  set(10, nthMonday(year, 10, 2), NAMES.sports);
  set(11, 3, NAMES.culture);
  set(11, 23, NAMES.labor);

  // 振替休日: 祝日が日曜なら、その後の最初の平日を休みにする
  for (const k of [...map.keys()]) {
    const [y, m, d] = k.split('-').map(Number);
    if (new Date(y, m - 1, d).getDay() !== 0) continue;
    const next = new Date(y, m - 1, d);
    do { next.setDate(next.getDate() + 1); }
    while (map.has(key(next.getFullYear(), next.getMonth() + 1, next.getDate())));
    map.set(key(next.getFullYear(), next.getMonth() + 1, next.getDate()), NAMES.substitute);
  }

  // 国民の休日: 祝日に挟まれた平日（敬老の日と秋分の日の間など）
  for (const k of [...map.keys()]) {
    const [y, m, d] = k.split('-').map(Number);
    const mid = new Date(y, m - 1, d + 1);
    const after = new Date(y, m - 1, d + 2);
    const midKey = key(mid.getFullYear(), mid.getMonth() + 1, mid.getDate());
    const afterKey = key(after.getFullYear(), after.getMonth() + 1, after.getDate());
    if (!map.has(midKey) && map.has(afterKey) && mid.getDay() !== 0 && mid.getDay() !== 6) {
      map.set(midKey, NAMES.citizens);
    }
  }

  return map;
}

function forYear(year) {
  if (!cache.has(year)) cache.set(year, build(year));
  return cache.get(year);
}

// 'YYYY-MM-DD' → 祝日名 or null
export function holidayName(ymdStr) {
  const year = Number(String(ymdStr).slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return forYear(year).get(String(ymdStr)) ?? null;
}

// 土日祝のどれかを返す（'sat' | 'sun' | 'holiday' | null）
// 祝日が土日と重なった場合は祝日として扱う。
export function dayKind(ymdStr, weekday) {
  if (holidayName(ymdStr)) return 'holiday';
  if (weekday === 6) return 'sat';
  if (weekday === 0) return 'sun';
  return null;
}
