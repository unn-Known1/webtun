// WebTun frontend - viewers.js (image/pdf/epub/office + html/md preview).


const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.bmp', '.ico']);

// Binary extensions from https://github.com/sindresorhus/binary-extensions (v2.3.0)
// Used to block editor preview for non-text files. Images are previewable via image viewer, so they are checked first.
const BINARY_EXTS = new Set([
  '3dm','3ds','3g2','3gp','7z','a','aac','adp','afdesign','afphoto','afpub','ai','aif','aiff','alz','ape','apk','appimage','avif','ar','arj','asf','au','avi','bak','baml','bh','bin','bk','bmp','btif','bz2','bzip2','cab','caf','cgm','class','cmx','cpio','cr2','cr3','cur','dat','dcm','deb','dex','djvu','dll','dmg','dng','doc','docm','docx','dot','dotm','dra','ds_store','dsk','dts','dtshd','dvb','dwg','dxf','ecelp4800','ecelp7470','ecelp9600','egg','eol','eot','epub','exe','f4v','fbs','fh','fla','flac','flatpak','fli','flv','fpx','fst','fvt','g3','gh','gif','graffle','gz','gzip','h261','h263','h264','icns','ico','ief','img','ipa','iso','jar','jpeg','jpg','jpgv','jpm','jxr','key','ktx','lha','lib','lvp','lz','lzh','lzma','lzo','m3u','m4a','m4v','mar','mdi','mht','mid','midi','mj2','mka','mkv','mmr','mng','mobi','mov','movie','mp3','mp4','mp4a','mpeg','mpg','mpga','mxu','nef','npx','numbers','nupkg','o','odp','ods','odt','oga','ogg','ogv','otf','ott','pages','pbm','pcx','pdb','pdf','pea','pgm','pic','png','pnm','pot','potm','potx','ppa','ppam','ppm','pps','ppsm','ppsx','ppt','pptm','pptx','psd','pya','pyc','pyo','pyv','qt','rar','ras','raw','resources','rgb','rip','rlc','rmf','rmvb','rpm','rtf','rz','s3m','s7z','scpt','sgi','shar','snap','sil','sketch','slk','smv','snk','so','stl','suo','sub','swf','tar','tbz','tbz2','tga','tgz','thmx','tif','tiff','tlz','ttc','ttf','txz','udf','uvh','uvi','uvm','uvp','uvs','uvu','viv','vob','war','wav','wax','wbmp','wdp','weba','webm','webp','whl','wim','wm','wma','wmv','wmx','woff','woff2','wrm','wvx','xbm','xif','xla','xlam','xls','xlsb','xlsm','xlsx','xlt','xltm','xltx','xm','xmind','xpi','xpm','xwd','xz','z','zip','zipx'
]);

function isImageFile(path) {
  const m = path.match(/\.([^.]+)$/);
  return m ? IMAGE_EXTS.has('.' + m[1].toLowerCase()) : false;
}

function getFileExt(path) {
  const m = path.match(/\.([^.\\/]+)$/);
  return m ? '.' + m[1].toLowerCase() : '';
}

function isBinaryFile(path) {
  const ext = getFileExt(path);
  return ext ? BINARY_EXTS.has(ext.slice(1).toLowerCase()) : false;
}

function canOpenInEditor(path) {
  if (isImageFile(path)) return false;
  if (isPdfFile(path) || isEpubFile(path)) return false;
  if (isBinaryFile(path)) return false;
  return true;
}

function isPdfFile(path) { return /\.pdf$/i.test(path); }
function isEpubFile(path) { return /\.epub$/i.test(path); }
function isOfficeDocx(path) { return /\.docx$/i.test(path); }
function isOfficeXlsx(path) { return /\.xlsx$/i.test(path); }
function isOfficeFile(path) { return isOfficeDocx(path) || isOfficeXlsx(path); }
function isLegacyOfficeFile(path) { return /\.(doc|dot|docm|dotm|xls|xlt|xlsm|xlsb|xlam|ppt|pot|pps|pptm|potm|ppsm|ppsx|odt|ods|odp|rtf)$/i.test(path); }
function isDocFile(path) { return isPdfFile(path) || isEpubFile(path) || isOfficeFile(path); }

// ── Doc preview dynamic loader ──
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function loadPdfJs() {
  if (window.pdfjsLib) return;
  // pdf.js v2 UMD global is pdfjsLib
  await loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.min.js');
  const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if (!lib) throw new Error('PDF.js not found');
  window.pdfjsLib = lib;
  if (lib.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js';
  }
}
async function loadEpubJs() {
  if (window.ePub) return;
  await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js');
  if (!window.ePub && !window.EPUBJS) throw new Error('EPUB.js not found');
  if (!window.ePub && window.EPUBJS) window.ePub = window.EPUBJS;
}

let _pdfDoc = null;
let _pdfPath = '';
let _pdfScale = 1.4;
let _pdfCurrentPage = 1;
let _pdfPageOrder = null;
let _pdfRenderGen = 0;
let _pdfScrollHandler = null;
let _pdfLazyObserver = null;
let _pdfQueue = [];
let _pdfQueued = new Set();
let _pdfRendering = new Set();
let _pdfQueueRunning = false;
let _pdfLabelMap = {};

