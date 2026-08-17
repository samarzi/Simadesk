import { storefrontDb } from '../services/storefrontDb';
import type { StorefrontSettings, StorefrontProduct, StorefrontBanner, StorefrontGroup, StorefrontVariantGroup } from '../services/storefrontDb';
import { companyService } from '../services/companyService';
import { showToast } from '../utils/toast';
import { reportAiUsage } from '@/services/aiUsage';

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function ic(d: string, sz = 16): string {
  return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;display:block">${d}</svg>`;
}
const I = {
  chart:   '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  gear:    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  image:   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  pkg:     '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  plus:    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  edit:    '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  trash:   '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>',
  up:      '<polyline points="18 15 12 9 6 15"/>',
  down:    '<polyline points="6 9 12 15 18 9"/>',
  eye:     '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:  '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  link2:   '<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>',
  copy:    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  extLink: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  check:   '<polyline points="20 6 9 17 4 12"/>',
  checkC:  '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  x:       '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  search:  '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  upload:  '<polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  phone:   '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  store:   '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  info:    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  arrow:   '<polyline points="9 18 15 12 9 6"/>',
  star:    '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
};

const SRC = { wb: 'WB', ozon: 'Ozon', yandex: 'Яндекс' } as const;

/* ── CSS ──────────────────────────────────────────────────────────────────── */
const CSS = `
/* Vitrina Store — uses app design tokens */
.vs{flex:1;min-width:0;overflow-y:auto;padding:32px 36px 120px;box-sizing:border-box}
@media(max-width:700px){.vs{padding:16px 16px max(96px,calc(72px + env(safe-area-inset-bottom,0px)))}}
.vs-inner{max-width:1080px;margin:0 auto}

/* Hero */
.vs-hero{display:flex;align-items:center;gap:18px;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid var(--border)}
.vs-hero-logo{width:52px;height:52px;border-radius:14px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:#000;flex-shrink:0;overflow:hidden}
html.light .vs-hero-logo{color:#000}
.vs-hero-logo img{width:100%;height:100%;object-fit:cover;display:block}
.vs-hero-body{flex:1;min-width:0}
.vs-hero-name{font-size:22px;font-weight:800;color:var(--text);line-height:1.15}
.vs-hero-sub{font-size:13px;color:var(--text2);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-hero-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}

/* Status */
.vs-status{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:99px;font-size:12px;font-weight:700}
.vs-status.on{background:var(--green-dim);color:var(--green)}
.vs-status.off{background:var(--bg4);color:var(--text2);border:1px solid var(--border)}
.vs-status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}

/* Tabs — underline style */
.vs-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:28px;overflow-x:auto;scrollbar-width:none}
.vs-tabs::-webkit-scrollbar{display:none}
.vs-tab{display:inline-flex;align-items:center;gap:7px;padding:10px 20px;font-size:13px;font-weight:600;color:var(--text2);background:none;border:none;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s;white-space:nowrap;flex-shrink:0}
.vs-tab:hover{color:var(--text)}
.vs-tab.on{color:var(--text);border-bottom-color:var(--accent)}
.vs-tab-cnt{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--bg4);font-size:10px;font-weight:700;color:var(--text2)}
.vs-tab.on .vs-tab-cnt{background:var(--accent-dim);color:var(--accent-text)}

/* Panel */
.vs-panel{display:none}.vs-panel.on{display:block}

/* Stats row */
.vs-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:24px}
.vs-stat{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:14px 14px 12px;transition:border-color .15s,box-shadow .15s;cursor:default;display:flex;flex-direction:column;gap:3px}
.vs-stat:hover{box-shadow:0 4px 18px rgba(0,0,0,.2);border-color:var(--border2)}
.vs-stat-ico{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:8px;overflow:hidden;flex-shrink:0}
.vs-stat-val{font-size:26px;font-weight:900;color:var(--text);line-height:1;letter-spacing:-1px}
.vs-stat-lbl{font-size:10.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.05em}
.vs-stat-sub{font-size:10px;color:var(--text3)}

/* Link bar */
.vs-linkbar{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);margin-bottom:24px}
.vs-linkbar-url{flex:1;font-size:13px;font-weight:500;color:var(--accent-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace}

/* Overview two-col */
.vs-ov-grid{display:grid;grid-template-columns:1fr;gap:20px}
@media(min-width:860px){.vs-ov-grid{grid-template-columns:3fr 2fr}}

/* Card */
.vs-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r3);padding:20px;margin-bottom:14px}
.vs-card:last-child{margin-bottom:0}
.vs-card-hdr{font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px;display:flex;align-items:center;gap:8px}

/* Section divider */
.vs-sec{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;margin:22px 0 12px;display:flex;align-items:center;gap:8px}
.vs-sec::after{content:'';flex:1;height:1px;background:var(--border)}

/* Checklist */
.vs-chk{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:9px;margin-bottom:6px;background:var(--bg3)}
.vs-chk-ico{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--bg4);border:1.5px solid var(--border2)}
.vs-chk.done .vs-chk-ico{background:var(--green);border-color:var(--green);color:#000}

/* Success banner */
.vs-success{display:flex;align-items:center;gap:14px;padding:16px 18px;background:var(--green-dim);border:1px solid rgba(68,221,136,.2);border-radius:var(--r)}

/* Toggle row */
.vs-toggle-row{display:flex;align-items:center;gap:16px;padding:16px 18px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);margin-bottom:20px}
.vs-toggle-info{flex:1}
.vs-toggle-ttl{font-size:14px;font-weight:600;color:var(--text)}
.vs-toggle-sub{font-size:12px;color:var(--text2);margin-top:2px}

/* Switch */
.vs-sw{display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0}
.vs-sw input{display:none}
.vs-sw-t{width:44px;height:26px;border-radius:13px;background:var(--bg4);position:relative;transition:background .2s;flex-shrink:0;border:1px solid var(--border2)}
.vs-sw-t::after{content:'';position:absolute;top:4px;left:4px;width:16px;height:16px;border-radius:50%;background:var(--text3);box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s,background .2s}
.vs-sw input:checked~.vs-sw-t{background:var(--accent);border-color:transparent}
.vs-sw input:checked~.vs-sw-t::after{transform:translateX(18px);background:#000}

/* Grid 2 */
.vs-grid2{display:grid;grid-template-columns:1fr;gap:24px}
@media(min-width:860px){.vs-grid2{grid-template-columns:1fr 1fr}}

/* Form */
.vs-field{margin-bottom:16px}
.vs-label{display:block;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.vs-label span{font-weight:400;text-transform:none;letter-spacing:0;color:var(--text3)}
.vs-inp{display:block;width:100%;padding:10px 14px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box;transition:border-color .15s}
.vs-inp:focus{border-color:var(--accent)}
.vs-inp::placeholder{color:var(--text3)}
.vs-slug-row{display:flex;align-items:center;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;overflow:hidden;transition:border-color .15s}
.vs-slug-row:focus-within{border-color:var(--accent)}
.vs-slug-pfx{padding:10px 0 10px 14px;font-size:12px;color:var(--text2);white-space:nowrap;flex-shrink:0;font-family:monospace;user-select:none}
.vs-slug-inp{border:none;background:transparent;padding:10px 14px 10px 2px;font-size:13px;color:var(--text);flex:1;outline:none;min-width:0;font-family:monospace}
.vs-hint{font-size:11px;margin-top:5px;color:var(--text2)}
.vs-hint.ok{color:var(--green)}.vs-hint.err{color:var(--red)}

/* Buttons */
.vs-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:all .15s;white-space:nowrap;text-decoration:none;box-sizing:border-box}
.vs-btn:disabled{opacity:.35;cursor:not-allowed}
.vs-btn-pri{background:var(--accent);color:#000!important}
.vs-btn-pri:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px);box-shadow:0 4px 16px rgba(212,240,0,.25)}
.vs-btn-sec{background:var(--bg3);color:var(--text)!important;border:1px solid var(--border2)}
.vs-btn-sec:hover:not(:disabled){border-color:var(--accent-text);color:var(--accent-text)!important}
.vs-btn-sm{padding:7px 14px;font-size:12px}
.vs-btn-xs{padding:5px 10px;font-size:11px;border-radius:6px}

/* Icon button */
.vs-ico-btn{width:32px;height:32px;padding:0;justify-content:center;border-radius:7px;background:transparent;border:1px solid transparent;color:var(--text2);cursor:pointer;display:inline-flex;align-items:center;transition:all .15s}
.vs-ico-btn:hover{background:var(--bg3);border-color:var(--border);color:var(--text)}
.vs-ico-btn.del:hover{background:var(--red-dim);color:var(--red);border-color:transparent}
.vs-ico-btn.hi:hover{background:var(--accent-dim);color:var(--accent-text);border-color:transparent}

/* Badges */
.vs-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700;white-space:nowrap}
.vs-badge.green{background:var(--green-dim);color:var(--green)}
.vs-badge.muted{background:var(--bg4);color:var(--text2)}
.vs-badge.wb{background:rgba(203,73,167,.1);color:rgb(220,120,190)}
.vs-badge.ozon{background:rgba(0,91,255,.08);color:rgb(100,150,255)}
.vs-badge.yandex{background:rgba(255,172,0,.1);color:rgb(210,150,0)}

/* Groups grid */
.vs-grp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.vs-grp-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r3);overflow:hidden;transition:all .15s}
.vs-grp-card:hover{border-color:var(--border2);box-shadow:0 4px 20px rgba(0,0,0,.25)}
.vs-grp-img{aspect-ratio:16/6;background:var(--bg3);overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;color:var(--text3)}
.vs-grp-img img{width:100%;height:100%;object-fit:cover;display:block}
.vs-grp-body{padding:12px 14px}
.vs-grp-name{font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px}
.vs-grp-meta{font-size:11px;color:var(--text2)}
.vs-grp-actions{display:flex;align-items:center;gap:4px;padding:10px 12px;border-top:1px solid var(--border)}
.vs-grp-idx{font-size:10px;font-weight:700;color:var(--text3);flex:1}
/* Banners grid */
.vs-bn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.vs-bn-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r3);overflow:hidden;transition:all .15s}
.vs-bn-card:hover{border-color:var(--border2);box-shadow:0 4px 20px rgba(0,0,0,.25)}
.vs-bn-img{aspect-ratio:16/6;background:var(--bg3);overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;color:var(--text3)}
.vs-bn-img img{width:100%;height:100%;object-fit:cover;display:block}
.vs-bn-body{padding:14px 16px}
.vs-bn-title{font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-bn-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vs-bn-actions{display:flex;align-items:center;gap:4px;padding:10px 12px;border-top:1px solid var(--border)}
.vs-bn-idx{font-size:10px;font-weight:700;color:var(--text3);flex:1}

/* Products */
.vs-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.vs-search-wrap{position:relative;flex:1;min-width:180px}
.vs-search-ico{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text2);pointer-events:none;display:flex}
.vs-search{display:block;width:100%;padding:9px 12px 9px 36px;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:13px;outline:none;box-sizing:border-box;transition:border-color .15s}
.vs-search:focus{border-color:var(--accent)}
.vs-src-pills{display:flex;gap:2px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:3px}
.vs-src-pill{padding:6px 14px;font-size:12px;font-weight:600;border:none;background:transparent;cursor:pointer;color:var(--text2);border-radius:6px;transition:all .15s;white-space:nowrap}
.vs-src-pill.on{background:var(--bg4);color:var(--text)}
.vs-tbl-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r3);overflow:hidden}
.vs-tbl{width:100%;border-collapse:collapse;font-size:13px}
.vs-tbl thead tr{background:var(--bg3)}
.vs-tbl th{padding:10px 12px;text-align:left;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border);white-space:nowrap}
.vs-tbl td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
.vs-tbl tbody tr:last-child td{border-bottom:none}
.vs-tbl tbody tr:hover td{background:var(--hover)}
.vs-prod-hidden td{opacity:.35}
.vs-prod-img{width:46px;height:46px;border-radius:8px;object-fit:cover;display:block;background:var(--bg3)}
.vs-prod-name{font-weight:600;color:var(--text);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-prod-art{font-size:11px;color:var(--text2);margin-top:2px;font-family:monospace}
.vs-url-inp{width:160px;padding:5px 9px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:11px;outline:none;box-sizing:border-box;transition:border-color .15s}
.vs-url-inp:focus{border-color:var(--accent)}
.vs-price-inp{width:90px;padding:5px 9px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:11px;outline:none;box-sizing:border-box;transition:border-color .15s;margin-top:4px}
.vs-price-inp:focus{border-color:var(--accent)}

/* Empty */
.vs-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px;text-align:center;border:1.5px dashed var(--border);border-radius:var(--r3)}
.vs-empty-ico{opacity:.2;margin-bottom:16px}
.vs-empty-ttl{font-size:16px;font-weight:700;color:var(--text);margin-bottom:6px}
.vs-empty-sub{font-size:13px;color:var(--text2);margin-bottom:20px}

/* Modal */
.vs-modal-bg{position:fixed;inset:0;z-index:9900;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.65);backdrop-filter:blur(6px)}
.vs-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);width:100%;max-width:600px;max-height:90vh;display:flex;flex-direction:column;box-shadow:var(--shadow);overflow:hidden}
.vs-modal-hdr{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border);flex-shrink:0}
.vs-modal-ico{width:36px;height:36px;border-radius:10px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;color:var(--accent-text);flex-shrink:0}
.vs-modal-ttl{font-size:16px;font-weight:700;color:var(--text);flex:1}
.vs-modal-body{overflow-y:auto;padding:20px;flex:1}
.vs-modal-footer{padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:10px;background:var(--bg3)}

/* Upload */
.vs-upload{border:2px dashed var(--border2);border-radius:var(--r);cursor:pointer;transition:all .2s;position:relative;overflow:hidden}
.vs-upload:hover,.vs-upload.drag{border-color:var(--accent);background:var(--accent-dim)}
.vs-upload-inner{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center}
.vs-upload-ico{width:52px;height:52px;border-radius:14px;background:var(--bg3);display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:var(--text2)}
.vs-upload-preview{position:relative}
.vs-upload-preview img{width:100%;max-height:200px;object-fit:contain;border-radius:8px;display:block}
.vs-upload-clear{position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center}
.vs-prev-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.vs-prev-card{background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:10px;text-align:center}
.vs-prev-lbl{font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;display:flex;align-items:center;justify-content:center;gap:5px}
.vs-prev-dt{aspect-ratio:16/5;background:var(--bg4);border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--text2);font-size:10px}
.vs-prev-mob{aspect-ratio:3/4;max-height:160px;background:var(--bg4);border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--text2);font-size:10px}
.vs-prev-dt img,.vs-prev-mob img{width:100%;height:100%;object-fit:cover}
@keyframes vs-spin{to{transform:rotate(360deg)}}
`;

