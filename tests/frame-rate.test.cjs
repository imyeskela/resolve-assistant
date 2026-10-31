'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fpsArgument}=require('../lib/frame-rate.cjs');

test('frame-rate arguments preserve integer and decimal rates without NTSC snapping',()=>{
  for(const [fps,expected]of [[1,'1'],[24,'24'],[120,'120'],[29.97,'2997/100'],[23.976,'2997/125'],[59.94,'2997/50'],[37.5,'75/2'],[7.125,'57/8'],[29.9701,'299701/10000']])assert.equal(fpsArgument(fps),expected);
});

test('frame-rate arguments recover exact fractional NTSC and other rational numbers',()=>{
  for(const [numerator,denominator]of [[24000,1001],[30000,1001],[60000,1001],[120000,1001],[7,3],[100,7]])assert.equal(fpsArgument(numerator/denominator),numerator+'/'+denominator);
});

test('frame-rate arguments stay within FFmpeg signed rational limits and retain precision',()=>{
  for(const fps of [Math.PI,Math.sqrt(2),29.123456789,119.123456789,37.1234567890123]){
    const argument=fpsArgument(fps);assert.match(argument,/^\d+\/\d+$/);
    const [numerator,denominator]=argument.split('/').map(Number);
    assert.ok(Number.isInteger(numerator)&&numerator>0&&numerator<=2147483647);
    assert.ok(Number.isInteger(denominator)&&denominator>0&&denominator<=2147483647);
    assert.ok(Math.abs(numerator/denominator-fps)<=Number.EPSILON*fps*2,argument+' preserves '+fps);
  }
});

test('frame-rate arguments reject invalid or unrepresentable inputs before launching tools',()=>{
  for(const fps of [undefined,null,'29.97',NaN,Infinity,-Infinity,0,-30,0.99,120.01,{},1+Number.EPSILON])assert.throws(()=>fpsArgument(fps),/fps|frame rate/i,String(fps));
});
