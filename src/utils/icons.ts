import { icons } from 'lucide';

type IconName = keyof typeof icons;

function svg(iconName: IconName, cls?: string, sz = 16): string {
  const children = (icons as any)[iconName] as [string, Record<string, string>][];
  if (!children) return '';
  const inner = children
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls || ''}">${inner}</svg>`;
}

function dot(color: string, cls?: string, sz = 16): string {
  return `<svg width="${sz}" height="${sz}" viewBox="0 0 16 16" fill="none" class="${cls || ''}"><circle cx="8" cy="8" r="7" fill="${color}"/></svg>`;
}

export const I = {
  // ── Navigation / Pages ──────────────────────────────────────────────
  home: (c?: string, s?: number) => svg('Home', c, s),
  chart: (c?: string, s?: number) => svg('BarChart3', c, s),
  chartBar: (c?: string, s?: number) => svg('BarChart', c, s),
  chartPie: (c?: string, s?: number) => svg('PieChart', c, s),
  chartActivity: (c?: string, s?: number) => svg('Activity', c, s),
  package: (c?: string, s?: number) => svg('Package', c, s),
  search: (c?: string, s?: number) => svg('Search', c, s),
  dollarSign: (c?: string, s?: number) => svg('DollarSign', c, s),
  messageCircle: (c?: string, s?: number) => svg('MessageCircle', c, s),
  store: (c?: string, s?: number) => svg('Store', c, s),
  settings: (c?: string, s?: number) => svg('Settings', c, s),
  users: (c?: string, s?: number) => svg('Users', c, s),
  user: (c?: string, s?: number) => svg('UserCircle', c, s),
  layers: (c?: string, s?: number) => svg('Layers', c, s),
  box: (c?: string, s?: number) => svg('Package', c, s),
  inbox: (c?: string, s?: number) => svg('Inbox', c, s),
  archive: (c?: string, s?: number) => svg('Archive', c, s),

  // ── Actions ─────────────────────────────────────────────────────────
  refresh: (c?: string, s?: number) => svg('RefreshCw', c, s),
  download: (c?: string, s?: number) => svg('Download', c, s),
  upload: (c?: string, s?: number) => svg('Upload', c, s),
  clipboard: (c?: string, s?: number) => svg('ClipboardList', c, s),
  paperclip: (c?: string, s?: number) => svg('Paperclip', c, s),
  save: (c?: string, s?: number) => svg('Save', c, s),
  trash: (c?: string, s?: number) => svg('Trash2', c, s),
  eye: (c?: string, s?: number) => svg('Eye', c, s),
  eyeOff: (c?: string, s?: number) => svg('EyeOff', c, s),
  edit: (c?: string, s?: number) => svg('Pencil', c, s),
  pencil: (c?: string, s?: number) => svg('Pencil', c, s),
  send: (c?: string, s?: number) => svg('Send', c, s),
  copy: (c?: string, s?: number) => svg('Copy', c, s),
  link: (c?: string, s?: number) => svg('Link', c, s),
  image: (c?: string, s?: number) => svg('Image', c, s),
  plus: (c?: string, s?: number) => svg('Plus', c, s),
  minus: (c?: string, s?: number) => svg('Minus', c, s),
  filter: (c?: string, s?: number) => svg('Filter', c, s),
  sortAsc: (c?: string, s?: number) => svg('SortAsc', c, s),
  sortDesc: (c?: string, s?: number) => svg('SortDesc', c, s),
  externalLink: (c?: string, s?: number) => svg('ExternalLink', c, s),
  grip: (c?: string, s?: number) => svg('GripVertical', c, s),
  move: (c?: string, s?: number) => svg('Move', c, s),
  pointer: (c?: string, s?: number) => svg('MousePointer2', c, s),

  // ── Status ──────────────────────────────────────────────────────────
  check: (c?: string, s?: number) => svg('Check', c, s),
  x: (c?: string, s?: number) => svg('X', c, s),
  checkCircle: (c?: string, s?: number) => svg('CircleCheck', c, s),
  xCircle: (c?: string, s?: number) => svg('XCircle', c, s),
  alertTriangle: (c?: string, s?: number) => svg('AlertTriangle', c, s),
  alertCircle: (c?: string, s?: number) => svg('CircleAlert', c, s),
  info: (c?: string, s?: number) => svg('Info', c, s),
  help: (c?: string, s?: number) => svg('CircleHelp', c, s),
  ban: (c?: string, s?: number) => svg('Ban', c, s),
  circleDot: (c?: string, s?: number) => svg('CircleDot', c, s),
  loader: (c?: string, s?: number) => svg('Loader2', c, s),
  power: (c?: string, s?: number) => svg('Power', c, s),
  powerOff: (c?: string, s?: number) => svg('PowerOff', c, s),

  // ── Security ────────────────────────────────────────────────────────
  key: (c?: string, s?: number) => svg('Key', c, s),
  lock: (c?: string, s?: number) => svg('Lock', c, s),
  shield: (c?: string, s?: number) => svg('Shield', c, s),
  shieldCheck: (c?: string, s?: number) => svg('ShieldCheck', c, s),
  shieldAlert: (c?: string, s?: number) => svg('ShieldAlert', c, s),
  fingerprint: (c?: string, s?: number) => svg('Fingerprint', c, s),

  // ── Data / Types ────────────────────────────────────────────────────
  hash: (c?: string, s?: number) => svg('Hash', c, s),
  type: (c?: string, s?: number) => svg('Type', c, s),
  fileText: (c?: string, s?: number) => svg('FileText', c, s),
  fileSpreadsheet: (c?: string, s?: number) => svg('FileSpreadsheet', c, s),
  tag: (c?: string, s?: number) => svg('Tag', c, s),
  tags: (c?: string, s?: number) => svg('Tags', c, s),
  badgePercent: (c?: string, s?: number) => svg('BadgePercent', c, s),
  percent: (c?: string, s?: number) => svg('Percent', c, s),

  // ── Analytics / Charts ──────────────────────────────────────────────
  trendingUp: (c?: string, s?: number) => svg('TrendingUp', c, s),
  trendingDown: (c?: string, s?: number) => svg('TrendingDown', c, s),
  flame: (c?: string, s?: number) => svg('Flame', c, s),
  calendar: (c?: string, s?: number) => svg('Calendar', c, s),
  calendarDays: (c?: string, s?: number) => svg('CalendarDays', c, s),
  clock: (c?: string, s?: number) => svg('Clock', c, s),
  lightbulb: (c?: string, s?: number) => svg('Lightbulb', c, s),
  scale: (c?: string, s?: number) => svg('Scale', c, s),
  brainCircuit: (c?: string, s?: number) => svg('BrainCircuit', c, s),
  focus: (c?: string, s?: number) => svg('Focus', c, s),
  crosshair: (c?: string, s?: number) => svg('Crosshair', c, s),
  gauge: (c?: string, s?: number) => svg('Gauge', c, s),
  radar: (c?: string, s?: number) => svg('Radar', c, s),
  target: (c?: string, s?: number) => svg('Target', c, s),

  // ── Shopping / Commerce ─────────────────────────────────────────────
  shoppingCart: (c?: string, s?: number) => svg('ShoppingCart', c, s),
  shoppingBag: (c?: string, s?: number) => svg('ShoppingBag', c, s),
  wallet: (c?: string, s?: number) => svg('Wallet', c, s),
  creditCard: (c?: string, s?: number) => svg('CreditCard', c, s),
  coins: (c?: string, s?: number) => svg('Coins', c, s),
  piggyBank: (c?: string, s?: number) => svg('PiggyBank', c, s),
  receipt: (c?: string, s?: number) => svg('Receipt', c, s),
  banknote: (c?: string, s?: number) => svg('Banknote', c, s),
  circleDollar: (c?: string, s?: number) => svg('CircleDollarSign', c, s),

  // ── Folders / Files ─────────────────────────────────────────────────
  folder: (c?: string, s?: number) => svg('Folder', c, s),
  folderOpen: (c?: string, s?: number) => svg('FolderOpen', c, s),
  folderTree: (c?: string, s?: number) => svg('FolderTree', c, s),
  grid: (c?: string, s?: number) => svg('Grid3X3', c, s),
  briefcase: (c?: string, s?: number) => svg('Briefcase', c, s),
  table: (c?: string, s?: number) => svg('Table2', c, s),
  layout: (c?: string, s?: number) => svg('LayoutGrid', c, s),
  columns: (c?: string, s?: number) => svg('Columns3', c, s),
  rows: (c?: string, s?: number) => svg('Rows3', c, s),

  // ── Transport ───────────────────────────────────────────────────────
  truck: (c?: string, s?: number) => svg('Truck', c, s),
  plane: (c?: string, s?: number) => svg('Plane', c, s),
  car: (c?: string, s?: number) => svg('Car', c, s),
  navigation: (c?: string, s?: number) => svg('Navigation', c, s),
  map: (c?: string, s?: number) => svg('Map', c, s),
  mapPin: (c?: string, s?: number) => svg('MapPin', c, s),
  compass: (c?: string, s?: number) => svg('Compass', c, s),
  globe: (c?: string, s?: number) => svg('Globe', c, s),
  route: (c?: string, s?: number) => svg('Route', c, s),
  flag: (c?: string, s?: number) => svg('Flag', c, s),

  // ── Weather / Nature ────────────────────────────────────────────────
  sun: (c?: string, s?: number) => svg('Sun', c, s),
  moon: (c?: string, s?: number) => svg('Moon', c, s),
  cloud: (c?: string, s?: number) => svg('Cloud', c, s),
  cloudRain: (c?: string, s?: number) => svg('CloudRain', c, s),
  lightning: (c?: string, s?: number) => svg('CloudLightning', c, s),
  droplet: (c?: string, s?: number) => svg('Droplet', c, s),
  snowflake: (c?: string, s?: number) => svg('Snowflake', c, s),
  wind: (c?: string, s?: number) => svg('Wind', c, s),
  waves: (c?: string, s?: number) => svg('Waves', c, s),
  rainbow: (c?: string, s?: number) => svg('Rainbow', c, s),
  sunrise: (c?: string, s?: number) => svg('Sunrise', c, s),
  sunset: (c?: string, s?: number) => svg('Sunset', c, s),
  thermometer: (c?: string, s?: number) => svg('Thermometer', c, s),

  // ── People / Social ─────────────────────────────────────────────────
  star: (c?: string, s?: number) => svg('Star', c, s),
  diamond: (c?: string, s?: number) => svg('Diamond', c, s),
  heart: (c?: string, s?: number) => svg('Heart', c, s),
  award: (c?: string, s?: number) => svg('Award', c, s),
  medal: (c?: string, s?: number) => svg('Medal', c, s),
  trophy: (c?: string, s?: number) => svg('Trophy', c, s),
  crown: (c?: string, s?: number) => svg('Crown', c, s),
  gem: (c?: string, s?: number) => svg('Gem', c, s),
  ring: (c?: string, s?: number) => svg('Circle', c, s),
  smile: (c?: string, s?: number) => svg('Smile', c, s),
  sparkle: (c?: string, s?: number) => svg('Sparkles', c, s),
  partyPopper: (c?: string, s?: number) => svg('PartyPopper', c, s),
  wand: (c?: string, s?: number) => svg('WandSparkles', c, s),

  // ── Tech / Device ───────────────────────────────────────────────────
  smartphone: (c?: string, s?: number) => svg('Smartphone', c, s),
  laptop: (c?: string, s?: number) => svg('Laptop', c, s),
  monitor: (c?: string, s?: number) => svg('Monitor', c, s),
  tablet: (c?: string, s?: number) => svg('Tablet', c, s),
  cpu: (c?: string, s?: number) => svg('Cpu', c, s),
  server: (c?: string, s?: number) => svg('Server', c, s),
  database: (c?: string, s?: number) => svg('Database', c, s),
  hardDrive: (c?: string, s?: number) => svg('HardDrive', c, s),
  cloudUpload: (c?: string, s?: number) => svg('CloudUpload', c, s),
  wifi: (c?: string, s?: number) => svg('Wifi', c, s),
  signal: (c?: string, s?: number) => svg('Signal', c, s),
  bluetooth: (c?: string, s?: number) => svg('Bluetooth', c, s),
  cast: (c?: string, s?: number) => svg('Cast', c, s),
  radio: (c?: string, s?: number) => svg('Radio', c, s),
  mic: (c?: string, s?: number) => svg('Mic', c, s),
  volume: (c?: string, s?: number) => svg('Volume2', c, s),
  headphones: (c?: string, s?: number) => svg('Headphones', c, s),
  video: (c?: string, s?: number) => svg('Video', c, s),
  camera: (c?: string, s?: number) => svg('Camera', c, s),
  bot: (c?: string, s?: number) => svg('Bot', c, s),
  brain: (c?: string, s?: number) => svg('BrainCircuit', c, s),
  zap: (c?: string, s?: number) => svg('Zap', c, s),
  battery: (c?: string, s?: number) => svg('Battery', c, s),
  batteryLow: (c?: string, s?: number) => svg('BatteryLow', c, s),
  plug: (c?: string, s?: number) => svg('Plug', c, s),

  // ── Food ────────────────────────────────────────────────────────────
  coffee: (c?: string, s?: number) => svg('Coffee', c, s),

  // ── Arrows / Navigation ─────────────────────────────────────────────
  chevronRight: (c?: string, s?: number) => svg('ChevronRight', c, s),
  chevronDown: (c?: string, s?: number) => svg('ChevronDown', c, s),
  arrowUpRight: (c?: string, s?: number) => svg('ArrowUpRight', c, s),
  arrowDownRight: (c?: string, s?: number) => svg('ArrowDownRight', c, s),
  undo: (c?: string, s?: number) => svg('Undo2', c, s),
  repeat: (c?: string, s?: number) => svg('Repeat', c, s),
  rotateCcw: (c?: string, s?: number) => svg('RotateCcw', c, s),
  rotateCw: (c?: string, s?: number) => svg('RotateCw', c, s),
  moreHorizontal: (c?: string, s?: number) => svg('MoreHorizontal', c, s),
  timer: (c?: string, s?: number) => svg('Timer', c, s),
  hourglass: (c?: string, s?: number) => svg('Hourglass', c, s),
  loaderCircle: (c?: string, s?: number) => svg('Loader', c, s),
  sleep: (c?: string, s?: number) => svg('Moon', c, s),

  // ── Marketplace Brands (colored dots) ──────────────────────────────
  ozon: (c?: string, s?: number) => dot('#005bff', c, s),
  yandex: (c?: string, s?: number) => dot('#ffcc00', c, s),
  wb: (c?: string, s?: number) => dot('#a855f7', c, s),
  manual: (c?: string, s?: number) => svg('Package', c, s),

  // ── Quick stickers (user choosable) ────────────────────────────────
  gift: (c?: string, s?: number) => svg('Gift', c, s),
  cart: (c?: string, s?: number) => svg('ShoppingCart', c, s),
  bag: (c?: string, s?: number) => svg('ShoppingBag', c, s),
  suitcase: (c?: string, s?: number) => svg('Briefcase', c, s),
  palette: (c?: string, s?: number) => svg('Palette', c, s),
  gamepad: (c?: string, s?: number) => svg('Gamepad2', c, s),
  circle: (c?: string, s?: number) => svg('Circle', c, s),
};

