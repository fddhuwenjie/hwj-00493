#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// LEB128 编码/解码
// ============================================================
function encodeULEB128(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return Buffer.from(out);
}

function encodeSLEB128(value) {
  const out = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) ||
        (value === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

function decodeULEB128(buf, offset) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, offset };
}

function decodeSLEB128(buf, offset) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (byte & 0x40) {
    result |= -(1 << shift);
  }
  return { value: result, offset };
}

// ============================================================
// 词法分析器 (Lexer)
// ============================================================
const KEYWORDS = new Set([
  'module','func','param','result','local','export','import',
  'memory','table','global','type','start','mut','elem','data',
  'i32','i64','f32','f64','funcref','externref',
  'block','loop','if','then','else','end',
  'br','br_if','br_table','return','call','call_indirect',
  'drop','select','nop','unreachable','offset','align',
  'local.get','local.set','local.tee',
  'global.get','global.set',
  'i32.load','i32.load8_s','i32.load8_u','i32.load16_s','i32.load16_u',
  'i64.load','i64.load8_s','i64.load8_u','i64.load16_s','i64.load16_u',
  'i64.load32_s','i64.load32_u',
  'f32.load','f64.load',
  'i32.store','i32.store8','i32.store16',
  'i64.store','i64.store8','i64.store16','i64.store32',
  'f32.store','f64.store',
  'memory.size','memory.grow',
  'i32.const','i64.const','f32.const','f64.const',
  'i32.add','i32.sub','i32.mul','i32.div_s','i32.div_u',
  'i32.rem_s','i32.rem_u','i32.and','i32.or','i32.xor',
  'i32.shl','i32.shr_s','i32.shr_u','i32.rotl','i32.rotr',
  'i32.eq','i32.ne','i32.lt_s','i32.lt_u','i32.gt_s','i32.gt_u',
  'i32.le_s','i32.le_u','i32.ge_s','i32.ge_u',
  'i32.eqz','i32.clz','i32.ctz','i32.popcnt',
  'i64.add','i64.sub','i64.mul','i64.div_s','i64.div_u',
  'i64.rem_s','i64.rem_u','i64.and','i64.or','i64.xor',
  'i64.shl','i64.shr_s','i64.shr_u','i64.rotl','i64.rotr',
  'i64.eq','i64.ne','i64.lt_s','i64.lt_u','i64.gt_s','i64.gt_u',
  'i64.le_s','i64.le_u','i64.ge_s','i64.ge_u',
  'i64.eqz','i64.clz','i64.ctz','i64.popcnt',
  'f32.add','f32.sub','f32.mul','f32.div','f32.sqrt',
  'f32.eq','f32.ne','f32.lt','f32.gt','f32.le','f32.ge',
  'f32.abs','f32.neg','f32.ceil','f32.floor','f32.trunc','f32.nearest',
  'f32.copysign','f32.min','f32.max',
  'f64.add','f64.sub','f64.mul','f64.div','f64.sqrt',
  'f64.eq','f64.ne','f64.lt','f64.gt','f64.le','f64.ge',
  'f64.abs','f64.neg','f64.ceil','f64.floor','f64.trunc','f64.nearest',
  'f64.copysign','f64.min','f64.max',
  'i32.wrap_i64','i32.trunc_f32_s','i32.trunc_f32_u',
  'i32.trunc_f64_s','i32.trunc_f64_u',
  'i64.extend_i32_s','i64.extend_i32_u',
  'i64.trunc_f32_s','i64.trunc_f32_u',
  'i64.trunc_f64_s','i64.trunc_f64_u',
  'f32.convert_i32_s','f32.convert_i32_u',
  'f32.convert_i64_s','f32.convert_i64_u','f32.demote_f64',
  'f64.convert_i32_s','f64.convert_i32_u',
  'f64.convert_i64_s','f64.convert_i64_u','f64.promote_f32',
  'i32.reinterpret_f32','i64.reinterpret_f64',
  'f32.reinterpret_i32','f64.reinterpret_i64',
  'i32.extend8_s','i32.extend16_s',
  'i64.extend8_s','i64.extend16_s','i64.extend32_s'
]);

const TOKEN_TYPES = {
  LPAREN:'LPAREN', RPAREN:'RPAREN', KEYWORD:'KEYWORD',
  NUMBER:'NUMBER', STRING:'STRING', IDENTIFIER:'IDENTIFIER', EOF:'EOF'
};

function tokenize(source) {
  const tokens = [];
  let pos = 0, line = 1, col = 1;
  function peek(n=0){return source[pos+n];}
  function advance(n=1){
    for(let i=0;i<n;i++){
      if(source[pos]==='\n'){line++;col=1;}else col++;
      pos++;
    }
  }
  while(pos<source.length){
    const ch = peek();
    if(/\s/.test(ch)){advance();continue;}
    if(ch===';'&&peek(1)===';'){
      while(pos<source.length&&peek()!=='\n')advance();
      continue;
    }
    if(ch==='('&&peek(1)===';'){
      advance(2);
      let depth=1;
      while(pos<source.length&&depth>0){
        if(peek()==='('&&peek(1)===';'){depth++;advance(2);}
        else if(peek()===';'&&peek(1)===')'){depth--;advance(2);}
        else advance();
      }
      continue;
    }
    if(ch==='('){tokens.push({type:'LPAREN',value:'(',line,col});advance();continue;}
    if(ch===')'){tokens.push({type:'RPAREN',value:')',line,col});advance();continue;}
    if(ch==='"'){
      const sL=line,sC=col;advance();let v='';
      while(pos<source.length&&peek()!=='"'){
        if(peek()==='\\'){
          advance();
          const e=peek();
          if(e==='n')v+='\n';
          else if(e==='t')v+='\t';
          else if(e==='r')v+='\r';
          else if(e==='\\')v+='\\';
          else if(e==='"')v+='"';
          else if(e==='0')v+='\0';
          else if(/[0-9a-fA-F]/.test(e)&&/[0-9a-fA-F]/.test(peek(1))){
            v+=String.fromCharCode(parseInt(e+peek(1),16));advance();
          } else v+=e;
          advance();
        } else {v+=peek();advance();}
      }
      advance();tokens.push({type:'STRING',value:v,line:sL,col:sC});continue;
    }
    if(ch==='$'){
      const sL=line,sC=col;advance();let v='$';
      while(pos<source.length&&/[^\s()]/.test(peek())){v+=peek();advance();}
      tokens.push({type:'IDENTIFIER',value:v,line:sL,col:sC});continue;
    }
    if(/[0-9a-zA-Z._+\-]/.test(ch)){
      const sL=line,sC=col;let v='';
      while(pos<source.length&&/[^\s()]/.test(peek())){v+=peek();advance();}
      const numR = /^[+\-]?(0x[0-9a-fA-F][0-9a-fA-F_]*|0b[01][01_]*|[0-9][0-9_]*(\.[0-9_]+)?([eE][+\-]?[0-9_]+)?|inf|nan:0x[0-9a-fA-F]+|nan)$/;
      const pTok = tokens[tokens.length-1];
      const numP = ['i32.const','i64.const','f32.const','f64.const'];
      const isNum = pTok && numP.includes(pTok.value);
      if(isNum||numR.test(v)){
        tokens.push({type:'NUMBER',value:v,line:sL,col:sC});
      } else if(KEYWORDS.has(v)){
        tokens.push({type:'KEYWORD',value:v,line:sL,col:sC});
      } else {
        tokens.push({type:'KEYWORD',value:v,line:sL,col:sC});
      }
      continue;
    }
    throw new Error(`Unexpected '${ch}' at line ${line}, col ${col}`);
  }
  tokens.push({type:'EOF',value:'',line,col});
  return tokens;
}

// ============================================================
// 指令操作码
// ============================================================
const OPCODES = {
  'unreachable':0x00,'nop':0x01,'block':0x02,'loop':0x03,'if':0x04,
  'else':0x05,'end':0x0b,'br':0x0c,'br_if':0x0d,'br_table':0x0e,
  'return':0x0f,'call':0x10,'call_indirect':0x11,
  'drop':0x1a,'select':0x1b,
  'local.get':0x20,'local.set':0x21,'local.tee':0x22,
  'global.get':0x23,'global.set':0x24,
  'i32.load':0x28,'i64.load':0x29,'f32.load':0x2a,'f64.load':0x2b,
  'i32.load8_s':0x2c,'i32.load8_u':0x2d,'i32.load16_s':0x2e,'i32.load16_u':0x2f,
  'i64.load8_s':0x30,'i64.load8_u':0x31,'i64.load16_s':0x32,'i64.load16_u':0x33,
  'i64.load32_s':0x34,'i64.load32_u':0x35,
  'i32.store':0x36,'i64.store':0x37,'f32.store':0x38,'f64.store':0x39,
  'i32.store8':0x3a,'i32.store16':0x3b,
  'i64.store8':0x3c,'i64.store16':0x3d,'i64.store32':0x3e,
  'memory.size':0x3f,'memory.grow':0x40,
  'i32.const':0x41,'i64.const':0x42,'f32.const':0x43,'f64.const':0x44,
  'i32.eqz':0x45,'i32.eq':0x46,'i32.ne':0x47,
  'i32.lt_s':0x48,'i32.lt_u':0x49,'i32.gt_s':0x4a,'i32.gt_u':0x4b,
  'i32.le_s':0x4c,'i32.le_u':0x4d,'i32.ge_s':0x4e,'i32.ge_u':0x4f,
  'i64.eqz':0x50,'i64.eq':0x51,'i64.ne':0x52,
  'i64.lt_s':0x53,'i64.lt_u':0x54,'i64.gt_s':0x55,'i64.gt_u':0x56,
  'i64.le_s':0x57,'i64.le_u':0x58,'i64.ge_s':0x59,'i64.ge_u':0x5a,
  'f32.eq':0x5b,'f32.ne':0x5c,'f32.lt':0x5d,'f32.gt':0x5e,
  'f32.le':0x5f,'f32.ge':0x60,
  'f64.eq':0x61,'f64.ne':0x62,'f64.lt':0x63,'f64.gt':0x64,
  'f64.le':0x65,'f64.ge':0x66,
  'i32.clz':0x67,'i32.ctz':0x68,'i32.popcnt':0x69,
  'i32.add':0x6a,'i32.sub':0x6b,'i32.mul':0x6c,
  'i32.div_s':0x6d,'i32.div_u':0x6e,'i32.rem_s':0x6f,'i32.rem_u':0x70,
  'i32.and':0x71,'i32.or':0x72,'i32.xor':0x73,
  'i32.shl':0x74,'i32.shr_s':0x75,'i32.shr_u':0x76,
  'i32.rotl':0x77,'i32.rotr':0x78,
  'i64.clz':0x79,'i64.ctz':0x7a,'i64.popcnt':0x7b,
  'i64.add':0x7c,'i64.sub':0x7d,'i64.mul':0x7e,
  'i64.div_s':0x7f,'i64.div_u':0x80,'i64.rem_s':0x81,'i64.rem_u':0x82,
  'i64.and':0x83,'i64.or':0x84,'i64.xor':0x85,
  'i64.shl':0x86,'i64.shr_s':0x87,'i64.shr_u':0x88,
  'i64.rotl':0x89,'i64.rotr':0x8a,
  'f32.abs':0x8b,'f32.neg':0x8c,'f32.ceil':0x8d,'f32.floor':0x8e,
  'f32.trunc':0x8f,'f32.nearest':0x90,'f32.sqrt':0x91,
  'f32.add':0x92,'f32.sub':0x93,'f32.mul':0x94,'f32.div':0x95,
  'f32.min':0x96,'f32.max':0x97,'f32.copysign':0x98,
  'f64.abs':0x99,'f64.neg':0x9a,'f64.ceil':0x9b,'f64.floor':0x9c,
  'f64.trunc':0x9d,'f64.nearest':0x9e,'f64.sqrt':0x9f,
  'f64.add':0xa0,'f64.sub':0xa1,'f64.mul':0xa2,'f64.div':0xa3,
  'f64.min':0xa4,'f64.max':0xa5,'f64.copysign':0xa6,
  'i32.wrap_i64':0xa7,
  'i32.trunc_f32_s':0xa8,'i32.trunc_f32_u':0xa9,
  'i32.trunc_f64_s':0xaa,'i32.trunc_f64_u':0xab,
  'i64.extend_i32_s':0xac,'i64.extend_i32_u':0xad,
  'i64.trunc_f32_s':0xae,'i64.trunc_f32_u':0xaf,
  'i64.trunc_f64_s':0xb0,'i64.trunc_f64_u':0xb1,
  'f32.convert_i32_s':0xb2,'f32.convert_i32_u':0xb3,
  'f32.convert_i64_s':0xb4,'f32.convert_i64_u':0xb5,'f32.demote_f64':0xb6,
  'f64.convert_i32_s':0xb7,'f64.convert_i32_u':0xb8,
  'f64.convert_i64_s':0xb9,'f64.convert_i64_u':0xba,'f64.promote_f32':0xbb,
  'i32.reinterpret_f32':0xbc,'i64.reinterpret_f64':0xbd,
  'f32.reinterpret_i32':0xbe,'f64.reinterpret_i64':0xbf,
  'i32.extend8_s':0xc0,'i32.extend16_s':0xc1,
  'i64.extend8_s':0xc2,'i64.extend16_s':0xc3,'i64.extend32_s':0xc4
};

const OPCODE_MAP = {};
for(const [k,v] of Object.entries(OPCODES)) OPCODE_MAP[v] = k;

const TYPE_CODE = { i32:0x7f, i64:0x7e, f32:0x7d, f64:0x7c, funcref:0x70, externref:0x6f };
const CODE_TYPE = { 0x7f:'i32', 0x7e:'i64', 0x7d:'f32', 0x7c:'f64', 0x70:'funcref', 0x6f:'externref' };