export class SimaStoreModule {
  private el!: HTMLElement;
  private companyId!: string;
  private settings: StorefrontSettings | null = null;
  private products: StorefrontProduct[] = [];
  private banners: StorefrontBanner[] = [];
  private groups: StorefrontGroup[] = [];
  private groupItems: Map<string, string> = new Map(); // vendor_code → group_id
  private tab: 'overview'|'settings'|'banners'|'groups'|'products'|'variants' = 'overview';
  private variantGroups: StorefrontVariantGroup[] = [];
  private slugTimer: ReturnType<typeof setTimeout> | null = null;
  private slugOk: boolean | null = null;
  private prodSearch = '';
  private prodSrc = 'all';
  private modalBanner: StorefrontBanner | null = null;
  private modalFile: File | null = null;
  private modalObjUrl: string | null = null;

  init(sectionId: string, companyId: string): void {
    this.el = document.getElementById(sectionId)!;
    this.companyId = companyId;
  }

  show(): void { this.el.style.display = 'flex'; this.load(); }
  hide(): void { this.el.style.display = 'none'; }

  private async load(): Promise<void> {
    const [s, products, overrides, banners, groups, groupItems, variantGroups] = await Promise.all([
      storefrontDb.get(this.companyId),
      storefrontDb.getProducts(this.companyId),
      storefrontDb.getOverrides(this.companyId),
      storefrontDb.getBanners(this.companyId),
      storefrontDb.getGroups(this.companyId),
      storefrontDb.getAllGroupItems(this.companyId),
      storefrontDb.getVariantGroups(this.companyId),
    ]);
    this.settings      = s;
    this.products      = products;
    this.banners       = banners;
    this.groups        = groups;
    this.groupItems    = groupItems;
    this.variantGroups = variantGroups;
    for (const p of this.products) {
      const ov = overrides.get(`${p.source}:${p.source_id}`);
      if (ov) Object.assign(p, ov);
    }
    this.render();
  }

  private injectCSS(): void {
    if (document.getElementById('vs-style')) return;
    const el = document.createElement('style');
    el.id = 'vs-style'; el.textContent = CSS;
    document.head.appendChild(el);
  }

  /* ── Main render ─────────────────────────────────────────────────────────── */
  private render(): void {
    this.injectCSS();
    const slug = this.settings?.slug ?? '';
    const url  = slug ? `${window.location.origin}/${slug}` : '';
    this.el.innerHTML = `<div class="vs"><div class="vs-inner">
      ${this.renderHero(url)}
      ${this.renderTabs()}
      <div id="vs-overview" class="vs-panel ${this.tab==='overview'?'on':''}">${this.renderOverview(url)}</div>
      <div id="vs-settings" class="vs-panel ${this.tab==='settings'?'on':''}">${this.renderSettings()}</div>
      <div id="vs-banners"  class="vs-panel ${this.tab==='banners' ?'on':''}">${this.renderBannersPanel()}</div>
      <div id="vs-groups"   class="vs-panel ${this.tab==='groups'  ?'on':''}">${this.renderGroupsPanel()}</div>
      <div id="vs-products" class="vs-panel ${this.tab==='products'?'on':''}">${this.renderProductsPanel()}</div>
      <div id="vs-variants" class="vs-panel ${this.tab==='variants'?'on':''}">${this.renderVariantsPanel()}</div>
    </div></div>`;
    this.bind();
  }

  /* ── Hero ────────────────────────────────────────────────────────────────── */
  private renderHero(url: string): string {
    const s  = this.settings;
    const on = !!(s?.is_enabled && url);
    const name = s?.store_name || 'SimaStore';
    return `<div class="vs-hero">
      <div class="vs-hero-logo">
        ${companyService.getActive()?.logo_url
          ? `<img src="${esc(companyService.getActive()!.logo_url!)}" alt="${esc(name)}" onerror="this.parentElement.innerHTML='${esc(name.charAt(0).toUpperCase())}';">`
          : esc(name.charAt(0).toUpperCase())}
      </div>
      <div class="vs-hero-body">
        <div class="vs-hero-name">${esc(name)}</div>
        <div class="vs-hero-sub">${url ? esc(url) : 'Задайте адрес в Настройках'}</div>
      </div>
      <div class="vs-hero-actions">
        <span class="vs-status ${on?'on':'off'}">
          <span class="vs-status-dot"></span>${on?'Активен':'Неактивен'}
        </span>
        ${url?`<a href="${esc(url)}" target="_blank" rel="noopener" class="vs-btn vs-btn-sec vs-btn-sm">${ic(I.extLink,13)} Открыть</a>`:''}
      </div>
    </div>`;
  }

  /* ── Tabs ────────────────────────────────────────────────────────────────── */
  private renderTabs(): string {
    const tabs: [string, string, string, number|null][] = [
      ['overview', 'chart',  'Обзор',     null],
      ['settings', 'gear',   'Настройки', null],
      ['banners',  'image',  'Баннеры',   this.banners.length],
      ['groups',   'store',  'Группы',    this.groups.length],
      ['products', 'pkg',    'Товары',    this.products.length],
      ['variants', 'star',   'Варианты',  this.variantGroups.length || null],
    ];
    return `<nav class="vs-tabs">${tabs.map(([id, ico, lbl, cnt]) =>
      `<button class="vs-tab ${this.tab===id?'on':''}" data-tab="${id}">
        ${ic((I as any)[ico]||I.chart, 14)} ${esc(lbl)}
        ${cnt!==null ? `<span class="vs-tab-cnt">${cnt}</span>` : ''}
      </button>`
    ).join('')}</nav>`;
  }

