(() => {
  'use strict';
  const storageKey='pid-lab-language';
  const {catalog,locales,languages}=window.PIDTranslations;
  const supported=Object.keys(languages), byEnglish=new Map(), byJapanese=new Map();
  for(const [id,message] of Object.entries(catalog)){
    byEnglish.set(message.en,id);
    for(const alias of message.aliases)byJapanese.set(alias,message.en);
  }
  let language='en', initialized=false;
  try{const saved=localStorage.getItem(storageKey);if(supported.includes(saved))language=saved;}catch(_){}
  const textBindings=[],attributeBindings=[];
  function text(ja,en,values=[]){
    // Japanese call sites already contain their interpolated values.
    if(language==='ja')return ja;
    const template=language==='en'?en:(locales[language][byEnglish.get(en)]??en);
    return template.replace(/\{(\d+)\}/g,(match,index)=>index<values.length?String(values[index]):match);
  }
  function applyStatic(){
    document.documentElement.lang=language;
    document.title=text('PIDラボ — 仮想ヒーターで制御を体感','PID Lab — Explore control with a virtual heater');
    const separateWords=!['ja','zh-Hans','zh-Hant'].includes(language);
    for(const b of textBindings){
      if(!b.node.isConnected)continue;
      const attachKoreanParticle=language==='ko'&&b.afterTerm;
      b.node.nodeValue=language==='ja'?b.original:(attachKoreanParticle?'':b.leading)+(separateWords&&b.afterTerm&&!attachKoreanParticle?' ':'')+text(b.ja,b.en)+(separateWords&&b.beforeTerm?' ':'')+b.trailing;
    }
    for(const b of attributeBindings)if(b.node.isConnected)b.node.setAttribute(b.attribute,text(b.ja,b.en));
    const select=document.getElementById('language-select');if(select)select.value=language;
  }
  function setLanguage(next){
    if(!supported.includes(next))return;
    language=next;
    try{localStorage.setItem(storageKey,language);}catch(_){}
    applyStatic();
    window.dispatchEvent(new CustomEvent('pid-language-change',{detail:{language}}));
  }
  function initialize(){
    if(initialized)return;initialized=true;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode;
      if(node.parentElement?.closest('script,style,#language-select,[data-no-translate]'))continue;
      const original=node.nodeValue,ja=original.trim(),en=byJapanese.get(ja);
      if(en!==undefined)textBindings.push({node,original,ja,en,
        leading:original.match(/^\s*/)[0],trailing:original.match(/\s*$/)[0],
        afterTerm:node.previousSibling?.nodeName==='STRONG',beforeTerm:node.nextSibling?.nodeName==='STRONG'});
    }
    document.querySelectorAll('[aria-label]').forEach(node=>{
      if(node.closest('[data-no-translate]'))return;
      const ja=node.getAttribute('aria-label'),en=byJapanese.get(ja);
      if(en!==undefined)attributeBindings.push({node,attribute:'aria-label',ja,en});
    });
    const select=document.getElementById('language-select');
    for(const [code,label] of Object.entries(languages)){
      const option=document.createElement('option');option.value=code;option.lang=code;option.textContent=label;select.appendChild(option);
    }
    select.addEventListener('change',()=>setLanguage(select.value));
    applyStatic();
  }
  window.PIDLocale=Object.freeze({text,language:()=>language,applyStatic,setLanguage,supportedLanguages:()=>[...supported]});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})();
