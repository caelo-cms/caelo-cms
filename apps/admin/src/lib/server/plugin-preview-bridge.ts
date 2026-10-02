// SPDX-License-Identifier: MPL-2.0
/** Only this host-owned script runs in the opaque-origin plugin iframe. */
export function previewBridge(channel: string, ids: string[], contextIds: string[] = []): string {
  const config = JSON.stringify({ channel, ids, contextIds }).replaceAll("<", "\\u003c");
  return `(()=>{const c=${config};const ids=new Set(c.ids);
  const nodes=[...document.querySelectorAll('[data-caelo-preview-target]')].filter(n=>ids.has(n.dataset.caeloPreviewTarget));
  function select(n){nodes.forEach(x=>x.style.outline='');n.style.outline='3px solid #2563eb';parent.postMessage({kind:'caelo:plugin-target',channel:c.channel,id:n.dataset.caeloPreviewTarget},'*');}
  nodes.forEach(n=>{n.tabIndex=0;n.style.cursor='pointer';});
  document.addEventListener('click',e=>{const n=e.target.closest('[data-caelo-preview-target]');if(n&&ids.has(n.dataset.caeloPreviewTarget)){e.preventDefault();e.stopPropagation();select(n);}});
  document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const n=e.target.closest('[data-caelo-preview-target]');if(n&&ids.has(n.dataset.caeloPreviewTarget)){e.preventDefault();select(n);}});
  const contexts=nodes.filter(n=>c.contextIds.includes(n.dataset.caeloPreviewTarget));
  let active='',scheduled=false;
  function visibleContext(){scheduled=false;let best=null,score=0;
    for(const n of contexts){const r=n.getBoundingClientRect();const visible=Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0))*Math.max(0,Math.min(r.right,innerWidth)-Math.max(r.left,0));if(visible>score){score=visible;best=n;}}
    if(best&&best.dataset.caeloPreviewTarget!==active){active=best.dataset.caeloPreviewTarget;nodes.forEach(n=>n.style.outline='');parent.postMessage({kind:'caelo:plugin-context',channel:c.channel,id:active},'*');}}
  function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(visibleContext);}}
  addEventListener('scroll',schedule,{passive:true});addEventListener('resize',schedule);addEventListener('load',schedule);schedule();
  })();`;
}
