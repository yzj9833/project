/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import ReactVersion from 'shared/ReactVersion';

import type {ReactNodeList} from 'shared/ReactTypes';

import {
  createRequest,
  startWork,
  startFlowing,
  abort,
} from 'react-server/src/ReactFizzServer';

import {
  createResumableState,
  createRenderState,
  createRootFormatContext,
} from 'react-dom-bindings/src/server/ReactFizzConfigDOMLegacy';

type ServerOptions = {
  identifierPrefix?: string,
};

function onError() {
  // Non-fatal errors are ignored.
}

function renderToStringImpl(
  children: ReactNodeList,//  待渲染的React节点
  options: void | ServerOptions,
  generateStaticMarkup: boolean,//  是否生成静态资源的标识。 renderToString:false, renderToStaticMarkup:true
  abortReason: string,//  中止渲染时的错误信息
): string {
  let didFatal = false;// 是否失败
  let fatalError = null;// 错误error
  let result = '';//  最终的html结果
  //  创建一个目标对象。支持push、destroy
  const destination = {
    //  生成的html字段追加到result
    push(chunk) {
      if (chunk !== null) {
        result += chunk;
      }
      return true;
    },
    //  设置错误状态
    destroy(error) {
      didFatal = true;
      fatalError = error;
    },
  };

  let readyToStream = false;//  基本框架是否准备好了。流式ssr中此时可以传输给客户端了
  function onShellReady() {
    readyToStream = true;
  }
  //  一个可恢复状态的对象。跟踪渲染状态。
  const resumableState = createResumableState(
    options ? options.identifierPrefix : undefined,
    undefined,
  );
  //  创建一个状态容器。追踪所有进行中的渲染任务 RequestInstance。后续所有操作都是围绕它
  //  同时创建一个根段容器，输出内容会输出到这个根段中
  const request = createRequest(
    children,
    resumableState,
    createRenderState(resumableState, generateStaticMarkup),//  对resumableState进行一些处理
    createRootFormatContext(),
    Infinity,//无限时间
    onError,
    undefined,
    onShellReady,
    undefined,
    undefined,
    undefined,
  );
  //  启动任务
  //  实际执行performWork进行处理
  startWork(request);

  //  处理suspense的挂起。将挂起的suspense组件标记为客户端渲染。
  abort(request, abortReason);

  //  开始流式传输内容。建立输出目标
  startFlowing(request, destination);
  if (didFatal && fatalError !== abortReason) {
    throw fatalError;
  }

  if (!readyToStream) {
    // Note: This error message is the one we use on the client. It doesn't
    // really make sense here. But this is the legacy server renderer, anyway.
    // We're going to delete it soon.
    throw new Error(
      'A component suspended while responding to synchronous input. This ' +
        'will cause the UI to be replaced with a loading indicator. To fix, ' +
        'updates that suspend should be wrapped with startTransition.',
    );
  }
// 返回完整的html字符串
  return result;
}

export {renderToStringImpl, ReactVersion as version};
