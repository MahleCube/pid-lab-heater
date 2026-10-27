const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const read = name => fs.readFileSync(path.join(root,name),'utf8');
const catalog=JSON.parse(read('locales/catalog.json'));
const languages={ja:'日本語',en:'English','zh-Hans':'简体中文','zh-Hant':'繁體中文',ko:'한국어',es:'Español','pt-BR':'Português (Brasil)',fr:'Français',de:'Deutsch',id:'Bahasa Indonesia'};
const locales={};
const placeholders=value=>(value.match(/\{\d+\}/g)||[]).sort().join('|');
for(const code of Object.keys(languages).filter(code=>!['ja','en'].includes(code))){
  const pack=JSON.parse(read('locales/'+code+'.json'));
  if(Object.keys(pack).length!==Object.keys(catalog).length)throw new Error(code+': incorrect message count');
  for(const [key,message] of Object.entries(catalog)){
    if(typeof pack[key]!=='string'||!pack[key].trim())throw new Error(code+': missing '+key);
    if(placeholders(pack[key])!==placeholders(message.en))throw new Error(code+': placeholder mismatch '+key);
  }
  locales[code]=pack;
}
// Bundled data keeps both index.html and the portable HTML fully offline.
const translations='window.PIDTranslations = '+JSON.stringify({catalog,locales,languages}).replace(/</g,'\\u003c')+';\n';
fs.writeFileSync(path.join(root,'translations.js'),translations,'utf8');
let html = read('index.html');
html = html.replace(/<link[^>]*href="styles\.css"[^>]*>/, () => '<style>\n'+read('styles.css')+'\n</style>');
html = html.replace(/<script[^>]*src="engine\.js"[^>]*><\/script>/, () => '<script>\n'+read('engine.js')+'\n</script>');
html = html.replace(/<script[^>]*src="translations\.js"[^>]*><\/script>/, () => '<script>\n'+translations+'\n</script>');
html = html.replace(/<script[^>]*src="locale\.js"[^>]*><\/script>/, () => '<script>\n'+read('locale.js')+'\n</script>');
html = html.replace(/<script[^>]*src="app\.js"[^>]*><\/script>/, () => '<script>\ndocument.addEventListener("DOMContentLoaded", function () {\n'+read('app.js')+'\n});\n</script>');
fs.writeFileSync(path.join(root,'pid-lab.html'),html,'utf8');
console.log('Built offline single-file pid-lab.html ('+Buffer.byteLength(html)+' bytes)');
