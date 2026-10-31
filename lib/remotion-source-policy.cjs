'use strict';
const {parse}=require('acorn');
// Ambient capabilities are denied by default, including APIs added by future
// Chromium releases. Local variables and explicitly permitted imports still work.
const GLOBALS=new Set(['undefined','NaN','Infinity','Math','JSON','Object','Array','String','Number','Boolean','BigInt','Date','RegExp','Map','Set','WeakMap','WeakSet','Intl','Promise','Error','TypeError','RangeError','parseInt','parseFloat','isFinite','isNaN','encodeURIComponent','decodeURIComponent','Uint8Array','Uint8ClampedArray','Uint16Array','Uint32Array','Int8Array','Int16Array','Int32Array','Float32Array','Float64Array','ArrayBuffer','DataView']);
const ESCAPE_PROPERTIES=new Set(['constructor','prototype','__proto__','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__','ownerDocument','defaultView','contentWindow','contentDocument','getPrototypeOf','setPrototypeOf','getOwnPropertyDescriptor','getOwnPropertyDescriptors','getOwnPropertyNames','getOwnPropertySymbols','defineProperty','defineProperties','getThis','getFunction']);
const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
function assertBrowserSource(code){
  const tree=parse(code,{ecmaVersion:'latest',sourceType:'module'});
  const edits=[];
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
  function hoistedVars(node,scope){
    if(!node||typeof node.type!=='string'||functions.has(node.type))return;
    if(node.type==='VariableDeclaration'&&node.kind==='var')node.declarations.forEach(d=>bind(d.id,scope));
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(n=>hoistedVars(n,scope));else if(value&&typeof value==='object')hoistedVars(value,scope);}
  }
  function has(scope,name){for(let s=scope;s;s=s.parent)if(s.names.has(name))return true;return false;}
  function patternExpressions(node,scope){
    if(!node)return;
    if(node.type==='AssignmentPattern'){walk(node.right,scope);patternExpressions(node.left,scope);}
    else if(node.type==='RestElement')patternExpressions(node.argument,scope);
    else if(node.type==='ArrayPattern')node.elements.forEach(n=>patternExpressions(n,scope));
    else if(node.type==='ObjectPattern')node.properties.forEach(p=>{if(p.type!=='RestElement')checkKey(p.key,p.computed);if(p.computed)walk(p.key,scope);patternExpressions(p.value||p.argument,scope);});
  }
  function staticString(node){
    if(node.type==='Literal'&&typeof node.value==='string')return node.value;
    if(node.type==='TemplateLiteral'&&!node.expressions.length)return node.quasis[0].value.cooked;
    if(node.type==='BinaryExpression'&&node.operator==='+'){const l=staticString(node.left),r=staticString(node.right);if(l!==undefined&&r!==undefined)return l+r;}
  }
  function checkKey(node,computed){
    const key=computed?staticString(node):node.name??node.value;
    if(ESCAPE_PROPERTIES.has(key))fail();
    if(computed&&key===undefined&&!(node.type==='Literal'&&typeof node.value==='number')){
      // Keep ordinary array indexing and object maps, while checking the actual
      // primitive key before JavaScript's ToPropertyKey can reach a capability.
      const condition=["(typeof k!=='string'&&typeof k!=='number')",...Array.from(ESCAPE_PROPERTIES,k=>'k==='+JSON.stringify(k))].join('||');
      edits.push({at:node.start,text:'((k)=>{if('+condition+')throw new Error("Недопустимый ключ свойства");return k;})('+'('},{at:node.end,text:'))'});
    }
  }
  function walk(node,scope){
    if(!node||typeof node.type!=='string')return;
    if(node.type==='ImportExpression'||node.type==='MetaProperty'||node.type==='ThisExpression')fail();
    if(node.type==='Identifier'){if(!GLOBALS.has(node.name)&&!has(scope,node.name))fail();return;}
    if(node.type==='Literal'||node.type==='TemplateElement'||node.type==='ImportDeclaration')return;
    if(node.type==='ExportSpecifier'){walk(node.local,scope);return;}
    if(node.type==='Program'||node.type==='BlockStatement'){
      const inner={parent:scope,names:new Set()};if(node.type==='Program')hoistedVars(node,inner);node.body.forEach(n=>declarations(n,inner));node.body.forEach(n=>walk(n,inner));return;
    }
    if(functions.has(node.type)){
      const inner={parent:scope,names:new Set()};bind(node.id,inner);node.params.forEach(p=>bind(p,inner));hoistedVars(node.body,inner);node.params.forEach(p=>patternExpressions(p,inner));walk(node.body,inner);return;
    }
    if(node.type==='CatchClause'){const inner={parent:scope,names:new Set()};bind(node.param,inner);patternExpressions(node.param,inner);walk(node.body,inner);return;}
    if(['ForStatement','ForOfStatement','ForInStatement'].includes(node.type)){
      const inner={parent:scope,names:new Set()};declarations(node.init||node.left,inner);
      for(const key of ['init','left','right','test','update','body'])walk(node[key],inner);return;
    }
    if(node.type==='SwitchStatement'){
      walk(node.discriminant,scope);const inner={parent:scope,names:new Set()};
      node.cases.forEach(c=>c.consequent.forEach(n=>declarations(n,inner)));
      node.cases.forEach(c=>{walk(c.test,inner);c.consequent.forEach(n=>walk(n,inner));});return;
    }
    if(node.type==='VariableDeclarator'){patternExpressions(node.id,scope);walk(node.init,scope);return;}
    if(node.type==='Property'||node.type==='MethodDefinition'||node.type==='PropertyDefinition'){
      checkKey(node.key,node.computed);if(node.computed)walk(node.key,scope);walk(node.value,scope);return;
    }
    if(node.type==='MemberExpression'){
      checkKey(node.property,node.computed);walk(node.object,scope);if(node.computed)walk(node.property,scope);return;
    }
    if(node.type==='LabeledStatement'){walk(node.body,scope);return;}
    if(node.type==='BreakStatement'||node.type==='ContinueStatement')return;
    for(const [key,value]of Object.entries(node)){
      if(key==='type'||key==='start'||key==='end')continue;
      if(Array.isArray(value))value.forEach(child=>walk(child,scope));else if(value&&typeof value==='object')walk(value,scope);
    }
  }
  walk(tree,null);
  for(const edit of edits.sort((a,b)=>b.at-a.at))code=code.slice(0,edit.at)+edit.text+code.slice(edit.at);
  return code;
}
module.exports={assertBrowserSource};