// ============================================================
// 指令栈效应
// ============================================================
const INSTR_STACK = (function(){
  const s = {};
  for(const k of ['unreachable','return']) s[k] = {pop:null,push:0,special:true};
  for(const k of ['nop','end','else']) s[k] = {pop:0,push:0};
  s['drop'] = {pop:1,push:0};
  s['select'] = {pop:3,push:1,select:true};
  for(const k of ['block','loop','if']) s[k] = {pop:0,push:0,ctrl:true};
  for(const k of ['br','br_if']) s[k] = {pop: k==='br'?0:1, push:0, branch:true};
  s['br_table'] = {pop:2,push:0,branch:true};
  for(const k of ['local.get','global.get']) s[k] = {pop:0,push:1,ref:true};
  for(const k of ['local.set','global.set']) s[k] = {pop:1,push:0,ref:true};
  s['local.tee'] = {pop:1,push:1,ref:true};
  for(const k of ['i32.load','i64.load','f32.load','f64.load',
    'i32.load8_s','i32.load8_u','i32.load16_s','i32.load16_u',
    'i64.load8_s','i64.load8_u','i64.load16_s','i64.load16_u',
    'i64.load32_s','i64.load32_u']) s[k] = {pop:1,push:1,pushT:k.split('.')[0],mem:true,load:true};
  for(const k of ['i32.store','i64.store','f32.store','f64.store',
    'i32.store8','i32.store16','i64.store8','i64.store16','i64.store32'])
    s[k] = {pop:2,push:0,popT:k.split('.')[0],mem:true,store:true};
  s['memory.size'] = {pop:0,push:1,pushT:'i32'};
  s['memory.grow'] = {pop:1,push:1,popT:'i32',pushT:'i32'};
  for(const k of ['i32.const','i64.const','f32.const','f64.const'])
    s[k] = {pop:0,push:1,pushT:k.split('.')[0]};
  for(const k of ['i32.add','i32.sub','i32.mul','i32.div_s','i32.div_u',
    'i32.rem_s','i32.rem_u','i32.and','i32.or','i32.xor',
    'i32.shl','i32.shr_s','i32.shr_u','i32.rotl','i32.rotr',
    'i32.eq','i32.ne','i32.lt_s','i32.lt_u','i32.gt_s','i32.gt_u',
    'i32.le_s','i32.le_u','i32.ge_s','i32.ge_u',
    'i64.add','i64.sub','i64.mul','i64.div_s','i64.div_u',
    'i64.rem_s','i64.rem_u','i64.and','i64.or','i64.xor',
    'i64.shl','i64.shr_s','i64.shr_u','i64.rotl','i64.rotr',
    'i64.eq','i64.ne','i64.lt_s','i64.lt_u','i64.gt_s','i64.gt_u',
    'i64.le_s','i64.le_u','i64.ge_s','i64.ge_u',
    'f32.add','f32.sub','f32.mul','f32.div',
    'f32.eq','f32.ne','f32.lt','f32.gt','f32.le','f32.ge',
    'f32.min','f32.max','f32.copysign',
    'f64.add','f64.sub','f64.mul','f64.div',
    'f64.eq','f64.ne','f64.lt','f64.gt','f64.le','f64.ge',
    'f64.min','f64.max','f64.copysign']) {
    const t = k.split('.')[0];
    const cmp = ['eq','ne','lt','gt','le','ge','lt_s','lt_u','gt_s','gt_u','le_s','le_u','ge_s','ge_u'].some(suff=>k.endsWith('.'+suff));
    s[k] = {pop:2,push:1,popT:t,pushT:cmp?'i32':t};
  }
  for(const k of ['i32.clz','i32.ctz','i32.popcnt','i32.eqz',
    'i64.clz','i64.ctz','i64.popcnt','i64.eqz',
    'f32.abs','f32.neg','f32.ceil','f32.floor','f32.trunc','f32.nearest','f32.sqrt',
    'f64.abs','f64.neg','f64.ceil','f64.floor','f64.trunc','f64.nearest','f64.sqrt']) {
    const t = k.split('.')[0];
    s[k] = {pop:1,push:1,popT:t,pushT: k.endsWith('eqz') ? 'i32' : t};
  }
  const conv = [
    ['i32.wrap_i64','i64','i32'],
    ['i32.trunc_f32_s','f32','i32'],
    ['i32.trunc_f32_u','f32','i32'],
    ['i32.trunc_f64_s','f64','i32'],
    ['i32.trunc_f64_u','f64','i32'],
    ['i64.extend_i32_s','i32','i64'],
    ['i64.extend_i32_u','i32','i64'],
    ['i64.trunc_f32_s','f32','i64'],
    ['i64.trunc_f32_u','f32','i64'],
    ['i64.trunc_f64_s','f64','i64'],
    ['i64.trunc_f64_u','f64','i64'],
    ['f32.convert_i32_s','i32','f32'],
    ['f32.convert_i32_u','i32','f32'],
    ['f32.convert_i64_s','i64','f32'],
    ['f32.convert_i64_u','i64','f32'],
    ['f32.demote_f64','f64','f32'],
    ['f64.convert_i32_s','i32','f64'],
    ['f64.convert_i32_u','i32','f64'],
    ['f64.convert_i64_s','i64','f64'],
    ['f64.convert_i64_u','i64','f64'],
    ['f64.promote_f32','f32','f64'],
    ['i32.reinterpret_f32','f32','i32'],
    ['i64.reinterpret_f64','f64','i64'],
    ['f32.reinterpret_i32','i32','f32'],
    ['f64.reinterpret_i64','i64','f64'],
    ['i32.extend8_s','i32','i32'],
    ['i32.extend16_s','i32','i32'],
    ['i64.extend8_s','i64','i64'],
    ['i64.extend16_s','i64','i64'],
    ['i64.extend32_s','i64','i64']
  ];
  for(const [nm,pt,qt] of conv) s[nm] = {pop:1,push:1,popT:pt,pushT:qt};
  s['call'] = {pop:null,push:null,call:true};
  s['call_indirect'] = {pop:null,push:null,call:true};
  return s;
})();

// ============================================================
// 解析器 (Parser)
// ============================================================
class Parser {
  constructor(tokens){ this.tokens=tokens; this.pos=0; }
  peek(n=0){return this.tokens[this.pos+n];}
  advance(n=1){return this.tokens[this.pos++];}
  expect(t,v=null){
    const tk=this.advance();
    if(tk.type!==t||(v!==null&&tk.value!==v)){
      const m = v?`Expected ${t} '${v}' got ${tk.type} '${tk.value}'`
               :`Expected ${t} got ${tk.type} '${tk.value}'`;
      throw new Error(`${m} at line ${tk.line}, col ${tk.col}`);
    }
    return tk;
  }
  check(t,v=null){const p=this.peek();return p.type===t&&(v===null||p.value===v);}
  match(t,v=null){if(this.check(t,v)){this.advance();return true;}return false;}

  parseSExpr(){
    if(this.check('LPAREN')){
      this.advance();const ch=[];
      while(!this.check('RPAREN')&&!this.check('EOF'))ch.push(this.parseSExpr());
      this.expect('RPAREN');return {type:'list',children:ch};
    } else {
      return {type:'atom',token:this.advance()};
    }
  }

  parseModule(){
    this.expect('LPAREN');this.expect('KEYWORD','module');
    const m = {type:'module',types:[],imports:[],functions:[],tables:[],
               memories:[],globals:[],exports:[],start:null,elems:[],datas:[]};
    while(!this.check('RPAREN')&&!this.check('EOF')){
      this._processTop(this.parseSExpr(),m);
    }
    this.expect('RPAREN');return m;
  }

  _processTop(node,m){
    if(node.type!=='list'||node.children.length===0)return;
    const h=node.children[0];
    if(h.type!=='atom')return;
    const kw=h.token.value;
    switch(kw){
      case 'type':m.types.push(this._parseType(node));break;
      case 'import':m.imports.push(this._parseImport(node));break;
      case 'func':m.functions.push(this._parseFunc(node));break;
      case 'table':m.tables.push(this._parseTable(node));break;
      case 'memory':m.memories.push(this._parseMemory(node));break;
      case 'global':m.globals.push(this._parseGlobal(node));break;
      case 'export':m.exports.push(this._parseExport(node));break;
      case 'start':m.start=this._parseStart(node);break;
      case 'elem':m.elems.push(this._parseElem(node));break;
      case 'data':m.datas.push(this._parseData(node));break;
    }
  }

  _parseType(node){
    const r={name:null,params:[],results:[]};
    for(let i=1;i<node.children.length;i++){
      const c=node.children[i];
      if(c.type==='atom'&&c.token.type==='IDENTIFIER')r.name=c.token.value;
      else if(c.type==='list'){
        const h=c.children[0].token.value;
        if(h==='func'){
          for(let j=1;j<c.children.length;j++){
            const fc=c.children[j];if(fc.type!=='list')continue;
            const fch=fc.children[0].token.value;
            if(fch==='param')for(let k=1;k<fc.children.length;k++){
              const cc=fc.children[k];
              if(cc.type==='atom'&&!cc.token.value.startsWith('$'))r.params.push(cc.token.value);
            }
            if(fch==='result')for(let k=1;k<fc.children.length;k++){
              const cc=fc.children[k];if(cc.type==='atom')r.results.push(cc.token.value);
            }
          }
        } else if(h==='param'){
          for(let k=1;k<c.children.length;k++){
            const cc=c.children[k];
            if(cc.type==='atom'&&!cc.token.value.startsWith('$'))r.params.push(cc.token.value);
          }
        } else if(h==='result'){
          for(let k=1;k<c.children.length;k++){
            const cc=c.children[k];if(cc.type==='atom')r.results.push(cc.token.value);
          }
        }
      }
    }
    return r;
  }

  _parseImport(node){
    const r={module:'',name:'',desc:null};
    if(node.children.length<4)return r;
    r.module=node.children[1].token.value;
    r.name=node.children[2].token.value;
    const d=node.children[3];
    if(d.type!=='list'||d.children.length===0)return r;
    const dkw=d.children[0].token.value;
    if(dkw==='func'){
      r.desc={kind:'func',name:null,params:[],results:[]};
      for(let i=1;i<d.children.length;i++){
        const dc=d.children[i];
        if(dc.type==='atom'&&dc.token.type==='IDENTIFIER')r.desc.name=dc.token.value;
        else if(dc.type==='list'){
          const h=dc.children[0].token.value;
          if(h==='param')for(let k=1;k<dc.children.length;k++){
            const cc=dc.children[k];
            if(cc.type==='atom'&&!cc.token.value.startsWith('$'))r.desc.params.push(cc.token.value);
          }
          if(h==='result')for(let k=1;k<dc.children.length;k++){
            const cc=dc.children[k];if(cc.type==='atom')r.desc.results.push(cc.token.value);
          }
        }
      }
    } else if(dkw==='memory'){
      r.desc={kind:'memory',limits:{min:0,max:null}};
      for(let i=1;i<d.children.length;i++){
        const dc=d.children[i];
        if(dc.type==='atom'&&dc.token.type==='NUMBER'){
          const v=parseInt(dc.token.value);
          if(r.desc.limits.min===0)r.desc.limits.min=v;
          else r.desc.limits.max=v;
        }
      }
    } else if(dkw==='table')r.desc={kind:'table',limits:{min:0,max:null},elemType:'funcref'};
    else if(dkw==='global')r.desc={kind:'global',mut:false,type:'i32'};
    return r;
  }

  _parseFunc(node){
    const f={name:null,exportName:null,params:[],paramNames:[],results:[],
             locals:[],localNames:[],instructions:[],typeRef:null,
             loc:{startLine:null,startCol:null,endLine:null,endCol:null}};
    const funcToken=node.children[0]?.token;
    if(funcToken){f.loc.startLine=funcToken.line;f.loc.startCol=funcToken.col;}
    let instStart=-1;
    for(let i=1;i<node.children.length;i++){
      const c=node.children[i];
      if(c.type==='atom'){
        if(f.name===null&&c.token.type==='IDENTIFIER'){f.name=c.token.value;}
        else {instStart=i;break;}
      }
      else if(c.type==='list'){
        const h=c.children[0];if(!h||h.type!=='atom'){instStart=i;break;}
        const kw=h.token.value;
        if(kw==='export'){f.exportName=c.children[1]?.token.value;}
        else if(kw==='param'){
          const nms=[],tys=[];
          for(let k=1;k<c.children.length;k++){
            const cc=c.children[k];
            if(cc.type==='atom'){
              if(cc.token.type==='IDENTIFIER')nms.push(cc.token.value);
              else tys.push(cc.token.value);
            }
          }
          for(const t of tys)f.params.push(t);
          if(nms.length===tys.length)for(const n of nms)f.paramNames.push(n);
          else for(let k=0;k<tys.length;k++)f.paramNames.push(nms[k]||null);
        }
        else if(kw==='result'){
          for(let k=1;k<c.children.length;k++){
            const cc=c.children[k];if(cc.type==='atom')f.results.push(cc.token.value);
          }
        }
        else if(kw==='local'){
          const nms=[],tys=[];
          for(let k=1;k<c.children.length;k++){
            const cc=c.children[k];
            if(cc.type==='atom'){
              if(cc.token.type==='IDENTIFIER')nms.push(cc.token.value);
              else tys.push(cc.token.value);
            }
          }
          for(const t of tys)f.locals.push(t);
          if(nms.length===tys.length)for(const n of nms)f.localNames.push(n);
          else for(let k=0;k<tys.length;k++)f.localNames.push(nms[k]||null);
        }
        else if(kw==='type'){if(c.children[1])f.typeRef=c.children[1].token.value;}
        else {instStart=i;break;}
      }
    }
    if(instStart>=0){
      const instrs=this._parseFlatInstrs(node.children.slice(instStart));
      f.instructions=instrs;
    }
    const lastInstr=f.instructions[f.instructions.length-1];
    if(lastInstr&&lastInstr.loc){
      f.loc.endLine=lastInstr.loc.line;
      f.loc.endCol=lastInstr.loc.col;
    }
    f.instrCount=countInstructions(f.instructions).count;
    return f;
  }

