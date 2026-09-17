// SPDX-License-Identifier: MPL-2.0
/** Only this host-owned script runs in the opaque-origin plugin iframe. */
export function previewBridge(channel: string, ids: string[]): string {
  const config = JSON.stringify({ channel, ids }).replaceAll("<", "\\u003c");
  return `(()=>{const c=${config};const ids=new Set(c.ids);
  const nodes=[...document.querySelectorAll('[data-caelo-preview-target]')].filter(n=>ids.has(n.dataset.caeloPreviewTarget));
  function select(n){nodes.forEach(x=>x.style.outline='');n.style.outline='3px solid #2563eb';parent.postMessage({kind:'caelo:plugin-target',channel:c.channel,id:n.dataset.caeloPreviewTarget},'*');}
  nodes.forEach(n=>{n.tabIndex=0;n.style.cursor='pointer';});
  document.addEventListener('click',e=>{const n=e.target.closest('[data-caelo-preview-target]');if(n&&ids.has(n.dataset.caeloPreviewTarget)){e.preventDefault();e.stopPropagation();select(n);}});
  document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const n=e.target.closest('[data-caelo-preview-target]');if(n&&ids.has(n.dataset.caeloPreviewTarget)){e.preventDefault();select(n);}});
  })();`;
}