export const MARKETPLACE_COLORS = {
  ozon: '#005bff',
  yandex: '#ffcc00',
  wb: '#a855f7',
  manual: '#6b7280',
} as const;

export const QUICK_STICKERS = [
  { key: 'package', label: 'Package', icon: I.package },
  { key: 'gift', label: 'Gift', icon: I.gift },
  { key: 'cart', label: 'Cart', icon: I.cart },
  { key: 'bag', label: 'Bag', icon: I.bag },
  { key: 'folder', label: 'Folder', icon: I.folder },
  { key: 'grid', label: 'Grid', icon: I.grid },
  { key: 'clipboard', label: 'Clipboard', icon: I.clipboard },
  { key: 'suitcase', label: 'Briefcase', icon: I.suitcase },
  { key: 'home', label: 'Home', icon: I.home },
  { key: 'truck', label: 'Truck', icon: I.truck },
  { key: 'star', label: 'Star', icon: I.star },
  { key: 'gem', label: 'Gem', icon: I.gem },
  { key: 'flame', label: 'Flame', icon: I.flame },
  { key: 'target', label: 'Target', icon: I.target },
  { key: 'palette', label: 'Palette', icon: I.palette },
  { key: 'smartphone', label: 'Phone', icon: I.smartphone },
  { key: 'laptop', label: 'Laptop', icon: I.laptop },
  { key: 'gamepad', label: 'Gamepad', icon: I.gamepad },
  { key: 'circle', label: 'Circle', icon: I.circle },
  { key: 'coffee', label: 'Coffee', icon: I.coffee },
];