  /* ── Overview ────────────────────────────────────────────────────────────── */
  private renderOverview(url: string): string {
    const s = this.settings;
    const total    = this.products.length;
    const wb       = this.products.filter(p=>p.source==='wb').length;
    const ozon     = this.products.filter(p=>p.source==='ozon').length;
    const yndx     = this.products.filter(p=>p.source==='yandex').length;
    const hidden   = this.products.filter(p=>p.is_hidden).length;
    const visible  = total - hidden;
    const activeBn = this.banners.filter(b=>b.is_active).length;
    const srcCount = [wb>0, ozon>0, yndx>0].filter(Boolean).length;

    const icoLayers = '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>';
    const svg = (d: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;display:block">${d}</svg>`;
    // Brand logos — fill the 44×44 icon container
    const logoWb   = `<svg width="28" height="28" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="44" height="44" fill="#CB49A7"/><polygon points="22,7 37,17 22,24 7,17" fill="rgba(255,255,255,.92)"/><polygon points="7,17 22,24 22,38" fill="rgba(255,255,255,.42)"/><polygon points="37,17 22,24 22,38" fill="rgba(255,255,255,.68)"/></svg>`;
    const logoOzon = `<svg width="28" height="28" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="44" height="44" fill="#005BFF"/><text x="22" y="29" text-anchor="middle" font-size="12" font-weight="900" fill="white" font-family="Arial,Helvetica,sans-serif" letter-spacing="1.5">OZON</text></svg>`;
    const logoYndx = `<svg width="28" height="28" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="44" height="44" fill="#FFCC00"/><text x="22" y="31" text-anchor="middle" font-size="24" font-weight="900" fill="#1A1A1A" font-family="Arial,Helvetica,sans-serif">Я</text></svg>`;

    const checks = [
      { done: !!(s?.store_name),     lbl: 'Название магазина',    tab: 'settings' },
      { done: !!(s?.slug),           lbl: 'URL-адрес задан',      tab: 'settings' },
      { done: !!(s?.is_enabled),     lbl: 'Магазин включён',      tab: 'settings' },
      { done: this.banners.length>0, lbl: 'Хотя бы один баннер',  tab: 'banners'  },
      { done: visible>0,             lbl: 'Есть видимые товары',   tab: 'products' },
    ];
    const allOk = checks.every(c => c.done);

    return `
      <div class="vs-stats">
        ${this.stat(ic(I.pkg,18),     'rgba(212,240,0,.12)',   total,              'Товаров',       `${visible} вид. · ${hidden} скр.`)}
        ${this.stat(ic(I.eye,18),     'rgba(68,221,136,.12)',  visible,            'Видимых',       'доступны покупателям')}
        ${this.stat(svg(icoLayers),   'rgba(251,146,60,.12)',  this.groups.length, 'Групп',         'разделы витрины')}
        ${this.stat(ic(I.image,18),   'rgba(139,92,246,.12)',  this.banners.length,'Баннеров',      `${activeBn} активных`)}
        ${this.stat(ic(I.store,18),   'rgba(20,184,166,.12)',  srcCount,           'Площадки',      'маркетплейсов')}
        ${this.stat(logoWb,            '',                      wb,                 'Wildberries',   'товаров')}
        ${this.stat(logoOzon,          '',                      ozon,               'Ozon',          'товаров')}
        ${this.stat(logoYndx,          '',                      yndx,               'Яндекс Маркет', 'товаров')}
      </div>

      ${url ? `<div class="vs-linkbar">
        <div class="vs-linkbar-url">${esc(url)}</div>
        <button id="vs-copy" class="vs-btn vs-btn-sec vs-btn-xs">${ic(I.copy,12)} Копировать</button>
        <a href="${esc(url)}" target="_blank" rel="noopener" class="vs-btn vs-btn-sec vs-btn-xs">${ic(I.extLink,12)} Открыть</a>
      </div>` : ''}

      <div class="vs-ov-grid">
        <div>
          ${allOk
            ? `<div class="vs-success">
                <div style="color:var(--green);flex-shrink:0">${ic(I.checkC, 22)}</div>
                <div>
                  <div style="font-size:13px;font-weight:700;color:var(--text)">Магазин полностью настроен</div>
                  <div style="font-size:12px;color:var(--text2);margin-top:2px">Все базовые шаги выполнены</div>
                </div>
              </div>`
            : `<div class="vs-sec" style="margin-top:0">${ic(I.info,14)} Быстрая настройка</div>
               ${checks.map(c => `
                <div class="vs-chk ${c.done?'done':''}">
                  <div class="vs-chk-ico">${c.done ? ic(I.check, 12) : ''}</div>
                  <div style="flex:1;font-size:13px;color:var(--text);${c.done?'opacity:.4':''}">
                    ${esc(c.lbl)}
                  </div>
                  ${!c.done ? `<button class="vs-btn vs-btn-sec vs-btn-xs vs-go" data-tab="${c.tab}">Настроить ${ic(I.arrow,11)}</button>` : ''}
                </div>`).join('')}`}
        </div>
        <div>
          ${s?.telegram||s?.whatsapp||s?.website ? `
            <div class="vs-sec" style="margin-top:0">${ic(I.link2,14)} Контакты</div>
            <div class="vs-card" style="padding:14px 16px;display:flex;flex-direction:column;gap:8px">
              ${s.telegram ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text2)"><span style="color:var(--text3)">TG</span><span style="color:var(--text)">${esc(s.telegram)}</span></div>` : ''}
              ${s.whatsapp ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text2)"><span style="color:var(--text3)">WA</span><span style="color:var(--text)">${esc(s.whatsapp)}</span></div>` : ''}
              ${s.website  ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text2)"><span style="color:var(--text3)">🌐</span><span style="color:var(--text)">${esc(s.website)}</span></div>` : ''}
            </div>` : ''}
        </div>
      </div>`;
  }

  private stat(ico: string, bg: string, val: number, lbl: string, sub: string): string {
    return `<div class="vs-stat">
      <div class="vs-stat-ico" style="background:${bg}">${ico}</div>
      <div class="vs-stat-val">${val}</div>
      <div class="vs-stat-lbl">${esc(lbl)}</div>
      <div class="vs-stat-sub">${esc(sub)}</div>
    </div>`;
  }

  private filterToggle(id: string, title: string, sub: string, checked: boolean): string {
    return `<div class="vs-toggle-row" style="margin-bottom:0">
      <div class="vs-toggle-info">
        <div class="vs-toggle-ttl">${esc(title)}</div>
        <div class="vs-toggle-sub">${esc(sub)}</div>
      </div>
      <label class="vs-sw"><input type="checkbox" id="${id}" ${checked?'checked':''}><span class="vs-sw-t"></span></label>
    </div>`;
  }

  /* ── Settings ────────────────────────────────────────────────────────────── */
  private renderSettings(): string {
    const s = this.settings;
    const v = (k: keyof StorefrontSettings) => esc(String(s?.[k] ?? ''));
    return `
      <div class="vs-toggle-row">
        <div class="vs-toggle-info">
          <div class="vs-toggle-ttl">Магазин активен</div>
          <div class="vs-toggle-sub">Публичная страница доступна по ссылке</div>
        </div>
        <label class="vs-sw">
          <input type="checkbox" id="vs-enabled" ${s?.is_enabled ? 'checked' : ''}>
          <span class="vs-sw-t"></span>
        </label>
      </div>

      <div class="vs-grid2">
        <div>
          <div class="vs-sec" style="margin-top:0">${ic(I.store,14)} Основное</div>
          <div class="vs-field">
            <label class="vs-label" for="vs-name">Название <span>отображается в шапке</span></label>
            <input class="vs-inp" id="vs-name" type="text" placeholder="Мой магазин" value="${v('store_name')}">
          </div>
          <div class="vs-field">
            <label class="vs-label" for="vs-slug">Адрес магазина <span>только a–z, 0–9, дефис</span></label>
            <div class="vs-slug-row">
              <span class="vs-slug-pfx">${esc(window.location.origin)}/</span>
              <input class="vs-slug-inp" id="vs-slug" type="text" placeholder="my-store" value="${v('slug')}">
            </div>
            <div id="vs-slug-hint" class="vs-hint"></div>
          </div>
          <div class="vs-field">
            <label class="vs-label" for="vs-tagline">Слоган <span>под названием в шапке</span></label>
            <input class="vs-inp" id="vs-tagline" type="text" placeholder="Качественные товары по честным ценам" value="${v('tagline')}">
          </div>
        </div>
        <div>
          <div class="vs-sec" style="margin-top:0">${ic(I.link2,14)} Контакты</div>
          <div class="vs-field">
            <label class="vs-label" for="vs-tg">Telegram <span>@username или t.me/…</span></label>
            <input class="vs-inp" id="vs-tg" type="text" placeholder="@mystore" value="${v('telegram')}">
          </div>
          <div class="vs-field">
            <label class="vs-label" for="vs-wa">WhatsApp <span>+7 999 …</span></label>
            <input class="vs-inp" id="vs-wa" type="tel" placeholder="+7 999 123-45-67" value="${v('whatsapp')}">
          </div>
          <div class="vs-field">
            <label class="vs-label" for="vs-ph">Позвонить <span>номер телефона для кнопки «Позвонить»</span></label>
            <input class="vs-inp" id="vs-ph" type="tel" placeholder="+7 999 123-45-67" value="${v('phone')}">
          </div>
          <div class="vs-field">
            <label class="vs-label" for="vs-web">Сайт <span>необязательно</span></label>
            <input class="vs-inp" id="vs-web" type="url" placeholder="https://mystore.ru" value="${v('website')}">
          </div>
        </div>
      </div>

      <div class="vs-sec">${ic(I.search,14)} Фильтры на витрине</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
        ${this.filterToggle('vs-fprice',    'Фильтр по цене',       'Ползунок «от/до» над каталогом',      !!s?.show_price_filter)}
        ${this.filterToggle('vs-fbrand',    'Фильтр по бренду',     'Чипы с брендами товаров',             !!s?.show_brand_filter)}
        ${this.filterToggle('vs-fcat',      'Фильтр по категориям', 'Чипы из категорий WB/Ozon/ЯМ',       !!s?.show_category_filter)}
      </div>

      <div class="vs-sec">${ic(I.pkg,14)} Остатки товаров</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
        ${this.filterToggle('vs-show-stock', 'Показывать остатки',          'На карточках отображается «осталось X шт.»',       !!s?.show_stock)}
        ${this.filterToggle('vs-hide-oos',   'Скрывать товары без остатков', 'Позиции с нулевым остатком не отображаются в витрине', !!s?.hide_out_of_stock)}
      </div>

      <div style="margin-top:8px;padding-top:20px;border-top:1px solid var(--border)">
        <button class="vs-btn vs-btn-pri" id="vs-save">${ic(I.check)} Сохранить настройки</button>
      </div>`;
  }

  /* ── Banners panel ───────────────────────────────────────────────────────── */
  private renderBannersPanel(): string {
    return `<div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <div style="font-size:18px;font-weight:800;color:var(--text)">Баннеры</div>
          <div style="font-size:13px;color:var(--text2);margin-top:3px">
            ${this.banners.length ? `${this.banners.length} баннеров · ${this.banners.filter(b=>b.is_active).length} активных` : 'Нет баннеров'}
          </div>
        </div>
        <button class="vs-btn vs-btn-pri" id="vs-bn-add">${ic(I.plus)} Добавить баннер</button>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:20px;display:flex;gap:12px;align-items:flex-start">
        <span style="font-size:18px;flex-shrink:0">📐</span>
        <div style="font-size:12px;color:var(--text2);line-height:1.6">
          <span style="font-weight:700;color:var(--text)">Рекомендуемый размер баннера:</span> <strong>1400 × 320 px</strong> (соотношение ~4:1).<br>
          На мобильных — центральная часть, на десктопе — полная ширина в связке с соседними баннерами (1:2:1).<br>
          Форматы: <strong>JPG, PNG, WebP</strong>. Размер файла — до <strong>2 МБ</strong>.
        </div>
      </div>
      <div id="vs-bn-list">${this.renderBannerList()}</div>
    </div>`;
  }

  private renderBannerList(): string {
    if (!this.banners.length) {
      return `<div class="vs-empty">
        <div class="vs-empty-ico">${ic(I.image, 52)}</div>
        <div class="vs-empty-ttl">Баннеров пока нет</div>
        <div class="vs-empty-sub">Добавьте первый баннер — он появится в шапке вашего магазина</div>
        <button class="vs-btn vs-btn-pri" id="vs-bn-add2">${ic(I.plus)} Добавить первый баннер</button>
      </div>`;
    }
    return `<div class="vs-bn-grid">${this.banners.map((b, i) => {
      const name = b.title || `Баннер ${i + 1}`;
      return `<div class="vs-bn-card" data-bid="${esc(b.id)}">
        <div class="vs-bn-img">
          ${b.image_url
            ? `<img src="${esc(b.image_url)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : ic(I.image, 32)}
        </div>
        <div class="vs-bn-body">
          <div class="vs-bn-title">${esc(name)}</div>
          <div class="vs-bn-meta">
            <span class="vs-badge ${b.is_active?'green':'muted'}">${b.is_active?'Активен':'Скрыт'}</span>
            <span class="vs-badge muted">Позиция ${b.sort_order + 1}</span>
          </div>
        </div>
        <div class="vs-bn-actions">
          <span class="vs-bn-idx">#${i+1}</span>
          <button class="vs-ico-btn hi" data-bact="${b.is_active?'hide':'show'}" title="${b.is_active?'Скрыть':'Показать'}">${ic(b.is_active?I.eyeOff:I.eye,14)}</button>
          <button class="vs-ico-btn" data-bact="up"   title="Вверх"  ${i===0?'disabled style="opacity:.25"':''}>${ic(I.up,14)}</button>
          <button class="vs-ico-btn" data-bact="down" title="Вниз"   ${i===this.banners.length-1?'disabled style="opacity:.25"':''}>${ic(I.down,14)}</button>
          <button class="vs-ico-btn hi" data-bact="edit"  title="Редактировать">${ic(I.edit,14)}</button>
          <button class="vs-ico-btn del" data-bact="del"  title="Удалить">${ic(I.trash,14)}</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  /* ── Groups panel ───────────────────────────────────────────────────────── */
  private renderGroupsPanel(): string {
    return `<div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
        <div>
          <div style="font-size:18px;font-weight:800;color:var(--text)">Группы товаров</div>
          <div style="font-size:13px;color:var(--text2);margin-top:3px">
            Объединяйте товары в коллекции — они выводятся как разделы витрины
          </div>
        </div>
        <button class="vs-btn vs-btn-pri" id="vs-grp-add">${ic(I.plus)} Создать группу</button>
      </div>
      <div id="vs-grp-list">${this.renderGroupList()}</div>
    </div>`;
  }

  private renderGroupList(): string {
    if (!this.groups.length) {
      return `<div class="vs-empty">
        <div class="vs-empty-ico">${ic(I.store, 52)}</div>
        <div class="vs-empty-ttl">Групп пока нет</div>
        <div class="vs-empty-sub">Создайте первую группу и назначьте товары во вкладке «Товары»</div>
        <button class="vs-btn vs-btn-pri" id="vs-grp-add2">${ic(I.plus)} Создать первую группу</button>
      </div>`;
    }
    // Count items per group
    const counts = new Map<string, number>();
    for (const gid of this.groupItems.values()) {
      counts.set(gid, (counts.get(gid) ?? 0) + 1);
    }
    return `<div class="vs-grp-grid">${this.groups.map((g, i) =>
      `<div class="vs-grp-card" data-gid="${esc(g.id)}">
        <div class="vs-grp-img">
          ${g.cover_url
            ? `<img src="${esc(g.cover_url)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : ic(I.store, 32)}
        </div>
        <div class="vs-grp-body">
          <div class="vs-grp-name">${esc(g.name)}</div>
          <div class="vs-grp-meta">${counts.get(g.id) ?? 0} товаров · Позиция ${i + 1}</div>
        </div>
        <div class="vs-grp-actions">
          <span class="vs-grp-idx">#${i+1}</span>
          <button class="vs-ico-btn" data-gact="up"   title="Вверх" ${i===0?'disabled style="opacity:.25"':''}>${ic(I.up,14)}</button>
          <button class="vs-ico-btn" data-gact="down" title="Вниз"  ${i===this.groups.length-1?'disabled style="opacity:.25"':''}>${ic(I.down,14)}</button>
          <button class="vs-ico-btn hi"  data-gact="edit"  title="Переименовать">${ic(I.edit,14)}</button>
          <button class="vs-ico-btn del" data-gact="del"   title="Удалить">${ic(I.trash,14)}</button>
        </div>
      </div>`
    ).join('')}</div>`;
  }

  /* ── Variants panel ─────────────────────────────────────────────────────── */
  private renderVariantsPanel(): string {
    const hasGroups = this.variantGroups.length > 0;

    // Build a lookup: vendor_code → product title for display
    const vcTitles = new Map<string, string>();
    for (const p of this.products) {
      const k = p.vendor_code.trim().toLowerCase();
      if (k && !vcTitles.has(k)) vcTitles.set(k, p.title);
    }

    return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <div>
        <div style="font-size:17px;font-weight:800;color:var(--text)">Варианты товаров</div>
        <div style="font-size:12px;color:var(--text2);margin-top:3px">Объединяйте карточки (размеры, цвета) — появятся кнопки переключения на витрине</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="vs-var-suggest" class="vs-btn vs-btn-sec vs-btn-sm">${ic(I.search,14)} Авто-группировка</button>
        <button id="vs-var-ai" class="vs-btn vs-btn-sec vs-btn-sm">${ic(I.star,14)} ИИ-группировка</button>
        <button id="vs-var-add" class="vs-btn vs-btn-sm">${ic(I.plus,14)} Создать группу</button>
      </div>
    </div>

    <div id="vs-var-suggest-box" style="display:none;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r3);padding:16px;margin-bottom:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-size:13px;font-weight:700;color:var(--text)">Предлагаемые группы <span id="vs-var-suggest-cnt" style="color:var(--text2)"></span></div>
        <button id="vs-var-suggest-close" class="vs-ico-btn">${ic(I.x,14)}</button>
      </div>
      <div id="vs-var-suggest-list" style="display:flex;flex-direction:column;gap:8px"></div>
      <div id="vs-var-suggest-empty" style="display:none;font-size:13px;color:var(--text2);text-align:center;padding:16px 0">Похожих артикулов не найдено</div>
    </div>

    ${hasGroups ? `
    <div id="vs-var-list" style="display:flex;flex-direction:column;gap:10px">
      ${this.variantGroups.map((vg, idx) => this.renderVariantGroupRow(vg, idx, vcTitles)).join('')}
    </div>
    ` : `
    <div id="vs-var-list">
      <div style="text-align:center;padding:48px 24px;background:var(--bg2);border:1px dashed var(--border);border-radius:var(--r3)">
        <div style="font-size:36px;margin-bottom:12px">🔀</div>
        <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px">Нет вариантных групп</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:20px">Объедините карточки (разные размеры обуви, цвета) — на витрине появятся кнопки переключения</div>
        <button id="vs-var-add2" class="vs-btn vs-btn-sm">${ic(I.plus,14)} Создать первую группу</button>
      </div>
    </div>
    `}`;
  }

  private renderVariantGroupRow(vg: StorefrontVariantGroup, _idx: number, vcTitles: Map<string,string>): string {
    const items = vg.items ?? [];
    const chips = items.map(it => {
      const c = (it.color ?? '').trim();
      const parts = c.split('|');
      const bg = parts.length >= 2
        ? `linear-gradient(135deg,${parts[0].trim()} 50%,${parts[1].trim()} 50%)`
        : (c || 'var(--bg4)');
      const textColor = c ? '#fff' : 'var(--text2)';
      const shadow = c ? 'text-shadow:0 1px 2px rgba(0,0,0,.4);' : '';
      return `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:26px;padding:0 6px;border-radius:6px;background:${bg};color:${textColor};font-size:11px;font-weight:800;${shadow}border:1px solid rgba(0,0,0,.15)">${esc(it.label)}</span>`;
    }).join('');
    const names = items.map(it => vcTitles.get(it.vendor_code) ?? it.vendor_code).join(', ');
    return `<div class="vs-card" data-vgid="${esc(vg.id)}" style="padding:14px 16px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="display:flex;gap:4px;flex-wrap:wrap;flex:1;min-width:0">${chips || '<span style="color:var(--text3);font-size:12px">пусто</span>'}</div>
        <div style="font-size:12px;color:var(--text2);flex:2;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(names)}">${esc(names.slice(0,80))}${names.length>80?'…':''}</div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="vs-ico-btn hi" data-vgact="edit"  title="Редактировать">${ic(I.edit,14)}</button>
          <button class="vs-ico-btn del" data-vgact="del"  title="Удалить">${ic(I.trash,14)}</button>
        </div>
      </div>
    </div>`;
  }

  private async reloadVariants(): Promise<void> {
    this.variantGroups = await storefrontDb.getVariantGroups(this.companyId);
    const vcTitles = new Map<string, string>();
    for (const p of this.products) {
      const k = p.vendor_code.trim().toLowerCase();
      if (k && !vcTitles.has(k)) vcTitles.set(k, p.title);
    }
    const list = document.getElementById('vs-var-list');
    if (list) {
      list.innerHTML = this.variantGroups.length
        ? this.variantGroups.map((vg, i) => this.renderVariantGroupRow(vg, i, vcTitles)).join('')
        : `<div style="text-align:center;padding:48px 24px;background:var(--bg2);border:1px dashed var(--border);border-radius:var(--r3)">
            <div style="font-size:36px;margin-bottom:12px">🔀</div>
            <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px">Нет вариантных групп</div>
            <button id="vs-var-add2" class="vs-btn vs-btn-sm" style="margin-top:12px">${ic(I.plus,14)} Создать первую группу</button>
          </div>`;
      // re-attach empty state button
      document.getElementById('vs-var-add2')?.addEventListener('click', () => this.openVariantModal(null));
    }
    // update tab count
    const tab = this.el.querySelector('[data-tab="variants"] .vs-tab-cnt') as HTMLElement|null;
    if (tab) { tab.textContent = String(this.variantGroups.length); tab.style.display = this.variantGroups.length?'':'none'; }
  }

  /* mechanical suggestion: group vendor_codes by common prefix (strip trailing digits/sizes) */
  private suggestVariantGroups(): { key: string; vcs: string[] }[] {
    // Get unique vendor_codes (lowercase, trimmed) that appear in products
    const vcSet = new Map<string, string>(); // normalized → title
    for (const p of this.products) {
      const k = p.vendor_code.trim().toLowerCase();
      if (k) vcSet.set(k, p.custom_title || p.title);
    }

    // Strip trailing size-like suffixes: digits, letters for sizes (XS,S,M,L,XL,XXL,XXXL,2XL,3XL, numeric shoe sizes 35-50)
    const stripSuffix = (vc: string): string =>
      vc.replace(/[-_\s]?(xs|s|m|l|xl|2xl|3xl|xxl|xxxl|\d{1,3})$/i, '').toLowerCase().trim();

    const byPrefix = new Map<string, string[]>();
    for (const [vc] of vcSet) {
      const prefix = stripSuffix(vc);
      if (!prefix) continue;
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix)!.push(vc);
    }

    // Only suggest groups with ≥2 members not already in an existing group
    const existingVcs = new Set<string>();
    for (const vg of this.variantGroups) {
      for (const it of vg.items) existingVcs.add(it.vendor_code.toLowerCase());
    }

    const suggestions: { key: string; vcs: string[] }[] = [];
    for (const [key, vcs] of byPrefix) {
      const fresh = vcs.filter(vc => !existingVcs.has(vc));
      if (fresh.length >= 2) suggestions.push({ key, vcs: fresh });
    }
    return suggestions.sort((a,b) => b.vcs.length - a.vcs.length);
  }

  private openVariantModal(group: StorefrontVariantGroup | null): void {
    document.getElementById('vs-vg-modal')?.remove();

    // Build working items list from group or empty
    // color field supports "color1|color2" for diagonal two-tone buttons
    const workItems: { vendor_code: string; label: string; color: string }[] =
      (group?.items ?? []).map(it => ({ vendor_code: it.vendor_code, label: it.label, color: it.color ?? '' }));

    // Build product lookup: normalized vc → title
    const vcTitles = new Map<string, string>();
    for (const p of this.products) {
      const k = p.vendor_code.trim().toLowerCase();
      if (k && !vcTitles.has(k)) vcTitles.set(k, p.custom_title || p.title);
    }

    const existingVcs = new Set<string>(workItems.map(it => it.vendor_code.toLowerCase()));

    const colorSwatch = (color: string) => {
      const parts = color.split('|');
      if (parts.length >= 2) {
        return `background:linear-gradient(135deg,${parts[0].trim()} 50%,${parts[1].trim()} 50%)`;
      }
      return color ? `background:${color}` : 'background:var(--bg4)';
    };

    const renderItems = () => {
      const rows = workItems.map((it, i) => {
        const title = vcTitles.get(it.vendor_code.toLowerCase()) ?? it.vendor_code;
        const parts = it.color.split('|');
        const c1 = parts[0]?.trim() || '';
        const c2 = parts[1]?.trim() || '';
        const hasColor = !!c1;
        return `<div class="vs-vg-item" data-idx="${i}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg3);border-radius:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
            <div style="font-size:11px;color:var(--text2)">${esc(it.vendor_code)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
            <input type="text" class="vs-vg-label vs-inp" style="width:58px;text-align:center;font-weight:800;font-size:13px;padding:4px 5px" maxlength="6" placeholder="Лейбл" value="${esc(it.label)}">
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px" title="Цвета кнопки (2-й опционально)">
              <div style="width:30px;height:22px;border-radius:5px;border:1px solid var(--border);overflow:hidden;cursor:pointer;position:relative;${colorSwatch(it.color)}">
                ${hasColor ? '' : '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--text3)">—</span>'}
              </div>
              <div style="display:flex;gap:2px">
                <input type="color" class="vs-vg-color1" style="width:13px;height:13px;border:none;cursor:pointer;border-radius:2px;padding:0" value="${esc(c1||'#3182ce')}" title="Цвет 1">
                <input type="color" class="vs-vg-color2" style="width:13px;height:13px;border:none;cursor:pointer;border-radius:2px;padding:0" value="${esc(c2||c1||'#3182ce')}" title="Цвет 2 (для 2-тонного)" data-linked="${!c2 || c2 === c1 ? 'true' : 'false'}">
              </div>
            </div>
            <button class="vs-ico-btn vs-vg-clear-color" title="Без цвета (нейтральный вид)" style="font-size:9px;width:22px;height:22px;border-radius:4px">—</button>
            <button class="vs-ico-btn del vs-vg-rm" title="Убрать">${ic(I.x,13)}</button>
          </div>
        </div>`;
      }).join('');
      return rows || `<div style="font-size:12px;color:var(--text3);text-align:center;padding:12px">Добавьте товары ниже</div>`;
    };

    const div = document.createElement('div');
    div.id = 'vs-vg-modal';
    div.className = 'vs-modal-bg';
    div.innerHTML = `<div class="vs-modal" style="max-width:520px">
      <div class="vs-modal-hdr">
        <div class="vs-modal-ico">${ic(I.star,18)}</div>
        <div class="vs-modal-ttl">${group && group.id !== '__new__' ? 'Редактировать группу вариантов' : 'Создать группу вариантов'}</div>
        <button class="vs-ico-btn" id="vs-vg-close">${ic(I.x,16)}</button>
      </div>
      <div class="vs-modal-body" style="max-height:70vh;overflow-y:auto">
        <div style="font-size:12px;color:var(--text2);margin-bottom:12px">
          Каждый товар получит кнопку с лейблом (до 6 симв.). Выберите цвет кнопки — или два цвета для двухтонного варианта (как «бело-чёрный»). Кнопка без цвета выглядит нейтрально.
        </div>

        <div id="vs-vg-items" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">${renderItems()}</div>

        <div style="border-top:1px solid var(--border);padding-top:14px;margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:8px">ДОБАВИТЬ ТОВАР</div>
          <div style="display:flex;gap:8px">
            <input id="vs-vg-search" class="vs-inp" style="flex:1" placeholder="Поиск по артикулу или названию…" autocomplete="off">
          </div>
          <div id="vs-vg-results" style="display:none;background:var(--bg3);border:1px solid var(--border);border-radius:8px;margin-top:6px;max-height:200px;overflow-y:auto"></div>
        </div>
      </div>
      <div class="vs-modal-footer">
        <button class="vs-btn vs-btn-sec vs-btn-sm" id="vs-vg-cancel">Отмена</button>
        <button class="vs-btn vs-btn-sm" id="vs-vg-save">${ic(I.check,14)} ${group && group.id !== '__new__' ? 'Сохранить' : 'Создать'}</button>
      </div>
    </div>`;

    document.body.appendChild(div);

    const close = () => { div.remove(); };
    div.addEventListener('click', e => { if (e.target === div) close(); });
    document.getElementById('vs-vg-close')?.addEventListener('click', close);
    document.getElementById('vs-vg-cancel')?.addEventListener('click', close);

    // Remove item
    const itemsEl = document.getElementById('vs-vg-items')!;
    itemsEl.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const row = t.closest('[data-idx]') as HTMLElement|null;
      if (!row) return;
      const idx = parseInt(row.dataset.idx!);
      if (t.closest('.vs-vg-rm')) {
        existingVcs.delete(workItems[idx].vendor_code.toLowerCase());
        workItems.splice(idx, 1);
        itemsEl.innerHTML = renderItems();
      } else if (t.closest('.vs-vg-clear-color')) {
        workItems[idx].color = '';
        itemsEl.innerHTML = renderItems();
      }
    });