async function openPdfViewer(path) {
  // Invalidate any in-flight PDF load/render so reopen/double-click can't duplicate pages
  const myGen = ++_pdfRenderGen;
  // Tear down previous doc render before starting a new one
  if (_pdfObserver) try { _pdfObserver.disconnect(); } catch {} _pdfObserver = null;
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); } catch {} _pdfLazyObserver = null;
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false; _pdfLabelMap = {};
  if (_pdfDoc) try { _pdfDoc.destroy(); } catch {} _pdfDoc = null;
  const _prevWrap = document.getElementById('pdf-canvas-wrap');
  if (_prevWrap && _pdfScrollHandler) try { _prevWrap.removeEventListener('scroll', _pdfScrollHandler); } catch {}
  _pdfScrollHandler = null;
  // Show viewer shell immediately for perceived performance
  editorPath = path;
  editorOriginalContent = '';
  const fileName = path.split(/[\\/]/).pop() || path;
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = 'none';
  document.getElementById('editor-preview').classList.remove('active');
  const iframe = document.getElementById('editor-preview-iframe');
  clearPreviewDoc(iframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('epub-viewer').classList.remove('active');
  document.getElementById('office-viewer').classList.remove('active');
  const pdfViewer = document.getElementById('pdf-viewer');
  pdfViewer.classList.add('active');
  document.getElementById('pdf-title').textContent = fileName;
  document.getElementById('pdf-page-info').textContent = 'Loading…';
  document.getElementById('pdf-canvas-wrap').innerHTML = '<div style="color:var(--fg2);padding:20px">Loading PDF…</div>';
  // open editor split immediately
  if (window.innerWidth > 768) {
    document.getElementById('content').classList.add('editor-open');
    const splitArea = document.getElementById('editor-split-area');
    try {
      const orient = safeStorage.getItem('wt-editor-split-orientation');
      const isHoriz = orient === 'horizontal';
      if (splitArea) splitArea.classList.toggle('horizontal', isHoriz);
    } catch {}
  }
  document.getElementById('editor-view').classList.add('open');
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
  // Load PDF.js immediately without confirmation (cached after first load)
  if (!window.pdfjsLib) {
    const t = toast('Loading PDF viewer…', 'info');
    try { await loadPdfJs(); t.remove(); } catch (e) { t.remove(); toast('Failed to load PDF viewer: ' + e.message, 'error'); return; }
  }
  if (myGen !== _pdfRenderGen) return;
  try {
    const resp = await fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, { headers: { 'x-pin-token': authToken } });
    if (myGen !== _pdfRenderGen) return;
    if (!resp.ok) throw new Error('Failed to fetch PDF');
    // Stream download with progress so big PDFs don't look stuck (fallback to arrayBuffer)
    let buf;
    try {
      const totalLen = parseInt(resp.headers.get('content-length') || '0', 10);
      if (resp.body && resp.body.getReader) {
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (myGen !== _pdfRenderGen) { try { reader.cancel(); } catch {} return; }
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (totalLen > 0) {
            const pct = Math.min(99, Math.round(received / totalLen * 100));
            document.getElementById('pdf-page-info').textContent = 'Downloading… ' + pct + '%';
          } else if (received % (1024*1024) < 65536) {
            document.getElementById('pdf-page-info').textContent = 'Downloading… ' + (received/1024/1024).toFixed(1) + 'MB';
          }
        }
        const merged = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        buf = merged.buffer;
      } else {
        buf = await resp.arrayBuffer();
      }
    } catch (e2) {
      if (myGen !== _pdfRenderGen) return;
      buf = await resp.arrayBuffer().catch(() => { throw e2; });
    }
    if (myGen !== _pdfRenderGen) return;
    const lib = window.pdfjsLib;
    const loadingTask = lib.getDocument({ data: buf });
    const doc = await loadingTask.promise;
    if (myGen !== _pdfRenderGen) { try { doc.destroy(); } catch {} return; }
    _pdfDoc = doc;
    _pdfPath = path;
    _pdfCurrentPage = 1;
    _pdfScale = 1.4;
    await renderPdfDoc(myGen);
  } catch (e) {
    if (myGen !== _pdfRenderGen) return;
    console.warn('PDF load failed', e);
    document.getElementById('pdf-canvas-wrap').innerHTML = '<div style="color:var(--red);padding:20px">Failed to load PDF: ' + escHtml(e.message) + '</div>';
    document.getElementById('pdf-page-info').textContent = 'Error';
    toast('PDF load failed: ' + e.message, 'error');
  }
}
async function renderPdfDoc(gen, opts) {
  const myGen = (gen !== undefined) ? gen : _pdfRenderGen;
  const doc = _pdfDoc;
  if (!doc) return;
  if (myGen !== _pdfRenderGen) return;
  const keepPage = opts && opts.keepPage ? _pdfCurrentPage : null;
  const wrap = document.getElementById('pdf-canvas-wrap');
  // reset lazy state for this generation
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); } catch {} _pdfLazyObserver = null;
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false;
  wrap.innerHTML = '';
  const total = doc.numPages;
  let pageLabels = null;
  try { pageLabels = await doc.getPageLabels(); } catch {}
  if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
  const getLabel = (idx) => pageLabels && pageLabels[idx-1] ? pageLabels[idx-1] : String(idx);
  // Build ordered list of pages sorted by actual page number (label if numeric, else index) to ensure preview matches printed page numbers
  let pageOrder = Array.from({length: total}, (_, k) => k+1);
  if (pageLabels) {
    try {
      pageOrder.sort((a,b) => {
        const la = getLabel(a), lb = getLabel(b);
        const na = parseInt(la, 10), nb = parseInt(lb, 10);
        const aIsNum = !isNaN(na) && String(na) === la.trim();
        const bIsNum = !isNaN(nb) && String(nb) === lb.trim();
        if (aIsNum && bIsNum) return na - nb;
        if (aIsNum && !bIsNum) return -1;
        if (!aIsNum && bIsNum) return 1;
        return la.localeCompare(lb);
      });
    } catch {}
  }
  _pdfPageOrder = pageOrder;
  _pdfLabelMap = {};
  for (const p of pageOrder) _pdfLabelMap[p] = getLabel(p);
  _pdfCurrentPage = (keepPage && pageOrder.includes(keepPage)) ? keepPage : pageOrder[0];
  document.getElementById('pdf-page-info').textContent = getLabel(pageOrder[0]) + ' / ' + getLabel(pageOrder[pageOrder.length-1]) + ' • ' + total + ' pages';
  // Build cheap placeholders for all pages in one DOM pass (fast even for 1000+ pages),
  // then lazily render only visible pages. This is the big-PDF optimization:
  // previously every page was rendered upfront serially (O(N) canvas work).
  try {
    const frag = document.createDocumentFragment();
    for (const i of pageOrder) {
      const pageWrap = document.createElement('div');
      pageWrap.className = 'pdf-page-box';
      pageWrap.id = 'pdf-wrap-' + i;
      pageWrap.dataset.page = i;
      pageWrap.dataset.label = getLabel(i);
      pageWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;width:100%';
      const slot = document.createElement('div');
      slot.className = 'pdf-page-slot';
      slot.dataset.page = i;
      slot.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:400px;min-width:min(100%,480px);background:rgba(127,127,127,0.08);border-radius:4px;color:var(--fg2);font-size:11px;padding:24px';
      slot.textContent = 'Page ' + getLabel(i) + ' — scroll to load…';
      pageWrap.appendChild(slot);
      const label = document.createElement('div');
      label.style.cssText = 'color:var(--fg2);font-size:10px';
      label.textContent = 'Page ' + getLabel(i) + ' • ' + i + '/' + total;
      pageWrap.appendChild(label);
      frag.appendChild(pageWrap);
    }
    wrap.appendChild(frag);
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
    setupPdfScrollTracking();
    setupPdfLazyRender(wrap, doc, myGen);
    // First-page-fast: render the current page immediately so the user sees content
    // without waiting for the observer, then let the queue handle the rest.
    await pdfRenderPageInto(_pdfCurrentPage, myGen, doc);
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
    // Pre-queue neighbours of the current page for instant scroll
    const order = _pdfPageOrder || pageOrder;
    const idx = order.indexOf(_pdfCurrentPage);
    for (let k = 1; k <= 2; k++) {
      if (order[idx+k]) pdfQueuePage(order[idx+k], myGen, doc, true);
      if (order[idx-k]) pdfQueuePage(order[idx-k], myGen, doc, true);
    }
  } catch (e) {
    if (myGen !== _pdfRenderGen) return;
    wrap.innerHTML = '<div style="color:var(--red);padding:20px">Render failed: ' + escHtml(e.message) + '</div>';
  }
}
// Queue a page for background render (deduped). Priority pages go to the front.
function pdfQueuePage(pageNum, myGen, doc, priority) {
  if (myGen !== _pdfRenderGen || !doc || _pdfDoc !== doc) return;
  const slot = document.querySelector('#pdf-wrap-' + pageNum + ' .pdf-page-slot');
  if (!slot || slot.dataset.rendered === '1' || _pdfRendering.has(pageNum) || _pdfQueued.has(pageNum)) return;
  if (priority) _pdfQueue.unshift({ pageNum, myGen });
  else _pdfQueue.push({ pageNum, myGen });
  _pdfQueued.add(pageNum);
  // cap queue so fast scrolling doesn't pile up hundreds of pending renders
  if (_pdfQueue.length > 30) {
    for (const dropped of _pdfQueue.splice(30)) _pdfQueued.delete(dropped.pageNum);
  }
  pumpPdfQueue(doc);
}
async function pumpPdfQueue(doc) {
  if (_pdfQueueRunning) return;
  _pdfQueueRunning = true;
  try {
    while (_pdfQueue.length) {
      const job = _pdfQueue.shift();
      _pdfQueued.delete(job.pageNum);
      if (job.myGen !== _pdfRenderGen || _pdfDoc !== doc) { _pdfQueue.length = 0; _pdfQueued.clear(); break; }
      try { await pdfRenderPageInto(job.pageNum, job.myGen, doc); }
      catch (e) { /* placeholder keeps retry-on-visible */ }
      // breathe between background pages so scrolling stays smooth
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    _pdfQueueRunning = false;
  }
}
async function pdfRenderPageInto(pageNum, myGen, doc) {
  if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
  const box = document.getElementById('pdf-wrap-' + pageNum);
  if (!box) return;
  const slot = box.querySelector('.pdf-page-slot');
  if (!slot || slot.dataset.rendered === '1' || _pdfRendering.has(pageNum)) return;
  _pdfRendering.add(pageNum);
  try {
    const page = await doc.getPage(pageNum);
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
    const viewport = page.getViewport({ scale: _pdfScale });
    // Cap canvas backing store so huge pages don't OOM (~2.5MP max)
    const MAX_PX = 2500000;
    const px = viewport.width * viewport.height;
    let outW = Math.round(viewport.width), outH = Math.round(viewport.height);
    let styleW = viewport.width, styleH = viewport.height;
    if (px > MAX_PX) {
      const s = Math.sqrt(MAX_PX / px);
      outW = Math.round(viewport.width * s); outH = Math.round(viewport.height * s);
    }
    const canvas = document.createElement('canvas');
    canvas.id = 'pdf-page-' + pageNum;
    canvas.dataset.page = pageNum;
    canvas.dataset.label = _pdfLabelMap[pageNum] || String(pageNum);
    canvas.width = outW; canvas.height = outH;
    canvas.style.width = styleW + 'px';
    canvas.style.height = styleH + 'px';
    canvas.style.maxWidth = '100%';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: (outW === Math.round(viewport.width)) ? viewport : page.getViewport({ scale: _pdfScale * Math.sqrt(MAX_PX / px) }) }).promise;
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc || !box.isConnected) return;
    slot.innerHTML = '';
    slot.style.minHeight = '';
    slot.style.background = 'transparent';
    slot.style.padding = '0';
    slot.style.position = 'relative';
    slot.appendChild(canvas);
    // Selectable text layer over the canvas (transparent spans). Sized to
    // the displayed canvas so max-width shrinking stays aligned.
    try {
      const lib = window.pdfjsLib;
      if (lib && typeof lib.renderTextLayer === 'function') {
        const textContent = await page.getTextContent();
        if (myGen !== _pdfRenderGen || _pdfDoc !== doc || !box.isConnected) return;
        if (textContent && textContent.items && textContent.items.length) {
          const dispW = canvas.clientWidth || styleW;
          const k = dispW / styleW;
          const textViewport = page.getViewport({ scale: _pdfScale * k });
          const layer = document.createElement('div');
          layer.className = 'textLayer';
          layer.style.width = dispW + 'px';
          layer.style.height = Math.round(styleH * k) + 'px';
          slot.appendChild(layer);
          const task = lib.renderTextLayer({ textContent, container: layer, viewport: textViewport });
          if (task && task.promise) await task.promise;
        }
      }
    } catch {}
    slot.dataset.rendered = '1';
    try { if (typeof page.cleanup === 'function') page.cleanup(); } catch {}
  } catch (e) {
    if (myGen !== _pdfRenderGen) return;
    if (slot && slot.dataset.rendered !== '1') {
      slot.textContent = 'Failed to render page ' + pageNum + ' — scroll away and back to retry';
    }
    throw e;
  } finally {
    _pdfRendering.delete(pageNum);
  }
}
function setupPdfLazyRender(wrap, doc, myGen) {
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); } catch {}
  try {
    _pdfLazyObserver = new IntersectionObserver((entries) => {
      if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const slot = e.target.nodeType === 1 && e.target.classList && e.target.classList.contains('pdf-page-slot')
          ? e.target
          : (e.target.querySelector ? e.target.querySelector('.pdf-page-slot') : null);
        const pn = slot ? parseInt(slot.dataset.page, 10) : parseInt(e.target.dataset && e.target.dataset.page, 10);
        if (pn) {
          if (slot && slot.dataset.rendered === '1') { try { _pdfLazyObserver.unobserve(e.target); } catch {} continue; }
          pdfQueuePage(pn, myGen, doc, false);
        }
      }
    }, { root: wrap, rootMargin: '1200px 0px', threshold: 0.01 });
    wrap.querySelectorAll('.pdf-page-box').forEach(b => _pdfLazyObserver.observe(b));
  } catch { _pdfLazyObserver = null; }
}
let _pdfObserver = null;
function setupPdfScrollTracking() {
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (!wrap || !_pdfDoc) return;
  if (_pdfObserver) try { _pdfObserver.disconnect(); } catch {}
  if (_pdfScrollHandler) try { wrap.removeEventListener('scroll', _pdfScrollHandler); } catch {}
  // Track boxes (not just rendered canvases) so tracking works before lazy render
  const boxes = wrap.querySelectorAll('.pdf-page-box');
  if (!boxes.length) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    let best = null;
    let bestTop = Infinity;
    const wrapRect = wrap.getBoundingClientRect();
    for (const c of boxes) {
      const r = c.getBoundingClientRect();
      // visible if within wrap viewport
      if (r.bottom > wrapRect.top && r.top < wrapRect.bottom) {
        const dist = Math.abs(r.top - wrapRect.top);
        if (dist < bestTop) { bestTop = dist; best = c; }
      }
    }
    if (best) {
      const pageNum = parseInt(best.dataset.page, 10);
      const label = best.dataset.label || String(pageNum);
      if (pageNum && pageNum !== _pdfCurrentPage) {
        _pdfCurrentPage = pageNum;
        let pageLabels2 = null;
        try { pageLabels2 = _pdfDoc.getPageLabels && _pdfDoc._pageLabels ? _pdfDoc._pageLabels : null; } catch {}
        // use stored label
        document.getElementById('pdf-page-info').textContent = label + ' • ' + pageNum + '/' + _pdfDoc.numPages + ' • scroll vertically';
      }
    }
  };
  _pdfScrollHandler = () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  };
  // also use IntersectionObserver for more precise
  try {
    _pdfObserver = new IntersectionObserver((entries) => {
      let best = null; let bestRatio = 0;
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio > bestRatio) {
          bestRatio = e.intersectionRatio; best = e.target;
        }
      }
      if (best) {
        const pageNum = parseInt(best.dataset.page, 10);
        const label = best.dataset.label || String(pageNum);
        if (pageNum) {
          _pdfCurrentPage = pageNum;
          document.getElementById('pdf-page-info').textContent = label + ' • ' + pageNum + '/' + _pdfDoc.numPages + ' • scroll vertically';
        }
      }
    }, { root: wrap, threshold: [0.5, 0.75] });
    boxes.forEach(c => _pdfObserver.observe(c));
  } catch { _pdfObserver = null; }
  if (_pdfObserver) {
    // The observer already updates the page indicator on visibility change. Both
    // used to run at once, so every scroll also did a getBoundingClientRect() pass
    // over every page box. The scroll pass is now only a fallback for browsers
    // without IntersectionObserver.
    requestAnimationFrame(update);
  } else {
    wrap.addEventListener('scroll', _pdfScrollHandler, { passive: true });
    setTimeout(update, 100);
  }
}
function pdfNav(dir) {
  if (!_pdfDoc) return;
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (!wrap) return;
  // Scroll to next/prev page in sorted order
  const total = _pdfDoc.numPages;
  const order = _pdfPageOrder || Array.from({length: total}, (_,k)=>k+1);
  const idx = order.indexOf(_pdfCurrentPage);
  let nextIdx = idx + dir;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= order.length) nextIdx = order.length - 1;
  const target = order[nextIdx];
  _pdfCurrentPage = target;
  // Prefer the box (always present) so nav works even before lazy render;
  // ensure the target is queued at priority so it renders immediately.
  const box = document.getElementById('pdf-wrap-' + target);
  const canvasEl = document.getElementById('pdf-page-' + target);
  const label = (box && box.dataset.label) || (canvasEl && canvasEl.dataset.label) || (_pdfLabelMap[target]) || String(target);
  document.getElementById('pdf-page-info').textContent = label + ' • ' + target + '/' + total + ' • scroll vertically';
  if (_pdfDoc) pdfQueuePage(target, _pdfRenderGen, _pdfDoc, true);
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else if (dir < 0) wrap.scrollBy({ top: -wrap.clientHeight * 0.9, behavior: 'smooth' });
  else wrap.scrollBy({ top: wrap.clientHeight * 0.9, behavior: 'smooth' });
}
function pdfZoom(delta) {
  if (!_pdfDoc) return;
  _pdfScale = Math.max(0.6, Math.min(3, _pdfScale + delta));
  // Lazy mode: rebuilding placeholders is cheap; only visible pages re-render.
  // Bump generation so a stale in-flight render can't append duplicates.
  const keepPage = _pdfCurrentPage;
  const myGen = ++_pdfRenderGen;
  const wrap = document.getElementById('pdf-canvas-wrap');
  const scrollTop = wrap ? wrap.scrollTop : 0;
  if (_pdfObserver) try { _pdfObserver.disconnect(); _pdfObserver = null; } catch {}
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); _pdfLazyObserver = null; } catch {}
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false;
  renderPdfDoc(myGen, { keepPage: true }).then(() => {
    if (myGen !== _pdfRenderGen) return;
    if (wrap) {
      const box = document.getElementById('pdf-wrap-' + keepPage);
      if (box) box.scrollIntoView({ block: 'start' });
      else wrap.scrollTop = scrollTop;
    }
  });
}