  _parseFlatInstrs(ch, instrIndexRef=null, ctrlPathBase=null){
    const tokens=[];
    for(const c of ch){
      if(c.type==='atom')tokens.push({kind:'atom',node:c});
      else tokens.push({kind:'list',node:c});
    }
    let pos=0;
    const peek=()=>tokens[pos];
    const advance=()=>tokens[pos++];
    const instrIndex=instrIndexRef||{value:0};
    const ctrlPath=ctrlPathBase?[...ctrlPathBase]:[];

    const addLoc=(ins,token,path)=>{
      ins.loc={line:token.line,col:token.col};
      ins.ctrlPath=[...path];
      ins.index=instrIndex.value++;
      return ins;
    };

    const parseOne=()=>{
      const t=peek();
      if(!t)return null;
      if(t.kind==='list'){
        advance();
        const ins=this._parseInstr(t.node);
        if(ins&&ins.opcode!=='end'&&ins.opcode!=='else'&&ins.opcode!=='then'){
          const firstToken=t.node.children[0]?.token;
          if(firstToken)addLoc(ins,firstToken,ctrlPath);
        }
        return ins;
      }
      const opToken=t.node.token;
      const op=opToken.value;
      advance();

      if(op==='block'||op==='loop'){
        let lbl=null,res=[];
        if(peek()&&peek().kind==='atom'&&peek().node.token.type==='IDENTIFIER'){
          lbl=peek().node.token.value;advance();
        }
        while(peek()&&peek().kind==='list'&&peek().node.children[0]?.token.value==='result'){
          const rl=advance().node;
          for(let k=1;k<rl.children.length;k++){
            if(rl.children[k].type==='atom')res.push(rl.children[k].token.value);
          }
        }
        const ctrlEntry={opcode:op,label:lbl||null};
        ctrlPath.push(ctrlEntry);
        const body=parseBlock(['end']);
        ctrlPath.pop();
        const ins={opcode:op,args:[lbl,res,body],block:true};
        return addLoc(ins,opToken,ctrlPath);
      }
      if(op==='if'){
        let lbl=null,res=[];
        if(peek()&&peek().kind==='atom'&&peek().node.token.type==='IDENTIFIER'){
          lbl=peek().node.token.value;advance();
        }
        while(peek()&&peek().kind==='list'&&peek().node.children[0]?.token.value==='result'){
          const rl=advance().node;
          for(let k=1;k<rl.children.length;k++){
            if(rl.children[k].type==='atom')res.push(rl.children[k].token.value);
          }
        }
        const ctrlEntry={opcode:'if',label:lbl||null,branch:'then'};
        ctrlPath.push(ctrlEntry);
        lastTerminator=null;
        const thenBody=parseBlock(['else','end']);
        let elseBody=[];
        if(lastTerminator==='else'||(peek()&&peek().kind==='atom'&&peek().node.token.value==='else')){
          if(lastTerminator!=='else')advance();
          ctrlEntry.branch='else';
          lastTerminator=null;
          elseBody=parseBlock(['end']);
        }
        ctrlPath.pop();
        if(lastTerminator!=='end'&&(peek()&&peek().kind==='atom'&&peek().node.token.value==='end'))advance();
        const ins={opcode:'if',args:[lbl,res,thenBody,elseBody],block:true};
        return addLoc(ins,opToken,ctrlPath);
      }
      if(op==='end'||op==='else'||op==='then'){
        return {opcode:op,args:[]};
      }

      const args=[];
      while(peek()){
        const nt=peek();
        if(nt.kind==='list')break;
        const val=nt.node.token.value;
        const type=nt.node.token.type;
        const isOpcode = (type==='KEYWORD'&&
          (OPCODES[val]!==undefined||
           ['block','loop','if','end','else','then'].includes(val)));
        if(isOpcode)break;
        args.push({kind:type,value:val});
        advance();
      }
      const ins={opcode:op,args,memArg:{offset:0,align:null}};
      return addLoc(ins,opToken,ctrlPath);
    };

    let lastTerminator=null;
    const parseBlock=(terminators)=>{
      const body=[];
      while(peek()){
        const t=peek();
        if(t.kind==='atom'&&terminators.includes(t.node.token.value)){
          lastTerminator=t.node.token.value;
          advance();
          break;
        }
        const ins=parseOne();
        if(ins&&ins.opcode!=='end'&&ins.opcode!=='else'&&ins.opcode!=='then')body.push(ins);
        else if(ins&&terminators.includes(ins.opcode)){
          lastTerminator=ins.opcode;
          break;
        }
      }
      return body;
    };

    const result=[];
    while(pos<tokens.length){
      const ins=parseOne();
      if(ins&&ins.opcode!=='end'&&ins.opcode!=='else'&&ins.opcode!=='then')result.push(ins);
    }
    return result;
  }

  _parseInstrs(ch){
    return this._parseFlatInstrs(ch);
  }

  _parseInstr(node, instrIndexRef=null, ctrlPathBase=null){
    if(node.type==='atom'){
      const v=node.token.value;
      if(v==='end'||v==='else'||v==='then')return {opcode:v,args:[]};
      if(INSTR_STACK[v]&&!INSTR_STACK[v].call&&!INSTR_STACK[v].ref&&!INSTR_STACK[v].ctrl&&!INSTR_STACK[v].branch){
        const fx=INSTR_STACK[v];
        if((fx.pop===0||fx.pop===null)&&fx.mem===undefined&&fx.pushT===undefined&&
           !v.startsWith('local.')&&!v.startsWith('global.')&&!v.endsWith('.const')&&
           !v.endsWith('.load')&&!v.endsWith('.store')&&
           v!=='memory.size'&&v!=='memory.grow'){
          const ins={opcode:v,args:[],memArg:{offset:0,align:null}};
          const instrIndex=instrIndexRef||{value:0};
          const ctrlPath=ctrlPathBase||[];
          ins.loc={line:node.token.line,col:node.token.col};
          ins.ctrlPath=[...ctrlPath];
          ins.index=instrIndex.value++;
          return ins;
        }
      }
      return null;
    }
    if(node.type==='list'&&node.children.length>0){
      const h=node.children[0];if(h.type!=='atom')return null;
      const op=h.token.value;
      const instrIndex=instrIndexRef||{value:0};
      const ctrlPath=ctrlPathBase||[];

      const addLoc=(ins,token)=>{
        ins.loc={line:token.line,col:token.col};
        ins.ctrlPath=[...ctrlPath];
        ins.index=instrIndex.value++;
        return ins;
      };

      if(op==='block'||op==='loop'){
        let lbl=null,res=[],bi=1;
        if(node.children[1]?.type==='atom'&&node.children[1].token.type==='IDENTIFIER'){
          lbl=node.children[1].token.value;bi=2;
        }
        if(node.children[bi]?.type==='list'&&node.children[bi].children[0]?.token.value==='result'){
          for(let k=1;k<node.children[bi].children.length;k++){
            if(node.children[bi].children[k].type==='atom')res.push(node.children[bi].children[k].token.value);
          }
          bi++;
        }
        const ctrlEntry={opcode:op,label:lbl||null};
        const nestedCtrlPath=[...ctrlPath,ctrlEntry];
        const bd=this._parseFlatInstrs(node.children.slice(bi,-1),instrIndex,nestedCtrlPath);
        const ins={opcode:op,args:[lbl,res,bd],block:true};
        return addLoc(ins,h.token);
      }
      if(op==='if'){
        let lbl=null,res=[],bi=1;
        if(node.children[1]?.type==='atom'&&node.children[1].token.type==='IDENTIFIER'){
          lbl=node.children[1].token.value;bi=2;
        }
        if(node.children[bi]?.type==='list'&&node.children[bi].children[0]?.token.value==='result'){
          for(let k=1;k<node.children[bi].children.length;k++){
            if(node.children[bi].children[k].type==='atom')res.push(node.children[bi].children[k].token.value);
          }
          bi++;
        }
        let te=node.children.length-1,es=-1;
        for(let k=bi;k<node.children.length;k++){
          const c=node.children[k];
          if(c.type==='atom'&&c.token.value==='else'){te=k;es=k+1;break;}
        }
        const ctrlEntry={opcode:'if',label:lbl||null,branch:'then'};
        const nestedCtrlPath=[...ctrlPath,ctrlEntry];
        const tb=this._parseFlatInstrs(node.children.slice(bi,te),instrIndex,nestedCtrlPath);
        ctrlEntry.branch='else';
        const eb=es>=0?this._parseFlatInstrs(node.children.slice(es,-1),instrIndex,nestedCtrlPath):[];
        const ins={opcode:'if',args:[lbl,res,tb,eb],block:true};
        return addLoc(ins,h.token);
      }
      // 普通指令
      const args=[];
      for(let k=1;k<node.children.length;k++){
        const ac=node.children[k];
        if(ac.type==='atom')args.push({kind:ac.token.type,value:ac.token.value});
      }
      const memArg = {offset:0,align:null};
      let cleanArgs = [];
      for(const a of args){
        if(typeof a.value==='string'&&a.value.startsWith('offset=')){
          memArg.offset=parseInt(a.value.slice(7));
        } else if(typeof a.value==='string'&&a.value.startsWith('align=')){
          memArg.align=parseInt(a.value.slice(6));
        } else cleanArgs.push(a);
      }
      const ins={opcode:op,args:cleanArgs,memArg};
      return addLoc(ins,h.token);
    }
    return null;
  }

  _parseTable(node){
    const r={name:null,limits:{min:0,max:null},elemType:'funcref',exportName:null};
    for(let i=1;i<node.children.length;i++){
      const c=node.children[i];
      if(c.type==='atom'){
        if(c.token.type==='IDENTIFIER')r.name=c.token.value;
        else if(c.token.value==='funcref'||c.token.value==='externref')r.elemType=c.token.value;
        else if(c.token.type==='NUMBER'){
          const v=parseInt(c.token.value);
          if(r.limits.min===0)r.limits.min=v;else r.limits.max=v;
        }
      } else if(c.type==='list'&&c.children[0].token.value==='export'){
        r.exportName=c.children[1]?.token.value;
      }
    }
    return r;
  }

  _parseMemory(node){
    const r={name:null,limits:{min:0,max:null},exportName:null};
    for(let i=1;i<node.children.length;i++){
      const c=node.children[i];
      if(c.type==='atom'){
        if(c.token.type==='IDENTIFIER')r.name=c.token.value;
        else if(c.token.type==='NUMBER'){
          const v=parseInt(c.token.value);
          if(r.limits.min===0)r.limits.min=v;else r.limits.max=v;
        }
      } else if(c.type==='list'&&c.children[0].token.value==='export'){
        r.exportName=c.children[1]?.token.value;
      }
    }
    return r;
  }

  _parseGlobal(node){
    const r={name:null,type:'i32',mut:false,exportName:null,init:[]};
    for(let i=1;i<node.children.length;i++){
      const c=node.children[i];
      if(c.type==='atom'&&c.token.type==='IDENTIFIER')r.name=c.token.value;
      else if(c.type==='list'){
        const kw=c.children[0].token.value;
        if(kw==='export')r.exportName=c.children[1]?.token.value;
        else if(kw==='mut'){r.mut=true;r.type=c.children[1]?.token.value||'i32';}
        else if(kw==='i32'||kw==='i64'||kw==='f32'||kw==='f64')r.type=kw;
        else {const ii=this._parseInstr(c);if(ii)r.init.push(ii);}
      }
    }
    return r;
  }

  _parseExport(node){
    const r={name:node.children[1]?.token.value||'',desc:{kind:'func',index:0,name:null}};
    const d=node.children[2];
    if(d&&d.type==='list'&&d.children.length>=2){
      r.desc.kind=d.children[0].token.value;
      const v=d.children[1].token.value;
      if(v.startsWith('$'))r.desc.name=v;
      else r.desc.index=parseInt(v);
    }
    return r;
  }

  _parseStart(node){
    const c=node.children[1];
    if(c&&c.type==='atom'){
      return {funcName:c.token.value.startsWith('$')?c.token.value:null,
              funcIndex:c.token.value.startsWith('$')?null:parseInt(c.token.value)};
    }
    return null;
  }

  _parseElem(node){
    const r={offset:[],funcs:[]};
    for(let i=1;i<node.children.length;i++){
      const c=node.children[i];
      if(c.type==='atom'&&c.token.type==='IDENTIFIER')r.funcs.push(c.token.value);
      else if(c.type==='list'){
        const ii=this._parseInstr(c);
        if(ii)r.offset.push(ii);
        for(let j=0;j<c.children.length;j++){
          const iii=this._parseInstr(c.children[j]);
          if(iii&&!r.offset.includes(iii)){r.offset.push(iii);break;}
        }
      }
    }
    return r;
  }

  _parseData(node){
    const r={offset:[],data:'',memoryName:null};
    for(let i=1;i<node.children.length;i++){
      const c=node.children[i];
      if(c.type==='atom'){
        if(c.token.type==='STRING')r.data+=c.token.value;
        else if(c.token.type==='IDENTIFIER')r.memoryName=c.token.value;
      } else if(c.type==='list'){
        const ii=this._parseInstr(c);
        if(ii)r.offset.push(ii);
      }
    }
    return r;
  }
}

// ============================================================
// 验证器 (Validator - 栈类型检查)
// ============================================================
function buildFuncIndex(ast){
  const idx = {names:{},types:[]};
  let i=0;
  for(const imp of ast.imports){
    if(imp.desc&&imp.desc.kind==='func'){
      if(imp.desc.name)idx.names[imp.desc.name]=i;
      idx.types.push({params:[...imp.desc.params],results:[...imp.desc.results]});
      i++;
    }
  }
  idx.importCount = i;
  for(const f of ast.functions){
    if(f.name)idx.names[f.name]=i;
    idx.types.push({params:[...f.params],results:[...f.results]});
    i++;
  }
  idx.total = i;
  return idx;
}

function buildLocalIndex(func){
  const idx = {names:{},types:[]};
  let i=0;
  for(const t of func.params){idx.types.push(t);i++;}
  for(let j=0;j<func.paramNames.length;j++){
    if(func.paramNames[j])idx.names[func.paramNames[j]]=j;
  }
  for(const t of func.locals){idx.types.push(t);i++;}
  for(let j=0;j<func.localNames.length;j++){
    if(func.localNames[j])idx.names[func.localNames[j]]=func.params.length+j;
  }
  idx.total=i;
  return idx;
}

function resolveIdx(args, nameMap){
  if(args.length===0)throw new Error('Missing index argument');
  const a=args[0];
  if(a.kind==='IDENTIFIER'){
    if(!(a.value in nameMap))throw new Error(`Unknown identifier ${a.value}`);
    return nameMap[a.value];
  }
  return parseInt(a.value);
}

function parseNum(s){
  if(s.startsWith('0x')||s.startsWith('-0x')||s.startsWith('+0x')){
    return BigInt(s);
  }
  if(s.startsWith('0b'))return BigInt(parseInt(s.slice(2),2));
  if(s==='inf')return Infinity;
  if(s.startsWith('nan'))return NaN;
  if(s.includes('.')||s.includes('e')||s.includes('E'))return parseFloat(s);
  return BigInt(s);
}

