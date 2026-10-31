'use strict';
const {parse}=require('acorn');
const GLOBALS=new Set(['eval','Function','fetch','XMLHttpRequest','WebSocket','Worker','SharedWorker','importScripts','window','document','globalThis','global','self','parent','top','opener','location','navigator','process','module','require','Deno','Bun']);
const ESCAPE_PROPERTIES=new Set(['constructor','__proto__','ownerDocument','defaultView','contentWindow','contentDocument']);
const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
function assertBrowserSource(code){
  const tree=parse(code,{ecmaVersion:'latest',sourceType:'module'});
  const fail=()=>{throw new Error('В TSX запрещены системные API, сеть и динамические импорты. Используйте React, Remotion и встроенный SVG.');};
  function bind(pattern,scope){
    if(!pattern)return;if(pattern.type==='Identifier')scope.names.add(pattern.name);
    else if(pattern.type==='RestElement')bind(pattern.argument,scope);
    else if(pattern.type==='AssignmentPattern')bind(pattern.left,scope);
    else if(pattern.type==='ArrayPattern')pattern.elements.forEach(p=>bind(p,scope));
    else if(pattern.type==='ObjectPattern')pattern.properties.forEach(p=>bind(p.type==='RestElement'?p.argument:p.value,scope));
  }
  function declarations(node,scope){
    if(!node)return;
    if(node.type==='ExportNamedDeclaration'||node.type==='ExportDefaultDeclaration')declarations(node.declaration,scope);
    else if(node.type==='VariableDeclaration')node.declarations.forEach(d=>bind(d.id,scope));
    else if(node.type==='FunctionDeclaration'||node.type==='ClassDeclaration')bind(node.id,scope);
    else if(node.type==='ImportDeclaration')node.specifiers.forEach(s=>bind(s.local,scope));
  }
  function has(scope,name){for(let s=scope;s;s=s.parent)if(s.names.has(name))return true;return false;}
  function patternExpressions(node,scope){
    if(!node)return;
    if(node.type==='AssignmentPattern'){walk(node.right,scope);patternExpressions(node.left,scope);}
    else if(node.type==='RestElement')patternExpressions(node.argument,scope);
    else if(node.type==='ArrayPattern')node.elements.forEach(n=>patternExpressions(n,scope));
    else if(node.type==='ObjectPattern')node.properties.forEach(p=>{if(p.computed)walk(p.key,scope);patternExpressions(p.value||p.argument,scope);});
  }
  function staticString(node){
    if(node.type==='Literal'&&typeof node.value==='string')return node.value;
    if(node.type==='TemplateLiteral'&&!node.expressions.length)return node.quasis[0].value.cooked;
    if(node.type==='BinaryExpression'&&node.operator==='+'){const l=staticString(node.left),r=staticString(node.right);if(l!==undefined&&r!==undefined)return l+r;}
  }
  function walk(node,scope){
    if(!node||typeof node.type!=='string')return;
    if(node.type==='ImportExpression'||node.type==='MetaProperty'||node.type==='ThisExpression')fail();
    if(node.type==='Identifier'){if(GLOBALS.has(node.name)&&!has(scope,node.name))fail();return;}
    if(node.type==='Literal'||node.type==='TemplateElement'||node.type==='ImportDeclaration')return;
    if(node.type==='Program'||node.type==='BlockStatement'){
      const inner={parent:scope,names:new Set()};node.body.forEach(n=>declarations(n,inner));node.body.forEach(n=>walk(n,inner));return;
    }
    if(functions.has(node.type)){
      const inner={parent:scope,names:new Set()};bind(node.id,inner);node.params.forEach(p=>bind(p,inner));node.params.forEach(p=>patternExpressions(p,inner));walk(node.body,inner);return;
    }
    if(node.type==='CatchClause'){const inner={parent:scope,names:new Set()};bind(node.param,inner);walk(node.body,inner);return;}
    if(node.type==='VariableDeclarator'){patternExpressions(node.id,scope);walk(node.init,scope);return;}
    if(node.type==='Property'||node.type==='MethodDefinition'||node.type==='PropertyDefinition'){
      if(node.computed)walk(node.key,scope);walk(node.value,scope);return;
    }
    if(node.type==='MemberExpression'){
      const key=node.computed?staticString(node.property):node.property.name;
      if(ESCAPE_PROPERTIES.has(key))fail();walk(node.object,scope);if(node.computed)walk(node.property,scope);return;
    }
    if(node.type==='LabeledStatement'){walk(node.body,scope);return;}
    if(node.type==='BreakStatement'||node.type==='ContinueStatement')return;
    for(const [key,value]of Object.entries(node)){
      if(key==='type'||key==='start'||key==='end')continue;
      if(Array.isArray(value))value.forEach(child=>walk(child,scope));else if(value&&typeof value==='object')walk(value,scope);
    }
  }
  walk(tree,null);
}
module.exports={assertBrowserSource};