let _epubBook = null;
let _epubRendition = null;
let _epubPath = '';
let _epubBlobUrl = null;

// epub.js renders book content into same-origin frames, which would otherwise
// inherit this origin's storage and fetch credentials. `allowScriptedContent:
// false` stops the library enabling scripts; this pins the sandbox ourselves and
// strips active content, so a hostile .epub stays inert even if the library's
// defaults change. `allow-same-origin` is kept because epub.js needs DOM access
// to apply themes and measure the page — without scripts it grants nothing.
function hardenEpubRendition(rendition) {
  try {
    rendition.hooks.content.register(contents => {
      try {
        const doc = contents && contents.document;
        const frame = doc && doc.defaultView && doc.defaultView.frameElement;
        if (frame) {
          frame.setAttribute('sandbox', 'allow-same-origin');
          frame.setAttribute('referrerpolicy', 'no-referrer');
        }
        if (doc) {
          for (const el of doc.querySelectorAll('script,object,embed,iframe,frame,applet,base')) {
            try { el.remove(); } catch {}
          }
        }
      } catch {}
    });
  } catch {}
}

async function openEpubViewer(path) {
  editorPath = path;
  editorOriginalContent = '';
  const fileName = path.split(/[\\/]/).pop() || path;
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = 'none';
  document.getElementById('editor-preview').classList.remove('active');
  const iframe = document.getElementById('editor-preview-iframe');
  clearPreviewDoc(iframe);
  const mdContent2 = document.getElementById('md-preview-content');
  if (mdContent2) { mdContent2.style.display = 'none'; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('pdf-viewer').classList.remove('active');
  document.getElementById('office-viewer').classList.remove('active');
  const epubViewer = document.getElementById('epub-viewer');
  epubViewer.classList.add('active');
  document.getElementById('epub-title').textContent = fileName;
  document.getElementById('epub-loc').textContent = 'Loading…';
  if (!window.ePub) {
    const t = toast('Loading EPUB viewer…', 'info');
    try { await loadEpubJs(); t.remove(); } catch (e) { t.remove(); toast('Failed to load EPUB viewer: ' + e.message, 'error'); return; }
  }
  if (window.innerWidth > 768) {
    document.getElementById('content').classList.add('editor-open');
    const splitArea = document.getElementById('editor-split-area');
    try {
      const orient = safeStorage.getItem('wt-editor-split-orientation');
      const isHoriz = orient === 'horizontal';
      if (splitArea) splitArea.classList.toggle('horizontal', isHoriz);
    } catch {}
  }
  document.getElementById('editor-view').classList.add('open');
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
  // cleanup previous
  try { if (_epubRendition) { _epubRendition.destroy(); _epubRendition = null; } } catch {}
  try { if (_epubBook) { _epubBook.destroy(); _epubBook = null; } } catch {}
  if (_epubBlobUrl) { URL.revokeObjectURL(_epubBlobUrl); _epubBlobUrl = null; }
  document.getElementById('epub-view').innerHTML = '';
  // Show loading immediately
  document.getElementById('epub-loc').textContent = 'Loading EPUB…';
  try {
    const resp = await fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, { headers: { 'x-pin-token': authToken } });
    if (!resp.ok) throw new Error('Failed to fetch EPUB (' + resp.status + ')');
    const arrayBuffer = await resp.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength < 100) throw new Error('Empty or invalid EPUB file (size ' + (arrayBuffer ? arrayBuffer.byteLength : 0) + ')');
    const header = new Uint8Array(arrayBuffer.slice(0, 4));
    const isZip = header[0] === 0x50 && header[1] === 0x4B;
    console.log('EPUB fetch OK', path, 'bytes', arrayBuffer.byteLength, 'isZip', isZip, 'header', Array.from(header));
    if (!isZip) throw new Error('Not a valid EPUB (missing PK header, got ' + Array.from(header).join(',') + ')');
    _epubPath = path;
    const book = window.ePub(arrayBuffer, { openAs: 'binary', encoding: 'binary', store: false });
    _epubBook = book;
    // Listen for openFailed
    book.on('openFailed', (e) => { console.warn('EPUB openFailed', e); throw e; });
    // Ensure container is visible and has layout before renderTo
    await new Promise(r => requestAnimationFrame(r));
    // Try scrolled-doc first (vertical scroll), fallback to paginated if fails
    let rendition;
    try {
      rendition = book.renderTo('epub-view', { flow: 'scrolled-doc', width: '100%', height: '100%', allowScriptedContent: false, store: false });
    } catch (e) {
      console.warn('scrolled-doc failed, fallback to paginated', e);
      try { if (rendition) rendition.destroy(); } catch {}
      document.getElementById('epub-view').innerHTML = '';
      rendition = book.renderTo('epub-view', { flow: 'paginated', width: '100%', height: '100%', manager: 'default', allowScriptedContent: false });
    }
    hardenEpubRendition(rendition);
    _epubRendition = rendition;
    const s = getComputedStyle(document.documentElement);
    const bg = s.getPropertyValue('--bg').trim();
    const fg = s.getPropertyValue('--fg').trim();
    try {
      rendition.themes.default({ body: { background: bg + ' !important', color: fg + ' !important', 'font-size': '16px', 'line-height': '1.6', 'padding': '0 12px' } });
    } catch {}
    const displayTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('EPUB display timeout - try downloading the file')), 15000));
    await Promise.race([rendition.display(), displayTimeout]);
    document.getElementById('epub-loc').textContent = 'Scroll vertically • ' + (rendition.location ? 'ready' : '');
    // keyboard nav still works for scrolled-doc (prev/next section)
    rendition.on('keyup', (e) => {
      if (e.key === 'ArrowLeft') rendition.prev();
      if (e.key === 'ArrowRight') rendition.next();
    });
    // also allow continuous wheel scroll naturally; update location on relocate
    try {
      rendition.on('relocated', (loc) => {
        if (loc && loc.start && loc.start.percentage !== undefined) {
          const pct = Math.round(loc.start.percentage * 100);
          document.getElementById('epub-loc').textContent = pct + '% • scroll';
        }
      });
    } catch {}
  } catch (e) {
    console.warn('EPUB load failed', e);
    document.getElementById('epub-loc').textContent = 'Failed';
    document.getElementById('epub-view').innerHTML = '<div style="color:var(--red);padding:20px">Failed to load EPUB: ' + escHtml(e.message) + '</div>';
    toast('EPUB load failed: ' + e.message, 'error');
  }
}
function epubNav(dir) {
  if (!_epubRendition) return;
  if (dir < 0) _epubRendition.prev();
  else _epubRendition.next();
}
function cleanupDocViewers() {
  // PDF — invalidate any in-flight load/render first
  _pdfRenderGen++;
  if (_pdfObserver) { try { _pdfObserver.disconnect(); } catch {} _pdfObserver = null; }
  if (_pdfLazyObserver) { try { _pdfLazyObserver.disconnect(); } catch {} _pdfLazyObserver = null; }
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false; _pdfLabelMap = {};
  if (_pdfDoc) { try { _pdfDoc.destroy(); } catch {} _pdfDoc = null; }
  _pdfPath = '';
  _pdfPageOrder = null;
  _pdfCurrentPage = 1;
  const pdfWrap = document.getElementById('pdf-canvas-wrap');
  if (pdfWrap) {
    // remove scroll listener added in setupPdfScrollTracking
    if (_pdfScrollHandler) try { pdfWrap.removeEventListener('scroll', _pdfScrollHandler); } catch {}
    _pdfScrollHandler = null;
    pdfWrap.innerHTML = '';
  }
  const pdfViewer = document.getElementById('pdf-viewer');
  if (pdfViewer) pdfViewer.classList.remove('active');
  // EPUB
  try { if (_epubRendition) { _epubRendition.destroy(); _epubRendition = null; } } catch {}
  try { if (_epubBook) { _epubBook.destroy(); _epubBook = null; } } catch {}
  if (_epubBlobUrl) { URL.revokeObjectURL(_epubBlobUrl); _epubBlobUrl = null; }
  _epubPath = '';
  const epubViewer = document.getElementById('epub-viewer');
  if (epubViewer) epubViewer.classList.remove('active');
  const epubView = document.getElementById('epub-view');
  if (epubView) epubView.innerHTML = '';
  // Office (DOCX/XLSX, read-only)
  _officeGen++;
  _officePath = '';
  const officeViewer = document.getElementById('office-viewer');
  if (officeViewer) officeViewer.classList.remove('active');
  const officeContent = document.getElementById('office-content');
  if (officeContent) officeContent.innerHTML = '';
  document.getElementById('editor-save-btn').style.display = '';
}
// ── Office doc preview (DOCX/XLSX, read-only) ──
// Client-side only: mammoth (DOCX→HTML) + SheetJS (XLSX→table), lazy-loaded
// from jsDelivr (already in CSP). Legacy .doc/.xls/.ppt have no browser
// renderer — those stay on the Download fallback.
const MAX_OFFICE_SIZE = 10 * 1024 * 1024; // 10MB — larger files: use Download
const OFFICE_SHEET_MAX_ROWS = 500;
const OFFICE_SHEET_MAX_COLS = 50;
let _officePath = '';
let _officeGen = 0;
async function loadMammoth() {
  if (window.mammoth) return;
  await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js');
  if (!window.mammoth) throw new Error('mammoth not found');
}
async function loadSheetJs() {
  if (window.XLSX) return;
  await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0/dist/xlsx.full.min.js');
  if (!window.XLSX) throw new Error('SheetJS not found');
}
async function openOfficeViewer(path) {
  const myGen = ++_officeGen;
  _officePath = '';
  // Viewer shell (mirrors openPdfViewer/openEpubViewer)
  editorPath = path;
  editorOriginalContent = '';
  const fileName = path.split(/[\\/]/).pop() || path;
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = 'none';
  document.getElementById('editor-preview').classList.remove('active');
  const iframe = document.getElementById('editor-preview-iframe');
  clearPreviewDoc(iframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('pdf-viewer').classList.remove('active');
  document.getElementById('epub-viewer').classList.remove('active');
  document.getElementById('office-viewer').classList.add('active');
  _officePath = path;
  document.getElementById('office-title').textContent = fileName;
  document.getElementById('office-info').textContent = 'Loading…';
  document.getElementById('office-content').innerHTML = '<div style="color:var(--fg2);padding:20px">Loading…</div>';
  if (window.innerWidth > 768) {
    document.getElementById('content').classList.add('editor-open');
    const splitArea = document.getElementById('editor-split-area');
    try {
      const orient = safeStorage.getItem('wt-editor-split-orientation');
      const isHoriz = orient === 'horizontal';
      if (splitArea) splitArea.classList.toggle('horizontal', isHoriz);
    } catch {}
  }
  document.getElementById('editor-view').classList.add('open');
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
  const isDocx = isOfficeDocx(path);
  // Libs lazy-load on first use (cached after)
  const needLib = (isDocx && !window.mammoth) || (!isDocx && !window.XLSX);
  let libToast = null;
  try {
    if (isDocx && typeof DOMPurify === 'undefined') throw new Error('sanitizer failed to load (CDN blocked?)');
    if (needLib) libToast = toast('Loading office viewer…', 'info');
    if (isDocx) await loadMammoth();
    else await loadSheetJs();
  } catch (e) {
    if (libToast) libToast.remove();
    if (myGen !== _officeGen) return;
    return officeLoadError(e.message);
  }
  if (libToast) libToast.remove();
  if (myGen !== _officeGen) return;
  try {
    const resp = await fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, { headers: { 'x-pin-token': authToken } });
    if (myGen !== _officeGen) return;
    if (!resp.ok) throw new Error('Failed to fetch file (' + resp.status + ')');
    const buf = await resp.arrayBuffer();
    if (myGen !== _officeGen) return;
    if (!buf || buf.byteLength < 4) throw new Error('Empty file');
    if (buf.byteLength > MAX_OFFICE_SIZE) throw new Error('File too large for preview (max 10MB) — use Download');
    const head = new Uint8Array(buf.slice(0, 4));
    if (!(head[0] === 0x50 && head[1] === 0x4B)) throw new Error('Not a valid Office file (missing ZIP header)');
    if (isDocx) await renderOfficeDocx(buf);
    else renderOfficeXlsx(buf);
  } catch (e) {
    if (myGen !== _officeGen) return;
    officeLoadError(e.message);
  }
}
function officeLoadError(msg) {
  document.getElementById('office-info').textContent = 'Failed';
  document.getElementById('office-content').innerHTML = '<div style="color:var(--red);padding:20px">Failed to load: ' + escHtml(msg) + '</div>';
  toast('Office preview failed: ' + msg, 'error');
}
let _officeWb = null; // cached xlsx workbook for sheet switching
async function renderOfficeDocx(buf) {
  _officeWb = null;
  try { const sel = document.getElementById('office-sheet-sel'); if (sel) sel.style.display = 'none'; } catch {}
  // convertImage keeps embedded pictures (dropped by default) as data: URLs —
  // allowed by CSP img-src and kept by DOMPurify; remote URLs still stripped below.
  const out = await window.mammoth.convertToHtml({ arrayBuffer: buf }, {
    convertImage: window.mammoth.images.imgElement(img => img.readAsDataURL().then(src => ({ src })))
  });
  let html = (out && out.value ? out.value : '').trim();
  if (!html) html = '<p>(Empty document)</p>';
  // Never render unsanitized HTML — office files can carry scripts/links.
  const wrap = document.createElement('div');
  wrap.innerHTML = DOMPurify.sanitize(html);
  // Drop remote images that could leak the session to third parties.
  wrap.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (/^https?:/i.test(src)) img.removeAttribute('src');
  });
  wrap.querySelectorAll('a').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); });
  const content = document.getElementById('office-content');
  content.innerHTML = '';
  content.appendChild(wrap);
  const notes = [];
  if (out && out.messages && out.messages.length) notes.push(out.messages.length + ' element(s) simplified');
  notes.push('Read-only');
  document.getElementById('office-info').textContent = notes.join(' • ');
}
function renderOfficeXlsx(buf) {
  const wb = window.XLSX.read(buf, { type: 'array' });
  const names = (wb && wb.SheetNames) || [];
  if (!names.length) throw new Error('No sheets found');
  _officeWb = wb;
  renderOfficeSheet(0);
}
function buildOfficeSheetSelect(names, idx) {
  const sel = document.getElementById('office-sheet-sel');
  if (!sel) return;
  if (!names || names.length < 2) { sel.style.display = 'none'; sel.innerHTML = ''; return; }
  sel.style.display = '';
  sel.innerHTML = names.map((n, i) => '<option value="' + i + '"' + (i === idx ? ' selected' : '') + '>' + escHtml(n) + '</option>').join('');
  sel.value = String(idx);
}
function officeSheetChanged(v) {
  const i = parseInt(v, 10);
  if (Number.isInteger(i)) { try { renderOfficeSheet(i); } catch (e) { officeLoadError(e.message); } }
}
function officeCellText(cell) {
  if (!cell) return '';
  // Prefer authored formatted text (dates, %, currency); fall back to raw value.
  if (cell.w != null) return String(cell.w);
  return fmtOfficeCell(cell.v);
}
function renderOfficeSheet(idx) {
  const wb = _officeWb;
  const names = (wb && wb.SheetNames) || [];
  const ws = wb && wb.Sheets[names[idx]];
  if (!ws || !ws['!ref']) {
    document.getElementById('office-content').innerHTML = '<p>(Empty sheet)</p>';
    document.getElementById('office-info').textContent = (names[idx] || 'Sheet') + ' • Empty • Read-only';
    buildOfficeSheetSelect(names, idx);
    return;
  }
  const range = window.XLSX.utils.decode_range(ws['!ref']);
  const totalRows = range.e.r - range.s.r + 1;
  const totalCols = range.e.c - range.s.c + 1;
  const endR = Math.min(range.e.r, range.s.r + OFFICE_SHEET_MAX_ROWS - 1);
  const endC = Math.min(range.e.c, range.s.c + OFFICE_SHEET_MAX_COLS - 1);
  // Merged ranges: top-left cell keeps colspan/rowspan, covered cells skipped.
  const skip = new Set(), span = new Map();
  try {
    for (const m of (ws['!merges'] || [])) {
      span.set(m.s.r + ',' + m.s.c, { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 });
      for (let R = m.s.r; R <= m.e.r; R++) for (let C = m.s.c; C <= m.e.c; C++) {
        if (R !== m.s.r || C !== m.s.c) skip.add(R + ',' + C);
      }
    }
  } catch {}
  // Title-row pattern: a single-row merge spanning the full width is a title,
  // not a header — the row below it becomes the header instead.
  let headerR = range.s.r;
  try {
    const t = span.get(range.s.r + ',' + range.s.c);
    if (t && t.rs === 1 && t.cs === totalCols && totalCols > 1) headerR = range.s.r + 1;
  } catch {}
  // Cell-address iteration (not sheet_to_json) so blank rows/cols keep alignment.
  const enc = window.XLSX.utils.encode_cell, encCol = window.XLSX.utils.encode_col;
  let html = '<table class="office-grid"><thead><tr><th class="corner" scope="col"></th>';
  for (let C = range.s.c; C <= endC; C++) html += '<th scope="col">' + encCol(C) + '</th>';
  html += '</tr></thead><tbody>';
  for (let R = range.s.r; R <= endR; R++) {
    html += '<tr><td class="rownum">' + (R + 1) + '</td>';
    for (let C = range.s.c; C <= endC; C++) {
      const k = R + ',' + C;
      if (skip.has(k)) continue;
      const txt = escHtml(officeCellText(ws[enc({ r: R, c: C })]));
      const sp = span.get(k);
      const spanAttr = sp ? ' colspan="' + sp.cs + '" rowspan="' + sp.rs + '"' : '';
      // Header row renders as <th>, like a real spreadsheet.
      html += R === headerR ? '<th scope="col"' + spanAttr + '>' + txt + '</th>' : '<td' + spanAttr + '>' + txt + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  const notes = [];
  notes.push(names[idx] + (names.length > 1 ? ' (' + (idx + 1) + '/' + names.length + ')' : ''));
  if (endR < range.e.r || endC < range.e.c) {
    notes.push('Showing ' + (endR - range.s.r + 1) + '×' + (endC - range.s.c + 1) + ' of ' + totalRows + '×' + totalCols);
  } else {
    notes.push(totalRows + '×' + totalCols);
  }
  notes.push('Read-only');
  buildOfficeSheetSelect(names, idx);
  document.getElementById('office-content').innerHTML = html;
  document.getElementById('office-info').textContent = notes.join(' • ');
}
function fmtOfficeCell(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'number') return String(Math.round(c * 1e10) / 1e10);
  return String(c);
}
// Preload doc viewers in background for instant open (respect datasaver)
function preloadDocViewers() {
  try {
    if (settings && settings.datasaver) return;
    // Honour the browser's own data-saving hint too (Android Chrome, Safari
    // low-data mode): a warm-up we never asked for shouldn't fight it.
    if (navigator.connection && navigator.connection.saveData) return;
    if (!window.pdfjsLib) loadPdfJs().catch(()=>{});
    if (!window.ePub) loadEpubJs().catch(()=>{});
    if (!window.mammoth) loadMammoth().catch(()=>{});
    if (!window.XLSX) loadSheetJs().catch(()=>{});
  } catch {}
}
setTimeout(() => {
  if (document.hidden) {
    const h = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', h); preloadDocViewers(); } };
    document.addEventListener('visibilitychange', h);
  } else {
    if ('requestIdleCallback' in window) requestIdleCallback(preloadDocViewers, { timeout: 3000 });
    else setTimeout(preloadDocViewers, 1500);
  }
}, 1500);

let _ivImageUrl = null;

let _ivGen = 0;
function openImageViewer(path) {
  const myGen = ++_ivGen;
  const name = path.split(/[\\/]/).pop() || path;
  document.getElementById('iv-name').textContent = name;
  document.getElementById('iv-img').style.display = 'none';
  document.getElementById('iv-loading').style.display = 'block';
  document.getElementById('iv-loading').textContent = 'Loading…';
  if (_ivImageUrl) { URL.revokeObjectURL(_ivImageUrl); _ivImageUrl = null; }
  openOverlay('image-viewer');
  fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, {
    headers: { 'x-pin-token': authToken }
  }).then(r => {
    if (!r.ok) throw new Error('Failed to load');
    return r.blob();
  }).then(blob => {
    if (myGen !== _ivGen) return; // stale — superseded, drop the blob
    _ivImageUrl = URL.createObjectURL(blob);
    const img = document.getElementById('iv-img');
    img.onload = () => {
      document.getElementById('iv-loading').style.display = 'none';
      img.style.display = '';
      img.onload = null;
    };
    img.onerror = () => {
      document.getElementById('iv-loading').textContent = 'Failed to load image';
    };
    img.src = _ivImageUrl;
  }).catch(() => {
    document.getElementById('iv-loading').textContent = 'Failed to load image';
  });
}