class Validator {
  constructor(ast){this.ast=ast;this.funcIdx=buildFuncIndex(ast);this.errors=[];}
  error(msg){this.errors.push(msg);}
  validate(){
    // 验证函数
    for(let i=0;i<this.ast.functions.length;i++){
      const f=this.ast.functions[i];
      try{this.validateFunc(f,this.funcIdx.importCount+i);}
      catch(e){this.error(`Func[${f.name||i}]: ${e.message}`);}
    }
    return this.errors;
  }
  validateFunc(func, funcIndex){
    const selfType = this.funcIdx.types[funcIndex];
    const locals = buildLocalIndex(func);
    const ctrlStack = [];
    const valStack = [];
    const labels = {};
    const funcName = func.name || `func_${funcIndex}`;

    ctrlStack.push({
      opcode:'func',
      label:null,
      startTypes:[],
      endTypes:[...selfType.results],
      unreachable:false,
      height:0
    });

    const locStr = (instr) => {
      if (instr && instr.loc) {
        return ` at ${funcName} line ${instr.loc.line}, col ${instr.loc.col}`;
      }
      return ` in ${funcName}`;
    };

    const pop = (n, from=null, instr=null) => {
      if(valStack.length<n){
        if(!ctrlStack.some(c=>c.unreachable))
          throw new Error(`Stack underflow: need ${n}, have ${valStack.length}${from?' in '+from:''}${locStr(instr)}`);
        return Array(n).fill('any');
      }
      return valStack.splice(-n,n);
    };
    const push = (types)=>{for(const t of types)valStack.push(t);};
    const checkT = (a,b)=> a===b||a==='any'||b==='any';
    const assertT = (a,ex,ctx,instr=null)=>{
      if(!checkT(a,ex))throw new Error(`Type mismatch in ${ctx}: expected ${ex}, got ${a}${locStr(instr)}`);
    };

    const execInstr = (instr) => {
      const op = instr.opcode;
      const fx = INSTR_STACK[op];
      if(!fx){
        // 未知指令，跳过（不严格）
        return;
      }

      if(fx.ctrl){
        const [lbl,res,body,elseBody]=instr.args;
        if(lbl)labels[lbl]=ctrlStack.length;
        if(op==='if'){
          const [c]=pop(1,'if condition',instr);
          assertT(c,'i32','if condition',instr);
        }
        const entryHeight = valStack.length;
        ctrlStack.push({
          opcode:op, label:lbl,
          startTypes:[], endTypes:[...res],
          unreachable:false,
          height:entryHeight
        });
        execBody(body);
        if(op==='if'&&elseBody){
          const r = ctrlStack.pop();
          if(res.length>0){
            const thenRes = pop(res.length,'if then',instr);
            for(let i=0;i<res.length;i++)assertT(thenRes[i],res[i],'if then',instr);
          }
          valStack.length = entryHeight;
          ctrlStack.push({
            opcode:'else', label:null,
            startTypes:[], endTypes:[...res],
            unreachable:false,
            height:entryHeight
          });
          execBody(elseBody);
        }
        const r2 = ctrlStack.pop();
        if(res.length>0){
          const rr = pop(res.length,`${op} result`,instr);
          for(let i=0;i<res.length;i++)assertT(rr[i],res[i],`${op} result`,instr);
        }
        push(res);
        return;
      }

      if(fx.call){
        if(op==='call'){
          let fi;
          try {
            fi = resolveIdx(instr.args,this.funcIdx.names);
          } catch(e) {
            throw new Error(`${e.message}${locStr(instr)}`);
          }
          if(fi>=this.funcIdx.types.length)throw new Error(`call: unknown function index ${fi}${locStr(instr)}`);
          const ft = this.funcIdx.types[fi];
          if(ft.params.length>0){
            const pp = pop(ft.params.length,'call params',instr);
            for(let i=0;i<ft.params.length;i++)
              assertT(pp[i],ft.params[i],`call param ${i}`,instr);
          }
          push(ft.results);
          return;
        }
        if(op==='call_indirect'){
          let typeIdx = 0;
          if(instr.args.length>=2){
            const a = instr.args[instr.args.length-1];
            if(a.kind==='IDENTIFIER'){
              typeIdx = resolveIdx([a],{});
            } else typeIdx = parseInt(a.value);
          } else if(instr.args.length===1){
            const a = instr.args[0];
            typeIdx = parseInt(a.value);
          }
          if(typeIdx>=this.ast.types.length)throw new Error(`call_indirect: type index out of range ${typeIdx}${locStr(instr)}`);
          const ft = this.ast.types[typeIdx];
          const [tbl] = pop(1,'call_indirect table',instr);
          assertT(tbl,'i32','call_indirect table',instr);
          if(ft.params.length>0){
            const pp = pop(ft.params.length,'call_indirect params',instr);
            for(let i=0;i<ft.params.length;i++)
              assertT(pp[i],ft.params[i],`call_indirect param ${i}`,instr);
          }
          push(ft.results);
          return;
        }
      }

      if(fx.branch){
        if(op==='br'||op==='br_if'){
          if(op==='br_if'){
            const [c]=pop(1,'br_if',instr);assertT(c,'i32','br_if cond',instr);
          }
          const depth = parseInt(instr.args[0]?.value);
          let actualDepth = depth;
          if(instr.args[0]?.kind==='IDENTIFIER'){
            const ln = instr.args[0].value;
            if(!(ln in labels))throw new Error(`Unknown label '${ln}'${locStr(instr)}`);
            const target = labels[ln];
            actualDepth = ctrlStack.length - 1 - target;
            if(actualDepth<0)throw new Error(`Label '${ln}' out of scope${locStr(instr)}`);
          }
          if(actualDepth>=ctrlStack.length)throw new Error(`Branch depth out of range: ${actualDepth}${locStr(instr)}`);
          const target = ctrlStack[ctrlStack.length-1-actualDepth];
          if(target.endTypes.length>0){
            const rr = pop(target.endTypes.length,`${op}`,instr);
            for(let i=0;i<target.endTypes.length;i++)
              assertT(rr[i],target.endTypes[i],`${op} result`,instr);
            if(op==='br_if')push(rr);
          }
          if(op==='br'){
            for(let i=0;i<=actualDepth;i++){
              ctrlStack[ctrlStack.length-1-i].unreachable = true;
            }
            valStack.length = target.height;
          }
          return;
        }
        if(op==='br_table'){
          const [idx]=pop(1,'br_table',instr);assertT(idx,'i32','br_table idx',instr);
          return;
        }
      }

      if(op==='return'){
        const top = ctrlStack[0];
        if(top.endTypes.length>0){
          const rr = pop(top.endTypes.length,'return',instr);
          for(let i=0;i<top.endTypes.length;i++)
            assertT(rr[i],top.endTypes[i],'return',instr);
        }
        const cur = ctrlStack[ctrlStack.length-1];
        cur.unreachable = true;
        valStack.length = cur.height;
        return;
      }

      if(op==='select'){
        const [a,b,c]=pop(3,'select',instr);
        assertT(c,'i32','select cond',instr);
        if(a!=='any'&&b!=='any'&&a!==b)throw new Error(`select type mismatch: ${a} vs ${b}${locStr(instr)}`);
        push([a==='any'?b:a]);
        return;
      }

      if(fx.mem){
        if(fx.load){
          const [addr]=pop(1,op,instr);assertT(addr,'i32',`${op} addr`,instr);
          push([fx.pushT]);
        } else {
          const [addr,val]=pop(2,op,instr);
          assertT(addr,'i32',`${op} addr`,instr);
          assertT(val,fx.popT,`${op} value`,instr);
        }
        return;
      }

      if(fx.ref&&op.startsWith('local.')){
        let li;
        try {
          li = resolveIdx(instr.args,locals.names);
        } catch(e) {
          throw new Error(`${e.message}${locStr(instr)}`);
        }
        if(li>=locals.total)throw new Error(`local index out of range: ${li}${locStr(instr)}`);
        const lt = locals.types[li];
        if(op==='local.get')push([lt]);
        else if(op==='local.set'){const [v]=pop(1,op,instr);assertT(v,lt,`${op}`,instr);}
        else if(op==='local.tee'){const [v]=pop(1,op,instr);assertT(v,lt,`${op}`,instr);push([lt]);}
        return;
      }
      if(fx.ref&&op.startsWith('global.')){
        const gi = resolveIdx(instr.args,{});
        if(op==='global.get')push(['i32']);
        else if(op==='global.set')pop(1,op,instr);
        return;
      }

      if(op.endsWith('.const')){
        const t = op.split('.')[0];
        push([t]);
        return;
      }

      if(fx.popT){
        const n = fx.pop;
        const pp = pop(n,op,instr);
        for(const p of pp)assertT(p,fx.popT,op,instr);
      } else if(fx.pop){
        pop(fx.pop,op,instr);
      }
      if(fx.pushT){
        const n = fx.push;
        push(Array(n).fill(fx.pushT));
      } else if(fx.push){
      }
    };

    const execBody = (body) => {
      for(const instr of body){
        execInstr(instr);
      }
    };

    execBody(func.instructions);

    // 检查函数返回类型
    const finalCtrl = ctrlStack[0];
    if(valStack.length < selfType.results.length){
      throw new Error(`Function returns ${selfType.results.length} value(s), stack has ${valStack.length} in ${funcName}`);
    }
    if(selfType.results.length>0){
      const rr = pop(selfType.results.length,'function end');
      for(let i=0;i<selfType.results.length;i++)
        assertT(rr[i],selfType.results[i],`function result ${i}`);
    }
  }
}

// ============================================================
// 编译器 (Compiler - WAT -> WASM)
// ============================================================
function encodeVec(arr, itemFn) {
  const bufs = [encodeULEB128(arr.length)];
  for (const item of arr) {
    const r = itemFn(item);
    if (r) bufs.push(r);
  }
  return Buffer.concat(bufs);
}

function encodeName(name) {
  const buf = Buffer.from(name, 'utf8');
  return Buffer.concat([encodeULEB128(buf.length), buf]);
}

function encodeLimits(lim) {
  if (lim.max !== null && lim.max !== undefined) {
    return Buffer.concat([Buffer.from([0x01]), encodeULEB128(lim.min), encodeULEB128(lim.max)]);
  }
  return Buffer.concat([Buffer.from([0x00]), encodeULEB128(lim.min)]);
}

function encodeGlobalType(g) {
  return Buffer.concat([Buffer.from([TYPE_CODE[g.type]]), Buffer.from([g.mut ? 0x01 : 0x00])]);
}

function encodeBlockType(results) {
  if (results.length === 0) return Buffer.from([0x40]);
  if (results.length === 1) return Buffer.from([TYPE_CODE[results[0]]]);
  throw new Error('Multi-value block results not supported');
}

