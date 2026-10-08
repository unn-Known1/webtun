'use strict';

const path = require('path');

// MIME type lookup without mime-types dependency
const MIME_MAP = {
  '.html':'text/html','.htm':'text/html','.css':'text/css','.js':'application/javascript',
  '.mjs':'application/javascript','.json':'application/json','.xml':'application/xml',
  '.txt':'text/plain','.csv':'text/csv','.tsv':'text/tab-separated-values',
  '.md':'text/markdown','.rtf':'text/rtf',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
  '.bmp':'image/bmp','.ico':'image/x-icon','.svg':'image/svg+xml','.webp':'image/webp',
  '.avif':'image/avif','.tif':'image/tiff','.tiff':'image/tiff',
  '.mp3':'audio/mpeg','.mp4':'video/mp4','.webm':'video/webm','.ogg':'audio/ogg',
  '.wav':'audio/wav','.flac':'audio/flac','.aac':'audio/aac','.m4a':'audio/mp4',
  '.pdf':'application/pdf','.zip':'application/zip','.gz':'application/gzip',
  '.tar':'application/x-tar','.7z':'application/x-7z-compressed',
  '.rar':'application/vnd.rar','.bz2':'application/x-bzip2','.xz':'application/x-xz',
  '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.eot':'application/vnd.ms-fontobject',
  '.wasm':'application/wasm','.map':'application/json','.tgz':'application/gzip',
  '.sh':'text/x-shellscript','.py':'text/x-python','.rb':'text/x-ruby',
  '.java':'text/x-java','.c':'text/x-c','.h':'text/x-c','.cpp':'text/x-c++',
  '.go':'text/x-go','.rs':'text/x-rust','.php':'text/x-php','.pl':'text/x-perl',
  '.sql':'application/sql','.graphql':'application/graphql',
  '.yaml':'text/yaml','.yml':'text/yaml','.toml':'application/toml','.ini':'text/plain',
  '.env':'text/plain','.lock':'text/plain','.epub':'application/epub+zip',
};
function mimeLookup(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// Binary extensions — preview not supported in editor (client has same list). Keep in sync.
const BINARY_EXTS = new Set([
  '3dm','3ds','3g2','3gp','7z','a','aac','adp','afdesign','afphoto','afpub','ai','aif','aiff','alz','ape','apk','appimage','ar','arj','asf','au','avi','bak','baml','bh','bin','bk','bmp','btif','bz2','bzip2','cab','caf','cgm','class','cmx','cpio','cr2','cr3','cur','dat','dcm','deb','dex','djvu','dll','dmg','dng','doc','docm','docx','dot','dotm','dra','ds_store','dsk','dts','dtshd','dvb','dwg','dxf','ecelp4800','ecelp7470','ecelp9600','egg','eol','eot','epub','exe','f4v','fbs','fh','fla','flac','flatpak','fli','flv','fpx','fst','fvt','g3','gh','gif','graffle','gz','gzip','h261','h263','h264','icns','ico','ief','img','ipa','iso','jar','jpeg','jpg','jpgv','jpm','jxr','key','ktx','lha','lib','lvp','lz','lzh','lzma','lzo','m3u','m4a','m4v','mar','mdi','mht','mid','midi','mj2','mka','mkv','mmr','mng','mobi','mov','movie','mp3','mp4','mp4a','mpeg','mpg','mpga','mxu','nef','npx','numbers','nupkg','o','odp','ods','odt','oga','ogg','ogv','otf','ott','pages','pbm','pcx','pdb','pdf','pea','pgm','pic','png','pnm','pot','potm','potx','ppa','ppam','ppm','pps','ppsm','ppsx','ppt','pptm','pptx','psd','pya','pyc','pyo','pyv','qt','rar','ras','raw','resources','rgb','rip','rlc','rmf','rmvb','rpm','rtf','rz','s3m','s7z','scpt','sgi','shar','snap','sil','sketch','slk','smv','snk','so','stl','suo','sub','swf','tar','tbz','tbz2','tga','tgz','thmx','tif','tiff','tlz','ttc','ttf','txz','udf','uvh','uvi','uvm','uvp','uvs','uvu','viv','vob','war','wav','wax','wbmp','wdp','weba','webm','webp','whl','wim','wm','wma','wmv','wmx','woff','woff2','wrm','wvx','xbm','xif','xla','xlam','xls','xlsb','xlsm','xlsx','xlt','xltm','xltx','xm','xmind','xpi','xpm','xwd','xz','z','zip','zipx'
]);


module.exports = { mimeLookup, BINARY_EXTS };