    // Live label/color sync
    itemsEl.addEventListener('input', e => {
      const inp = e.target as HTMLInputElement;
      const row = inp.closest('[data-idx]') as HTMLElement|null;
      if (!row) return;
      const idx = parseInt(row.dataset.idx!);
      if (inp.classList.contains('vs-vg-label')) {
        workItems[idx].label = inp.value.slice(0, 6);
      } else if (inp.classList.contains('vs-vg-color1') || inp.classList.contains('vs-vg-color2')) {
        const rowEl = inp.closest('[data-idx]')!;
        const c1El = rowEl.querySelector('.vs-vg-color1') as HTMLInputElement;
        const c2El = rowEl.querySelector('.vs-vg-color2') as HTMLInputElement;
        if (inp.classList.contains('vs-vg-color1') && c2El?.dataset.linked === 'true') {
          c2El.value = c1El.value;
        }
        if (inp.classList.contains('vs-vg-color2')) {
          inp.dataset.linked = 'false';
        }
        const c1 = c1El?.value || '';
        const c2 = c2El?.value || '';
        workItems[idx].color = c1 === c2 ? c1 : `${c1}|${c2}`;
        // Update swatch preview
        const swatch = rowEl.querySelector<HTMLElement>('[style*="border-radius:5px"]');
        if (swatch) swatch.style.cssText = `width:30px;height:22px;border-radius:5px;border:1px solid var(--border);overflow:hidden;cursor:pointer;position:relative;${colorSwatch(workItems[idx].color)}`;
      }
    });

    // Product search
    const searchInp = document.getElementById('vs-vg-search') as HTMLInputElement;
    const results   = document.getElementById('vs-vg-results')!;

    // Get all unique product groups (by normalized vc)
    const allGroups = new Map<string, { vc: string; title: string }>();
    for (const p of this.products) {
      const k = p.vendor_code.trim().toLowerCase();
      if (k && !allGroups.has(k)) allGroups.set(k, { vc: p.vendor_code.trim(), title: p.custom_title || p.title });
    }

    const showResults = (q: string) => {
      const ql = q.toLowerCase();
      const hits = [...allGroups.values()].filter(g =>
        !existingVcs.has(g.vc.toLowerCase()) &&
        (g.vc.toLowerCase().includes(ql) || g.title.toLowerCase().includes(ql))
      ).slice(0, 15);
      if (!q || !hits.length) { results.style.display = 'none'; return; }
      results.style.display = '';
      results.innerHTML = hits.map(g =>
        `<div class="vs-vg-res-row" data-vc="${esc(g.vc)}" style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)">
          <span style="font-weight:700;color:var(--text)">${esc(g.vc)}</span>
          <span style="color:var(--text2);margin-left:8px">${esc(g.title)}</span>
        </div>`
      ).join('');
    };