function closeImageViewer() {
  document.getElementById('iv-img').src = '';
  if (_ivImageUrl) { URL.revokeObjectURL(_ivImageUrl); _ivImageUrl = null; }
  closeOverlay('image-viewer');
}

function toggleHtmlPreview() {
  const cmWrapper = document.querySelector('.CodeMirror');
  const preview = document.getElementById('editor-preview');
  const iframe = document.getElementById('editor-preview-iframe');
  const btn = document.getElementById('md-preview-toggle');
  const refreshBtn = document.getElementById('preview-refresh-btn');
  const isActive = preview.classList.contains('active');
  if (isActive) {
    if (cmWrapper) cmWrapper.style.display = '';
    preview.classList.remove('active');
    if (iframe) iframe.style.display = 'none';
    btn.textContent = 'Preview';
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
    mdPreviewActive = false;
    editor.focus();
    clearPreviewLiveReload();
  } else {
    // hide doc viewers when entering html preview
    document.getElementById('pdf-viewer').classList.remove('active');
    document.getElementById('epub-viewer').classList.remove('active');
    renderHtmlPreview();
    if (cmWrapper) cmWrapper.style.display = 'none';
    preview.classList.add('active');
    btn.textContent = 'Edit';
    if (refreshBtn) refreshBtn.style.display = '';
    setFullBtnVisible(true);
    mdPreviewActive = true;
    startPreviewLiveReload();
  }
}

