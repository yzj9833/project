/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type TypeOfMode = number;

export const NoMode = /*                         */ 0b0000000;//  没有任何特性
// TODO: Remove ConcurrentMode by reading from the root tag instead
export const ConcurrentMode = /*                 */ 0b0000001;//  并发
export const ProfileMode = /*                    */ 0b0000010;//  性能分析
export const DebugTracingMode = /*               */ 0b0000100;//  调试模式
export const StrictLegacyMode = /*               */ 0b0001000;//  严格模式
export const StrictEffectsMode = /*              */ 0b0010000;// 严格副作用
export const NoStrictPassiveEffectsMode = /*     */ 0b1000000;//  禁用严格模式下的被动效果检查