function encodeConst(instr) {
  const op = instr.opcode;
  const parts = [];
  parts.push(Buffer.from([OPCODES[op]]));
  if (instr.args.length === 0) throw new Error(`${op} missing argument`);
  const valStr = instr.args[0].value;
  if (op === 'i32.const') {
    const n = parseNum(valStr);
    parts.push(encodeSLEB128(Number(BigInt.asIntN(32, BigInt(n)))));
  } else if (op === 'i64.const') {
    const n = parseNum(valStr);
    parts.push(encodeSLEB128(Number(BigInt.asIntN(64, BigInt(n)))));
  } else if (op === 'f32.const') {
    const f = parseFloat(valStr);
    const b = Buffer.alloc(4);
    b.writeFloatLE(f, 0);
    parts.push(b);
  } else if (op === 'f64.const') {
    const f = parseFloat(valStr);
    const b = Buffer.alloc(8);
    b.writeDoubleLE(f, 0);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function encodeMemArg(ma) {
  // align -> log2(align)
  let alignExp = 0;
  if (ma && ma.align !== null && ma.align !== undefined) {
    alignExp = Math.log2(ma.align);
  }
  const offset = ma ? ma.offset : 0;
  return Buffer.concat([encodeULEB128(alignExp), encodeULEB128(offset)]);
}

class Compiler {
  constructor(ast) {
    this.ast = ast;
    this.funcIdx = buildFuncIndex(ast);
    this._buildNameMaps();
    this.debugInfo = null;
  }

  _buildNameMaps() {
    this.typeMap = {};
    this.ast.types.forEach((t, i) => { if (t.name) this.typeMap[t.name] = i; });

    // 收集函数签名 -> 类型索引
    this.sigToType = new Map();
    for (let i = 0; i < this.ast.types.length; i++) {
      const t = this.ast.types[i];
      const key = t.params.join(',') + '->' + t.results.join(',');
      this.sigToType.set(key, i);
    }
    // 将函数签名去重加入types数组
    this.allTypes = [...this.ast.types];
    for (const sig of this.funcIdx.types) {
      const key = sig.params.join(',') + '->' + sig.results.join(',');
      if (!this.sigToType.has(key)) {
        this.sigToType.set(key, this.allTypes.length);
        this.allTypes.push({ name: null, params: [...sig.params], results: [...sig.results] });
      }
    }

    this.funcToType = [];
    for (let i = 0; i < this.funcIdx.total; i++) {
      const sig = this.funcIdx.types[i];
      const key = sig.params.join(',') + '->' + sig.results.join(',');
      this.funcToType.push(this.sigToType.get(key));
    }

    this.globalNames = {};
    this.ast.globals.forEach((g, i) => { if (g.name) this.globalNames[g.name] = i; });
    this.memNames = {};
    this.ast.memories.forEach((m, i) => { if (m.name) this.memNames[m.name] = i; });
    this.tableNames = {};
    this.ast.tables.forEach((t, i) => { if (t.name) this.tableNames[t.name] = i; });
  }

  _idxFor(args, nameMap, size) {
    if (args.length === 0) return 0;
    const a = args[0];
    if (a.kind === 'IDENTIFIER') {
      if (!(a.value in nameMap)) throw new Error(`Unknown identifier ${a.value}`);
      return nameMap[a.value];
    }
    return parseInt(a.value);
  }

  _labelDepth(labels, ctrl, arg) {
    if (arg.kind === 'IDENTIFIER') {
      const ln = arg.value;
      if (!(ln in labels)) throw new Error(`Unknown label ${ln}`);
      const target = labels[ln];
      return ctrl.length - 1 - target;
    }
    return parseInt(arg.value);
  }

  _encodeInstr(instr, labels, ctrl, offsetMap = null, baseOffset = 0) {
    const op = instr.opcode;
    if (op === 'block' || op === 'loop' || op === 'if') {
      const [lbl, results, body, elseBody] = instr.args;
      const parts = [];
      parts.push(Buffer.from([OPCODES[op]]));
      parts.push(encodeBlockType(results));
      const prevLen = labels[lbl];
      if (lbl) labels[lbl] = ctrl.length;
      ctrl.push({ endTypes: results });
      let nestedOffset = baseOffset + 2; // opcode + blocktype
      const bodyBuf = this._encodeInstrs(body, labels, ctrl, offsetMap, nestedOffset);
      parts.push(bodyBuf);
      nestedOffset += bodyBuf.length;
      if (op === 'if' && elseBody && elseBody.length > 0) {
        parts.push(Buffer.from([OPCODES['else']]));
        nestedOffset += 1;
        const elseBuf = this._encodeInstrs(elseBody, labels, ctrl, offsetMap, nestedOffset);
        parts.push(elseBuf);
        nestedOffset += elseBuf.length;
      }
      ctrl.pop();
      if (lbl) {
        if (prevLen !== undefined) labels[lbl] = prevLen;
        else delete labels[lbl];
      }
      parts.push(Buffer.from([OPCODES['end']]));
      return Buffer.concat(parts);
    }

    if (op === 'end' || op === 'else' || op === 'then') {
      return null;
    }

    if (op === 'call') {
      const fi = this._idxFor(instr.args, this.funcIdx.names, this.funcIdx.total);
      return Buffer.concat([Buffer.from([OPCODES[op]]), encodeULEB128(fi)]);
    }
    if (op === 'call_indirect') {
      let typeIdx = 0, tableIdx = 0;
      if (instr.args.length === 1) {
        typeIdx = parseInt(instr.args[0].value);
      } else if (instr.args.length >= 2) {
        tableIdx = parseInt(instr.args[0].value);
        typeIdx = parseInt(instr.args[1].value);
      }
      return Buffer.concat([Buffer.from([OPCODES[op]]), encodeULEB128(typeIdx), encodeULEB128(tableIdx)]);
    }

    if (op === 'br' || op === 'br_if') {
      if (instr.args.length === 0) throw new Error(`${op} missing label argument`);
      const depth = this._labelDepth(labels, ctrl, instr.args[0]);
      return Buffer.concat([Buffer.from([OPCODES[op]]), encodeULEB128(depth)]);
    }
    if (op === 'br_table') {
      const parts = [Buffer.from([OPCODES[op]])];
      // 最后一个是default
      const count = instr.args.length - 1;
      parts.push(encodeULEB128(count));
      for (let i = 0; i < count; i++) {
        const depth = this._labelDepth(labels, ctrl, instr.args[i]);
        parts.push(encodeULEB128(depth));
      }
      const defDepth = this._labelDepth(labels, ctrl, instr.args[instr.args.length - 1]);
      parts.push(encodeULEB128(defDepth));
      return Buffer.concat(parts);
    }

    if (op === 'return') {
      return Buffer.from([OPCODES[op]]);
    }

    if (op.startsWith('local.')) {
      const li = this._idxFor(instr.args, {}, 0);
      return Buffer.concat([Buffer.from([OPCODES[op]]), encodeULEB128(li)]);
    }
    if (op.startsWith('global.')) {
      const gi = this._idxFor(instr.args, this.globalNames, this.ast.globals.length);
      return Buffer.concat([Buffer.from([OPCODES[op]]), encodeULEB128(gi)]);
    }

    if (op.endsWith('.const')) {
      return encodeConst(instr);
    }

    if (op === 'memory.size' || op === 'memory.grow') {
      return Buffer.concat([Buffer.from([OPCODES[op]]), encodeULEB128(0x00)]);
    }

    if (OPCODES[op] !== undefined) {
      // 内存指令有 memarg
      const memInstrs = new Set([
        'i32.load', 'i64.load', 'f32.load', 'f64.load',
        'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
        'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u',
        'i64.load32_s', 'i64.load32_u',
        'i32.store', 'i64.store', 'f32.store', 'f64.store',
        'i32.store8', 'i32.store16',
        'i64.store8', 'i64.store16', 'i64.store32'
      ]);
      if (memInstrs.has(op)) {
        return Buffer.concat([Buffer.from([OPCODES[op]]), encodeMemArg(instr.memArg)]);
      }
      // 普通零参/简单指令
      return Buffer.from([OPCODES[op]]);
    }

    // 未知指令 - 尝试记录警告但跳过
    console.warn(`Warning: unrecognized instruction: ${op}`);
    return null;
  }

  _encodeInstrs(instrs, labels, ctrl, offsetMap, funcBodyStart) {
    const parts = [];
    let currentOffset = 0;
    for (const ins of instrs) {
      if (ins.opcode === 'end' || ins.opcode === 'else' || ins.opcode === 'then') continue;
      const b = this._encodeInstr(ins, labels, ctrl, offsetMap, funcBodyStart + currentOffset);
      if (b) {
        parts.push(b);
        if (offsetMap && ins.index !== undefined) {
          offsetMap.push({
            instrIndex: ins.index,
            codeOffset: funcBodyStart + currentOffset,
            size: b.length
          });
        }
        currentOffset += b.length;
      }
    }
    return Buffer.concat(parts);
  }

  _encodeFunctionBody(func, funcGlobalIdx, collectDebug = false) {
    const locals = [];
    let i = 0;
    while (i < func.locals.length) {
      let count = 1;
      while (i + count < func.locals.length && func.locals[i + count] === func.locals[i]) count++;
      locals.push({ count, type: func.locals[i] });
      i += count;
    }
    const localBuf = encodeVec(locals, (l) => Buffer.concat([
      encodeULEB128(l.count),
      Buffer.from([TYPE_CODE[l.type]])
    ]));

    const labels = {};
    const ctrl = [{ endTypes: func.results }];
    const funcLocals = buildLocalIndex(func);
    const selfIdx = this.funcIdx.names[func.name];
    const localNames = funcLocals.names;

    const resolveLocalRef = (instr) => {
      if (!instr || !instr.args) return;
      if(instr.args.length > 0 && instr.args[0] && instr.args[0].kind === 'IDENTIFIER' &&
          (instr.opcode.startsWith('local.'))) {
        const v = instr.args[0].value;
        if (v in funcLocals.names) {
          instr.args[0] = { kind: 'NUMBER', value: String(funcLocals.names[v]) };
        }
      }
      if(instr.args.length > 0 && instr.args[0] && instr.args[0].kind === 'IDENTIFIER' &&
          (instr.opcode.startsWith('global.'))) {
        const v = instr.args[0].value;
        if (v in this.globalNames) {
          instr.args[0] = { kind: 'NUMBER', value: String(this.globalNames[v]) };
        }
      }
      if(instr.args.length > 0 && instr.args[0] && instr.args[0].kind === 'IDENTIFIER' &&
          instr.opcode === 'call') {
        const v = instr.args[0].value;
        if (v in this.funcIdx.names) {
          instr.args[0] = { kind: 'NUMBER', value: String(this.funcIdx.names[v]) };
        }
      }
      if ((instr.opcode === 'br' || instr.opcode === 'br_if') &&
          instr.args.length > 0 && instr.args[0] && instr.args[0].kind === 'IDENTIFIER') {
      }
      if(instr.block && instr.args.length >= 3) {
        const body = instr.args[2];
        const elseB = instr.args[3];
        if (Array.isArray(body)) for (const bi of body) resolveLocalRef(bi);
        if (Array.isArray(elseB)) for (const bi of elseB) resolveLocalRef(bi);
      }
    };
    const clonedInstrs = JSON.parse(JSON.stringify(func.instructions));
    for (const ins of clonedInstrs) resolveLocalRef(ins);

    const offsetMap = collectDebug ? [] : null;
    const bodyBuf = this._encodeInstrs(clonedInstrs, labels, ctrl, offsetMap, localBuf.length);
    const endBuf = Buffer.from([OPCODES['end']]);

    const codeBuf = Buffer.concat([localBuf, bodyBuf, endBuf]);

    if (collectDebug && offsetMap) {
      if (!this.debugInfo) this.debugInfo = { functions: {} };
      this.debugInfo.functions[funcGlobalIdx] = {
        name: func.name || `$func_${funcGlobalIdx}`,
        codeOffsets: offsetMap
      };
    }

    return Buffer.concat([encodeULEB128(codeBuf.length), codeBuf]);
  }

  compile(collectDebug = false) {
    this._collectDebug = collectDebug;
    this.debugInfo = null;
    const sections = [];

    // Type Section (1)
    const typeSection = encodeVec(this.allTypes, (t) => {
      const formBuf = Buffer.from([0x60]);
      const paramBuf = encodeVec(t.params, (p) => Buffer.from([TYPE_CODE[p]]));
      const resBuf = encodeVec(t.results, (r) => Buffer.from([TYPE_CODE[r]]));
      return Buffer.concat([formBuf, paramBuf, resBuf]);
    });
    sections.push({ id: 1, data: typeSection });

    // Import Section (2)
    if (this.ast.imports.length > 0) {
      const importSection = encodeVec(this.ast.imports, (imp) => {
        const modBuf = encodeName(imp.module);
        const nmBuf = encodeName(imp.name);
        if (imp.desc.kind === 'func') {
          const typeIdx = this.funcToType[this.ast.imports.indexOf(imp)];
          return Buffer.concat([modBuf, nmBuf, Buffer.from([0x00]), encodeULEB128(typeIdx)]);
        } else if (imp.desc.kind === 'table') {
          return Buffer.concat([modBuf, nmBuf, Buffer.from([0x01]),
            encodeLimits(imp.desc.limits),
            Buffer.from([TYPE_CODE[imp.desc.elemType || 'funcref']])
          ]);
        } else if (imp.desc.kind === 'memory') {
          return Buffer.concat([modBuf, nmBuf, Buffer.from([0x02]), encodeLimits(imp.desc.limits)]);
        } else if (imp.desc.kind === 'global') {
          return Buffer.concat([modBuf, nmBuf, Buffer.from([0x03]), encodeGlobalType(imp.desc)]);
        }
      });
      sections.push({ id: 2, data: importSection });
    }

    // Function Section (3)
    const funcIndices = [];
    for (let i = this.funcIdx.importCount; i < this.funcIdx.total; i++) {
      funcIndices.push(this.funcToType[i]);
    }
    const funcSection = encodeVec(funcIndices, (idx) => encodeULEB128(idx));
    sections.push({ id: 3, data: funcSection });

    // Table Section (4)
    if (this.ast.tables.length > 0) {
      const tableSection = encodeVec(this.ast.tables, (t) => {
        return Buffer.concat([
          Buffer.from([TYPE_CODE[t.elemType]]),
          encodeLimits(t.limits)
        ]);
      });
      sections.push({ id: 4, data: tableSection });
    }

    // Memory Section (5)
    if (this.ast.memories.length > 0) {
      const memSection = encodeVec(this.ast.memories, (m) => encodeLimits(m.limits));
      sections.push({ id: 5, data: memSection });
    }

    // Global Section (6)
    if (this.ast.globals.length > 0) {
      const globalSection = encodeVec(this.ast.globals, (g) => {
        const typeBuf = encodeGlobalType(g);
        const initParts = [];
        const lbl = {}, ctrl = [];
        for (const ins of g.init) {
          const cloned = JSON.parse(JSON.stringify(ins));
          if (cloned.args.length > 0 && cloned.args[0].kind === 'IDENTIFIER' && cloned.opcode.startsWith('global.')) {
            const v = cloned.args[0].value;
            if (v in this.globalNames) cloned.args[0] = { kind: 'NUMBER', value: String(this.globalNames[v]) };
          }
          const b = this._encodeInstr(cloned, lbl, ctrl);
          if (b) initParts.push(b);
        }
        initParts.push(Buffer.from([OPCODES['end']]));
        return Buffer.concat([typeBuf, ...initParts]);
      });
      sections.push({ id: 6, data: globalSection });
    }

    // Export Section (7)
    // 收集内联导出 (例如 func 内部的 (export "xxx"))
    const allExports = [...this.ast.exports];
    this.ast.functions.forEach((f, idx) => {
      if (f.exportName) {
        allExports.push({
          name: f.exportName,
          desc: { kind: 'func', index: this.funcIdx.importCount + idx, name: f.name }
        });
      }
    });
    this.ast.tables.forEach((t, idx) => {
      if (t.exportName) {
        allExports.push({ name: t.exportName, desc: { kind: 'table', index: idx, name: t.name } });
      }
    });
    this.ast.memories.forEach((m, idx) => {
      if (m.exportName) {
        allExports.push({ name: m.exportName, desc: { kind: 'memory', index: idx, name: m.name } });
      }
    });
    this.ast.globals.forEach((g, idx) => {
      if (g.exportName) {
        allExports.push({ name: g.exportName, desc: { kind: 'global', index: idx, name: g.name } });
      }
    });

    if (allExports.length > 0) {
      const kindCode = { func: 0x00, table: 0x01, memory: 0x02, global: 0x03 };
      const exportSection = encodeVec(allExports, (e) => {
        const nmBuf = encodeName(e.name);
        // 解析 desc 索引
        let idx = e.desc.index;
        if (e.desc.name) {
          if (e.desc.kind === 'func') {
            idx = this.funcIdx.names[e.desc.name];
          } else if (e.desc.kind === 'memory') {
            idx = this.memNames[e.desc.name] || 0;
          } else if (e.desc.kind === 'table') {
            idx = this.tableNames[e.desc.name] || 0;
          } else if (e.desc.kind === 'global') {
            idx = this.globalNames[e.desc.name] || 0;
          }
        }
        return Buffer.concat([
          nmBuf,
          Buffer.from([kindCode[e.desc.kind] || 0]),
          encodeULEB128(idx || 0)
        ]);
      });
      sections.push({ id: 7, data: exportSection });
    }

    // Start Section (8)
    if (this.ast.start) {
      let funcIdx = this.ast.start.funcIndex;
      if (this.ast.start.funcName) funcIdx = this.funcIdx.names[this.ast.start.funcName];
      if (funcIdx !== undefined && funcIdx !== null) {
        sections.push({ id: 8, data: encodeULEB128(funcIdx) });
      }
    }

    // Element Section (9)
    if (this.ast.elems.length > 0) {
      const elemSection = encodeVec(this.ast.elems, (e) => {
        // 简化：mode=active, table=0
        const modeBuf = Buffer.from([0x00]);
        const offsetParts = [];
        const lbl = {}, ctrl = [];
        for (const ins of e.offset) {
          const b = this._encodeInstr(ins, lbl, ctrl);
          if (b) offsetParts.push(b);
        }
        offsetParts.push(Buffer.from([OPCODES['end']]));
        const funcIdxs = [];
        for (const fn of e.funcs) {
          if (fn.startsWith('$') && fn in this.funcIdx.names) {
            funcIdxs.push(this.funcIdx.names[fn]);
          } else {
            funcIdxs.push(parseInt(fn));
          }
        }
        const vecBuf = encodeVec(funcIdxs, (fi) => encodeULEB128(fi));
        return Buffer.concat([modeBuf, ...offsetParts, vecBuf]);
      });
      sections.push({ id: 9, data: elemSection });
    }

    // Code Section (10)
    const codeBodies = this.ast.functions.map((f, i) => {
      const funcGlobalIdx = this.funcIdx.importCount + i;
      return this._encodeFunctionBody(f, funcGlobalIdx, this._collectDebug);
    });
    const codeSection = encodeVec(codeBodies, (buf) => buf);
    sections.push({ id: 10, data: codeSection });

    // Data Section (11)
    if (this.ast.datas.length > 0) {
      const dataSection = encodeVec(this.ast.datas, (d) => {
        // 简化 mode=active memory=0
        const flagBuf = Buffer.from([0x00]);
        const offsetParts = [];
        const lbl = {}, ctrl = [];
        for (const ins of d.offset) {
          const cloned = JSON.parse(JSON.stringify(ins));
          const b = this._encodeInstr(cloned, lbl, ctrl);
          if (b) offsetParts.push(b);
        }
        offsetParts.push(Buffer.from([OPCODES['end']]));
        const dataBuf = Buffer.from(d.data, 'binary');
        const lenBuf = encodeULEB128(dataBuf.length);
        return Buffer.concat([flagBuf, ...offsetParts, lenBuf, dataBuf]);
      });
      sections.push({ id: 11, data: dataSection });
    }

    // Data Count Section (12) - 需要在data section前声明
    if (this.ast.datas.length > 0) {
      sections.push({ id: 12, data: encodeULEB128(this.ast.datas.length), _priority: true });
    }

    // 组装
    const magic = Buffer.from([0x00, 0x61, 0x73, 0x6d]); // \0asm
    const version = Buffer.from([0x01, 0x00, 0x00, 0x00]);
    const sectionBufs = [magic, version];

    // WASM section 规范顺序:
    // 1 type, 2 import, 3 function, 4 table, 5 memory, 6 global,
    // 7 export, 8 start, 9 element, 12 datacount, 10 code, 11 data
    const sectionOrder = {1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,12:10,10:11,11:12};
    sections.sort((a, b) => (sectionOrder[a.id] ?? 99) - (sectionOrder[b.id] ?? 99));

    for (const s of sections) {
      const idBuf = encodeULEB128(s.id);
      const sizeBuf = encodeULEB128(s.data.length);
      sectionBufs.push(idBuf, sizeBuf, s.data);
    }

    return Buffer.concat(sectionBufs);
  }
}

// ============================================================
// 反汇编器 (Disassembler - WASM -> WAT)
// ============================================================
class Disassembler {
  constructor(buf, sourceMap = null) {
    this.buf = buf;
    this.offset = 0;
    this.sourceMap = sourceMap;
  }

  _u8() { return this.buf[this.offset++]; }
  _bytes(n) { const b = this.buf.slice(this.offset, this.offset + n); this.offset += n; return b; }
  _uleb() { const r = decodeULEB128(this.buf, this.offset); this.offset = r.offset; return r.value; }
  _sleb() { const r = decodeSLEB128(this.buf, this.offset); this.offset = r.offset; return r.value; }
  _name() { const len = this._uleb(); const s = this.buf.toString('utf8', this.offset, this.offset + len); this.offset += len; return s; }
  _vec(fn) { const n = this._uleb(); const arr = []; for (let i = 0; i < n; i++) arr.push(fn.call(this)); return arr; }

  disasm() {
    // header
    const magic = this._bytes(4);
    if (magic.toString('hex') !== '0061736d') throw new Error('Invalid WASM magic');
    const version = this._bytes(4);
    if (version.toString('hex') !== '01000000') throw new Error('Invalid WASM version');

    const ast = {
      types: [], imports: [], functions: [], tables: [], memories: [],
      globals: [], exports: [], start: null, elems: [], datas: []
    };
    const funcBodies = [];
    let funcImportCount = 0;

    while (this.offset < this.buf.length) {
      const secId = this._uleb();
      const secSize = this._uleb();
      const endOffset = this.offset + secSize;

      switch (secId) {
        case 0: this.offset = endOffset; break; // custom
        case 1: // Type
          ast.types = this._vec(() => {
            const form = this._uleb();
            if (form !== 0x60) throw new Error(`Invalid func type form: ${form}`);
            const params = this._vec(() => CODE_TYPE[this._u8()]);
            const results = this._vec(() => CODE_TYPE[this._u8()]);
            return { name: null, params, results };
          });
          break;
        case 2: // Import
          ast.imports = this._vec(() => {
            const mod = this._name();
            const nm = this._name();
            const dk = this._u8();
            let desc = null;
            if (dk === 0) {
              const ti = this._uleb();
              const t = ast.types[ti] || { params: [], results: [] };
              funcImportCount++;
              desc = { kind: 'func', params: [...t.params], results: [...t.results] };
            } else if (dk === 1) {
              const et = CODE_TYPE[this._u8()];
              const limits = this._parseLimits();
              desc = { kind: 'table', elemType: et, limits };
            } else if (dk === 2) {
              desc = { kind: 'memory', limits: this._parseLimits() };
            } else if (dk === 3) {
              const gt = CODE_TYPE[this._u8()];
              const mut = this._u8() === 0x01;
              desc = { kind: 'global', type: gt, mut };
            }
            return { module: mod, name: nm, desc };
          });
          break;
        case 3: // Function
          const typeIdxs = this._vec(() => this._uleb());
          for (const ti of typeIdxs) {
            const t = ast.types[ti] || { params: [], results: [] };
            ast.functions.push({
              name: null, params: [...t.params], paramNames: [],
              results: [...t.results], locals: [], localNames: [],
              instructions: [], typeIndex: ti
            });
          }
          break;
        case 4: // Table
          ast.tables = this._vec(() => {
            const et = CODE_TYPE[this._u8()];
            const limits = this._parseLimits();
            return { limits, elemType: et };
          });
          break;
        case 5: // Memory
          ast.memories = this._vec(() => ({ limits: this._parseLimits() }));
          break;
        case 6: // Global
          ast.globals = this._vec(() => {
            const t = CODE_TYPE[this._u8()];
            const mut = this._u8() === 0x01;
            const init = this._parseInstrs(true);
            return { type: t, mut, init };
          });
          break;
        case 7: // Export
          ast.exports = this._vec(() => {
            const nm = this._name();
            const dk = this._u8();
            const idx = this._uleb();
            const kindMap = { 0: 'func', 1: 'table', 2: 'memory', 3: 'global' };
            return { name: nm, desc: { kind: kindMap[dk], index: idx } };
          });
          break;
        case 8: // Start
          ast.start = { funcIndex: this._uleb() };
          break;
        case 9: // Element
          ast.elems = this._vec(() => {
            const flag = this._uleb();
            if (flag === 0) {
              const offset = this._parseInstrs(true);
              const funcs = this._vec(() => {
                const idx = this._uleb();
                return `$__func_${idx}`;
              });
              return { offset, funcs };
            }
            return { offset: [], funcs: [] };
          });
          break;
        case 10: // Code
          const bodies = this._vec(() => {
            const size = this._uleb();
            const endOffset = this.offset + size;
            const locals = [];
            const localGroups = this._uleb();
            for (let i = 0; i < localGroups; i++) {
              const cnt = this._uleb();
              const tp = CODE_TYPE[this._u8()];
              for (let j = 0; j < cnt; j++) locals.push(tp);
            }
            const localSectionSize = this.offset - (endOffset - size + 1);
            const instrs = this._parseInstrs(false, localSectionSize);
            this.offset = endOffset;
            return { locals, instructions: instrs };
          });
          for (let i = 0; i < bodies.length; i++) {
            if (ast.functions[i]) {
              ast.functions[i].locals = bodies[i].locals;
              ast.functions[i].instructions = bodies[i].instructions;
            }
          }
          break;
        case 11: // Data
          ast.datas = this._vec(() => {
            const flag = this._uleb();
            if (flag === 0) {
              const offset = this._parseInstrs(true);
              const len = this._uleb();
              const data = this._bytes(len).toString('binary');
              return { offset, data };
            }
            return { offset: [], data: '' };
          });
          break;
        case 12: // Data Count
          this._uleb();
          break;
        default:
          this.offset = endOffset;
      }
      this.offset = endOffset;
    }

    // 生成WAT文本
    return this._emitWat(ast);
  }

  _parseLimits() {
    const flags = this._u8();
    const min = this._uleb();
    const max = (flags & 0x01) ? this._uleb() : null;
    return { min, max };
  }

  _parseBlockType() {
    const b = this._u8();
    if (b === 0x40) return [];
    if (b in CODE_TYPE) return [CODE_TYPE[b]];
    // 其他情况：signed LEB for type index （多值）
    throw new Error(`Unsupported block type: 0x${b.toString(16)}`);
  }

  _parseInstrs(exprMode = false, codeOffsetBase = 0) {
    const root = [];
    const ctrlStack = [{ list: root, opcode: 'root', inElse: false }];
    const labelMap = {};
    let labelCounter = 0;
    let depth = exprMode ? 0 : 1;
    let currentCodeOffset = codeOffsetBase;

    const pushInstr = (instr) => {
      const top = ctrlStack[ctrlStack.length - 1];
      if (top.inElse && top.blockInstr) {
        top.blockInstr.args[3].push(instr);
      } else if (top.blockInstr) {
        top.blockInstr.args[2].push(instr);
      } else {
        top.list.push(instr);
      }
    };

    while (true) {
      const startOffset = this.offset;
      const opByte = this._u8();
      if (opByte === 0x0b) { // end
        depth--;
        if (depth < 0) break;
        if (ctrlStack.length > 1) {
          ctrlStack.pop();
        }
        if (depth === 0 && !exprMode) break;
        continue;
      }
      if (opByte === 0x05) { // else
        const top = ctrlStack[ctrlStack.length - 1];
        if (top.opcode === 'if') {
          top.inElse = true;
        }
        continue;
      }
      if (opByte === 0x02 || opByte === 0x03 || opByte === 0x04) { // block/loop/if
        depth++;
        const bt = this._parseBlockType();
        const labelName = `$L${labelCounter++}`;
        labelMap[ctrlStack.length] = labelName;
        const opName = OPCODE_MAP[opByte];
        const instr = { opcode: opName, args: [labelName, bt, [], []], block: true, codeOffset: currentCodeOffset };
        pushInstr(instr);
        const headerSize = this.offset - startOffset;
        currentCodeOffset += headerSize;
        ctrlStack.push({ list: null, opcode: opName, blockInstr: instr, inElse: false, baseOffset: currentCodeOffset });
        continue;
      }

      let opName = OPCODE_MAP[opByte];
      if (!opName) {
        throw new Error(`Unknown opcode: 0x${opByte.toString(16)}`);
      }

      const instr = { opcode: opName, args: [], codeOffset: currentCodeOffset };

      if (opName === 'call') {
        instr.args.push({ kind: 'NUMBER', value: String(this._uleb()) });
      } else if (opName === 'call_indirect') {
        const ti = this._uleb();
        const tab = this._uleb();
        instr.args.push({ kind: 'NUMBER', value: String(tab) });
        instr.args.push({ kind: 'NUMBER', value: String(ti) });
      } else if (opName === 'br' || opName === 'br_if') {
        const d = this._uleb();
        const targetDepth = ctrlStack.length - 1 - d;
        const lbl = labelMap[targetDepth] || String(d);
        instr.args.push({ kind: 'IDENTIFIER', value: lbl.startsWith('$') ? lbl : String(d) });
      } else if (opName === 'br_table') {
        const cnt = this._uleb();
        for (let i = 0; i < cnt; i++) {
          const d = this._uleb();
          instr.args.push({ kind: 'IDENTIFIER', value: String(d) });
        }
        const dd = this._uleb();
        instr.args.push({ kind: 'IDENTIFIER', value: String(dd) });
      } else if (opName.startsWith('local.') || opName.startsWith('global.')) {
        instr.args.push({ kind: 'NUMBER', value: String(this._uleb()) });
      } else if (opName === 'memory.size' || opName === 'memory.grow') {
        this._uleb();
      } else if (opName === 'i32.const') {
        const v = this._sleb();
        instr.args.push({ kind: 'NUMBER', value: String(v) });
      } else if (opName === 'i64.const') {
        const v = this._sleb();
        instr.args.push({ kind: 'NUMBER', value: String(v) });
      } else if (opName === 'f32.const') {
        const b = this._bytes(4);
        const v = b.readFloatLE(0);
        instr.args.push({ kind: 'NUMBER', value: String(v) });
      } else if (opName === 'f64.const') {
        const b = this._bytes(8);
        const v = b.readDoubleLE(0);
        instr.args.push({ kind: 'NUMBER', value: String(v) });
      } else {
        const memInstrs = new Set([
          'i32.load', 'i64.load', 'f32.load', 'f64.load',
          'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
          'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u',
          'i64.load32_s', 'i64.load32_u',
          'i32.store', 'i64.store', 'f32.store', 'f64.store',
          'i32.store8', 'i32.store16',
          'i64.store8', 'i64.store16', 'i64.store32'
        ]);
        if (memInstrs.has(opName)) {
          const alignLog = this._uleb();
          const offset = this._uleb();
          instr.memArg = { align: 1 << alignLog, offset };
        }
      }

      const instrSize = this.offset - startOffset;
      currentCodeOffset += instrSize;
      pushInstr(instr);
    }
    return root;
  }

  _emitWat(ast) {
    const lines = ['(module'];
    const indent = (n) => '  '.repeat(n);
    const funcIdx = buildFuncIndex(ast);

    const locMap = {};
    if (this.sourceMap && this.sourceMap.functions) {
      for (const func of this.sourceMap.functions) {
        locMap[func.index] = {};
        for (const instr of func.instructions) {
          if (instr.codeOffset !== undefined) {
            locMap[func.index][instr.codeOffset] = {
              funcName: func.name,
              line: instr.source?.line,
              col: instr.source?.col,
              ctrlPath: instr.ctrlPath
            };
          }
        }
      }
    }

    const formatLocComment = (funcIdx, codeOffset) => {
      if (!locMap[funcIdx]) return '';
      const loc = locMap[funcIdx][codeOffset];
      if (!loc) return '';
      const pathStr = loc.ctrlPath && loc.ctrlPath.length > 0
        ? ' [' + loc.ctrlPath.map(p => p.opcode + (p.label ? ':' + p.label : '') + (p.branch ? '/' + p.branch : '')).join(' > ') + ']'
        : '';
      return `  ;; ${loc.funcName} line ${loc.line}, col ${loc.col}${pathStr}`;
    };

    // 分配名称
    for (let i = 0; i < ast.functions.length; i++) {
      if (!ast.functions[i].name) ast.functions[i].name = `$f${i}`;
    }
    // 导出名称 -> 函数索引
    const expFuncNames = {};
    for (const e of ast.exports) {
      if (e.desc.kind === 'func') expFuncNames[e.desc.index] = e.name;
    }

    // Type section
    for (let i = 0; i < ast.types.length; i++) {
      const t = ast.types[i];
      let s = `${indent(1)}(type $T${i} (func`;
      if (t.params.length) s += ` (param ${t.params.join(' ')})`;
      if (t.results.length) s += ` (result ${t.results.join(' ')})`;
      s += '))';
      lines.push(s);
    }

    // Import
    for (const imp of ast.imports) {
      if (!imp.desc) continue;
      const d = imp.desc;
      if (d.kind === 'func') {
        let s = `${indent(1)}(import "${imp.module}" "${imp.name}" (func`;
        if (d.params.length) s += ` (param ${d.params.join(' ')})`;
        if (d.results.length) s += ` (result ${d.results.join(' ')})`;
        s += '))';
        lines.push(s);
      }
    }

    // Memory
    for (let i = 0; i < ast.memories.length; i++) {
      const m = ast.memories[i];
      let hasExport = false;
      for (const e of ast.exports) {
        if (e.desc.kind === 'memory' && e.desc.index === i) {
          lines.push(`${indent(1)}(memory (export "${e.name}") ${m.limits.min}${m.limits.max !== null ? ' ' + m.limits.max : ''})`);
          hasExport = true;
        }
      }
      if (!hasExport) {
        lines.push(`${indent(1)}(memory ${m.limits.min}${m.limits.max !== null ? ' ' + m.limits.max : ''})`);
      }
    }

    // Data
    for (const d of ast.datas) {
      let offset = 0;
      for (const ins of d.offset) {
        if (ins.opcode === 'i32.const' && ins.args.length > 0) offset = parseInt(ins.args[0].value);
      }
      // escape string
      const escaped = d.data.split('').map(ch => {
        const c = ch.charCodeAt(0);
        if (c >= 32 && c < 127 && c !== 34 && c !== 92) return ch;
        return '\\' + c.toString(16).padStart(2, '0');
      }).join('');
      lines.push(`${indent(1)}(data (i32.const ${offset}) "${escaped}")`);
    }

    // Global
    for (let i = 0; i < ast.globals.length; i++) {
      const g = ast.globals[i];
      let s = `${indent(1)}(global `;
      let hasExport = false;
      for (const e of ast.exports) {
        if (e.desc.kind === 'global' && e.desc.index === i) {
          s += `(export "${e.name}") `;
          hasExport = true;
        }
      }
      if (g.mut) s += `(mut ${g.type})`;
      else s += g.type;
      // init expr
      let init = ' (i32.const 0)';
      if (g.init.length > 0) {
        const gi = g.init[0];
        if (gi.opcode.endsWith('.const')) init = ` (${gi.opcode} ${gi.args[0]?.value || 0})`;
      }
      s += init + ')';
      lines.push(s);
    }

    // Start
    if (ast.start) {
      lines.push(`${indent(1)}(start ${ast.start.funcIndex})`);
    }

    // Elem
    for (const e of ast.elems) {
      let offset = 0;
      for (const ins of e.offset) {
        if (ins.opcode === 'i32.const') offset = parseInt(ins.args[0]?.value || 0);
      }
      lines.push(`${indent(1)}(elem (i32.const ${offset}) ${e.funcs.join(' ')})`);
    }

    // Functions
    for (let i = 0; i < ast.functions.length; i++) {
      const f = ast.functions[i];
      const fIdx = funcIdx.importCount + i;
      let s = `${indent(1)}(func ${f.name}`;
      if (expFuncNames[fIdx] !== undefined) {
        s += ` (export "${expFuncNames[fIdx]}")`;
      }
      // params
      for (let j = 0; j < f.params.length; j++) {
        s += ` (param $p${j} ${f.params[j]})`;
      }
      if (f.results.length) s += ` (result ${f.results.join(' ')})`;
      lines.push(s);
      // locals
      for (let j = 0; j < f.locals.length; j++) {
        lines.push(`${indent(2)}(local $l${j} ${f.locals[j]})`);
      }
      // instructions
      const realFuncIdx = funcIdx.importCount + i;
      const emitInstr = (ins, depth) => {
        if (ins.block) {
          const [lbl, res, body, elseB] = ins.args;
          let hdr = `${indent(depth)}(${ins.opcode}`;
          if (lbl) hdr += ` ${lbl}`;
          if (res.length) hdr += ` (result ${res.join(' ')})`;
          if (ins.codeOffset !== undefined) {
            hdr += formatLocComment(realFuncIdx, ins.codeOffset);
          }
          lines.push(hdr);
          for (const bi of body) emitInstr(bi, depth + 1);
          if (elseB && elseB.length > 0) {
            lines.push(`${indent(depth + 1)}(else`);
            for (const bi of elseB) emitInstr(bi, depth + 2);
            lines.push(`${indent(depth + 1)})`);
          }
          lines.push(`${indent(depth)})`);
          return;
        }
        if (ins.opcode === 'end' || ins.opcode === 'else' || ins.opcode === 'then') return;
        const argStr = ins.args.map(a => {
          if (a.kind === 'IDENTIFIER') return a.value;
          return a.value;
        }).join(' ');
        let memargStr = '';
        if (ins.memArg) {
          if (ins.memArg.offset) memargStr += ` offset=${ins.memArg.offset}`;
        }
        let line = `${indent(depth)}(${ins.opcode}${argStr ? ' ' + argStr : ''}${memargStr})`;
        if (ins.codeOffset !== undefined) {
          line += formatLocComment(realFuncIdx, ins.codeOffset);
        }
        lines.push(line);
      };
      for (const ins of f.instructions) emitInstr(ins, 2);
      lines.push(`${indent(1)})`);
    }

    // Export (非func的导出)
    for (const e of ast.exports) {
      if (e.desc.kind !== 'func' && e.desc.kind !== 'memory' && e.desc.kind !== 'global') {
        lines.push(`${indent(1)}(export "${e.name}" (${e.desc.kind} ${e.desc.index}))`);
      }
    }

    lines.push(')');
    return lines.join('\n');
  }
}

// ============================================================
// 信息展示 (Info Display)
// ============================================================
function countInstructions(instrs) {
  let count = 0;
  const freq = {};
  const walk = (ins) => {
    if (ins.opcode === 'end' || ins.opcode === 'else' || ins.opcode === 'then') return;
    count++;
    freq[ins.opcode] = (freq[ins.opcode] || 0) + 1;
    if (ins.block) {
      const [lbl, res, body, elseB] = ins.args;
      for (const bi of body) walk(bi);
      if (elseB) for (const bi of elseB) walk(bi);
    }
  };
  for (const ins of instrs) walk(ins);
  return { count, freq };
}

function showModule(ast) {
  const funcIdx = buildFuncIndex(ast);
  console.log('=== Module Structure ===');
  console.log(`\nTypes: ${ast.types.length}`);
  for (let i = 0; i < ast.types.length; i++) {
    const t = ast.types[i];
    console.log(`  [${i}] (${t.name || 'anon'}) (${t.params.join(' ')}${t.params.length?' -> ':''}${t.results.join(' ')})`);
  }
  console.log(`\nImports: ${ast.imports.length}`);
  for (const imp of ast.imports) {
    if (imp.desc?.kind === 'func') {
      console.log(`  func ${imp.module}.${imp.name} (${imp.desc.params.join(' ')} -> ${imp.desc.results.join(' ')})`);
    } else if (imp.desc) {
      console.log(`  ${imp.desc.kind} ${imp.module}.${imp.name}`);
    }
  }
  console.log(`\nFunctions: ${ast.functions.length}`);
  for (let i = 0; i < ast.functions.length; i++) {
    const f = ast.functions[i];
    const realIdx = funcIdx.importCount + i;
    const st = countInstructions(f.instructions);
    console.log(`  [${realIdx}] ${f.name || 'anon'} ` +
      `(param: ${f.params.length}, result: ${f.results.length}, local: ${f.locals.length}, instr: ${st.count})`);
  }
  console.log(`\nTables: ${ast.tables.length}`);
  for (let i = 0; i < ast.tables.length; i++) {
    const t = ast.tables[i];
    console.log(`  [${i}] ${t.name || 'anon'} ${t.elemType} [${t.limits.min}${t.limits.max?'-'+t.limits.max:''}]`);
  }
  console.log(`\nMemories: ${ast.memories.length}`);
  for (let i = 0; i < ast.memories.length; i++) {
    const m = ast.memories[i];
    console.log(`  [${i}] ${m.name || 'anon'} [${m.limits.min}${m.limits.max?'-'+m.limits.max:''}] pages`);
  }
  console.log(`\nGlobals: ${ast.globals.length}`);
  for (let i = 0; i < ast.globals.length; i++) {
    const g = ast.globals[i];
    console.log(`  [${i}] ${g.name || 'anon'} ${g.mut?'mut ':''}${g.type}`);
  }
  console.log(`\nExports: ${ast.exports.length}`);
  for (const e of ast.exports) {
    let idx = e.desc.index;
    if (e.desc.name) {
      if (e.desc.kind === 'func') {
        idx = funcIdx.names[e.desc.name];
      }
    }
    console.log(`  "${e.name}" -> ${e.desc.kind}[${idx}]`);
  }
  if (ast.start) console.log(`\nStart function: ${ast.start.funcName || ast.start.funcIndex}`);

  // 统计
  let totalInstr = 0;
  const totalFreq = {};
  for (const f of ast.functions) {
    const st = countInstructions(f.instructions);
    totalInstr += st.count;
    for (const [k, v] of Object.entries(st.freq)) {
      totalFreq[k] = (totalFreq[k] || 0) + v;
    }
  }
  console.log(`\n=== Statistics ===`);
  console.log(`Total functions: ${funcIdx.total}`);
  console.log(`Imported functions: ${funcIdx.importCount}`);
  console.log(`Defined functions: ${ast.functions.length}`);
  console.log(`Total instructions: ${totalInstr}`);
  console.log(`\nInstruction frequency (top 15):`);
  const sorted = Object.entries(totalFreq).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [k, v] of sorted) {
    console.log(`  ${k}: ${v}`);
  }
}

function formatInstrArgs(ins) {
  return ins.args.map(a => {
    if (a.kind === 'IDENTIFIER') return a.value;
    return a.value;
  }).join(' ');
}

function generateSourceMap(ast, sourceFile) {
  const funcIdx = buildFuncIndex(ast);
  const map = {
    version: 1,
    sourceFile: path.basename(sourceFile),
    generatedAt: new Date().toISOString(),
    functions: []
  };

  function flattenInstructions(instrs) {
    const flat = [];
    for (const ins of instrs) {
      if (ins.opcode === 'end' || ins.opcode === 'else' || ins.opcode === 'then') continue;
      flat.push(ins);
      if (ins.block) {
        const [lbl, res, body, elseB] = ins.args;
        if (Array.isArray(body)) flat.push(...flattenInstructions(body));
        if (Array.isArray(elseB)) flat.push(...flattenInstructions(elseB));
      }
    }
    return flat;
  }

  for (let i = 0; i < ast.functions.length; i++) {
    const f = ast.functions[i];
    const realIdx = funcIdx.importCount + i;
    const allInstrs = flattenInstructions(f.instructions);

    const funcEntry = {
      name: f.name || `$func_${realIdx}`,
      index: realIdx,
      instrCount: f.instrCount || 0,
      sourceRange: {
        startLine: f.loc.startLine,
        startCol: f.loc.startCol,
        endLine: f.loc.endLine,
        endCol: f.loc.endCol
      },
      params: f.params.map((t, j) => ({
        name: f.paramNames[j] || `$p${j}`,
        index: j,
        type: t
      })),
      locals: f.locals.map((t, j) => ({
        name: f.localNames[j] || `$l${j}`,
        index: f.params.length + j,
        type: t
      })),
      instructions: []
    };

    for (let j = 0; j < allInstrs.length; j++) {
      const ins = allInstrs[j];
      const simpleArgs = [];
      if (!ins.block) {
        for (const a of ins.args) {
          if (a && typeof a === 'object' && a.kind !== undefined) {
            simpleArgs.push({ kind: a.kind, value: a.value });
          }
        }
      } else {
        const [lbl, res, body, elseB] = ins.args;
        if (lbl) simpleArgs.push({ kind: 'IDENTIFIER', value: lbl });
        if (res && res.length > 0) {
          for (const r of res) {
            simpleArgs.push({ kind: 'KEYWORD', value: r });
          }
        }
      }
      const instrEntry = {
        index: ins.index !== undefined ? ins.index : j,
        opcode: ins.opcode,
        args: simpleArgs,
        source: {
          line: ins.loc?.line,
          col: ins.loc?.col
        },
        ctrlPath: ins.ctrlPath ? ins.ctrlPath.map(p => ({
          opcode: p.opcode,
          label: p.label,
          branch: p.branch
        })) : []
      };
      if (ins.memArg && (ins.memArg.offset !== 0 || ins.memArg.align !== null)) {
        instrEntry.memArg = {
          offset: ins.memArg.offset,
          align: ins.memArg.align
        };
      }
      funcEntry.instructions.push(instrEntry);
    }

    map.functions.push(funcEntry);
  }

  return map;
}

function showFunc(ast, nameOrIdx) {
  const funcIdx = buildFuncIndex(ast);
  let fi = -1;
  if (nameOrIdx.startsWith('$')) {
    fi = funcIdx.names[nameOrIdx] ?? -1;
  } else if (/^-?\d+$/.test(nameOrIdx)) {
    fi = parseInt(nameOrIdx);
  } else {
    // 尝试加上$查找
    const withDollar = '$' + nameOrIdx;
    if (withDollar in funcIdx.names) {
      fi = funcIdx.names[withDollar];
    }
  }
  let f = null, realIdx = fi;
  if (fi >= 0 && fi < funcIdx.importCount) {
    // import function
    const imp = ast.imports.filter(i => i.desc?.kind === 'func')[fi];
    if (!imp) { console.log('Function not found'); return; }
    console.log(`=== Import Function [${fi}] ${imp.module}.${imp.name} ===`);
    console.log(`Signature: (${imp.desc.params.join(' ')}) -> (${imp.desc.results.join(' ')})`);
    return;
  }
  if (fi >= funcIdx.importCount) {
    f = ast.functions[fi - funcIdx.importCount];
  }
  if (!f) { console.log(`Function '${nameOrIdx}' not found`); return; }

  console.log(`=== Function [${realIdx}] ${f.name || 'anon'} ===`);
  console.log(`Signature: (${f.params.join(' ')}) -> (${f.results.join(' ')})`);
  console.log(`\nParams (${f.params.length}):`);
  for (let i = 0; i < f.params.length; i++) {
    console.log(`  [${i}] ${f.paramNames[i] || `p${i}`}: ${f.params[i]}`);
  }
  console.log(`\nLocals (${f.locals.length}):`);
  for (let i = 0; i < f.locals.length; i++) {
    console.log(`  [${f.params.length + i}] ${f.localNames[i] || `l${i}`}: ${f.locals[i]}`);
  }
  console.log(`\nInstructions:`);
  const emit = (ins, d) => {
    const prefix = '  '.repeat(d + 1);
    if (ins.opcode === 'end' || ins.opcode === 'else' || ins.opcode === 'then') return;
    if (ins.block) {
      const [lbl, res, body, elseB] = ins.args;
      let h = `${prefix}(${ins.opcode}`;
      if (lbl) h += ` ${lbl}`;
      if (res.length) h += ` (result ${res.join(' ')})`;
      console.log(h);
      for (const bi of body) emit(bi, d + 1);
      if (elseB && elseB.length > 0) {
        console.log(`${prefix}  (else`);
        for (const bi of elseB) emit(bi, d + 2);
        console.log(`${prefix}  )`);
      }
      console.log(`${prefix})`);
      return;
    }
    let mem = '';
    if (ins.memArg) {
      if (ins.memArg.offset) mem += ` offset=${ins.memArg.offset}`;
    }
    console.log(`${prefix}(${ins.opcode}${formatInstrArgs(ins) ? ' ' + formatInstrArgs(ins) : ''}${mem})`);
  };
  for (const ins of f.instructions) emit(ins, 0);
}

// ============================================================
// CLI 入口
// ============================================================
function parseWatFile(filepath) {
  const src = fs.readFileSync(filepath, 'utf8');
  const tokens = tokenize(src);
  const parser = new Parser(tokens);
  return parser.parseModule();
}

function usage() {
  console.log(`
WAT Parser / Validator / Compiler / Disassembler

Usage:
  node watparser.js parse <MODULE.wat>                     Tokenize and parse WAT file
  node watparser.js validate <MODULE.wat>                  Validate type correctness (stack checking)
  node watparser.js compile <MODULE.wat> -o <out>          Compile WAT to WASM binary
  node watparser.js compile <MODULE.wat> -o <out> --debug-map <map.json>
                                                            Compile with debug map (code offset → source)
  node watparser.js disasm <INPUT.wasm>                    Disassemble WASM to WAT text
  node watparser.js disasm <INPUT.wasm> --with-loc <map.json>
                                                            Disassemble with source location annotations
  node watparser.js sourcemap <MODULE.wat> -o <map.json>   Export source map to JSON
  node watparser.js module <MODULE.wat>                    Show module structure
  node watparser.js func <name|idx> <MODULE.wat>           Show function details

Debug commands:
  node watparser.js tokens <MODULE.wat>                    Show tokens (lexer output)
  node watparser.js test <MODULE.wat>                      Compile+load+test via Node.js
  node watparser.js roundtrip <MODULE.wat>                 Compile → disasm → recompile verification

Examples:
  node watparser.js parse examples/add.wat
  node watparser.js validate examples/factorial.wat
  node watparser.js compile examples/add.wat -o add.wasm
  node watparser.js sourcemap examples/debug.wat -o map.json
  node watparser.js compile examples/debug.wat -o debug.wasm --debug-map map.json
  node watparser.js disasm debug.wasm --with-loc map.json
`);
  process.exit(1);
}

async function testWat(filepath) {
  const ast = parseWatFile(filepath);
  const val = new Validator(ast);
  const errs = val.validate();
  if (errs.length) {
    console.log('Validation errors:');
    for (const e of errs) console.log('  - ' + e);
    return;
  }
  console.log('Validation: OK');
  const comp = new Compiler(ast);
  const buf = comp.compile();
  const mod = await WebAssembly.compile(buf);
  console.log('WASM compilation: OK');
  const inst = await WebAssembly.instantiate(mod, {});
  console.log('WASM instantiation: OK');

  // 尝试调用函数
  const base = path.basename(filepath, '.wat');
  if (base === 'add') {
    const tests = [[3, 4], [10, 20], [100, 5]];
    console.log('\nTest add(a, b):');
    for (const [a, b] of tests) {
      const r = inst.exports.add(a, b);
      console.log(`  add(${a}, ${b}) = ${r} ${r === a + b ? '✓' : '✗ (expected ' + (a+b) + ')'}`);
      const s = inst.exports.sub(a, b);
      console.log(`  sub(${a}, ${b}) = ${s} ${s === a - b ? '✓' : '✗ (expected ' + (a-b) + ')'}`);
      const m = inst.exports.mul(a, b);
      console.log(`  mul(${a}, ${b}) = ${m} ${m === a * b ? '✓' : '✗ (expected ' + (a*b) + ')'}`);
    }
  } else if (base === 'factorial') {
    const tests = [0, 1, 5, 10];
    function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
    console.log('\nTest factorial(n):');
    for (const n of tests) {
      const r = inst.exports.factorial(n);
      console.log(`  factorial(${n}) = ${r} ${r === fact(n) ? '✓' : '✗ (expected ' + fact(n) + ')'}`);
    }
    function fib(n) {
      if (n < 2) return n;
      let a = 0, b = 1;
      for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; }
      return a;
    }
    console.log('\nTest fib(n):');
    for (const n of [0, 1, 5, 10]) {
      const r = inst.exports.fib(n);
      console.log(`  fib(${n}) = ${r} ${r === fib(n) ? '✓' : '✗ (expected ' + fib(n) + ')'}`);
    }
  } else if (base === 'stringops') {
    const mem = new Uint8Array(inst.exports.memory.buffer);
    const data = 'Hello, World!\0';
    for (let i = 0; i < data.length; i++) mem[i] = data.charCodeAt(i);
    console.log('\nTest strlen:');
    const len = inst.exports.strlen(0);
    console.log(`  strlen("Hello, World!") = ${len} ${len === 13 ? '✓' : '✗ (expected 13)'}`);
    console.log('\nTest to_upper:');
    inst.exports.to_upper(0, 13);
    let result = '';
    for (let i = 0; i < 13; i++) result += String.fromCharCode(mem[i]);
    console.log(`  to_upper: "${result}" ${result === 'HELLO, WORLD!' ? '✓' : '✗ (expected "HELLO, WORLD!")'}`);
  } else {
    console.log('\nAvailable exports:', Object.keys(inst.exports));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const cmd = args[0];
  try {
    switch (cmd) {
      case 'tokens': {
        if (args.length < 2) usage();
        const src = fs.readFileSync(args[1], 'utf8');
        const toks = tokenize(src);
        for (const t of toks) {
          if (t.type === 'EOF') break;
          const v = t.type === 'STRING' ? JSON.stringify(t.value) : t.value;
          console.log(`${String(t.line).padStart(3)}:${String(t.col).padStart(2)} ${t.type.padEnd(12)} ${v}`);
        }
        console.log(`\nTotal tokens: ${toks.length - 1}`);
        break;
      }
      case 'sourcemap': {
        if (args.length < 2) usage();
        let outPath = 'map.json';
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '-o' && args[i + 1]) { outPath = args[i + 1]; i++; }
        }
        const ast = parseWatFile(args[1]);
        const map = generateSourceMap(ast, args[1]);
        const jsonStr = JSON.stringify(map, null, 2);
        fs.writeFileSync(outPath, jsonStr);
        try {
          JSON.parse(jsonStr);
          console.log(`✓ Source map exported: ${outPath}`);
          console.log(`  Functions: ${map.functions.length}`);
          let totalInstr = 0;
          for (const f of map.functions) {
            totalInstr += f.instructions.length;
            console.log(`    ${f.name}: ${f.instructions.length} instructions`);
          }
          console.log(`  Total instructions: ${totalInstr}`);
          console.log(`  JSON validated: can be parsed by json.tool`);
        } catch (e) {
          console.error(`✗ Generated JSON is invalid: ${e.message}`);
          process.exitCode = 1;
        }
        break;
      }
      case 'parse': {
        if (args.length < 2) usage();
        const src = fs.readFileSync(args[1], 'utf8');
        const toks = tokenize(src);
        const ast = parseWatFile(args[1]);
        console.log(`✓ Parsed successfully: ${args[1]}`);
        console.log(`  Tokens: ${toks.length - 1}`);
        console.log(`  Types: ${ast.types.length}`);
        console.log(`  Functions: ${ast.functions.length}`);
        console.log(`  Imports: ${ast.imports.length}`);
        console.log(`  Exports: ${ast.exports.length}`);
        console.log(`  Memories: ${ast.memories.length}`);
        console.log(`  Tables: ${ast.tables.length}`);
        console.log(`  Globals: ${ast.globals.length}`);
        if (ast.start !== undefined && ast.start !== null) console.log(`  Start function: func[${ast.start}]`);
        if (ast.datas) console.log(`  Data segments: ${ast.datas.length}`);
        if (ast.functions.length > 0) {
          const funcIdx = buildFuncIndex(ast);
          console.log(`\n  Functions details:`);
          for (let i = 0; i < ast.functions.length; i++) {
            const f = ast.functions[i];
            const realIdx = funcIdx.importCount + i;
            const srcRange = f.loc.startLine !== null ?
              `lines ${f.loc.startLine}-${f.loc.endLine}` : 'unknown';
            console.log(`    [${realIdx}] ${f.name || 'anon'}: ${f.instrCount || 0} instructions, ${srcRange}`);
          }
        }
        break;
      }
      case 'module': {
        if (args.length < 2) usage();
        const ast = parseWatFile(args[1]);
        showModule(ast);
        break;
      }
      case 'func': {
        if (args.length < 3) usage();
        const ast = parseWatFile(args[2]);
        showFunc(ast, args[1]);
        break;
      }
      case 'validate': {
        if (args.length < 2) usage();
        const ast = parseWatFile(args[1]);
        const val = new Validator(ast);
        const errs = val.validate();
        if (errs.length) {
          console.log(`Validation FAILED (${errs.length} error(s)):`);
          for (const e of errs) console.log('  ✗ ' + e);
          process.exitCode = 1;
        } else {
          console.log('✓ Validation passed! No type errors found.');
        }
        break;
      }
      case 'compile': {
        if (args.length < 2) usage();
        let outPath = 'out.wasm';
        let debugMapPath = null;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '-o' && args[i + 1]) { outPath = args[i + 1]; i++; }
          else if (args[i] === '--debug-map' && args[i + 1]) { debugMapPath = args[i + 1]; i++; }
        }
        const ast = parseWatFile(args[1]);
        const val = new Validator(ast);
        const errs = val.validate();
        if (errs.length) {
          console.log(`Cannot compile: validation failed (${errs.length} error(s)):`);
          for (const e of errs) console.log('  ✗ ' + e);
          process.exitCode = 1;
          return;
        }
        const comp = new Compiler(ast);
        const buf = comp.compile(!!debugMapPath);
        fs.writeFileSync(outPath, buf);
        console.log(`✓ Compiled successfully: ${outPath} (${buf.length} bytes)`);

        if (debugMapPath && comp.debugInfo) {
          let existingMap = null;
          try {
            if (fs.existsSync(debugMapPath)) {
              const mapContent = fs.readFileSync(debugMapPath, 'utf8');
              existingMap = JSON.parse(mapContent);
            }
          } catch (e) {
            console.log(`  Note: Could not read existing map file, creating new one`);
          }

          if (!existingMap) {
            existingMap = generateSourceMap(ast, args[1]);
          }

          for (const func of existingMap.functions) {
            const debugFunc = comp.debugInfo.functions[func.index];
            if (debugFunc && debugFunc.codeOffsets) {
              const offsetMap = {};
              for (const off of debugFunc.codeOffsets) {
                offsetMap[off.instrIndex] = {
                  codeOffset: off.codeOffset,
                  size: off.size
                };
              }
              for (const instr of func.instructions) {
                const off = offsetMap[instr.index];
                if (off) {
                  instr.codeOffset = off.codeOffset;
                  instr.codeSize = off.size;
                }
              }
            }
          }

          const jsonStr = JSON.stringify(existingMap, null, 2);
          fs.writeFileSync(debugMapPath, jsonStr);
          console.log(`✓ Debug map updated with code offsets: ${debugMapPath}`);
          try {
            JSON.parse(jsonStr);
            console.log(`  JSON validated: can be parsed by json.tool`);
          } catch (e) {
            console.error(`  ✗ JSON validation failed: ${e.message}`);
          }
        }

        try {
          const mod = await WebAssembly.compile(buf);
          console.log('✓ Generated WASM can be loaded by WebAssembly.compile()');
          const exps = WebAssembly.Module.exports(mod);
          console.log(`  Exports: ${exps.map(e => `${e.kind}:${e.name}`).join(', ')}`);
        } catch (e) {
          console.log(`✗ WebAssembly.compile() failed: ${e.message}`);
        }
        break;
      }
      case 'disasm': {
        if (args.length < 2) usage();
        let locMapPath = null;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--with-loc' && args[i + 1]) { locMapPath = args[i + 1]; i++; }
        }
        const buf = fs.readFileSync(args[1]);
        let sourceMap = null;
        if (locMapPath) {
          try {
            const mapContent = fs.readFileSync(locMapPath, 'utf8');
            sourceMap = JSON.parse(mapContent);
            console.log(`✓ Loaded source map: ${locMapPath}`);
          } catch (e) {
            console.error(`✗ Could not load source map: ${e.message}`);
            process.exitCode = 1;
          }
        }
        const d = new Disassembler(buf, sourceMap);
        const wat = d.disasm();
        console.log(wat);
        break;
      }
      case 'test': {
        if (args.length < 2) usage();
        await testWat(args[1]);
        break;
      }
      case 'roundtrip': {
        if (args.length < 2) usage();
        const srcWat = fs.readFileSync(args[1], 'utf8');
        const ast1 = parseWatFile(args[1]);
        const comp1 = new Compiler(ast1);
        const buf1 = comp1.compile();
        console.log(`✓ Compiled original WAT → ${buf1.length} bytes`);

        const d = new Disassembler(buf1);
        const outWat = d.disasm();
        console.log('✓ Disassembled WASM → WAT');

        const tmpPath = '/tmp/_roundtrip_.wat';
        fs.writeFileSync(tmpPath, outWat);
        const ast2 = parseWatFile(tmpPath);
        const comp2 = new Compiler(ast2);
        const buf2 = comp2.compile();
        fs.unlinkSync(tmpPath);
        console.log(`✓ Re-compiled roundtrip WAT → ${buf2.length} bytes`);

        console.log('\n=== Original WAT ===');
        console.log(srcWat);
        console.log('\n=== Roundtrip WAT (compile → disasm) ===');
        console.log(outWat);

        console.log('\n=== Verifying roundtrip ===');
        try {
          const m1 = await WebAssembly.compile(buf1);
          const m2 = await WebAssembly.compile(buf2);
          const exp1 = WebAssembly.Module.exports(m1);
          const exp2 = WebAssembly.Module.exports(m2);
          const namesMatch = exp1.map(e => e.name).join(',') === exp2.map(e => e.name).join(',');
          const kindsMatch = exp1.map(e => e.kind).join(',') === exp2.map(e => e.kind).join(',');
          if (namesMatch && kindsMatch) {
            console.log('✓ Both WASM modules load and have matching exports.');
          } else {
            console.log(`✗ Export mismatch: original=[${exp1.map(e=>e.kind+':'+e.name).join(',')}] roundtrip=[${exp2.map(e=>e.kind+':'+e.name).join(',')}]`);
          }
        } catch (e) {
          console.log(`✗ ${e.message}`);
        }
        break;
      }
      case '-h':
      case '--help':
      case 'help':
        usage();
        break;
      default:
        console.log(`Unknown command: ${cmd}`);
        usage();
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (e.stack && process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e); process.exit(1); });