function toggleFullHtmlPreview() {
  if (!/\.html?$/i.test(editorPath || '')) return;
  htmlFullPreview = !htmlFullPreview;
  const b = document.getElementById('html-full-toggle');
  if (b) {
    b.classList.toggle('btn-primary', htmlFullPreview);
    b.classList.toggle('btn-ghost', !htmlFullPreview);
    b.setAttribute('aria-pressed', String(htmlFullPreview));
  }
  if (htmlFullPreview) {
    // Warn once ever (persisted): the mode itself is per-file and Safe-default,
    // but the explanation shouldn't nag on every toggle.
    let warned = false;
    try { warned = safeStorage.getItem('wt-full-preview-warned') === 'true'; } catch {}
    if (!warned) {
      toast('Full preview: this file\u2019s scripts run in an isolated frame — no access to the app, its storage or your files', 'warning');
      try { safeStorage.setItem('wt-full-preview-warned', 'true'); } catch {}
    }
  }
  renderHtmlPreview();
}

function getHtmlBaseDir() {
  const p = editorPath || currentPath || '';
  if (!p) return '';
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx > 0 ? p.slice(0, idx) : p;
}
function isAbsoluteUrlForHtml(url) {
  // Truly external/unresolvable: schemes, protocol-relative, data/blob,
  // fragments. A single leading "/" is NOT absolute here — a file preview has
  // no web root (see toPreviewApiUrl), so "/x" resolves against the file dir.
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|data:|blob:|#)/i.test(url.trim());
}
// Single-purpose preview token so frame-readable preview DOM never carries the
// live session secret (audit run-1 F1). Returns null in open mode (nothing to
// protect); throws when authed but minting fails, and every preview renderer
// toasts and treats that as fail-closed (no preview, never a session-bearing one).
async function mintPreviewFileToken(path) {
  if (!authToken || authToken === 'open') return null;
  let r;
  try {
    r = await fetch('/api/files/preview-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pin-token': authToken },
      body: JSON.stringify({ path }),
    });
  } catch (e) { throw new Error('preview auth unavailable'); }
  if (!r.ok) throw new Error('preview auth refused (' + r.status + ')');
  const j = await r.json().catch(() => null);
  if (!j || typeof j.token !== 'string' || !j.token) throw new Error('preview auth refused');
  return j.token;
}
function toPreviewApiUrl(rel, baseDir, ptok) {
  if (!rel || isAbsoluteUrlForHtml(rel)) return rel;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return rel;
  let pathPart = rel;
  // No web root exists in a file preview: root-absolute "/x" would resolve
  // against the app itself and 404 (the classic blank page), so resolve it
  // against the previewed file's directory instead.
  if (pathPart.trim().startsWith('/')) pathPart = pathPart.trim().replace(/^\/+/, '');
  // keep query/hash part
  let hash = '';
  let query = '';
  const hIdx = pathPart.indexOf('#');
  if (hIdx !== -1) { hash = pathPart.slice(hIdx); pathPart = pathPart.slice(0, hIdx); }
  const qIdx = pathPart.indexOf('?');
  if (qIdx !== -1) { query = pathPart.slice(qIdx); pathPart = pathPart.slice(0, qIdx); }
  pathPart = pathPart.trim();
  if (!pathPart) return rel;
  const abs = joinPath(baseDir || '', pathPart);
  let api = `/api/files/image?path=${encodeURIComponent(abs)}`;
  // Scoped preview token (ptoken) when the renderer minted one; legacy session
  // token only as a fallback so open-mode/older flows keep working. Frame-
  // delivered documents must always pass ptok — never the session.
  if (ptok) api += `&ptoken=${encodeURIComponent(ptok)}`;
  else if (authToken) api += `&token=${encodeURIComponent(authToken)}`;
  if (query) api += (query.startsWith('?') ? `&${query.slice(1)}` : query);
  if (hash) api += hash;
  return api;
}
// Rewrite attributes everywhere (including <script src=> tags) but never touch
// script BODIES: JS string literals must stay byte-identical or scripted pages
// break in subtle ways (blank or half-dead renders). Only Full mode needs
// this — sanitized output has no scripts left to protect.
function rewriteFullHtmlUrls(raw, baseDir, ptok) {
  if (!baseDir) return raw;
  const re = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi;
  let out = '', last = 0, m;
  for (;;) {
    m = re.exec(raw);
    if (!m) break;
    out += rewriteHtmlRelativeUrls(raw.slice(last, m.index), baseDir, ptok);
    out += rewriteHtmlRelativeUrls(m[1], baseDir, ptok); // opening tag: src rewritten
    out += m[2]; // body: verbatim
    out += m[3];
    last = m.index + m[0].length;
  }
  out += rewriteHtmlRelativeUrls(raw.slice(last), baseDir, ptok);
  return out;
}
function rewriteHtmlRelativeUrls(html, baseDir, ptok) {
  if (!baseDir) return html;
  // src/href/srcset/poster/data/action/cite/background/formaction/xlink:href
  html = html.replace(/\b(src|href|srcset|poster|data|cite|action|background|formaction|xlink:href)\s*=\s*(["'])([^"']+)\2/gi, (m, attr, q, val) => {
    if (attr.toLowerCase() === 'srcset') {
      const parts = val.split(',').map(p => {
        const seg = p.trim();
        if (!seg) return seg;
        const sp = seg.split(/\s+/);
        const url = sp[0];
        const desc = sp.slice(1).join(' ');
        const newUrl = toPreviewApiUrl(url, baseDir, ptok);
        return desc ? `${newUrl} ${desc}` : newUrl;
      });
      return `${attr}=${q}${parts.join(', ')}${q}`;
    }
    const newVal = toPreviewApiUrl(val, baseDir, ptok);
    if (newVal === val) return m;
    return `${attr}=${q}${newVal}${q}`;
  });
  // url(...) in style attributes and <style> tags
  html = html.replace(/url\(\s*(["']?)([^"'\)]+)\1\s*\)/gi, (m, q, url) => {
    const trimmed = url.trim();
    if (!trimmed || isAbsoluteUrlForHtml(trimmed)) return m;
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return m;
    const newUrl = toPreviewApiUrl(trimmed, baseDir, ptok);
    return `url(${q}${newUrl}${q})`;
  });
  // <meta http-equiv="refresh" content="0;url=..."> would navigate the frame
  // outside the authed proxy — rewrite the url= target too.
  html = html.replace(/(<meta\b[^>]*content=(["'])[^"']*?url=)([^"';\s>]+)/gi, (m, pre, q, url) => {
    if (!url || isAbsoluteUrlForHtml(url.trim())) return m;
    return pre + toPreviewApiUrl(url.trim(), baseDir, ptok);
  });
  return html;
}
// Preview frame transport: blob URLs instead of srcdoc. Some browsers refuse
// to paint a sandboxed srcdoc frame (healthy rect, correct document delivered,
// blank pixels), while blob: is explicitly allowed by the CSP frame-src and
// paints everywhere. The sandbox attribute (opaque origin, scripts-only)
// applies identically — only the delivery changes. Previous blob revoked
// on every swap so long sessions don't hoard object URLs.
let _previewDocUrl = null;
function setPreviewDoc(iframe, doc) {
  try { if (_previewDocUrl) URL.revokeObjectURL(_previewDocUrl); } catch {}
  _previewDocUrl = null;
  if (!iframe) return;
  try {
    _previewDocUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
    iframe.removeAttribute('srcdoc');
    iframe.src = _previewDocUrl;
  } catch (e) {
    try { iframe.srcdoc = doc; } catch {} // pre-Blob browsers
  }
  iframe.style.display = 'block';
}
function clearPreviewDoc(iframe) {
  try { if (_previewDocUrl) URL.revokeObjectURL(_previewDocUrl); } catch {}
  _previewDocUrl = null;
  if (!iframe) return;
  try { iframe.removeAttribute('srcdoc'); iframe.src = 'about:blank'; } catch {}
  iframe.style.display = 'none';
}
async function renderHtmlPreview() {
  try { await renderHtmlPreviewInner(); }
  catch (e) {
    // A preview must never die as a silent blank pane: surface the reason
    // inside the frame (works over tunnel too — no console needed to see it).
    console.warn('HTML preview failed:', e);
    try {
      const iframe = document.getElementById('editor-preview-iframe');
      setPreviewDoc(iframe, '<p style="font-family:sans-serif;padding:16px">Preview failed: ' + escHtml((e && e.message) || 'unknown error') + '</p>');
    } catch {}
    try { toast('Preview failed: ' + ((e && e.message) || 'unknown error'), 'error'); } catch {}
  }
}
async function renderHtmlPreviewInner() {
  const iframe = document.getElementById('editor-preview-iframe');
  const mdContent = document.getElementById('md-preview-content');
  const raw = editor ? editor.getValue() : '';
  if (!iframe) return;
  if (!editor || !raw) {
    setPreviewDoc(iframe, '<p style="font-family:sans-serif;padding:16px">' + (!editor ? 'Nothing to preview — open a file first.' : 'Nothing to preview — the file is empty.') + '</p>');
    return;
  }
  if (mdContent) mdContent.style.display = 'none';
  if (iframe) iframe.style.display = 'block';
  // Frame-readable preview DOM must never carry the session secret: mint a
  // dir-scoped token for this file's assets, and fail closed (no preview)
  // when authed but minting fails.
  let ptok = null;
  try {
    ptok = await mintPreviewFileToken(editorPath);
  } catch (e) {
    setPreviewDoc(iframe, '<p style="font-family:sans-serif;padding:16px">Preview unavailable — could not authorize file assets (' + escHtml((e && e.message) || 'unknown error') + ').</p>');
    try { toast('Preview unavailable: ' + ((e && e.message) || 'unknown error'), 'error'); } catch {}
    return;
  }
  const baseDir = getHtmlBaseDir();
  const s = getComputedStyle(document.documentElement);
  const isDark = !['#f9f9fb', '#ffffff', 'rgb(249, 249, 251)', 'rgb(255, 255, 255)'].includes(s.getPropertyValue('--bg').trim());
  const isFullDoc = /<!DOCTYPE|<html[\s>]/i.test(raw);
  const baseHref = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (ptok ? `&ptoken=${encodeURIComponent(ptok)}` : '');
  const injectHead = (doc, tags) => /<head[^>]*>/i.test(doc)
    ? doc.replace(/<head[^>]*>/i, m => m + tags)
    : doc.replace(/<html[^>]*>/i, m => m + '<head>' + tags + '</head>');
  if (htmlFullPreview) {
    // FULL mode: author's bytes verbatim — scripts run. Still confined to the
    // opaque-origin sandbox (allow-scripts only): no parent DOM, no storage,
    // no popups, no top navigation, no form submit. Needs no CDN. The frame-
    // readable document carries only the scoped preview token, never the session.
    let doc;
    if (isFullDoc) {
      doc = rewriteFullHtmlUrls(raw, baseDir, ptok);
      if (!/<base\b/i.test(doc)) doc = injectHead(doc, `<base href="${escHtml(baseHref)}">`);
      if (!/<meta[^>]*color-scheme/i.test(doc)) doc = injectHead(doc, `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
    } else {
      // Fragment: minimal shell, no theme CSS — the author's own styles rule,
      // like opening the file in a real browser tab.
      const frag = rewriteFullHtmlUrls(raw, baseDir, ptok);
      doc = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">\n<base href="${escHtml(baseHref)}">\n</head>\n<body>${frag}</body>\n</html>`;
    }
    setPreviewDoc(iframe, doc);
    return;
  }
  // Never render unsanitized HTML: without the DOMPurify CDN the preview
  // stays off (scripts in the file could otherwise reach the app).
  if (typeof DOMPurify === 'undefined') {
    setPreviewDoc(iframe, '<p style="font-family:sans-serif;padding:16px">Preview unavailable — sanitizer failed to load (CDN blocked?).</p>');
    toast('Preview unavailable: sanitizer failed to load', 'warning');
    return;
  }
  const bg = s.getPropertyValue('--bg').trim();
  const fg = s.getPropertyValue('--fg').trim();
  const accent = s.getPropertyValue('--accent').trim();
  const bg2 = s.getPropertyValue('--bg2').trim();
  const border = s.getPropertyValue('--border').trim();
  const font = s.getPropertyValue('--font').trim();
  let doc;
  if (isFullDoc) {
    let sanitized = DOMPurify.sanitize(raw, { WHOLE_DOCUMENT: true, USE_PROFILES: { html: true }, ADD_TAGS: ['base','style'], ADD_ATTR: ['target'] });
    sanitized = rewriteHtmlRelativeUrls(sanitized, baseDir, ptok);
    // An author-supplied <base href> survives sanitizing and re-targets every
    // relative asset/script include: strip them all, then inject our own.
    const baseHref = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (ptok ? `&ptoken=${encodeURIComponent(ptok)}` : '');
    sanitized = sanitized.replace(/<base\b[^>]*>/gi, '');
    sanitized = sanitized.replace(/<head[^>]*>/i, m => m + `<base href="${escHtml(baseHref)}">`);
    // Ensure color-scheme meta
    if (!/<meta[^>]*color-scheme/i.test(sanitized)) {
      sanitized = sanitized.replace(/<head[^>]*>/i, m => m + `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
    }
    doc = sanitized;
  } else {
    let fragment = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] });
    fragment = rewriteHtmlRelativeUrls(fragment, baseDir, ptok);
    const baseHrefFrag = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (ptok ? `&ptoken=${encodeURIComponent(ptok)}` : '');
    doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">
<base href="${escHtml(baseHrefFrag)}">
<style>
  :root { color-scheme: ${isDark ? 'dark' : 'light'}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 24px; font-family: ${font};
    font-size: 14px; line-height: 1.6; background: ${bg}; color: ${fg};
    -webkit-font-smoothing: antialiased;
  }
  a { color: ${accent}; }
  img { max-width: 100%; height: auto; }
  pre { background: ${bg2}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; overflow-x: auto; }
  code { font-family: ${font}; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  code:not(pre code) { background: ${bg2}; padding: 2px 6px; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid ${border}; padding: 8px 12px; text-align: left; }
  th { background: ${bg2}; }
  blockquote { margin: 0.75em 0; padding: 4px 16px; border-left: 4px solid ${accent}; background: ${bg2}; border-radius: 0 6px 6px 0; }
  h1, h2, h3, h4, h5, h6 { margin: 1em 0 0.5em; font-weight: 700; }
  h1 { font-size: 1.8em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid ${border}; padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  p { margin: 0.75em 0; }
  ul, ol { margin: 0.5em 0; padding-left: 2em; }
  li { margin: 0.25em 0; }
  hr { border: none; border-top: 1px solid ${border}; margin: 1.5em 0; }
  input[type="text"], input[type="email"], input[type="password"], input[type="number"],
  textarea, select, button {
    font-family: ${font}; font-size: 14px; padding: 6px 10px;
    border: 1px solid ${border}; border-radius: 4px; background: ${bg2}; color: ${fg};
  }
  button { cursor: pointer; }
  input:focus, textarea:focus, select:focus { outline: 2px solid ${accent}; outline-offset: 1px; }
</style>
</head>
<body>${fragment}</body>
</html>`;
  }
  setPreviewDoc(iframe, doc);
}

async function renderMdPreview() {
  const preview = document.getElementById('editor-preview');
  const mdContent = document.getElementById('md-preview-content');
  const iframe = document.getElementById('editor-preview-iframe');
  const raw = editor ? editor.getValue() : '';
  if (!preview || !mdContent) return;
  if (iframe) iframe.style.display = 'none';
  mdContent.style.display = 'block';
  try {
    if (typeof DOMPurify === 'undefined') {
      mdContent.innerHTML = '<p style="padding:16px">Preview unavailable — sanitizer failed to load (CDN blocked?).</p>';
      return;
    }
    const html = marked.parse(raw, { breaks: true, gfm: true, langPrefix: 'language-' });
    let sanitized = DOMPurify.sanitize(html);
    // Mirror the tab preview: route relative assets through the authed image
    // endpoint and open links out of the app (a relative click used to
    // navigate the whole app away).
    try {
      const mdBase = (typeof getHtmlBaseDir === 'function') ? getHtmlBaseDir() : '';
      let mdTok = null;
      try { mdTok = await mintPreviewFileToken(editorPath); } catch {}
      sanitized = rewriteHtmlRelativeUrls(sanitized, mdBase, mdTok);
    } catch {}
    try {
      sanitized = sanitized.replace(/<a\b(?![^>]*\btarget=)[^>]*>/gi, m => m.replace(/<a\b/i, '<a target="_blank" rel="noopener"'));
    } catch {}
    const s = getComputedStyle(document.documentElement);
    const bg = s.getPropertyValue('--bg').trim();
    const fg = s.getPropertyValue('--fg').trim();
    const accent = s.getPropertyValue('--accent').trim();
    const bg2 = s.getPropertyValue('--bg2').trim();
    const bg3 = s.getPropertyValue('--bg3').trim();
    const border = s.getPropertyValue('--border').trim();
    const fg2 = s.getPropertyValue('--fg2').trim();
    const font = s.getPropertyValue('--font').trim();
    mdContent.innerHTML = `
      <style>
        .md-rendered { max-width: 800px; margin: 0 auto; }
        .md-rendered h1, .md-rendered h2, .md-rendered h3, .md-rendered h4, .md-rendered h5, .md-rendered h6 { color: ${fg}; margin: 1.2em 0 0.5em; font-weight: 700; }
        .md-rendered h1 { font-size: 1.8em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
        .md-rendered h2 { font-size: 1.5em; border-bottom: 1px solid ${border}; padding-bottom: 0.25em; }
        .md-rendered h3 { font-size: 1.25em; }
        .md-rendered h4 { font-size: 1.1em; }
        .md-rendered p { margin: 0.75em 0; line-height: 1.7; }
        .md-rendered ul, .md-rendered ol { margin: 0.5em 0; padding-left: 2em; }
        .md-rendered li { margin: 0.25em 0; }
        .md-rendered blockquote { margin: 0.75em 0; padding: 4px 16px; border-left: 4px solid ${accent}; background: ${bg2}; color: ${fg2}; border-radius: 0 6px 6px 0; }
        .md-rendered code { font-family: ${font}; background: ${bg3}; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
        .md-rendered pre { background: ${bg2}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; overflow-x: auto; margin: 0.75em 0; }
        .md-rendered pre code { background: none; padding: 0; border-radius: 0; font-size: 0.85em; }
        .md-rendered table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
        .md-rendered th, .md-rendered td { border: 1px solid ${border}; padding: 8px 12px; text-align: left; }
        .md-rendered th { background: ${bg3}; font-weight: 600; }
        .md-rendered hr { border: none; border-top: 1px solid ${border}; margin: 1.5em 0; }
        .md-rendered a { color: ${accent}; text-decoration: none; }
        .md-rendered a:hover { text-decoration: underline; }
        .md-rendered img { max-width: 100%; border-radius: 6px; }
      </style>
      <div class="md-rendered">${sanitized}</div>`;
  } catch (e) {
    console.warn('Markdown preview error:', e);
    mdContent.textContent = 'Error rendering markdown preview';
  }
}

let _previewLiveReloadTimer = null;
// Live preview is driven by CodeMirror's `change` event (see initCodeMirror) with a
// debounce, instead of a 1 s interval that called editor.getValue() and compared the
// whole document text every tick. Same result, no polling, and it fires per edit.
const PREVIEW_MAX_LIVE_BYTES = 200000;
function schedulePreviewLiveReload() {
  if (!mdPreviewActive || !editor) return;
  if (editor.getValue().length > PREVIEW_MAX_LIVE_BYTES) return;
  clearTimeout(_previewLiveReloadTimer);
  _previewLiveReloadTimer = setTimeout(() => {
    _previewLiveReloadTimer = null;
    if (!mdPreviewActive || !editor) return;
    if (editor.getValue().length > PREVIEW_MAX_LIVE_BYTES) return;
    if (/\.html?$/i.test(editorPath)) renderHtmlPreview();
    else renderMdPreview();
  }, 350);
}
function startPreviewLiveReload() {
  // Nothing to start: the change handler is always wired. Kept as the entry point
  // the preview toggles call, and used to drop any pending render.
  clearPreviewLiveReload();
}
function clearPreviewLiveReload() {
  if (_previewLiveReloadTimer) { clearTimeout(_previewLiveReloadTimer); _previewLiveReloadTimer = null; }
}

function refreshPreview() {
  if (!editor) return;
  if (/\.html?$/i.test(editorPath)) renderHtmlPreview();
  else renderMdPreview();
  toast('Preview refreshed', 'success');
}

function toggleMdPreview() {
  if (/\.html?$/i.test(editorPath)) {
    toggleHtmlPreview();
    return;
  }
  const cmWrapper = document.querySelector('.CodeMirror');
  const preview = document.getElementById('editor-preview');
  const btn = document.getElementById('md-preview-toggle');
  const refreshBtn = document.getElementById('preview-refresh-btn');
  mdPreviewActive = !mdPreviewActive;
  if (mdPreviewActive) {
    document.getElementById('pdf-viewer').classList.remove('active');
    document.getElementById('epub-viewer').classList.remove('active');
    renderMdPreview();
    if (cmWrapper) cmWrapper.style.display = 'none';
    preview.classList.add('active');
    btn.textContent = 'Edit';
    if (refreshBtn) refreshBtn.style.display = '';
    startPreviewLiveReload();
  } else {
    if (cmWrapper) cmWrapper.style.display = '';
    preview.classList.remove('active');
    btn.textContent = 'Preview';
    if (refreshBtn) refreshBtn.style.display = 'none';
    editor.focus();
    clearPreviewLiveReload();
  }
}