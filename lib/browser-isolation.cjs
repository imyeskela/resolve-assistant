'use strict';
const {createHash}=require('node:crypto');
// Executed in the generated document before any saved/generated script. This is
// browser hardening, not an OS network sandbox; CSP and request allowlists remain
// independent controls. Never evaluate generated JavaScript in the Node process.
function installBrowserIsolation(){
  for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebSocket','WebTransport','EventSource','XMLHttpRequest','fetch','Worker','SharedWorker']){
    Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});
  }
  if(typeof Navigator!=='undefined')Object.defineProperty(Navigator.prototype,'sendBeacon',{value:undefined,writable:false,configurable:false});
}
const ISOLATION_SCRIPT=('('+installBrowserIsolation.toString()+')();').replace(/\r\n?/g,'\n');
const scriptHash=source=>"'sha256-"+createHash('sha256').update(source.replace(/\r\n?/g,'\n')).digest('base64')+"'";
const ISOLATION_HASH=scriptHash(ISOLATION_SCRIPT);
function inlineScriptHashes(html){
  // Preserve existing trusted legacy timeline scripts without unsafe-inline.
  // Hash the exact delivered script text; never honor a saved nonce or CSP.
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match=>scriptHash(match[1])).join(' ');
}
function isolatedDocument(html){
  // A new leading doctype preserves standards mode even for legacy files with
  // scripts before <head>. A hash-authorized inline guard cannot fail open due
  // to a missing/blocked external bootstrap request.
  return '<!doctype html><script>'+ISOLATION_SCRIPT+'</script>'+html;
}
module.exports={installBrowserIsolation,ISOLATION_HASH,inlineScriptHashes,isolatedDocument};
