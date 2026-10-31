'use strict';
const MAX_RATIONAL=2147483647;
function gcd(a,b){while(b){const remainder=a%b;a=b;b=remainder;}return a;}
function fpsArgument(fps){
  if(typeof fps!=='number'||!Number.isFinite(fps)||fps<1||fps>120)throw new Error('Invalid fps: expected a finite number from 1 to 120');
  if(Number.isInteger(fps))return String(fps);
  // Preserve the actual chosen rate: decimal 29.97 is 2997/100, while
  // 30000/1001 is a different number. Do not silently reinterpret NTSC labels.
  const [whole,fraction]=String(fps).split('.');
  const numerator=BigInt(whole+fraction),denominator=10n**BigInt(fraction.length);
  const divisor=gcd(numerator,denominator),num=numerator/divisor,den=denominator/divisor;
  if(num<=BigInt(MAX_RATIONAL)&&den<=BigInt(MAX_RATIONAL))return num+'/'+den;
  // Doubles such as 30000/1001 have long decimal expansions. Recover a bounded
  // continued-fraction convergent within floating-point roundoff, never changing
  // the rate to a nearby preset or emitting FFmpeg's out-of-range rationals.
  let value=fps,previousNum=0,currentNum=1,previousDen=1,currentDen=0;
  for(let step=0;step<64;step++){
    const coefficient=Math.floor(value);
    if(!Number.isSafeInteger(coefficient)||
      currentNum&&coefficient>Math.floor((MAX_RATIONAL-previousNum)/currentNum)||
      currentDen&&coefficient>Math.floor((MAX_RATIONAL-previousDen)/currentDen))break;
    const nextNum=coefficient*currentNum+previousNum,nextDen=coefficient*currentDen+previousDen;
    if(nextDen>1&&Math.abs(nextNum/nextDen-fps)<=Number.EPSILON*fps*2)return nextNum+'/'+nextDen;
    [previousNum,currentNum]=[currentNum,nextNum];[previousDen,currentDen]=[currentDen,nextDen];
    const remainder=value-coefficient;if(remainder===0)break;value=1/remainder;
  }
  throw new Error('Invalid fps: frame rate cannot be represented accurately within FFmpeg rational limits');
}
module.exports={fpsArgument};
