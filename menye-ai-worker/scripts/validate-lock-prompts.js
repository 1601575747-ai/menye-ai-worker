'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'src', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

const requiredPhrases = [
  '不能在锁体外的门板上额外重复生成独立圆孔',
  '不能在门板上额外重复画一个独立圆孔',
  '不能在新锁下方或门板空白处额外重复画独立圆孔',
  '不能在新锁外的门板空白处额外重复生成',
  '不能在新锁下方、旁边门板空白处或错误门扇上额外重复生成独立圆孔',
  '不能在锁体外门板空白处重复生成第二个独立圆孔'
];

const forbiddenPatterns = [
  /小圆孔[^'\n]*应放在参考图对应的门扇\/中缝附近独立位置/,
  /小圆孔[^'\n]*应位于门扇\/中缝附近的独立位置/,
  /小圆孔作为独立实体应急锁孔/,
  /小圆孔是独立实体应急锁孔，不能放在把手或黑色智能面板上/
];

for (const phrase of requiredPhrases) {
  assert(
    source.includes(phrase),
    `missing lock round-hole prompt guard: ${phrase}`
  );
}

for (const pattern of forbiddenPatterns) {
  assert(
    !pattern.test(source),
    `forbidden lock round-hole prompt remains: ${pattern}`
  );
}

console.log('lock prompt validation passed');
