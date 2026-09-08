// 見た目の設定。このブラウザにだけ保存する（サーバには送らない）。
//
// 配色は「OSに合わせる/明るい/暗い」の3択。auto のときだけ
// prefers-color-scheme に従うので、CSS 側は
//   :root                                   … 明るい既定
//   @media (dark) { :root:not([data-theme=light]) } … OSが暗いとき
//   :root[data-theme=dark]                  … 手動で暗いを選んだとき
// の3段構えにしてある。

const LS = 'afd.settings';

// グラフの系列色。見分けやすさ優先の既定と、落ち着いた/鮮やか/無彩色。
export const PALETTES = {
  standard: {
    label: '標準',
    colors: ['#2f6feb', '#e07b39', '#13866f', '#a259c4', '#c2413a',
      '#0e8ecf', '#b8730b', '#5b6775', '#3fa06a', '#cf5b8f', '#7b6bd6', '#c9a227'],
  },
  calm: {
    label: '落ち着いた',
    colors: ['#4a6fa5', '#8a9a5b', '#b08968', '#7d8491', '#a3777f',
      '#5f8a8b', '#9c8aa5', '#6b7f9e', '#8f9779', '#b39c86', '#7a8b99', '#a08a9c'],
  },
  vivid: {
    label: '鮮やか',
    colors: ['#0f62fe', '#ff6b00', '#00a878', '#c026d3', '#e11d48',
      '#0891b2', '#eab308', '#7c3aed', '#16a34a', '#ec4899', '#f97316', '#0ea5e9'],
  },
  mono: {
    label: '単色（濃淡だけ）',
    colors: ['#1c2430', '#39465a', '#556582', '#7183a1', '#8fa0ba',
      '#a9b7cc', '#c2ccdb', '#d6dde7', '#454f5f', '#6a7789', '#93a0b1', '#bcc5d1'],
  },
  colorblind: {
    label: '色覚に配慮',
    colors: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00',
      '#56b4e9', '#f0e442', '#666666', '#117733', '#882255', '#88ccee', '#999933'],
  },
};

const DEFAULTS = {
  theme: 'auto',              // auto | light | dark
  palette: 'standard',
  statusColor: true,          // 承認=緑 / 保留=黄 / 却下=赤
  density: 'normal',          // compact | normal | large
};

let current = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || '{}');
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function settings() {
  return current;
}

export function defaults() {
  return { ...DEFAULTS };
}

export function palette() {
  return (PALETTES[current.palette] || PALETTES.standard).colors;
}

// 変更を保存して <html> に反映する。呼び出し側は戻り値を見ずに
// 「再描画が要るか」を onChange で受け取る。
export function update(patch) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(LS, JSON.stringify(current));
  } catch {
    /* プライベートモードなどで保存できなくても、その場の見た目は変える */
  }
  applyToDocument();
}

export function reset() {
  current = { ...DEFAULTS };
  try {
    localStorage.removeItem(LS);
  } catch { /* 保存できなくても続行 */ }
  applyToDocument();
}

// 実際に暗い表示になっているか（グラフの文字色を決めるのに使う）
export function isDark() {
  if (current.theme === 'dark') return true;
  if (current.theme === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyToDocument() {
  const root = document.documentElement;
  if (current.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = current.theme;

  root.dataset.density = current.density;
  root.dataset.statusColor = current.statusColor ? 'on' : 'off';
}