    searchInp.addEventListener('input', () => showResults(searchInp.value));
    searchInp.addEventListener('focus', () => showResults(searchInp.value));
    document.addEventListener('click', (e) => {
      if (!results.contains(e.target as Node) && e.target !== searchInp) results.style.display = 'none';
    }, { capture: true, once: false });

    results.addEventListener('click', e => {
      const row = (e.target as HTMLElement).closest('.vs-vg-res-row') as HTMLElement|null;
      if (!row) return;
      const vc = row.dataset.vc!;
      const vcL = vc.toLowerCase();
      if (existingVcs.has(vcL)) return;
      existingVcs.add(vcL);
      // New items default to no color (neutral look)
      const label = vc.replace(/[-_\s]?(xs|s|m|l|xl|2xl|3xl|xxl|xxxl|\d{1,3})$/i, (_,g)=>g||'').slice(0,6).toUpperCase();
      workItems.push({ vendor_code: vc, label, color: '' });
      itemsEl.innerHTML = renderItems();
      searchInp.value = '';
      results.style.display = 'none';
    });

    // Save
    document.getElementById('vs-vg-save')?.addEventListener('click', async () => {
      if (workItems.length < 2) { showToast('Добавьте минимум 2 товара', 'error'); return; }
      const saveBtn = document.getElementById('vs-vg-save') as HTMLButtonElement;
      saveBtn.disabled = true;
      try {
        const items = workItems.map((it, i) => ({
          vendor_code: it.vendor_code,
          label: it.label.slice(0, 6) || it.vendor_code.slice(0, 6),
          color: it.color || '',
          sort_order: i,
        }));
        if (group && group.id && group.id !== '__new__') {
          await storefrontDb.updateVariantGroup(group.id, items);
        } else {
          await storefrontDb.addVariantGroup(this.companyId, items, this.variantGroups.length);
        }
        showToast(group && group.id !== '__new__' ? 'Группа обновлена' : 'Группа создана', 'success');
        close();
        await this.reloadVariants();
      } catch {
        showToast('Ошибка сохранения', 'error');
        saveBtn.disabled = false;
      }
    });
  }

  private async runAISuggest(): Promise<void> {
    const apiKey = sessionStorage.getItem('sd_ai_key');
    if (!apiKey) {
      showToast('Нет AI-ключа. Добавьте OpenRouter API Key в настройках профиля.', 'error');
      return;
    }
    const model = localStorage.getItem('sd_ai_model') || 'anthropic/claude-haiku-4-5';

    const aiBtn = document.getElementById('vs-var-ai') as HTMLButtonElement|null;
    if (aiBtn) { aiBtn.disabled = true; aiBtn.innerHTML = `${ic(I.star,14)} ИИ думает…`; }

    try {
      // Build list of unique vendor_codes with titles for the AI
      const vcMap = new Map<string, string>();
      for (const p of this.products) {
        const k = p.vendor_code.trim().toLowerCase();
        if (k && !vcMap.has(k)) vcMap.set(k, p.custom_title || p.title);
      }
      const existingVcs = new Set<string>();
      for (const vg of this.variantGroups) {
        for (const it of vg.items) existingVcs.add(it.vendor_code.toLowerCase());
      }
      const candidates = [...vcMap.entries()]
        .filter(([k]) => !existingVcs.has(k))
        .map(([vc, title]) => `${vc} | ${title}`)
        .slice(0, 200);

      if (candidates.length < 2) {
        showToast('Недостаточно артикулов для анализа', 'error');
        return;
      }

      const prompt = `Ты помощник менеджера интернет-магазина. Посмотри на список артикулов и названий товаров ниже.
Найди группы, которые можно объединить в вариантные группы (например, один товар в разных размерах или цветах).
Верни ТОЛЬКО JSON-массив групп в формате:
[{"vendor_codes": ["арт1", "арт2"], "reason": "причина группировки"}]

Если групп нет, верни пустой массив [].

Список артикулов:
${candidates.join('\n')}`;

      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2000 }),
      });
      if (!resp.ok) throw new Error(`AI API error ${resp.status}`);
      const data = await resp.json();
      reportAiUsage('Витрина · группировка', data);
      const text = data.choices?.[0]?.message?.content ?? '';

      // Extract JSON from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { showToast('ИИ не нашёл групп для объединения', 'success'); return; }
      const groups: { vendor_codes: string[]; reason: string }[] = JSON.parse(jsonMatch[0]);
      if (!groups.length) { showToast('ИИ не нашёл групп для объединения', 'success'); return; }

      // Show in suggest box
      const box = document.getElementById('vs-var-suggest-box')!;
      const listEl = document.getElementById('vs-var-suggest-list')!;
      const cntEl  = document.getElementById('vs-var-suggest-cnt')!;
      const emptyEl = document.getElementById('vs-var-suggest-empty')!;
      box.style.display = '';
      cntEl.textContent = `(${groups.length})`;
      emptyEl.style.display = 'none';

      const vcTitles = new Map<string, string>();
      for (const p of this.products) {
        const k = p.vendor_code.trim().toLowerCase();
        if (k && !vcTitles.has(k)) vcTitles.set(k, p.custom_title || p.title);
      }

      listEl.innerHTML = groups.map((g, gi) => {
        const chips = g.vendor_codes.map(vc =>
          `<span style="background:var(--bg4);border:1px solid var(--border);border-radius:5px;padding:2px 7px;font-size:11px;font-weight:700">${esc(vc)}</span>`
        ).join('');
        return `<div data-sugg="${gi}" style="background:var(--bg3);border-radius:10px;padding:10px 12px;display:flex;align-items:flex-start;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${chips}</div>
            <div style="font-size:11px;color:var(--text2)">${esc(g.reason)}</div>
          </div>
          <button class="vs-btn vs-btn-sec vs-btn-xs vs-sugg-edit" data-sugg="${gi}" title="Открыть и отредактировать">${ic(I.edit,12)} Изменить</button>
          <button class="vs-btn vs-btn-xs vs-sugg-apply" data-sugg="${gi}">${ic(I.check,12)} Применить</button>
        </div>`;
      }).join('');

      // Store suggestions for event handlers
      (box as any)._aiSuggestions = groups;

      listEl.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('[data-sugg]') as HTMLElement|null;
        if (!btn) return;
        const gi = parseInt(btn.dataset.sugg!);
        const sugg = ((box as any)._aiSuggestions as typeof groups)[gi];
        if (!sugg) return;

        if (btn.classList.contains('vs-sugg-edit')) {
          // Open modal pre-filled with these vendor_codes
          const fakeGroup: StorefrontVariantGroup = {
            id: '', sort_order: 0, items: sugg.vendor_codes.map((vc, i) => ({
              vendor_code: vc,
              label: vc.replace(/[-_\s]?(xs|s|m|l|xl|2xl|3xl|xxl|xxxl|\d{1,3})$/i,(_,g)=>g||'').slice(0,6).toUpperCase(),
              color: '',
              sort_order: i,
            })),
          };
          // pass null id to create new, pre-seeded with items
          const pseudoNew = { ...fakeGroup, id: '__new__' };
          this.openVariantModal(pseudoNew);
        } else if (btn.classList.contains('vs-sugg-apply')) {
          btn.setAttribute('disabled','');
          try {
            const items = sugg.vendor_codes.map((vc, i) => ({
              vendor_code: vc,
              label: vc.replace(/[-_\s]?(xs|s|m|l|xl|2xl|3xl|xxl|xxxl|\d{1,3})$/i,(_,g)=>g||'').slice(0,6).toUpperCase(),
              color: '',
              sort_order: i,
            }));
            await storefrontDb.addVariantGroup(this.companyId, items, this.variantGroups.length);
            showToast('Группа создана', 'success');
            btn.closest('[data-sugg]')?.remove();
            await this.reloadVariants();
          } catch {
            showToast('Ошибка создания группы', 'error');
            btn.removeAttribute('disabled');
          }
        }
      });

    } catch (err) {
      console.error(err);
      showToast('Ошибка ИИ-группировки', 'error');
    } finally {
      if (aiBtn) { aiBtn.disabled = false; aiBtn.innerHTML = `${ic(I.star,14)} ИИ-группировка`; }
    }
  }

  private grpModalFile: File | null = null;
  private grpModalObjUrl: string | null = null;

  private openGroupModal(group: StorefrontGroup | null): void {
    document.getElementById('vs-grp-modal')?.remove();
    this.grpModalFile = null;
    if (this.grpModalObjUrl) { URL.revokeObjectURL(this.grpModalObjUrl); this.grpModalObjUrl = null; }
    const isEdit   = !!group;
    const prevUrl  = group?.cover_url ?? '';
    const div = document.createElement('div');
    div.id = 'vs-grp-modal';
    div.className = 'vs-modal-bg';
    div.innerHTML = `<div class="vs-modal" style="max-width:480px">
      <div class="vs-modal-hdr">
        <div class="vs-modal-ico">${ic(I.store,18)}</div>
        <div class="vs-modal-ttl">${isEdit ? 'Редактировать группу' : 'Новая группа'}</div>
        <button class="vs-ico-btn" id="vs-gm-close">${ic(I.x,16)}</button>
      </div>
      <div class="vs-modal-body">
        <div class="vs-field">
          <label class="vs-label" for="vs-gm-name">Название группы</label>
          <input class="vs-inp" id="vs-gm-name" type="text" placeholder="Столы и стулья" value="${esc(group?.name??'')}">
        </div>
        <div class="vs-field">
          <label class="vs-label">Обложка группы <span>рекомендуется 1440×450 px (16:5)</span></label>
          <div class="vs-upload" id="vs-gm-drop">
            <input type="file" accept="image/*" id="vs-gm-file" style="display:none">
            <div id="vs-gm-inner" class="vs-upload-inner" style="${prevUrl?'display:none':''}">
              <div class="vs-upload-ico">${ic(I.upload, 24)}</div>
              <button type="button" class="vs-btn vs-btn-sec vs-btn-sm" id="vs-gm-file-btn">Выбрать фото</button>
              <div style="font-size:11px;color:var(--text3);margin-top:6px">JPG, PNG, WebP — до 5 МБ</div>
            </div>
            <div class="vs-upload-preview" id="vs-gm-prev-wrap" style="${prevUrl?'':'display:none'}">
              <img id="vs-gm-prev-img" src="${esc(prevUrl)}" alt="">
              <button type="button" class="vs-upload-clear" id="vs-gm-clear">${ic(I.x,13)}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="vs-modal-footer">
        <button class="vs-btn vs-btn-pri" id="vs-gm-save" style="flex:1">${ic(I.check)} ${isEdit?'Сохранить':'Создать группу'}</button>
        <button class="vs-btn vs-btn-sec" id="vs-gm-cancel">Отмена</button>
      </div>
    </div>`;
    document.body.appendChild(div);
    document.body.style.overflow = 'hidden';
    const close = () => {
      div.remove();
      document.body.style.overflow = '';
      if (this.grpModalObjUrl) { URL.revokeObjectURL(this.grpModalObjUrl); this.grpModalObjUrl = null; }
      this.grpModalFile = null;
    };
    div.addEventListener('click', e => { if (e.target === div) close(); });
    div.querySelector('#vs-gm-close')?.addEventListener('click', close);
    div.querySelector('#vs-gm-cancel')?.addEventListener('click', close);

    const fileInp  = div.querySelector('#vs-gm-file')     as HTMLInputElement;
    const fileBtn  = div.querySelector('#vs-gm-file-btn');
    const clearBtn = div.querySelector('#vs-gm-clear');
    const prevWrap = div.querySelector('#vs-gm-prev-wrap') as HTMLElement;
    const inner    = div.querySelector('#vs-gm-inner')     as HTMLElement;
    const prevImg  = div.querySelector('#vs-gm-prev-img')  as HTMLImageElement;

    const showImg = (url: string) => {
      prevImg.src = url; prevWrap.style.display = ''; inner.style.display = 'none';
    };
    const clearImg = () => {
      prevImg.src = ''; prevWrap.style.display = 'none'; inner.style.display = '';
      this.grpModalFile = null;
      if (this.grpModalObjUrl) { URL.revokeObjectURL(this.grpModalObjUrl); this.grpModalObjUrl = null; }
      fileInp.value = '';
    };

    fileBtn?.addEventListener('click', () => fileInp.click());
    clearBtn?.addEventListener('click', (e) => { e.stopPropagation(); clearImg(); });
    fileInp.addEventListener('change', () => {
      const f = fileInp.files?.[0]; if (!f) return;
      if (!f.type.startsWith('image/')) { showToast('Только изображения', 'error'); return; }
      if (f.size > 5*1024*1024)         { showToast('Файл больше 5 МБ', 'error'); return; }
      this.grpModalFile = f;
      if (this.grpModalObjUrl) URL.revokeObjectURL(this.grpModalObjUrl);
      this.grpModalObjUrl = URL.createObjectURL(f);
      showImg(this.grpModalObjUrl);
    });
    const drop = div.querySelector('#vs-gm-drop') as HTMLElement;
    drop.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#vs-gm-file-btn,#vs-gm-clear')) return;
      if (!prevImg.src || prevImg.src === window.location.href) fileInp.click();
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('drag');
      const f = e.dataTransfer?.files?.[0]; if (!f) return;
      if (!f.type.startsWith('image/')) { showToast('Только изображения', 'error'); return; }
      if (f.size > 5*1024*1024)         { showToast('Файл больше 5 МБ', 'error'); return; }
      this.grpModalFile = f;
      if (this.grpModalObjUrl) URL.revokeObjectURL(this.grpModalObjUrl);
      this.grpModalObjUrl = URL.createObjectURL(f);
      showImg(this.grpModalObjUrl);
    });

    div.querySelector('#vs-gm-save')?.addEventListener('click', async () => {
      const name = (div.querySelector('#vs-gm-name') as HTMLInputElement).value.trim();
      if (!name) { showToast('Введите название группы', 'error'); return; }
      const saveBtn = div.querySelector('#vs-gm-save') as HTMLButtonElement;
      saveBtn.disabled = true; saveBtn.textContent = 'Сохраняем…';
      try {
        let coverUrl = group?.cover_url ?? '';
        if (this.grpModalFile) coverUrl = await storefrontDb.uploadGroupImage(this.grpModalFile, this.companyId);
        if (group) {
          await storefrontDb.updateGroup(group.id, { name, cover_url: coverUrl });
          showToast('Группа обновлена', 'success');
        } else {
          await storefrontDb.addGroup(this.companyId, name, coverUrl, this.groups.length);
          showToast('Группа создана', 'success');
        }
        close();
        await this.reloadGroups();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Ошибка сохранения', 'error');
        saveBtn.disabled = false; saveBtn.innerHTML = `${ic(I.check)} ${isEdit?'Сохранить':'Создать группу'}`;
      }
    });
  }

  private async reloadGroups(): Promise<void> {
    this.groups     = await storefrontDb.getGroups(this.companyId);
    this.groupItems = await storefrontDb.getAllGroupItems(this.companyId);
    const list = document.getElementById('vs-grp-list');
    if (list) list.innerHTML = this.renderGroupList();
    const cnt = document.querySelector('[data-tab="groups"] .vs-tab-cnt');
    if (cnt) cnt.textContent = String(this.groups.length);
    // Refresh group selects in products table
    document.querySelectorAll('.vs-grp-sel').forEach(sel => {
      const s = sel as HTMLSelectElement;
      const vc = s.dataset.vc!;
      const currentGid = this.groupItems.get(vc) ?? '';
      s.innerHTML = this.groupSelectOptions(currentGid);
    });
    document.getElementById('vs-grp-add2')?.addEventListener('click', () => this.openGroupModal(null));
  }

  /* ── Banner modal ────────────────────────────────────────────────────────── */
  private openModal(banner: StorefrontBanner | null): void {
    this.modalBanner = banner;
    this.modalFile   = null;
    if (this.modalObjUrl) { URL.revokeObjectURL(this.modalObjUrl); this.modalObjUrl = null; }

    const isEdit  = !!banner;
    const prevUrl = banner?.image_url ?? '';

    const div = document.createElement('div');
    div.id = 'vs-modal';
    div.className = 'vs-modal-bg';
    div.innerHTML = `<div class="vs-modal">
      <div class="vs-modal-hdr">
        <div class="vs-modal-ico">${ic(I.image, 18)}</div>
        <div class="vs-modal-ttl">${isEdit ? 'Редактировать баннер' : 'Добавить баннер'}</div>
        <button class="vs-ico-btn" id="vs-modal-close">${ic(I.x, 16)}</button>
      </div>
      <div class="vs-modal-body">
        <div id="vs-modal-err" style="display:none;background:var(--red-dim);border:1px solid var(--red);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--red);margin-bottom:14px"></div>

        <div class="vs-field">
          <label class="vs-label" for="vs-m-title">Название <span>для ориентации в админке</span></label>
          <input class="vs-inp" id="vs-m-title" type="text" placeholder="Летняя акция" value="${esc(banner?.title||'')}">
        </div>

        <div class="vs-field">
          <label class="vs-label">Изображение</label>
          <div class="vs-upload" id="vs-m-drop">
            <input type="file" accept="image/*" id="vs-m-file" style="display:none">
            <div id="vs-m-inner" class="vs-upload-inner" style="${prevUrl?'display:none':''}">
              <div class="vs-upload-ico">${ic(I.upload, 28)}</div>
              <div style="margin-bottom:8px">
                <button type="button" class="vs-btn vs-btn-sec vs-btn-sm" id="vs-m-file-btn">Выбрать файл</button>
              </div>
              <div style="font-size:11px;color:var(--text3)">JPG, PNG, WebP — не более 5 МБ</div>
            </div>
            <div class="vs-upload-preview" id="vs-m-prev-wrap" style="${prevUrl?'':'display:none'}">
              <img id="vs-m-prev-img" src="${esc(prevUrl)}" alt="">
              <button type="button" class="vs-upload-clear" id="vs-m-clear">${ic(I.x, 13)}</button>
            </div>
          </div>
        </div>

        <div id="vs-m-prev-grid" class="vs-prev-grid" style="${prevUrl?'':'display:none'}">
          <div class="vs-prev-card">
            <div class="vs-prev-lbl">${ic(I.monitor,12)} Десктоп (16:5)</div>
            <div class="vs-prev-dt" id="vs-m-dt">${prevUrl?`<img src="${esc(prevUrl)}" alt="">`:'<span>16:5</span>'}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:5px">Рек. 1440×450 px</div>
          </div>
          <div class="vs-prev-card">
            <div class="vs-prev-lbl">${ic(I.phone,12)} Мобайл (3:4)</div>
            <div class="vs-prev-mob" id="vs-m-mob">${prevUrl?`<img src="${esc(prevUrl)}" alt="">`:'<span>3:4</span>'}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:5px">Рек. 1080×1440 px</div>
          </div>
        </div>

        <div class="vs-field" style="margin-top:16px">
          <label class="vs-label" for="vs-m-link">Ссылка при клике <span>необязательно</span></label>
          <input class="vs-inp" id="vs-m-link" type="url" placeholder="/catalog или https://…" value="${esc(banner?.link_url==='/'?'':(banner?.link_url||''))}">
        </div>

        <div class="vs-field">
          <label class="vs-label" for="vs-m-order">Порядок отображения</label>
          <input class="vs-inp" id="vs-m-order" type="number" style="width:120px" value="${banner?.sort_order ?? this.banners.length}">
        </div>

        <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg3);border:1px solid var(--border);border-radius:8px">
          <label class="vs-sw"><input type="checkbox" id="vs-m-active" ${!isEdit||banner?.is_active?'checked':''}><span class="vs-sw-t"></span></label>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Активный баннер</div>
            <div style="font-size:11px;color:var(--text2);margin-top:1px">Показывается в магазине</div>
          </div>
        </div>
      </div>
      <div class="vs-modal-footer">
        <button class="vs-btn vs-btn-pri" id="vs-m-save" style="flex:1">${ic(I.check)} ${isEdit?'Обновить баннер':'Создать баннер'}</button>
        <button class="vs-btn vs-btn-sec" id="vs-m-cancel">Отмена</button>
      </div>
    </div>`;

    document.body.appendChild(div);
    document.body.style.overflow = 'hidden';
    this.bindModal(div);
  }

  private closeModal(): void {
    document.getElementById('vs-modal')?.remove();
    document.body.style.overflow = '';
    if (this.modalObjUrl) { URL.revokeObjectURL(this.modalObjUrl); this.modalObjUrl = null; }
    this.modalFile   = null;
    this.modalBanner = null;
  }

  private bindModal(div: HTMLElement): void {
    const close = () => this.closeModal();
    div.addEventListener('click', (e) => { if (e.target === div) close(); });
    div.querySelector('#vs-modal-close')?.addEventListener('click', close);
    div.querySelector('#vs-m-cancel')?.addEventListener('click', close);

    const fileInp  = div.querySelector('#vs-m-file')      as HTMLInputElement;
    const fileBtn  = div.querySelector('#vs-m-file-btn');
    const clearBtn = div.querySelector('#vs-m-clear');
    const prevWrap = div.querySelector('#vs-m-prev-wrap')  as HTMLElement;
    const inner    = div.querySelector('#vs-m-inner')      as HTMLElement;
    const prevImg  = div.querySelector('#vs-m-prev-img')   as HTMLImageElement;
    const prevGrid = div.querySelector('#vs-m-prev-grid')  as HTMLElement;
    const dt       = div.querySelector('#vs-m-dt')         as HTMLElement;
    const mob      = div.querySelector('#vs-m-mob')        as HTMLElement;

    const showImg = (url: string) => {
      prevImg.src = url;
      prevWrap.style.display = '';
      inner.style.display    = 'none';
      prevGrid.style.display = 'grid';
      dt.innerHTML  = `<img src="${url}" alt="">`;
      mob.innerHTML = `<img src="${url}" alt="">`;
    };
    const clearImg = () => {
      prevImg.src = '';
      prevWrap.style.display = 'none';
      inner.style.display    = '';
      prevGrid.style.display = 'none';
      dt.innerHTML  = '<span>16:5</span>';
      mob.innerHTML = '<span>3:4</span>';
      this.modalFile = null;
      if (this.modalObjUrl) { URL.revokeObjectURL(this.modalObjUrl); this.modalObjUrl = null; }
      fileInp.value = '';
    };

    fileBtn?.addEventListener('click', () => fileInp.click());
    clearBtn?.addEventListener('click', (e) => { e.stopPropagation(); clearImg(); });
    fileInp.addEventListener('change', () => {
      const f = fileInp.files?.[0]; if (!f) return;
      if (!f.type.startsWith('image/'))  { showToast('Только изображения', 'error'); return; }
      if (f.size > 5*1024*1024)          { showToast('Файл больше 5 МБ', 'error'); return; }
      this.modalFile = f;
      if (this.modalObjUrl) URL.revokeObjectURL(this.modalObjUrl);
      this.modalObjUrl = URL.createObjectURL(f);
      showImg(this.modalObjUrl);
    });
    const drop = div.querySelector('#vs-m-drop') as HTMLElement;
    drop.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#vs-m-file-btn,#vs-m-clear')) return;
      if (!prevImg.src || prevImg.src === window.location.href) fileInp.click();
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('drag');
      const f = e.dataTransfer?.files?.[0]; if (!f) return;
      if (!f.type.startsWith('image/'))  { showToast('Только изображения', 'error'); return; }
      if (f.size > 5*1024*1024)          { showToast('Файл больше 5 МБ', 'error'); return; }
      this.modalFile = f;
      if (this.modalObjUrl) URL.revokeObjectURL(this.modalObjUrl);
      this.modalObjUrl = URL.createObjectURL(f);
      showImg(this.modalObjUrl);
    });

    div.querySelector('#vs-m-save')?.addEventListener('click', () => this.saveModal(div));
  }

  private async saveModal(div: HTMLElement): Promise<void> {
    const g  = (id: string) => (div.querySelector(id) as HTMLInputElement)?.value?.trim() ?? '';
    const gc = (id: string) => (div.querySelector(id) as HTMLInputElement)?.checked ?? false;
    const errEl   = div.querySelector('#vs-modal-err') as HTMLElement;
    const saveBtn = div.querySelector('#vs-m-save')    as HTMLButtonElement;

    const title  = g('#vs-m-title');
    const link   = g('#vs-m-link') || '/';
    const order  = parseInt(g('#vs-m-order')) || 0;
    const active = gc('#vs-m-active');

    if (!this.modalFile && !this.modalBanner?.image_url) {
      errEl.textContent = 'Выберите изображение баннера';
      errEl.style.display = '';
      return;
    }

    saveBtn.disabled  = true;
    saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="animation:vs-spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Сохраняем…`;
    errEl.style.display = 'none';

    try {
      let imageUrl = this.modalBanner?.image_url ?? '';
      if (this.modalFile) imageUrl = await storefrontDb.uploadBannerImage(this.modalFile, this.companyId);

      if (this.modalBanner) {
        await storefrontDb.updateBanner(this.modalBanner.id, { title: title||undefined, image_url: imageUrl, link_url: link });
        await storefrontDb.updateBannerOrder([{ id: this.modalBanner.id, sort_order: order }]);
        await storefrontDb.toggleBannerActive(this.modalBanner.id, active);
        showToast('Баннер обновлён', 'success');
      } else {
        await storefrontDb.addBanner(this.companyId, imageUrl, link, order, title);
        if (!active) {
          const fresh = await storefrontDb.getBanners(this.companyId);
          const last  = fresh[fresh.length - 1];
          if (last) await storefrontDb.toggleBannerActive(last.id, false);
        }
        showToast('Баннер добавлен', 'success');
      }
      this.closeModal();
      await this.reloadBanners();
    } catch (err: unknown) {
      errEl.textContent   = err instanceof Error ? err.message : 'Ошибка сохранения';
      errEl.style.display = '';
      saveBtn.disabled    = false;
      saveBtn.innerHTML   = `${ic(I.check)} ${this.modalBanner ? 'Обновить баннер' : 'Создать баннер'}`;
    }
  }

  private async reloadBanners(): Promise<void> {
    this.banners = await storefrontDb.getBanners(this.companyId);
    const list = document.getElementById('vs-bn-list');
    if (list) list.innerHTML = this.renderBannerList();
    const cnt = document.querySelector('[data-tab="banners"] .vs-tab-cnt');
    if (cnt) cnt.textContent = String(this.banners.length);
    document.getElementById('vs-bn-add2')?.addEventListener('click', () => this.openModal(null));
  }

  private groupSelectOptions(currentGid: string): string {
    return `<option value="">—</option>` +
      this.groups.map(g => `<option value="${esc(g.id)}" ${currentGid===g.id?'selected':''}>${esc(g.name)}</option>`).join('');
  }

  /* ── Products panel ──────────────────────────────────────────────────────── */

  /** Group flat products array by vendor_code (like storefront does). */
  private groupedProducts(): Array<{ key: string; title: string; image: string|null; variants: StorefrontProduct[] }> {
    const byKey = new Map<string, StorefrontProduct[]>();
    for (const p of this.products) {
      const key = p.vendor_code.trim().toLowerCase() || `__${p.source}:${p.source_id}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(p);
    }
    const result: Array<{ key: string; title: string; image: string|null; variants: StorefrontProduct[] }> = [];
    for (const [key, variants] of byKey) {
      const title = variants.reduce((best, p) => p.title.length > best.length ? p.title : best, '');
      const withImg = variants.find(p => p.image);
      result.push({ key, title, image: withImg?.image ?? null, variants });
    }
    return result;
  }

  private renderProductsPanel(): string {
    const groups = this.groupedProducts();
    const visible = this.products.filter(p => !p.is_hidden).length;
    const counts: Record<string, number> = {};
    for (const p of this.products) counts[p.source] = (counts[p.source] || 0) + 1;

    return `<div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:18px;font-weight:800;color:var(--text)">Товары в магазине</div>
          <div style="font-size:13px;color:var(--text2);margin-top:3px">${groups.length} позиций · ${visible} из ${this.products.length} видны покупателям</div>
        </div>
      </div>

      <div class="vs-toolbar">
        <div class="vs-search-wrap">
          <div class="vs-search-ico">${ic(I.search, 14)}</div>
          <input class="vs-search" id="vs-psearch" type="search" placeholder="Поиск по названию или артикулу…" value="${esc(this.prodSearch)}">
        </div>
        <div class="vs-src-pills">
          <button class="vs-src-pill ${this.prodSrc==='all'?'on':''}" data-src="all">Все (${groups.length})</button>
          ${(['wb','ozon','yandex'] as const).filter(s => counts[s]).map(s =>
            `<button class="vs-src-pill ${this.prodSrc===s?'on':''}" data-src="${s}">${SRC[s]} (${counts[s]})</button>`
          ).join('')}
        </div>
      </div>

      <div class="vs-tbl-wrap" style="overflow-x:auto">
        <table class="vs-tbl">
          <thead><tr>
            <th style="width:54px;padding-left:14px"></th>
            <th>Название / Артикул</th>
            <th>Площадки и цены</th>
            ${this.groups.length ? `<th>Группа</th>` : ''}
          </tr></thead>
          <tbody id="vs-ptbody">${this.renderProdRows()}</tbody>
        </table>
      </div>
    </div>`;
  }

  private renderProdRows(): string {
    const q = this.prodSearch.toLowerCase();
    const groups = this.groupedProducts().filter(g => {
      if (this.prodSrc !== 'all' && !g.variants.some(v => v.source === this.prodSrc)) return false;
      if (q && !(g.title + ' ' + g.key).toLowerCase().includes(q)) return false;
      return true;
    }).slice(0, 300);

    if (!groups.length) {
      return `<tr><td colspan="4" style="text-align:center;padding:48px 20px">
        <div style="color:var(--text2);opacity:.25;margin-bottom:12px">${ic(I.search, 32)}</div>
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px">Товары не найдены</div>
        <div style="font-size:12px;color:var(--text2)">Измените запрос или фильтр площадки</div>
      </td></tr>`;
    }

    const vcKey = (g: { key: string; variants: StorefrontProduct[] }) =>
      g.variants[0]?.vendor_code?.trim().toLowerCase() || g.key;

    return groups.map(g => {
      const allHidden = g.variants.every(v => v.is_hidden);
      const img = g.image
        ? `<img class="vs-prod-img" src="${esc(g.image)}" alt="" loading="lazy" onerror="this.style.opacity='.1'">`
        : `<div class="vs-prod-img" style="display:flex;align-items:center;justify-content:center;color:var(--bg4)">${ic(I.pkg, 18)}</div>`;

      // One custom price/url per group (taken from first variant that has it, or first variant)
      const refVariant = g.variants.find(v => v.custom_price != null || v.custom_url) ?? g.variants[0];
      const groupCustomPrice = refVariant?.custom_price ?? null;
      const groupCustomUrl   = refVariant?.custom_url ?? '';

      const mpCells = g.variants.map(v => `
        <div class="vs-mp-entry" style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span class="vs-badge ${v.source}" style="min-width:52px;justify-content:center">${SRC[v.source]}</span>
          <span style="font-size:13px;font-weight:700;color:var(--text);min-width:70px">${Math.round(v.price).toLocaleString('ru-RU')} ₽</span>
          <label class="vs-sw" title="${v.is_hidden?'Скрыт':'Виден'}" style="margin-left:auto">
            <input type="checkbox" class="vs-vis"
              data-src="${esc(v.source)}" data-id="${esc(v.source_id)}"
              ${!v.is_hidden?'checked':''}><span class="vs-sw-t"></span>
          </label>
        </div>`).join('');

      const vc = vcKey(g);
      const currentGid = this.groupItems.get(vc) ?? '';

      // Shared price/url row (saved to all variants in group)
      const sharedRow = `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--text2);min-width:52px">Мой сайт</span>
          <input type="number" class="vs-price-inp vs-grp-inp" data-vc="${esc(vc)}"
            placeholder="Своя цена" value="${groupCustomPrice != null ? groupCustomPrice : ''}" style="width:90px">
          <input type="url" class="vs-url-inp vs-grp-inp" data-vc="${esc(vc)}"
            placeholder="Ссылка на товар" value="${esc(groupCustomUrl)}" style="width:150px">
        </div>`;
      const customTitle = g.variants.find(v => v.custom_title)?.custom_title ?? '';

      const eyeIcon = allHidden
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

      return `<tr class="${allHidden?'vs-prod-hidden':''}" data-vc="${esc(vc)}">
        <td style="padding:8px 10px 8px 14px">${img}</td>
        <td>
          <div style="display:flex;align-items:flex-start;gap:6px">
            <div style="flex:1;min-width:0">
              <div class="vs-prod-name">${esc(g.title)}</div>
              ${g.key && !g.key.startsWith('__') ? `<div class="vs-prod-art">${esc(g.key)}</div>` : ''}
              <input type="text" class="vs-title-inp vs-url-inp" data-vc="${esc(vc)}"
                placeholder="Название на витрине (если нужно изменить)" value="${esc(customTitle)}" style="width:200px;margin-top:5px">
            </div>
            <button class="vs-hide-all-btn" data-vc="${esc(vc)}" data-hidden="${allHidden?'1':'0'}"
              title="${allHidden?'Показать товар':'Скрыть товар полностью'}"
              style="flex-shrink:0;margin-top:2px;padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:${allHidden?'rgba(255,107,107,.12)':'var(--bg2)'};color:${allHidden?'#ff6b6b':'var(--text3)'};cursor:pointer;display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap">
              ${eyeIcon} ${allHidden?'Скрыт':'Скрыть'}
            </button>
          </div>
        </td>
        <td style="min-width:260px">
          <div style="border-top:1px solid var(--border)">${mpCells}${sharedRow}</div>
        </td>
        ${this.groups.length ? `<td>
          <select class="vs-url-inp vs-grp-sel" style="width:130px;padding:5px 8px;cursor:pointer" data-vc="${esc(vc)}">
            ${this.groupSelectOptions(currentGid)}
          </select>
        </td>` : ''}
      </tr>`;
    }).join('');
  }

  /* ── Event binding ───────────────────────────────────────────────────────── */
  private bind(): void {
    this.el.querySelectorAll('.vs-tab').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab((btn as HTMLElement).dataset.tab as typeof this.tab));
    });
    this.el.querySelectorAll('.vs-go').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab((btn as HTMLElement).dataset.tab as typeof this.tab));
    });

    document.getElementById('vs-copy')?.addEventListener('click', () => {
      const slug = this.settings?.slug;
      if (slug) {
        navigator.clipboard.writeText(`${window.location.origin}/${slug}`);
        showToast('Ссылка скопирована', 'success');
      }
    });

    const slugInp = document.getElementById('vs-slug') as HTMLInputElement|null;
    slugInp?.addEventListener('input', () => {
      const v = slugInp.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (slugInp.value !== v) slugInp.value = v;
      this.validateSlug(v);
    });
    document.getElementById('vs-save')?.addEventListener('click', () => this.save());

    // Groups
    const grpAdd = () => this.openGroupModal(null);
    document.getElementById('vs-grp-add')?.addEventListener('click', grpAdd);
    document.getElementById('vs-grp-add2')?.addEventListener('click', grpAdd);

    document.getElementById('vs-grp-list')?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('[data-gact]') as HTMLElement|null;
      if (!btn) return;
      const row = btn.closest('[data-gid]') as HTMLElement|null;
      if (!row) return;
      const id  = row.dataset.gid!;
      const idx = this.groups.findIndex(g => g.id === id);
      if (idx < 0) return;
      const act = btn.dataset.gact!;
      if (act === 'edit') { this.openGroupModal(this.groups[idx]); return; }
      if (act === 'del') {
        if (!confirm(`Удалить группу «${this.groups[idx].name}»? Товары останутся в каталоге.`)) return;
        await storefrontDb.deleteGroup(id);
        showToast('Группа удалена', 'success');
        await this.reloadGroups();
        return;
      }
      if (act === 'up'   && idx > 0)                          { await this.swapGrp(idx, idx-1); return; }
      if (act === 'down' && idx < this.groups.length-1)       { await this.swapGrp(idx, idx+1); return; }
    });

    // Group select in products table
    document.getElementById('vs-ptbody')?.addEventListener('change', async (e) => {
      const sel = e.target as HTMLSelectElement;
      if (!sel.classList.contains('vs-grp-sel')) return;
      const vc    = sel.dataset.vc!;
      const gid   = sel.value || null;
      await storefrontDb.setProductGroup(this.companyId, vc, gid);
      if (gid) this.groupItems.set(vc, gid);
      else     this.groupItems.delete(vc);
      showToast(gid ? 'Товар добавлен в группу' : 'Товар убран из группы', 'success');
    });

    const bnAdd = () => this.openModal(null);
    document.getElementById('vs-bn-add')?.addEventListener('click', bnAdd);
    document.getElementById('vs-bn-add2')?.addEventListener('click', bnAdd);

    document.getElementById('vs-bn-list')?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('[data-bact]') as HTMLElement|null;
      if (!btn) return;
      const row = btn.closest('[data-bid]') as HTMLElement|null;
      if (!row) return;
      const id  = row.dataset.bid!;
      const idx = this.banners.findIndex(b => b.id === id);
      if (idx < 0) return;
      const act = btn.dataset.bact!;

      if (act === 'edit') { this.openModal(this.banners[idx]); return; }
      if (act === 'del') {
        if (!confirm('Удалить баннер?')) return;
        await storefrontDb.deleteBanner(id);
        showToast('Баннер удалён', 'success');
        await this.reloadBanners();
        return;
      }
      if (act === 'hide') {
        this.banners[idx].is_active = false;
        await storefrontDb.toggleBannerActive(id, false);
        showToast('Баннер скрыт', 'success');
        await this.reloadBanners(); return;
      }
      if (act === 'show') {
        this.banners[idx].is_active = true;
        await storefrontDb.toggleBannerActive(id, true);
        showToast('Баннер показан', 'success');
        await this.reloadBanners(); return;
      }
      if (act === 'up'   && idx > 0)                          { await this.swapBn(idx, idx-1); return; }
      if (act === 'down' && idx < this.banners.length-1)      { await this.swapBn(idx, idx+1); return; }
    });

    document.getElementById('vs-ptbody')?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('.vs-hide-all-btn') as HTMLElement | null;
      if (!btn) return;
      const vc = btn.dataset.vc!;
      const nowHidden = btn.dataset.hidden === '1';
      const newHidden = !nowHidden;
      const groupProds = this.products.filter(x => {
        const k = x.vendor_code.trim().toLowerCase() || `__${x.source}:${x.source_id}`;
        return k === vc;
      });
      if (!groupProds.length) return;
      for (const p of groupProds) p.is_hidden = newHidden;
      await Promise.all(groupProds.map(p =>
        storefrontDb.setOverride(this.companyId, p.source, p.source_id, { is_hidden: newHidden }),
      ));
      // Update row visuals without full re-render
      const row = btn.closest('tr') as HTMLTableRowElement | null;
      if (row) {
        row.classList.toggle('vs-prod-hidden', newHidden);
        btn.dataset.hidden = newHidden ? '1' : '0';
        btn.title = newHidden ? 'Показать товар' : 'Скрыть товар полностью';
        btn.style.background = newHidden ? 'rgba(255,107,107,.12)' : 'var(--bg2)';
        btn.style.color = newHidden ? '#ff6b6b' : 'var(--text3)';
        const eyeOpen  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
        const eyeClosed = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
        btn.innerHTML = `${newHidden ? eyeClosed : eyeOpen} ${newHidden ? 'Скрыт' : 'Скрыть'}`;
        // Sync per-MP checkboxes
        row.querySelectorAll<HTMLInputElement>('.vs-vis').forEach(chk => { chk.checked = !newHidden; });
      }
      showToast(newHidden ? 'Товар скрыт из магазина' : 'Товар снова виден покупателям', 'success');
    });

    document.getElementById('vs-ptbody')?.addEventListener('change', async (e) => {
      const chk = e.target as HTMLInputElement;
      if (!chk.classList.contains('vs-vis')) return;
      // data-src and data-id are on the checkbox itself (grouped view)
      const src = chk.dataset.src!; const sid = chk.dataset.id!;
      const p = this.products.find(x => x.source===src && x.source_id===sid); if (!p) return;
      p.is_hidden = !chk.checked;
      await storefrontDb.setOverride(this.companyId, src, sid, { is_hidden: p.is_hidden });
      // Update row dimming based on whether ALL variants in the group are hidden
      const row = chk.closest('tr') as HTMLTableRowElement|null;
      if (row) {
        const vcKey = row.dataset.vc;
        if (vcKey) {
          const groupProds = this.products.filter(x => {
            const k = x.vendor_code.trim().toLowerCase() || `__${x.source}:${x.source_id}`;
            return k === vcKey;
          });
          row.classList.toggle('vs-prod-hidden', groupProds.every(x => x.is_hidden));
        }
      }
      showToast(p.is_hidden ? 'Товар скрыт из магазина' : 'Товар снова в магазине', 'success');
    });

    document.getElementById('vs-ptbody')?.addEventListener('blur', async (e) => {
      const inp = e.target as HTMLInputElement;

      // Custom title: per group (data-vc), saved to all variants
      if (inp.classList.contains('vs-title-inp')) {
        const vc = inp.dataset.vc!; if (!vc) return;
        const val = inp.value.trim();
        const groupProds = this.products.filter(x => {
          const k = x.vendor_code.trim().toLowerCase() || `__${x.source}:${x.source_id}`;
          return k === vc;
        });
        if (!groupProds.length) return;
        const cur = groupProds.find(p => p.custom_title)?.custom_title ?? '';
        if (cur === val) return;
        for (const p of groupProds) { p.custom_title = val; }
        await Promise.all(groupProds.map(p =>
          storefrontDb.setOverride(this.companyId, p.source, p.source_id, { custom_title: val }),
        ));
        showToast('Название сохранено', 'success');
        return;
      }

      // Shared price/url: saved to all variants in the group (data-vc)
      if (inp.classList.contains('vs-grp-inp')) {
        const vc = inp.dataset.vc!; if (!vc) return;
        const groupProds = this.products.filter(x => {
          const k = x.vendor_code.trim().toLowerCase() || `__${x.source}:${x.source_id}`;
          return k === vc;
        });
        if (!groupProds.length) return;
        if (inp.classList.contains('vs-url-inp')) {
          const val = inp.value.trim();
          for (const p of groupProds) p.custom_url = val;
          await Promise.all(groupProds.map(p => storefrontDb.setOverride(this.companyId, p.source, p.source_id, { custom_url: val })));
          showToast('Ссылка сохранена', 'success');
        } else if (inp.classList.contains('vs-price-inp')) {
          const raw = inp.value.trim();
          const val: number|null = raw === '' ? null : Number(raw);
          for (const p of groupProds) p.custom_price = val;
          await Promise.all(groupProds.map(p => storefrontDb.setOverride(this.companyId, p.source, p.source_id, { custom_price: val })));
          showToast('Цена сохранена', 'success');
        }
        return;
      }

      const src = inp.dataset.src!; const sid = inp.dataset.id!;
      if (!src || !sid) return;
    }, true);

    document.getElementById('vs-ptbody')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        const t = e.target as HTMLInputElement;
        if (t.classList.contains('vs-url-inp') || t.classList.contains('vs-price-inp')) t.blur();
      }
    });

    document.getElementById('vs-psearch')?.addEventListener('input', (e) => {
      this.prodSearch = (e.target as HTMLInputElement).value;
      const tbody = document.getElementById('vs-ptbody');
      if (tbody) tbody.innerHTML = this.renderProdRows();
    });

    this.el.querySelectorAll('.vs-src-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        this.prodSrc = (btn as HTMLElement).dataset.src ?? 'all';
        this.el.querySelectorAll('.vs-src-pill').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        const tbody = document.getElementById('vs-ptbody');
        if (tbody) tbody.innerHTML = this.renderProdRows();
      });
    });

    // Variants tab
    const varAdd = () => this.openVariantModal(null);
    document.getElementById('vs-var-add')?.addEventListener('click', varAdd);
    document.getElementById('vs-var-add2')?.addEventListener('click', varAdd);

    document.getElementById('vs-var-suggest')?.addEventListener('click', () => {
      const box      = document.getElementById('vs-var-suggest-box')!;
      const listEl   = document.getElementById('vs-var-suggest-list')!;
      const cntEl    = document.getElementById('vs-var-suggest-cnt')!;
      const emptyEl  = document.getElementById('vs-var-suggest-empty')!;
      const suggestions = this.suggestVariantGroups();
      box.style.display = '';
      cntEl.textContent = suggestions.length ? `(${suggestions.length})` : '';
      if (!suggestions.length) { emptyEl.style.display = ''; listEl.innerHTML = ''; return; }
      emptyEl.style.display = 'none';

      const vcTitles = new Map<string, string>();
      for (const p of this.products) {
        const k = p.vendor_code.trim().toLowerCase();
        if (k && !vcTitles.has(k)) vcTitles.set(k, p.custom_title || p.title);
      }

      listEl.innerHTML = suggestions.map((s, si) => {
        const chips = s.vcs.map(vc =>
          `<span style="background:var(--bg4);border:1px solid var(--border);border-radius:5px;padding:2px 7px;font-size:11px;font-weight:700">${esc(vc)}</span>`
        ).join('');
        const names = s.vcs.map(vc => vcTitles.get(vc) ?? vc).join(', ');
        return `<div data-msugg="${si}" style="background:var(--bg3);border-radius:10px;padding:10px 12px;display:flex;align-items:flex-start;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${chips}</div>
            <div style="font-size:11px;color:var(--text2)">${esc(names.slice(0,120))}${names.length>120?'…':''}</div>
          </div>
          <button class="vs-btn vs-btn-sec vs-btn-xs vs-msugg-edit"  data-msugg="${si}">${ic(I.edit,12)} Изменить</button>
          <button class="vs-btn vs-btn-xs            vs-msugg-apply" data-msugg="${si}">${ic(I.check,12)} Применить</button>
        </div>`;
      }).join('');
      (box as any)._mSuggestions = suggestions;
    });

    document.getElementById('vs-var-suggest-close')?.addEventListener('click', () => {
      const box = document.getElementById('vs-var-suggest-box');
      if (box) box.style.display = 'none';
    });

    document.getElementById('vs-var-suggest-list')?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('[data-msugg]') as HTMLElement|null;
      if (!btn) return;
      const si = parseInt(btn.dataset.msugg!);
      const box = document.getElementById('vs-var-suggest-box')!;
      const sugg = ((box as any)._mSuggestions as { key: string; vcs: string[] }[])[si];
      if (!sugg) return;

      if (btn.classList.contains('vs-msugg-edit')) {
        const fakeGroup: StorefrontVariantGroup = {
          id: '__new__', sort_order: 0,
          items: sugg.vcs.map((vc, i) => ({
            vendor_code: vc,
            label: vc.replace(/[-_\s]?(xs|s|m|l|xl|2xl|3xl|xxl|xxxl|\d{1,3})$/i,(_,g)=>g||'').slice(0,6).toUpperCase(),
            color: '',
            sort_order: i,
          })),
        };
        this.openVariantModal(fakeGroup);
      } else if (btn.classList.contains('vs-msugg-apply')) {
        btn.setAttribute('disabled','');
        try {
          const items = sugg.vcs.map((vc, i) => ({
            vendor_code: vc,
            label: vc.replace(/[-_\s]?(xs|s|m|l|xl|2xl|3xl|xxl|xxxl|\d{1,3})$/i,(_,g)=>g||'').slice(0,6).toUpperCase(),
            color: '',
            sort_order: i,
          }));
          await storefrontDb.addVariantGroup(this.companyId, items, this.variantGroups.length);
          showToast('Группа создана', 'success');
          btn.closest('[data-msugg]')?.remove();
          await this.reloadVariants();
        } catch {
          showToast('Ошибка', 'error');
          btn.removeAttribute('disabled');
        }
      }
    });

    document.getElementById('vs-var-ai')?.addEventListener('click', () => this.runAISuggest());

    document.getElementById('vs-var-list')?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('[data-vgact]') as HTMLElement|null;
      if (!btn) return;
      const row = btn.closest('[data-vgid]') as HTMLElement|null;
      if (!row) return;
      const id  = row.dataset.vgid!;
      const vg  = this.variantGroups.find(g => g.id === id);
      if (!vg) return;
      const act = btn.dataset.vgact!;
      if (act === 'edit') { this.openVariantModal(vg); }
      if (act === 'del') {
        if (!confirm('Удалить группу вариантов?')) return;
        await storefrontDb.deleteVariantGroup(id);
        showToast('Группа удалена', 'success');
        await this.reloadVariants();
      }
    });
  }

  private switchTab(tab: typeof this.tab): void {
    if (!tab) return;
    this.tab = tab;
    this.el.querySelectorAll('.vs-tab').forEach(b => b.classList.remove('on'));
    this.el.querySelectorAll('.vs-panel').forEach(p => p.classList.remove('on'));
    this.el.querySelector(`[data-tab="${tab}"]`)?.classList.add('on');
    document.getElementById(`vs-${tab}`)?.classList.add('on');
  }

  private async swapBn(a: number, b: number): Promise<void> {
    const ba = this.banners[a], bb = this.banners[b];
    const tmp = ba.sort_order; ba.sort_order = bb.sort_order; bb.sort_order = tmp;
    [this.banners[a], this.banners[b]] = [bb, ba];
    await storefrontDb.updateBannerOrder([
      { id: ba.id, sort_order: ba.sort_order },
      { id: bb.id, sort_order: bb.sort_order },
    ]);
    const list = document.getElementById('vs-bn-list');
    if (list) list.innerHTML = this.renderBannerList();
  }

  private validateSlug(val: string): void {
    const hint = document.getElementById('vs-slug-hint'); if (!hint) return;
    if (this.slugTimer) clearTimeout(this.slugTimer);
    if (!val)          { hint.textContent = ''; hint.className = 'vs-hint'; this.slugOk = null; return; }
    if (val.length < 3) { hint.textContent = 'Минимум 3 символа'; hint.className = 'vs-hint err'; this.slugOk = false; return; }
    hint.textContent = 'Проверяем…'; hint.className = 'vs-hint';
    this.slugTimer = setTimeout(async () => {
      const ok = await storefrontDb.checkSlugAvailable(val, this.companyId);
      this.slugOk = ok;
      hint.textContent = ok ? `✓ ${window.location.origin}/s/${val} — свободно` : '✗ Этот адрес уже занят';
      hint.className   = `vs-hint ${ok ? 'ok' : 'err'}`;
    }, 500);
  }

  private async swapGrp(a: number, b: number): Promise<void> {
    [this.groups[a], this.groups[b]] = [this.groups[b], this.groups[a]];
    await storefrontDb.updateGroupOrder(
      this.groups.map((g, i) => ({ id: g.id, sort_order: i })),
    );
    await this.reloadGroups();
  }

  private async save(): Promise<void> {
    const g   = (id: string) => (document.getElementById(id) as HTMLInputElement|null)?.value?.trim() ?? '';
    const slug = g('vs-slug');
    if (slug && this.slugOk === false) { showToast('Исправьте адрес магазина', 'error'); return; }
    const btn = document.getElementById('vs-save') as HTMLButtonElement|null;
    if (btn) { btn.disabled = true; btn.textContent = 'Сохраняем…'; }
    try {
      const cb = (id: string) => (document.getElementById(id) as HTMLInputElement|null)?.checked ?? false;
      await storefrontDb.save({
        company_id:           this.companyId,
        is_enabled:           cb('vs-enabled'),
        slug:                 slug || (null as unknown as string),
        store_name:           g('vs-name'),
        tagline:              g('vs-tagline'),
        telegram:             g('vs-tg'),
        whatsapp:             g('vs-wa'),
        phone:                g('vs-ph'),
        website:              g('vs-web'),
        show_price_filter:    cb('vs-fprice'),
        show_brand_filter:    cb('vs-fbrand'),
        show_category_filter: cb('vs-fcat'),
        show_stock:           cb('vs-show-stock'),
        hide_out_of_stock:    cb('vs-hide-oos'),
      });
      this.settings = await storefrontDb.get(this.companyId);
      showToast('Настройки сохранены', 'success');
      this.render();
    } catch {
      showToast('Ошибка сохранения', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = `${ic(I.check)} Сохранить настройки`; }
    }
  }
}
