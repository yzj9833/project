/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Destination,
  Chunk,
  PrecomputedChunk,
} from './ReactServerStreamConfig';
import type {
  ReactNodeList,
  ReactContext,
  ReactConsumerType,
  OffscreenMode,
  Wakeable,
  Thenable,
  ReactFormState,
  ReactComponentInfo,
  ReactDebugInfo,
} from 'shared/ReactTypes';
import type {LazyComponent as LazyComponentType} from 'react/src/ReactLazy';
import type {
  RenderState,
  ResumableState,
  FormatContext,
  HoistableState,
} from './ReactFizzConfig';
import type {ContextSnapshot} from './ReactFizzNewContext';
import type {ComponentStackNode} from './ReactFizzComponentStack';
import type {TreeContext} from './ReactFizzTreeContext';
import type {ThenableState} from './ReactFizzThenable';
import {describeObjectForErrorMessage} from 'shared/ReactSerializationErrors';

import {
  scheduleWork,
  scheduleMicrotask,
  beginWriting,
  writeChunk,
  writeChunkAndReturn,
  completeWriting,
  flushBuffered,
  close,
  closeWithError,
} from './ReactServerStreamConfig';
import {
  writeCompletedRoot,
  writePlaceholder,
  writeStartCompletedSuspenseBoundary,
  writeStartPendingSuspenseBoundary,
  writeStartClientRenderedSuspenseBoundary,
  writeEndCompletedSuspenseBoundary,
  writeEndPendingSuspenseBoundary,
  writeEndClientRenderedSuspenseBoundary,
  writeStartSegment,
  writeEndSegment,
  writeClientRenderBoundaryInstruction,
  writeCompletedBoundaryInstruction,
  writeCompletedSegmentInstruction,
  writeHoistablesForBoundary,
  pushTextInstance,
  pushStartInstance,
  pushEndInstance,
  pushStartCompletedSuspenseBoundary,
  pushEndCompletedSuspenseBoundary,
  pushSegmentFinale,
  getChildFormatContext,
  writeHoistables,
  writePreamble,
  writePostamble,
  hoistHoistables,
  createHoistableState,
  supportsRequestStorage,
  requestStorage,
  pushFormStateMarkerIsMatching,
  pushFormStateMarkerIsNotMatching,
  resetResumableState,
  completeResumableState,
  emitEarlyPreloads,
  bindToConsole,
} from './ReactFizzConfig';
import {
  constructClassInstance,
  mountClassInstance,
} from './ReactFizzClassComponent';
import {
  getMaskedContext,
  processChildContext,
  emptyContextObject,
} from './ReactFizzContext';
import {
  readContext,
  rootContextSnapshot,
  switchContext,
  getActiveContext,
  pushProvider,
  popProvider,
} from './ReactFizzNewContext';
import {
  prepareToUseHooks,
  prepareToUseThenableState,
  finishHooks,
  checkDidRenderIdHook,
  resetHooksState,
  HooksDispatcher,
  currentResumableState,
  setCurrentResumableState,
  getThenableStateAfterSuspending,
  unwrapThenable,
  readPreviousThenableFromState,
  getActionStateCount,
  getActionStateMatchingIndex,
} from './ReactFizzHooks';
import {DefaultAsyncDispatcher} from './ReactFizzAsyncDispatcher';
import {
  getStackByComponentStackNode,
  getOwnerStackByComponentStackNodeInDev,
} from './ReactFizzComponentStack';
import {emptyTreeContext, pushTreeContext} from './ReactFizzTreeContext';
import {currentTaskInDEV, setCurrentTaskInDEV} from './ReactFizzCurrentTask';
import {
  callLazyInitInDEV,
  callComponentInDEV,
  callRenderInDEV,
} from './ReactFizzCallUserSpace';

import {
  getIteratorFn,
  ASYNC_ITERATOR,
  REACT_ELEMENT_TYPE,
  REACT_PORTAL_TYPE,
  REACT_LAZY_TYPE,
  REACT_SUSPENSE_TYPE,
  REACT_LEGACY_HIDDEN_TYPE,
  REACT_DEBUG_TRACING_MODE_TYPE,
  REACT_STRICT_MODE_TYPE,
  REACT_PROFILER_TYPE,
  REACT_SUSPENSE_LIST_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_MEMO_TYPE,
  REACT_PROVIDER_TYPE,
  REACT_CONTEXT_TYPE,
  REACT_CONSUMER_TYPE,
  REACT_SCOPE_TYPE,
  REACT_OFFSCREEN_TYPE,
  REACT_POSTPONE_TYPE,
} from 'shared/ReactSymbols';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import {
  disableLegacyContext,
  disableLegacyContextForFunctionComponents,
  enableScopeAPI,
  enableSuspenseAvoidThisFallbackFizz,
  enableCache,
  enablePostpone,
  enableHalt,
  enableRenderableContext,
  enableRefAsProp,
  disableDefaultPropsExceptForClasses,
  enableAsyncIterableChildren,
  disableStringRefs,
  enableOwnerStacks,
} from 'shared/ReactFeatureFlags';

import assign from 'shared/assign';
import getComponentNameFromType from 'shared/getComponentNameFromType';
import isArray from 'shared/isArray';
import {SuspenseException, getSuspendedThenable} from './ReactFizzThenable';
import type {Postpone} from 'react/src/ReactPostpone';

// Linked list representing the identity of a component given the component/tag name and key.
// The name might be minified but we assume that it's going to be the same generated name. Typically
// because it's just the same compiled output in practice.
export type KeyNode = [
  Root | KeyNode /* parent */,
  string | null /* name */,
  string | number /* key */,
];

type ResumeSlots =
  | null // nothing to resume
  | number // resume with segment ID at the root position
  | {[index: number]: number}; // resume with segmentID at the index

type ReplaySuspenseBoundary = [
  string | null /* name */,
  string | number /* key */,
  Array<ReplayNode> /* content keyed children */,
  ResumeSlots /* content resumable slots */,
  null | ReplayNode /* fallback content */,
  number /* rootSegmentID */,
];

type ReplayNode =
  | [
      string | null /* name */,
      string | number /* key */,
      Array<ReplayNode> /* keyed children */,
      ResumeSlots /* resumable slots */,
    ]
  | ReplaySuspenseBoundary;

type PostponedHoles = {
  workingMap: Map<KeyNode, ReplayNode>,
  rootNodes: Array<ReplayNode>,
  rootSlots: ResumeSlots,
};

type LegacyContext = {
  [key: string]: any,
};

const CLIENT_RENDERED = 4; // if it errors or infinitely suspends

type SuspenseBoundary = {
  status: 0 | 1 | 4 | 5,
  rootSegmentID: number,
  parentFlushed: boolean,
  pendingTasks: number, // when it reaches zero we can show this boundary's content
  completedSegments: Array<Segment>, // completed but not yet flushed segments.
  byteSize: number, // used to determine whether to inline children boundaries.
  fallbackAbortableTasks: Set<Task>, // used to cancel task on the fallback if the boundary completes or gets canceled.
  contentState: HoistableState,
  fallbackState: HoistableState,
  trackedContentKeyPath: null | KeyNode, // used to track the path for replay nodes
  trackedFallbackNode: null | ReplayNode, // used to track the fallback for replay nodes
  errorDigest: ?string, // the error hash if it errors
  // DEV-only fields
  errorMessage?: null | string, // the error string if it errors
  errorStack?: null | string, // the error stack if it errors
  errorComponentStack?: null | string, // the error component stack if it errors
};

type RenderTask = {
  replay: null,
  node: ReactNodeList,
  childIndex: number,
  ping: () => void,
  blockedBoundary: Root | SuspenseBoundary,
  blockedSegment: Segment, // the segment we'll write to
  hoistableState: null | HoistableState, // Boundary state we'll mutate while rendering. This may not equal the state of the blockedBoundary
  abortSet: Set<Task>, // the abortable set that this task belongs to
  keyPath: Root | KeyNode, // the path of all parent keys currently rendering
  formatContext: FormatContext, // the format's specific context (e.g. HTML/SVG/MathML)
  context: ContextSnapshot, // the current new context that this task is executing in
  treeContext: TreeContext, // the current tree context that this task is executing in
  componentStack: null | ComponentStackNode, // stack frame description of the currently rendering component
  thenableState: null | ThenableState,
  isFallback: boolean, // whether this task is rendering inside a fallback tree
  legacyContext: LegacyContext, // the current legacy context that this task is executing in
  debugTask: null | ConsoleTask, // DEV only
  // DON'T ANY MORE FIELDS. We at 16 already which otherwise requires converting to a constructor.
  // Consider splitting into multiple objects or consolidating some fields.
};

type ReplaySet = {
  nodes: Array<ReplayNode>, // the possible paths to follow down the replaying
  slots: ResumeSlots, // slots to resume
  pendingTasks: number, // tracks the number of tasks currently tracking this set of nodes
  // if pending tasks reach zero but there are still nodes left, it means we couldn't find
  // them all in the tree, so we need to abort and client render the boundary.
};

type ReplayTask = {
  replay: ReplaySet,
  node: ReactNodeList,
  childIndex: number,
  ping: () => void,
  blockedBoundary: Root | SuspenseBoundary,
  blockedSegment: null, // we don't write to anything when we replay
  hoistableState: null | HoistableState, // Boundary state we'll mutate while rendering. This may not equal the state of the blockedBoundary
  abortSet: Set<Task>, // the abortable set that this task belongs to
  keyPath: Root | KeyNode, // the path of all parent keys currently rendering
  formatContext: FormatContext, // the format's specific context (e.g. HTML/SVG/MathML)
  context: ContextSnapshot, // the current new context that this task is executing in
  treeContext: TreeContext, // the current tree context that this task is executing in
  componentStack: null | ComponentStackNode, // stack frame description of the currently rendering component
  thenableState: null | ThenableState,
  isFallback: boolean, // whether this task is rendering inside a fallback tree
  legacyContext: LegacyContext, // the current legacy context that this task is executing in
  debugTask: null | ConsoleTask, // DEV only
  // DON'T ANY MORE FIELDS. We at 16 already which otherwise requires converting to a constructor.
  // Consider splitting into multiple objects or consolidating some fields.
};

export type Task = RenderTask | ReplayTask;

const PENDING = 0;
const COMPLETED = 1;
const FLUSHED = 2;
const ABORTED = 3;
const ERRORED = 4;
const POSTPONED = 5;
const RENDERING = 6;

type Root = null;

type Segment = {
  status: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  parentFlushed: boolean, // typically a segment will be flushed by its parent, except if its parent was already flushed
  id: number, // starts as 0 and is lazily assigned if the parent flushes early
  +index: number, // the index within the parent's chunks or 0 at the root
  +chunks: Array<Chunk | PrecomputedChunk>,
  +children: Array<Segment>,
  // The context that this segment was created in.
  parentFormatContext: FormatContext,
  // If this segment represents a fallback, this is the content that will replace that fallback.
  +boundary: null | SuspenseBoundary,
  // used to discern when text separator boundaries are needed
  lastPushedText: boolean,
  textEmbedded: boolean,
};

const OPENING = 10;
const OPEN = 11;
const ABORTING = 12;
const CLOSING = 13;
const CLOSED = 14;

export opaque type Request = {
  destination: null | Destination,
  flushScheduled: boolean,
  +resumableState: ResumableState,
  +renderState: RenderState,
  +rootFormatContext: FormatContext,
  +progressiveChunkSize: number,
  status: 10 | 11 | 12 | 13 | 14,
  fatalError: mixed,
  nextSegmentId: number,
  allPendingTasks: number, // when it reaches zero, we can close the connection.
  pendingRootTasks: number, // when this reaches zero, we've finished at least the root boundary.
  completedRootSegment: null | Segment, // Completed but not yet flushed root segments.
  abortableTasks: Set<Task>,
  pingedTasks: Array<Task>, // High priority tasks that should be worked on first.
  // Queues to flush in order of priority
  clientRenderedBoundaries: Array<SuspenseBoundary>, // Errored or client rendered but not yet flushed.
  completedBoundaries: Array<SuspenseBoundary>, // Completed but not yet fully flushed boundaries to show.
  partialBoundaries: Array<SuspenseBoundary>, // Partially completed boundaries that can flush its segments early.
  trackedPostpones: null | PostponedHoles, // Gets set to non-null while we want to track postponed holes. I.e. during a prerender.
  // onError is called when an error happens anywhere in the tree. It might recover.
  // The return string is used in production  primarily to avoid leaking internals, secondarily to save bytes.
  // Returning null/undefined will cause a defualt error message in production
  onError: (error: mixed, errorInfo: ThrownInfo) => ?string,
  // onAllReady is called when all pending task is done but it may not have flushed yet.
  // This is a good time to start writing if you want only HTML and no intermediate steps.
  onAllReady: () => void,
  // onShellReady is called when there is at least a root fallback ready to show.
  // Typically you don't need this callback because it's best practice to always have a
  // root fallback ready so there's no need to wait.
  onShellReady: () => void,
  // onShellError is called when the shell didn't complete. That means you probably want to
  // emit a different response to the stream instead.
  onShellError: (error: mixed) => void,
  onFatalError: (error: mixed) => void,
  // onPostpone is called when postpone() is called anywhere in the tree, which will defer
  // rendering - e.g. to the client. This is considered intentional and not an error.
  onPostpone: (reason: string, postponeInfo: ThrownInfo) => void,
  // Form state that was the result of an MPA submission, if it was provided.
  formState: null | ReactFormState<any, any>,
  // DEV-only, warning dedupe
  didWarnForKey?: null | WeakSet<ComponentStackNode>,
};

// This is a default heuristic for how to split up the HTML content into progressive
// loading. Our goal is to be able to display additional new content about every 500ms.
// Faster than that is unnecessary and should be throttled on the client. It also
// adds unnecessary overhead to do more splits. We don't know if it's a higher or lower
// end device but higher end suffer less from the overhead than lower end does from
// not getting small enough pieces. We error on the side of low end.
// We base this on low end 3G speeds which is about 500kbits per second. We assume
// that there can be a reasonable drop off from max bandwidth which leaves you with
// as little as 80%. We can receive half of that each 500ms - at best. In practice,
// a little bandwidth is lost to processing and contention - e.g. CSS and images that
// are downloaded along with the main content. So we estimate about half of that to be
// the lower end throughput. In other words, we expect that you can at least show
// about 12.5kb of content per 500ms. Not counting starting latency for the first
// paint.
// 500 * 1024 / 8 * .8 * 0.5 / 2
const DEFAULT_PROGRESSIVE_CHUNK_SIZE = 12800;

function defaultErrorHandler(error: mixed) {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof error.environmentName === 'string'
  ) {
    // This was a Server error. We print the environment name in a badge just like we do with
    // replays of console logs to indicate that the source of this throw as actually the Server.
    bindToConsole('error', [error], error.environmentName)();
  } else {
    console['error'](error); // Don't transform to our wrapper
  }
  return null;
}

function noop(): void {}

function RequestInstance(
  this: $FlowFixMe,
  resumableState: ResumableState,
  renderState: RenderState,
  rootFormatContext: FormatContext,
  progressiveChunkSize: void | number,
  onError: void | ((error: mixed, errorInfo: ErrorInfo) => ?string),
  onAllReady: void | (() => void),
  onShellReady: void | (() => void),
  onShellError: void | ((error: mixed) => void),
  onFatalError: void | ((error: mixed) => void),
  onPostpone: void | ((reason: string, postponeInfo: PostponeInfo) => void),
  formState: void | null | ReactFormState<any, any>,
) {
  const pingedTasks: Array<Task> = [];
  const abortSet: Set<Task> = new Set();
  this.destination = null;
  this.flushScheduled = false;
  this.resumableState = resumableState;
  this.renderState = renderState;
  this.rootFormatContext = rootFormatContext;
  this.progressiveChunkSize =
    progressiveChunkSize === undefined
      ? DEFAULT_PROGRESSIVE_CHUNK_SIZE
      : progressiveChunkSize;
  this.status = OPENING;
  this.fatalError = null;
  this.nextSegmentId = 0;
  this.allPendingTasks = 0;
  this.pendingRootTasks = 0;
  this.completedRootSegment = null;
  this.abortableTasks = abortSet;
  this.pingedTasks = pingedTasks;
  this.clientRenderedBoundaries = ([]: Array<SuspenseBoundary>);
  this.completedBoundaries = ([]: Array<SuspenseBoundary>);
  this.partialBoundaries = ([]: Array<SuspenseBoundary>);
  this.trackedPostpones = null;
  this.onError = onError === undefined ? defaultErrorHandler : onError;
  this.onPostpone = onPostpone === undefined ? noop : onPostpone;
  this.onAllReady = onAllReady === undefined ? noop : onAllReady;
  this.onShellReady = onShellReady === undefined ? noop : onShellReady;
  this.onShellError = onShellError === undefined ? noop : onShellError;
  this.onFatalError = onFatalError === undefined ? noop : onFatalError;
  this.formState = formState === undefined ? null : formState;
  if (__DEV__) {
    this.didWarnForKey = null;
  }
}

export function createRequest(
  children: ReactNodeList,//  需要渲染的React树
  resumableState: ResumableState,// 一个可恢复状态
  renderState: RenderState,// 渲染状态
  rootFormatContext: FormatContext,// 格式化上下文
  progressiveChunkSize: void | number,// 渐进式块大小。一次渲染工作中，最大工作单元数量
  onError: void | ((error: mixed, errorInfo: ErrorInfo) => ?string),// 错误处理回调
  onAllReady: void | (() => void),// 所有内容完成的回调函数
  onShellReady: void | (() => void),//  壳资源准备完毕的回调函数
  onShellError: void | ((error: mixed) => void),//  渲染页面"壳"时发生错误的回调函数
  onFatalError: void | ((error: mixed) => void),//  发生致命错误时的回调函数。
  onPostpone: void | ((reason: string, postponeInfo: PostponeInfo) => void),// 渲染被推迟时的回调函数，用于React 18的选择性水合功能。
  formState: void | null | ReactFormState<any, any>,// 表单状态，用于处理表单的渲染和数据。
): Request {
  // 创建一个request初始化对象。包含整次渲染的一些必要参数、函数。
  //  当前请求状态，各种回调，渲染状态、可中止的任务集合，被ping的任务队列【在下次执行】、suspense边界列表、部分完成的suspense边界列表
  const request: Request = new RequestInstance(
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    formState,
  );

  // 创建一个根节点片段
  const rootSegment = createPendingSegment(
    request,
    0,
    null,
    rootFormatContext,
    // Root segments are never embedded in Text on either edge
    false,
    false,
  );
  // 它是根，没有父节点，可以理解输出
  rootSegment.parentFlushed = true;
  //  创建一个渲染整个组件的根任务。包含了要渲染的组件树children
  const rootTask = createRenderTask(
    request,
    null,
    children,
    -1,
    null,
    rootSegment,
    null,
    request.abortableTasks,
    null,
    rootFormatContext,
    rootContextSnapshot,
    emptyTreeContext,
    null,
    false,
    emptyContextObject,
    null,
  );
  //  推入任务栈、待处理任务栈
  pushComponentStack(rootTask);
  request.pingedTasks.push(rootTask);
  return request;
}

export function createPrerenderRequest(
  children: ReactNodeList,
  resumableState: ResumableState,
  renderState: RenderState,
  rootFormatContext: FormatContext,
  progressiveChunkSize: void | number,
  onError: void | ((error: mixed, errorInfo: ErrorInfo) => ?string),
  onAllReady: void | (() => void),
  onShellReady: void | (() => void),
  onShellError: void | ((error: mixed) => void),
  onFatalError: void | ((error: mixed) => void),
  onPostpone: void | ((reason: string, postponeInfo: PostponeInfo) => void),
): Request {
  const request = createRequest(
    children,
    resumableState,
    renderState,
    rootFormatContext,
    progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    undefined,
  );
  // Start tracking postponed holes during this render.
  request.trackedPostpones = {
    workingMap: new Map(),
    rootNodes: [],
    rootSlots: null,
  };
  return request;
}

export function resumeRequest(
  children: ReactNodeList,
  postponedState: PostponedState,
  renderState: RenderState,
  onError: void | ((error: mixed, errorInfo: ErrorInfo) => ?string),
  onAllReady: void | (() => void),
  onShellReady: void | (() => void),
  onShellError: void | ((error: mixed) => void),
  onFatalError: void | ((error: mixed) => void),
  onPostpone: void | ((reason: string, postponeInfo: PostponeInfo) => void),
): Request {
  // $FlowFixMe[invalid-constructor]: the shapes are exact here but Flow doesn't like constructors
  const request: Request = new RequestInstance(
    postponedState.resumableState,
    renderState,
    postponedState.rootFormatContext,
    postponedState.progressiveChunkSize,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
    null,
  );
  request.nextSegmentId = postponedState.nextSegmentId;

  if (typeof postponedState.replaySlots === 'number') {
    const resumedId = postponedState.replaySlots;
    // We have a resume slot at the very root. This is effectively just a full rerender.
    const rootSegment = createPendingSegment(
      request,
      0,
      null,
      postponedState.rootFormatContext,
      // Root segments are never embedded in Text on either edge
      false,
      false,
    );
    rootSegment.id = resumedId;
    // There is no parent so conceptually, we're unblocked to flush this segment.
    rootSegment.parentFlushed = true;
    const rootTask = createRenderTask(
      request,
      null,
      children,
      -1,
      null,
      rootSegment,
      null,
      request.abortableTasks,
      null,
      postponedState.rootFormatContext,
      rootContextSnapshot,
      emptyTreeContext,
      null,
      false,
      emptyContextObject,
      null,
    );
    pushComponentStack(rootTask);
    request.pingedTasks.push(rootTask);
    return request;
  }

  const replay: ReplaySet = {
    nodes: postponedState.replayNodes,
    slots: postponedState.replaySlots,
    pendingTasks: 0,
  };
  const rootTask = createReplayTask(
    request,
    null,
    replay,
    children,
    -1,
    null,
    null,
    request.abortableTasks,
    null,
    postponedState.rootFormatContext,
    rootContextSnapshot,
    emptyTreeContext,
    null,
    false,
    emptyContextObject,
    null,
  );
  pushComponentStack(rootTask);
  request.pingedTasks.push(rootTask);
  return request;
}

export function resumeAndPrerenderRequest(
  children: ReactNodeList,
  postponedState: PostponedState,
  renderState: RenderState,
  onError: void | ((error: mixed, errorInfo: ErrorInfo) => ?string),
  onAllReady: void | (() => void),
  onShellReady: void | (() => void),
  onShellError: void | ((error: mixed) => void),
  onFatalError: void | ((error: mixed) => void),
  onPostpone: void | ((reason: string, postponeInfo: PostponeInfo) => void),
): Request {
  const request = resumeRequest(
    children,
    postponedState,
    renderState,
    onError,
    onAllReady,
    onShellReady,
    onShellError,
    onFatalError,
    onPostpone,
  );
  // Start tracking postponed holes during this render.
  request.trackedPostpones = {
    workingMap: new Map(),
    rootNodes: [],
    rootSlots: null,
  };
  return request;
}

let currentRequest: null | Request = null;

export function resolveRequest(): null | Request {
  if (currentRequest) return currentRequest;
  if (supportsRequestStorage) {
    const store = requestStorage.getStore();
    if (store) return store;
  }
  return null;
}

function pingTask(request: Request, task: Task): void {
  const pingedTasks = request.pingedTasks;
  pingedTasks.push(task);
  if (request.pingedTasks.length === 1) {
    request.flushScheduled = request.destination !== null;
    if (request.trackedPostpones !== null || request.status === OPENING) {
      scheduleMicrotask(() => performWork(request));
    } else {
      scheduleWork(() => performWork(request));
    }
  }
}

function createSuspenseBoundary(
  request: Request,
  fallbackAbortableTasks: Set<Task>,
): SuspenseBoundary {
  const boundary: SuspenseBoundary = {
    status: PENDING,
    rootSegmentID: -1,
    parentFlushed: false,
    pendingTasks: 0,
    completedSegments: [],
    byteSize: 0,
    fallbackAbortableTasks,
    errorDigest: null,
    contentState: createHoistableState(),
    fallbackState: createHoistableState(),
    trackedContentKeyPath: null,
    trackedFallbackNode: null,
  };
  if (__DEV__) {
    // DEV-only fields for hidden class
    boundary.errorMessage = null;
    boundary.errorStack = null;
    boundary.errorComponentStack = null;
  }
  return boundary;
}

function createRenderTask(
  request: Request,
  thenableState: ThenableState | null,
  node: ReactNodeList,
  childIndex: number,
  blockedBoundary: Root | SuspenseBoundary,
  blockedSegment: Segment,
  hoistableState: null | HoistableState,
  abortSet: Set<Task>,
  keyPath: Root | KeyNode,
  formatContext: FormatContext,
  context: ContextSnapshot,
  treeContext: TreeContext,
  componentStack: null | ComponentStackNode,
  isFallback: boolean,
  legacyContext: LegacyContext,
  debugTask: null | ConsoleTask,
): RenderTask {
  request.allPendingTasks++;
  if (blockedBoundary === null) {
    request.pendingRootTasks++;
  } else {
    blockedBoundary.pendingTasks++;
  }
  const task: RenderTask = ({
    replay: null,
    node,
    childIndex,
    ping: () => pingTask(request, task),
    blockedBoundary,
    blockedSegment,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    componentStack,
    thenableState,
    isFallback,
  }: any);
  if (!disableLegacyContext) {
    task.legacyContext = legacyContext;
  }
  if (__DEV__ && enableOwnerStacks) {
    task.debugTask = debugTask;
  }
  abortSet.add(task);
  return task;
}

function createReplayTask(
  request: Request,
  thenableState: ThenableState | null,
  replay: ReplaySet,
  node: ReactNodeList,
  childIndex: number,
  blockedBoundary: Root | SuspenseBoundary,
  hoistableState: null | HoistableState,
  abortSet: Set<Task>,
  keyPath: Root | KeyNode,
  formatContext: FormatContext,
  context: ContextSnapshot,
  treeContext: TreeContext,
  componentStack: null | ComponentStackNode,
  isFallback: boolean,
  legacyContext: LegacyContext,
  debugTask: null | ConsoleTask,
): ReplayTask {
  request.allPendingTasks++;
  if (blockedBoundary === null) {
    request.pendingRootTasks++;
  } else {
    blockedBoundary.pendingTasks++;
  }
  replay.pendingTasks++;
  const task: ReplayTask = ({
    replay,
    node,
    childIndex,
    ping: () => pingTask(request, task),
    blockedBoundary,
    blockedSegment: null,
    hoistableState,
    abortSet,
    keyPath,
    formatContext,
    context,
    treeContext,
    componentStack,
    thenableState,
    isFallback,
  }: any);
  if (!disableLegacyContext) {
    task.legacyContext = legacyContext;
  }
  if (__DEV__ && enableOwnerStacks) {
    task.debugTask = debugTask;
  }
  abortSet.add(task);
  return task;
}

function createPendingSegment(
  request: Request,
  index: number,
  boundary: null | SuspenseBoundary,
  parentFormatContext: FormatContext,
  lastPushedText: boolean,
  textEmbedded: boolean,
): Segment {
  return {
    status: PENDING,
    id: -1, // lazily assigned later
    index,
    parentFlushed: false,
    chunks: [],
    children: [],
    parentFormatContext,
    boundary,
    lastPushedText,
    textEmbedded,
  };
}

function getCurrentStackInDEV(): string {
  if (__DEV__) {
    if (currentTaskInDEV === null || currentTaskInDEV.componentStack === null) {
      return '';
    }
    if (enableOwnerStacks) {
      return getOwnerStackByComponentStackNodeInDev(
        currentTaskInDEV.componentStack,
      );
    }
    return getStackByComponentStackNode(currentTaskInDEV.componentStack);
  }
  return '';
}

function getStackFromNode(stackNode: ComponentStackNode): string {
  return getStackByComponentStackNode(stackNode);
}

function pushServerComponentStack(
  task: Task,
  debugInfo: void | null | ReactDebugInfo,
): void {
  if (!__DEV__) {
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'pushServerComponentStack should never be called in production. This is a bug in React.',
    );
  }
  // Build a Server Component parent stack from the debugInfo.
  if (debugInfo != null) {
    const stack: ReactDebugInfo = debugInfo;
    for (let i = 0; i < stack.length; i++) {
      const componentInfo: ReactComponentInfo = (stack[i]: any);
      if (typeof componentInfo.name !== 'string') {
        continue;
      }
      if (enableOwnerStacks && componentInfo.debugStack === undefined) {
        continue;
      }
      task.componentStack = {
        parent: task.componentStack,
        type: componentInfo,
        owner: componentInfo.owner,
        stack: enableOwnerStacks ? componentInfo.debugStack : null,
      };
      if (enableOwnerStacks) {
        task.debugTask = (componentInfo.debugTask: any);
      }
    }
  }
}

function pushComponentStack(task: Task): void {
  const node = task.node;
  // Create the Component Stack frame for the element we're about to try.
  // It's unfortunate that we need to do this refinement twice. Once for
  // the stack frame and then once again while actually
  if (typeof node === 'object' && node !== null) {
    switch ((node: any).$$typeof) {
      case REACT_ELEMENT_TYPE: {
        const element: any = node;
        const type = element.type;
        const owner = __DEV__ ? element._owner : null;
        const stack = __DEV__ && enableOwnerStacks ? element._debugStack : null;
        if (__DEV__) {
          pushServerComponentStack(task, element._debugInfo);
          if (enableOwnerStacks) {
            task.debugTask = element._debugTask;
          }
        }
        task.componentStack = createComponentStackFromType(
          task.componentStack,
          type,
          owner,
          stack,
        );
        break;
      }
      case REACT_LAZY_TYPE: {
        if (__DEV__) {
          const lazyNode: LazyComponentType<any, any> = (node: any);
          pushServerComponentStack(task, lazyNode._debugInfo);
        }
        break;
      }
      default: {
        if (__DEV__) {
          const maybeUsable: Object = node;
          if (typeof maybeUsable.then === 'function') {
            const thenable: Thenable<ReactNodeList> = (maybeUsable: any);
            pushServerComponentStack(task, thenable._debugInfo);
          }
        }
      }
    }
  }
}

function createComponentStackFromType(
  parent: null | ComponentStackNode,
  type: Function | string | symbol,
  owner: null | ReactComponentInfo | ComponentStackNode, // DEV only
  stack: null | Error, // DEV only
): ComponentStackNode {
  if (__DEV__) {
    return {
      parent,
      type,
      owner,
      stack,
    };
  }
  return {
    parent,
    type,
  };
}

type ThrownInfo = {
  componentStack?: string,
};
export type ErrorInfo = ThrownInfo;
export type PostponeInfo = ThrownInfo;

function getThrownInfo(node: null | ComponentStackNode): ThrownInfo {
  const errorInfo: ThrownInfo = {};
  if (node) {
    Object.defineProperty(errorInfo, 'componentStack', {
      configurable: true,
      enumerable: true,
      get() {
        // Lazyily generate the stack since it's expensive.
        const stack = getStackFromNode(node);
        Object.defineProperty(errorInfo, 'componentStack', {
          value: stack,
        });
        return stack;
      },
    });
  }
  return errorInfo;
}

function encodeErrorForBoundary(
  boundary: SuspenseBoundary,
  digest: ?string,
  error: mixed,
  thrownInfo: ThrownInfo,
  wasAborted: boolean,
) {
  boundary.errorDigest = digest;
  if (__DEV__) {
    let message, stack;
    // In dev we additionally encode the error message and component stack on the boundary
    if (error instanceof Error) {
      // eslint-disable-next-line react-internal/safe-string-coercion
      message = String(error.message);
      // eslint-disable-next-line react-internal/safe-string-coercion
      stack = String(error.stack);
    } else if (typeof error === 'object' && error !== null) {
      message = describeObjectForErrorMessage(error);
      stack = null;
    } else {
      // eslint-disable-next-line react-internal/safe-string-coercion
      message = String(error);
      stack = null;
    }
    const prefix = wasAborted
      ? 'Switched to client rendering because the server rendering aborted due to:\n\n'
      : 'Switched to client rendering because the server rendering errored:\n\n';
    boundary.errorMessage = prefix + message;
    boundary.errorStack = stack !== null ? prefix + stack : null;
    boundary.errorComponentStack = thrownInfo.componentStack;
  }
}

function logPostpone(
  request: Request,
  reason: string,
  postponeInfo: ThrownInfo,
  debugTask: null | ConsoleTask,
): void {
  // If this callback errors, we intentionally let that error bubble up to become a fatal error
  // so that someone fixes the error reporting instead of hiding it.
  const onPostpone = request.onPostpone;
  if (__DEV__ && enableOwnerStacks && debugTask) {
    debugTask.run(onPostpone.bind(null, reason, postponeInfo));
  } else {
    onPostpone(reason, postponeInfo);
  }
}

function logRecoverableError(
  request: Request,
  error: any,
  errorInfo: ThrownInfo,
  debugTask: null | ConsoleTask,
): ?string {
  // If this callback errors, we intentionally let that error bubble up to become a fatal error
  // so that someone fixes the error reporting instead of hiding it.
  const onError = request.onError;
  const errorDigest =
    __DEV__ && enableOwnerStacks && debugTask
      ? debugTask.run(onError.bind(null, error, errorInfo))
      : onError(error, errorInfo);
  if (errorDigest != null && typeof errorDigest !== 'string') {
    // We used to throw here but since this gets called from a variety of unprotected places it
    // seems better to just warn and discard the returned value.
    if (__DEV__) {
      console.error(
        'onError returned something with a type other than "string". onError should return a string and may return null or undefined but must not return anything else. It received something of type "%s" instead',
        typeof errorDigest,
      );
    }
    return;
  }
  return errorDigest;
}

function fatalError(
  request: Request,
  error: mixed,
  errorInfo: ThrownInfo,
  debugTask: null | ConsoleTask,
): void {
  // This is called outside error handling code such as if the root errors outside
  // a suspense boundary or if the root suspense boundary's fallback errors.
  // It's also called if React itself or its host configs errors.
  const onShellError = request.onShellError;
  const onFatalError = request.onFatalError;
  if (__DEV__ && enableOwnerStacks && debugTask) {
    debugTask.run(onShellError.bind(null, error));
    debugTask.run(onFatalError.bind(null, error));
  } else {
    onShellError(error);
    onFatalError(error);
  }
  if (request.destination !== null) {
    request.status = CLOSED;
    closeWithError(request.destination, error);
  } else {
    request.status = CLOSING;
    request.fatalError = error;
  }
}

function renderSuspenseBoundary(
  request: Request,
  someTask: Task,
  keyPath: KeyNode,
  props: Object,
): void {
  if (someTask.replay !== null) {
    // If we're replaying through this pass, it means we're replaying through
    // an already completed Suspense boundary. It's too late to do anything about it
    // so we can just render through it.
    const prevKeyPath = someTask.keyPath;
    someTask.keyPath = keyPath;
    const content: ReactNodeList = props.children;
    try {
      renderNode(request, someTask, content, -1);
    } finally {
      someTask.keyPath = prevKeyPath;
    }
    return;
  }
  // $FlowFixMe: Refined.
  const task: RenderTask = someTask;

  const prevKeyPath = task.keyPath;
  const parentBoundary = task.blockedBoundary;
  const parentHoistableState = task.hoistableState;
  const parentSegment = task.blockedSegment;


  const fallback: ReactNodeList = props.fallback;// 当内容挂起时显示的回退 UI
  const content: ReactNodeList = props.children;//  实际内容

  const fallbackAbortSet: Set<Task> = new Set();//   用于收集与 fallback 相关的可中止任务的集合
  //  一个边界对象，跟踪该组件
  const newBoundary = createSuspenseBoundary(request, fallbackAbortSet);

  if (request.trackedPostpones !== null) {
    newBoundary.trackedContentKeyPath = keyPath;
  }
  // 记录当前组件在父段的位置
  const insertionIndex = parentSegment.chunks.length;
  //  创建一个新的段，存放suspense边界的内容
  const boundarySegment = createPendingSegment(
    request,
    insertionIndex,
    newBoundary,
    task.formatContext,
    false,
    false,
  );
  parentSegment.children.push(boundarySegment);
  parentSegment.lastPushedText = false;
  //  存储实际内容的渲染内容。渲染成功会放入boundarySegment
  const contentRootSegment = createPendingSegment(
    request,
    0,
    null,
    task.formatContext,
    false,
    false,
  );

  contentRootSegment.parentFlushed = true;

  if (request.trackedPostpones !== null) { // 预渲染
    const trackedPostpones = request.trackedPostpones;
    // 创建一个fallback节点
    const fallbackKeyPath = [keyPath[0], 'Suspense Fallback', keyPath[2]];
    //  创建一个回放节点
    const fallbackReplayNode: ReplayNode = [
      fallbackKeyPath[1],
      fallbackKeyPath[2],
      ([]: Array<ReplayNode>),
      null,
    ];
    //  记录关系到trackedPostpones中
    trackedPostpones.workingMap.set(fallbackKeyPath, fallbackReplayNode);
    //  记录fallback节点到维护suspense状态的newBoundary中
    newBoundary.trackedFallbackNode = fallbackReplayNode;
    //  设置任务状态
    task.blockedSegment = boundarySegment;
    task.keyPath = fallbackKeyPath;
    boundarySegment.status = RENDERING;
    try {
      //  渲染fallback
      renderNode(request, task, fallback, -1);
      pushSegmentFinale(
        boundarySegment.chunks,
        request.renderState,
        boundarySegment.lastPushedText,
        boundarySegment.textEmbedded,
      );
      boundarySegment.status = COMPLETED;
    } catch (thrownValue: mixed) {
      if (request.status === ABORTING) {
        boundarySegment.status = ABORTED;
      } else {
        boundarySegment.status = ERRORED;
      }
      throw thrownValue;
    } finally {
      task.blockedSegment = parentSegment;
      task.keyPath = prevKeyPath;
    }

    // 创建一个新的渲染实际内容的任务
    const suspendedPrimaryTask = createRenderTask(
      request,
      null,
      content,
      -1,
      newBoundary,
      contentRootSegment,
      newBoundary.contentState,
      task.abortSet,
      keyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.componentStack,
      task.isFallback,
      !disableLegacyContext ? task.legacyContext : emptyContextObject,
      __DEV__ && enableOwnerStacks ? task.debugTask : null,
    );
    pushComponentStack(suspendedPrimaryTask);
    request.pingedTasks.push(suspendedPrimaryTask);
  } else {
    // 同步渲染
    task.blockedBoundary = newBoundary;
    task.hoistableState = newBoundary.contentState;
    task.blockedSegment = contentRootSegment;
    task.keyPath = keyPath;
    contentRootSegment.status = RENDERING;

    try {
      // 渲染实际的内容
      renderNode(request, task, content, -1);
      pushSegmentFinale(
        contentRootSegment.chunks,
        request.renderState,
        contentRootSegment.lastPushedText,
        contentRootSegment.textEmbedded,
      );
      contentRootSegment.status = COMPLETED;
      //  将已完成的内容根段添加到新边界的完成段队列中，表示这部分内容已准备好发送到客户端。
      queueCompletedSegment(newBoundary, contentRootSegment);
      if (newBoundary.pendingTasks === 0 && newBoundary.status === PENDING) {
        // 没有待处理任务了，设置完成。不用处理fallback
        newBoundary.status = COMPLETED;
        return;
      }
    } catch (thrownValue: mixed) {
      //  挂起，标记客户端渲染
      newBoundary.status = CLIENT_RENDERED;
      let error: mixed;
      if (request.status === ABORTING) {
        contentRootSegment.status = ABORTED;
        error = request.fatalError;
      } else {
        contentRootSegment.status = ERRORED;
        error = thrownValue;
      }

      const thrownInfo = getThrownInfo(task.componentStack);
      let errorDigest;
      if (
        enablePostpone &&
        typeof error === 'object' &&
        error !== null &&
        error.$$typeof === REACT_POSTPONE_TYPE
      ) {
        const postponeInstance: Postpone = (error: any);
        logPostpone(
          request,
          postponeInstance.message,
          thrownInfo,
          __DEV__ && enableOwnerStacks ? task.debugTask : null,
        );
        // TODO: Figure out a better signal than a magic digest value.
        errorDigest = 'POSTPONE';
      } else {
        errorDigest = logRecoverableError(
          request,
          error,
          thrownInfo,
          __DEV__ && enableOwnerStacks ? task.debugTask : null,
        );
      }
      encodeErrorForBoundary(
        newBoundary,
        errorDigest,
        error,
        thrownInfo,
        false,
      );

      untrackBoundary(request, newBoundary);

      // We don't need to decrement any task numbers because we didn't spawn any new task.
      // We don't need to schedule any task because we know the parent has written yet.
      // We do need to fallthrough to create the fallback though.
    } finally {
      task.blockedBoundary = parentBoundary;
      task.hoistableState = parentHoistableState;
      task.blockedSegment = parentSegment;
      task.keyPath = prevKeyPath;
    }
    //  创建fallback的任务
    const fallbackKeyPath = [keyPath[0], 'Suspense Fallback', keyPath[2]];
    const suspendedFallbackTask = createRenderTask(
      request,
      null,
      fallback,
      -1,
      parentBoundary,
      boundarySegment,
      newBoundary.fallbackState,
      fallbackAbortSet,
      fallbackKeyPath,
      task.formatContext,
      task.context,
      task.treeContext,
      task.componentStack,
      true,
      !disableLegacyContext ? task.legacyContext : emptyContextObject,
      __DEV__ && enableOwnerStacks ? task.debugTask : null,
    );
    pushComponentStack(suspendedFallbackTask);
    // TODO: This should be queued at a separate lower priority queue so that we only work
    // on preparing fallbacks if we don't have any more main content to task on.
    request.pingedTasks.push(suspendedFallbackTask);
  }
}

function replaySuspenseBoundary(
  request: Request,
  task: ReplayTask,
  keyPath: KeyNode,
  props: Object,
  id: number,
  childNodes: Array<ReplayNode>,
  childSlots: ResumeSlots,
  fallbackNodes: Array<ReplayNode>,
  fallbackSlots: ResumeSlots,
): void {
  const prevKeyPath = task.keyPath;
  const previousReplaySet: ReplaySet = task.replay;

  const parentBoundary = task.blockedBoundary;
  const parentHoistableState = task.hoistableState;

  const content: ReactNodeList = props.children;
  const fallback: ReactNodeList = props.fallback;

  const fallbackAbortSet: Set<Task> = new Set();
  const resumedBoundary = createSuspenseBoundary(request, fallbackAbortSet);
  resumedBoundary.parentFlushed = true;
  // We restore the same id of this boundary as was used during prerender.
  resumedBoundary.rootSegmentID = id;

  // We can reuse the current context and task to render the content immediately without
  // context switching. We just need to temporarily switch which boundary and replay node
  // we're writing to. If something suspends, it'll spawn new suspended task with that context.
  task.blockedBoundary = resumedBoundary;
  task.hoistableState = resumedBoundary.contentState;
  task.keyPath = keyPath;
  task.replay = {nodes: childNodes, slots: childSlots, pendingTasks: 1};

  try {
    // We use the safe form because we don't handle suspending here. Only error handling.
    renderNode(request, task, content, -1);

    if (task.replay.pendingTasks === 1 && task.replay.nodes.length > 0) {
      throw new Error(
        "Couldn't find all resumable slots by key/index during replaying. " +
          "The tree doesn't match so React will fallback to client rendering.",
      );
    }
    task.replay.pendingTasks--;
    if (
      resumedBoundary.pendingTasks === 0 &&
      resumedBoundary.status === PENDING
    ) {
      // This must have been the last segment we were waiting on. This boundary is now complete.
      // Therefore we won't need the fallback. We early return so that we don't have to create
      // the fallback.
      resumedBoundary.status = COMPLETED;
      request.completedBoundaries.push(resumedBoundary);
      // We restore the parent componentStack. Semantically this is the same as
      // popComponentStack(task) but we do this instead because it should be slightly
      // faster
      return;
    }
  } catch (error: mixed) {
    resumedBoundary.status = CLIENT_RENDERED;
    const thrownInfo = getThrownInfo(task.componentStack);
    let errorDigest;
    if (
      enablePostpone &&
      typeof error === 'object' &&
      error !== null &&
      error.$$typeof === REACT_POSTPONE_TYPE
    ) {
      const postponeInstance: Postpone = (error: any);
      logPostpone(
        request,
        postponeInstance.message,
        thrownInfo,
        __DEV__ && enableOwnerStacks ? task.debugTask : null,
      );
      // TODO: Figure out a better signal than a magic digest value.
      errorDigest = 'POSTPONE';
    } else {
      errorDigest = logRecoverableError(
        request,
        error,
        thrownInfo,
        __DEV__ && enableOwnerStacks ? task.debugTask : null,
      );
    }
    encodeErrorForBoundary(
      resumedBoundary,
      errorDigest,
      error,
      thrownInfo,
      false,
    );

    task.replay.pendingTasks--;

    // The parent already flushed in the prerender so we need to schedule this to be emitted.
    request.clientRenderedBoundaries.push(resumedBoundary);

    // We don't need to decrement any task numbers because we didn't spawn any new task.
    // We don't need to schedule any task because we know the parent has written yet.
    // We do need to fallthrough to create the fallback though.
  } finally {
    task.blockedBoundary = parentBoundary;
    task.hoistableState = parentHoistableState;
    task.replay = previousReplaySet;
    task.keyPath = prevKeyPath;
  }

  const fallbackKeyPath = [keyPath[0], 'Suspense Fallback', keyPath[2]];

  // We create suspended task for the fallback because we don't want to actually work
  // on it yet in case we finish the main content, so we queue for later.
  const fallbackReplay = {
    nodes: fallbackNodes,
    slots: fallbackSlots,
    pendingTasks: 0,
  };
  const suspendedFallbackTask = createReplayTask(
    request,
    null,
    fallbackReplay,
    fallback,
    -1,
    parentBoundary,
    resumedBoundary.fallbackState,
    fallbackAbortSet,
    fallbackKeyPath,
    task.formatContext,
    task.context,
    task.treeContext,
    task.componentStack,
    true,
    !disableLegacyContext ? task.legacyContext : emptyContextObject,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );
  pushComponentStack(suspendedFallbackTask);
  // TODO: This should be queued at a separate lower priority queue so that we only work
  // on preparing fallbacks if we don't have any more main content to task on.
  request.pingedTasks.push(suspendedFallbackTask);
}

function renderBackupSuspenseBoundary(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  props: Object,
) {
  const content = props.children;
  const segment = task.blockedSegment;
  const prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  if (segment === null) {
    // Replay
    renderNode(request, task, content, -1);
  } else {
    // Render
    pushStartCompletedSuspenseBoundary(segment.chunks);
    renderNode(request, task, content, -1);
    pushEndCompletedSuspenseBoundary(segment.chunks);
  }
  task.keyPath = prevKeyPath;
}

function renderHostElement(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  type: string,
  props: Object,
): void {
  //  获取任务
  const segment = task.blockedSegment;
  if (segment === null) {
    // Replay
    const children = props.children; // TODO: Make this a Config for replaying.
    const prevContext = task.formatContext;
    const prevKeyPath = task.keyPath;
    task.formatContext = getChildFormatContext(prevContext, type, props);
    task.keyPath = keyPath;

    // We use the non-destructive form because if something suspends, we still
    // need to pop back up and finish this subtree of HTML.
    renderNode(request, task, children, -1);

    // We expect that errors will fatal the whole task and that we don't need
    // the correct context. Therefore this is not in a finally.
    task.formatContext = prevContext;
    task.keyPath = prevKeyPath;
  } else {
    // Render
    //  生成html标签
    const children = pushStartInstance(
      segment.chunks,
      type,
      props,
      request.resumableState,
      request.renderState,
      task.hoistableState,
      task.formatContext,
      segment.lastPushedText,
      task.isFallback,
    );
    segment.lastPushedText = false;
    const prevContext = task.formatContext;
    const prevKeyPath = task.keyPath;
    //  创建子元素的上下文
    task.formatContext = getChildFormatContext(prevContext, type, props);
    task.keyPath = keyPath;

    // 继续渲染内部内容
    renderNode(request, task, children, -1);

    // We expect that errors will fatal the whole task and that we don't need
    // the correct context. Therefore this is not in a finally.
    task.formatContext = prevContext;
    task.keyPath = prevKeyPath;
    //  
    pushEndInstance(
      segment.chunks,
      type,
      props,
      request.resumableState,
      prevContext,
    );
    segment.lastPushedText = false;
  }
}

function shouldConstruct(Component: any) {
  return Component.prototype && Component.prototype.isReactComponent;
}

function renderWithHooks<Props, SecondArg>(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  Component: (p: Props, arg: SecondArg) => any,
  props: Props,
  secondArg: SecondArg,
): any {
  //  处理可能存在的Promise状态
  const prevThenableState = task.thenableState;
  task.thenableState = null;

  const componentIdentity = {};
  //  预制hooks相关的配置
  prepareToUseHooks(
    request,
    task,
    keyPath,
    componentIdentity,
    prevThenableState,
  );
  
  let result;
  if (__DEV__) {
    result = callComponentInDEV(Component, props, secondArg);
  } else {
    //  执行函数组件，包括hooks。
    result = Component(props, secondArg);
  }
  // 处理渲染阶段更新
  return finishHooks(Component, props, result, secondArg);
}

function finishClassComponent(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  instance: any,
  Component: any,
  props: any,
): ReactNodeList {
  let nextChildren;
  if (__DEV__) {
    nextChildren = (callRenderInDEV(instance): any);
  } else {
    nextChildren = instance.render();
  }
  if (request.status === ABORTING) {
    // eslint-disable-next-line no-throw-literal
    throw null;
  }

  if (__DEV__) {
    if (instance.props !== props) {
      if (!didWarnAboutReassigningProps) {
        console.error(
          'It looks like %s is reassigning its own `this.props` while rendering. ' +
            'This is not supported and can lead to confusing bugs.',
          getComponentNameFromType(Component) || 'a component',
        );
      }
      didWarnAboutReassigningProps = true;
    }
  }

  if (!disableLegacyContext) {
    const childContextTypes = Component.childContextTypes;
    if (childContextTypes !== null && childContextTypes !== undefined) {
      const previousContext = task.legacyContext;
      const mergedContext = processChildContext(
        instance,
        Component,
        previousContext,
        childContextTypes,
      );
      task.legacyContext = mergedContext;
      renderNodeDestructive(request, task, nextChildren, -1);
      task.legacyContext = previousContext;
      return;
    }
  }

  const prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  renderNodeDestructive(request, task, nextChildren, -1);
  task.keyPath = prevKeyPath;
}

export function resolveClassComponentProps(
  Component: any,
  baseProps: Object,
): Object {
  let newProps = baseProps;

  if (enableRefAsProp) {
    // Remove ref from the props object, if it exists.
    if ('ref' in baseProps) {
      newProps = ({}: any);
      for (const propName in baseProps) {
        if (propName !== 'ref') {
          newProps[propName] = baseProps[propName];
        }
      }
    }
  }

  // Resolve default props.
  const defaultProps = Component.defaultProps;
  if (
    defaultProps &&
    // If disableDefaultPropsExceptForClasses is true, we always resolve
    // default props here, rather than in the JSX runtime.
    disableDefaultPropsExceptForClasses
  ) {
    // We may have already copied the props object above to remove ref. If so,
    // we can modify that. Otherwise, copy the props object with Object.assign.
    if (newProps === baseProps) {
      newProps = assign({}, newProps, baseProps);
    }
    // Taken from old JSX runtime, where this used to live.
    for (const propName in defaultProps) {
      if (newProps[propName] === undefined) {
        newProps[propName] = defaultProps[propName];
      }
    }
  }

  return newProps;
}

function renderClassComponent(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  Component: any,
  props: any,
): void {
  const resolvedProps = resolveClassComponentProps(Component, props);
  const maskedContext = !disableLegacyContext
    ? getMaskedContext(Component, task.legacyContext)
    : undefined;
  const instance = constructClassInstance(
    Component,
    resolvedProps,
    maskedContext,
  );
  mountClassInstance(instance, Component, resolvedProps, maskedContext);
  finishClassComponent(
    request,
    task,
    keyPath,
    instance,
    Component,
    resolvedProps,
  );
}

const didWarnAboutBadClass: {[string]: boolean} = {};
const didWarnAboutContextTypes: {[string]: boolean} = {};
const didWarnAboutContextTypeOnFunctionComponent: {[string]: boolean} = {};
const didWarnAboutGetDerivedStateOnFunctionComponent: {[string]: boolean} = {};
let didWarnAboutReassigningProps = false;
const didWarnAboutDefaultPropsOnFunctionComponent: {[string]: boolean} = {};
let didWarnAboutGenerators = false;
let didWarnAboutMaps = false;

function renderFunctionComponent(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  Component: any,
  props: any,
): void {
  let legacyContext;
  if (!disableLegacyContext && !disableLegacyContextForFunctionComponents) {
    legacyContext = getMaskedContext(Component, task.legacyContext);
  }
  if (__DEV__) {
    if (
      Component.prototype &&
      typeof Component.prototype.render === 'function'
    ) {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutBadClass[componentName]) {
        console.error(
          "The <%s /> component appears to have a render method, but doesn't extend React.Component. " +
            'This is likely to cause errors. Change %s to extend React.Component instead.',
          componentName,
          componentName,
        );
        didWarnAboutBadClass[componentName] = true;
      }
    }
  }

  const value = renderWithHooks(
    request,
    task,
    keyPath,
    Component,
    props,
    legacyContext,
  );
  if (request.status === ABORTING) {
    // eslint-disable-next-line no-throw-literal
    throw null;
  }

  const hasId = checkDidRenderIdHook();
  const actionStateCount = getActionStateCount();
  const actionStateMatchingIndex = getActionStateMatchingIndex();

  if (__DEV__) {
    if (Component.contextTypes) {
      const componentName = getComponentNameFromType(Component) || 'Unknown';
      if (!didWarnAboutContextTypes[componentName]) {
        didWarnAboutContextTypes[componentName] = true;
        if (disableLegacyContext) {
          console.error(
            '%s uses the legacy contextTypes API which was removed in React 19. ' +
              'Use React.createContext() with React.useContext() instead. ' +
              '(https://react.dev/link/legacy-context)',
            componentName,
          );
        } else {
          console.error(
            '%s uses the legacy contextTypes API which will be removed soon. ' +
              'Use React.createContext() with React.useContext() instead. ' +
              '(https://react.dev/link/legacy-context)',
            componentName,
          );
        }
      }
    }
  }
  if (__DEV__) {
    validateFunctionComponentInDev(Component);
  }
  finishFunctionComponent(
    request,
    task,
    keyPath,
    value,
    hasId,
    actionStateCount,
    actionStateMatchingIndex,
  );
}

function finishFunctionComponent(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  children: ReactNodeList,
  hasId: boolean,
  actionStateCount: number,
  actionStateMatchingIndex: number,
) {
  let didEmitActionStateMarkers = false;
  if (actionStateCount !== 0 && request.formState !== null) {
    // For each useActionState hook, emit a marker that indicates whether we
    // rendered using the form state passed at the root. We only emit these
    // markers if form state is passed at the root.
    const segment = task.blockedSegment;
    if (segment === null) {
      // Implies we're in reumable mode.
    } else {
      didEmitActionStateMarkers = true;
      const target = segment.chunks;
      for (let i = 0; i < actionStateCount; i++) {
        if (i === actionStateMatchingIndex) {
          pushFormStateMarkerIsMatching(target);
        } else {
          pushFormStateMarkerIsNotMatching(target);
        }
      }
    }
  }

  const prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  if (hasId) {
    // This component materialized an id. We treat this as its own level, with
    // a single "child" slot.
    const prevTreeContext = task.treeContext;
    const totalChildren = 1;
    const index = 0;
    // Modify the id context. Because we'll need to reset this if something
    // suspends or errors, we'll use the non-destructive render path.
    task.treeContext = pushTreeContext(prevTreeContext, totalChildren, index);
    renderNode(request, task, children, -1);
    // Like the other contexts, this does not need to be in a finally block
    // because renderNode takes care of unwinding the stack.
    task.treeContext = prevTreeContext;
  } else if (didEmitActionStateMarkers) {
    // If there were useActionState hooks, we must use the non-destructive path
    // because this component is not a pure indirection; we emitted markers
    // to the stream.
    renderNode(request, task, children, -1);
  } else {
    // We're now successfully past this task, and we haven't modified the
    // context stack. We don't have to pop back to the previous task every
    // again, so we can use the destructive recursive form.
    renderNodeDestructive(request, task, children, -1);
  }
  task.keyPath = prevKeyPath;
}

function validateFunctionComponentInDev(Component: any): void {
  if (__DEV__) {
    if (Component && Component.childContextTypes) {
      console.error(
        'childContextTypes cannot be defined on a function component.\n' +
          '  %s.childContextTypes = ...',
        Component.displayName || Component.name || 'Component',
      );
    }

    if (
      !disableDefaultPropsExceptForClasses &&
      Component.defaultProps !== undefined
    ) {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutDefaultPropsOnFunctionComponent[componentName]) {
        console.error(
          '%s: Support for defaultProps will be removed from function components ' +
            'in a future major release. Use JavaScript default parameters instead.',
          componentName,
        );
        didWarnAboutDefaultPropsOnFunctionComponent[componentName] = true;
      }
    }

    if (typeof Component.getDerivedStateFromProps === 'function') {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutGetDerivedStateOnFunctionComponent[componentName]) {
        console.error(
          '%s: Function components do not support getDerivedStateFromProps.',
          componentName,
        );
        didWarnAboutGetDerivedStateOnFunctionComponent[componentName] = true;
      }
    }

    if (
      typeof Component.contextType === 'object' &&
      Component.contextType !== null
    ) {
      const componentName = getComponentNameFromType(Component) || 'Unknown';

      if (!didWarnAboutContextTypeOnFunctionComponent[componentName]) {
        console.error(
          '%s: Function components do not support contextType.',
          componentName,
        );
        didWarnAboutContextTypeOnFunctionComponent[componentName] = true;
      }
    }
  }
}

function resolveDefaultPropsOnNonClassComponent(
  Component: any,
  baseProps: Object,
): Object {
  if (disableDefaultPropsExceptForClasses) {
    // Support for defaultProps is removed in React 19 for all types
    // except classes.
    return baseProps;
  }
  if (Component && Component.defaultProps) {
    // Resolve default props. Taken from ReactElement
    const props = assign({}, baseProps);
    const defaultProps = Component.defaultProps;
    for (const propName in defaultProps) {
      if (props[propName] === undefined) {
        props[propName] = defaultProps[propName];
      }
    }
    return props;
  }
  return baseProps;
}

function renderForwardRef(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  type: any,
  props: Object,
  ref: any,
): void {
  let propsWithoutRef;
  if (enableRefAsProp && 'ref' in props) {
    // `ref` is just a prop now, but `forwardRef` expects it to not appear in
    // the props object. This used to happen in the JSX runtime, but now we do
    // it here.
    propsWithoutRef = ({}: {[string]: any});
    for (const key in props) {
      // Since `ref` should only appear in props via the JSX transform, we can
      // assume that this is a plain object. So we don't need a
      // hasOwnProperty check.
      if (key !== 'ref') {
        propsWithoutRef[key] = props[key];
      }
    }
  } else {
    propsWithoutRef = props;
  }

  const children = renderWithHooks(
    request,
    task,
    keyPath,
    type.render,
    propsWithoutRef,
    ref,
  );
  //  判断是否使用了useId的钩子
  const hasId = checkDidRenderIdHook();
  //  获取组件中使用useActionState(或useFormState)钩子的数量
  const actionStateCount = getActionStateCount();
  //  useActionState相关
  const actionStateMatchingIndex = getActionStateMatchingIndex();
  //  
  finishFunctionComponent(
    request,
    task,
    keyPath,
    children,
    hasId,
    actionStateCount,
    actionStateMatchingIndex,
  );
}

function renderMemo(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  type: any,
  props: Object,
  ref: any,
): void {
  const innerType = type.type;
  const resolvedProps = resolveDefaultPropsOnNonClassComponent(
    innerType,
    props,
  );
  renderElement(request, task, keyPath, innerType, resolvedProps, ref);
}

function renderContextConsumer(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  context: ReactContext<any>,
  props: Object,
): void {
  const render = props.children;

  if (__DEV__) {
    if (typeof render !== 'function') {
      console.error(
        'A context consumer was rendered with multiple children, or a child ' +
          "that isn't a function. A context consumer expects a single child " +
          'that is a function. If you did pass a function, make sure there ' +
          'is no trailing or leading whitespace around it.',
      );
    }
  }

  const newValue = readContext(context);
  const newChildren = render(newValue);

  const prevKeyPath = task.keyPath;
  task.keyPath = keyPath;
  renderNodeDestructive(request, task, newChildren, -1);
  task.keyPath = prevKeyPath;
}

function renderContextProvider(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  context: ReactContext<any>,
  props: Object,
): void {
  const value = props.value;
  const children = props.children;
  let prevSnapshot;
  if (__DEV__) {
    prevSnapshot = task.context;
  }
  const prevKeyPath = task.keyPath;
  task.context = pushProvider(context, value);
  task.keyPath = keyPath;
  renderNodeDestructive(request, task, children, -1);
  task.context = popProvider(context);
  task.keyPath = prevKeyPath;
  if (__DEV__) {
    if (prevSnapshot !== task.context) {
      console.error(
        'Popping the context provider did not return back to the original snapshot. This is a bug in React.',
      );
    }
  }
}

function renderLazyComponent(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  lazyComponent: LazyComponentType<any, any>,
  props: Object,
  ref: any,
): void {
  let Component;
  if (__DEV__) {
    Component = callLazyInitInDEV(lazyComponent);
  } else {
    const payload = lazyComponent._payload;
    const init = lazyComponent._init;
    Component = init(payload);
  }
  if (request.status === ABORTING) {
    // eslint-disable-next-line no-throw-literal
    throw null;
  }
  const resolvedProps = resolveDefaultPropsOnNonClassComponent(
    Component,
    props,
  );
  renderElement(request, task, keyPath, Component, resolvedProps, ref);
}

function renderOffscreen(
  request: Request,
  task: Task,
  keyPath: KeyNode,
  props: Object,
): void {
  const mode: ?OffscreenMode = (props.mode: any);
  if (mode === 'hidden') {
    // A hidden Offscreen boundary is not server rendered. Prerendering happens
    // on the client.
  } else {
    // A visible Offscreen boundary is treated exactly like a fragment: a
    // pure indirection.
    const prevKeyPath = task.keyPath;
    task.keyPath = keyPath;
    renderNodeDestructive(request, task, props.children, -1);
    task.keyPath = prevKeyPath;
  }
}

function renderElement(
  request: Request,
  task: Task,
  keyPath: KeyNode,// 元素在组件树的位置，用户水合
  type: any,
  props: Object,
  ref: any,
): void {
  //  函数组件/类组件
  if (typeof type === 'function') {
    if (shouldConstruct(type)) {
      renderClassComponent(request, task, keyPath, type, props);
      return;
    } else {
      renderFunctionComponent(request, task, keyPath, type, props);
      return;
    }
  }
  //  原生DOM
  if (typeof type === 'string') {
    renderHostElement(request, task, keyPath, type, props);
    return;
  }
  //
  switch (type) {
    // LegacyHidden acts the same as a fragment. This only works because we
    // currently assume that every instance of LegacyHidden is accompanied by a
    // host component wrapper. In the hidden mode, the host component is given a
    // `hidden` attribute, which ensures that the initial HTML is not visible.
    // To support the use of LegacyHidden as a true fragment, without an extra
    // DOM node, we would have to hide the initial HTML in some other way.
    // TODO: Delete in LegacyHidden. It's an unstable API only used in the
    // www build. As a migration step, we could add a special prop to Offscreen
    // that simulates the old behavior (no hiding, no change to effects).
    case REACT_LEGACY_HIDDEN_TYPE:
    case REACT_DEBUG_TRACING_MODE_TYPE:
    case REACT_STRICT_MODE_TYPE:
    case REACT_PROFILER_TYPE:
    case REACT_FRAGMENT_TYPE: {
      const prevKeyPath = task.keyPath;
      task.keyPath = keyPath;
      renderNodeDestructive(request, task, props.children, -1);
      task.keyPath = prevKeyPath;
      return;
    }
    case REACT_OFFSCREEN_TYPE: {
      renderOffscreen(request, task, keyPath, props);
      return;
    }
    case REACT_SUSPENSE_LIST_TYPE: {
      // TODO: SuspenseList should control the boundaries.
      const prevKeyPath = task.keyPath;
      task.keyPath = keyPath;
      renderNodeDestructive(request, task, props.children, -1);
      task.keyPath = prevKeyPath;
      return;
    }
    case REACT_SCOPE_TYPE: {
      if (enableScopeAPI) {
        const prevKeyPath = task.keyPath;
        task.keyPath = keyPath;
        renderNodeDestructive(request, task, props.children, -1);
        task.keyPath = prevKeyPath;
        return;
      }
      throw new Error('ReactDOMServer does not yet support scope components.');
    }
    case REACT_SUSPENSE_TYPE: {
      if (
        enableSuspenseAvoidThisFallbackFizz &&
        props.unstable_avoidThisFallback === true
      ) {
        renderBackupSuspenseBoundary(request, task, keyPath, props);
      } else {
        renderSuspenseBoundary(request, task, keyPath, props);
      }
      return;
    }
  }

  if (typeof type === 'object' && type !== null) {
    switch (type.$$typeof) {
      case REACT_FORWARD_REF_TYPE: {
        renderForwardRef(request, task, keyPath, type, props, ref);
        return;
      }
      case REACT_MEMO_TYPE: {
        renderMemo(request, task, keyPath, type, props, ref);
        return;
      }
      case REACT_PROVIDER_TYPE: {
        if (!enableRenderableContext) {
          const context: ReactContext<any> = (type: any)._context;
          renderContextProvider(request, task, keyPath, context, props);
          return;
        }
        // Fall through
      }
      case REACT_CONTEXT_TYPE: {
        if (enableRenderableContext) {
          const context = type;
          renderContextProvider(request, task, keyPath, context, props);
          return;
        } else {
          let context: ReactContext<any> = (type: any);
          if (__DEV__) {
            if ((context: any)._context !== undefined) {
              context = (context: any)._context;
            }
          }
          renderContextConsumer(request, task, keyPath, context, props);
          return;
        }
      }
      case REACT_CONSUMER_TYPE: {
        if (enableRenderableContext) {
          const context: ReactContext<any> = (type: ReactConsumerType<any>)
            ._context;
          renderContextConsumer(request, task, keyPath, context, props);
          return;
        }
        // Fall through
      }
      case REACT_LAZY_TYPE: {
        renderLazyComponent(request, task, keyPath, type, props, ref);
        return;
      }
    }
  }

  let info = '';
  if (__DEV__) {
    if (
      type === undefined ||
      (typeof type === 'object' &&
        type !== null &&
        Object.keys(type).length === 0)
    ) {
      info +=
        ' You likely forgot to export your component from the file ' +
        "it's defined in, or you might have mixed up default and " +
        'named imports.';
    }
  }

  throw new Error(
    'Element type is invalid: expected a string (for built-in ' +
      'components) or a class/function (for composite components) ' +
      `but got: ${type == null ? type : typeof type}.${info}`,
  );
}

function resumeNode(
  request: Request,
  task: ReplayTask,
  segmentId: number,
  node: ReactNodeList,
  childIndex: number,
): void {
  const prevReplay = task.replay;
  const blockedBoundary = task.blockedBoundary;
  const resumedSegment = createPendingSegment(
    request,
    0,
    null,
    task.formatContext,
    false,
    false,
  );
  resumedSegment.id = segmentId;
  resumedSegment.parentFlushed = true;
  try {
    // Convert the current ReplayTask to a RenderTask.
    const renderTask: RenderTask = (task: any);
    renderTask.replay = null;
    renderTask.blockedSegment = resumedSegment;
    renderNode(request, task, node, childIndex);
    resumedSegment.status = COMPLETED;
    if (blockedBoundary === null) {
      request.completedRootSegment = resumedSegment;
    } else {
      queueCompletedSegment(blockedBoundary, resumedSegment);
      if (blockedBoundary.parentFlushed) {
        request.partialBoundaries.push(blockedBoundary);
      }
    }
  } finally {
    // Restore to a ReplayTask.
    task.replay = prevReplay;
    task.blockedSegment = null;
  }
}

function replayElement(
  request: Request,
  task: ReplayTask,
  keyPath: KeyNode,
  name: null | string,
  keyOrIndex: number | string,
  childIndex: number,
  type: any,
  props: Object,
  ref: any,
  replay: ReplaySet,
): void {
  // We're replaying. Find the path to follow.
  const replayNodes = replay.nodes;
  for (let i = 0; i < replayNodes.length; i++) {
    // Flow doesn't support refinement on tuples so we do it manually here.
    const node = replayNodes[i];
    if (keyOrIndex !== node[1]) {
      continue;
    }
    if (node.length === 4) {
      // Matched a replayable path.
      // Let's double check that the component name matches as a precaution.
      if (name !== null && name !== node[0]) {
        throw new Error(
          'Expected the resume to render <' +
            (node[0]: any) +
            '> in this slot but instead it rendered <' +
            name +
            '>. ' +
            "The tree doesn't match so React will fallback to client rendering.",
        );
      }
      const childNodes = node[2];
      const childSlots = node[3];
      const currentNode = task.node;
      task.replay = {nodes: childNodes, slots: childSlots, pendingTasks: 1};
      try {
        renderElement(request, task, keyPath, type, props, ref);
        if (
          task.replay.pendingTasks === 1 &&
          task.replay.nodes.length > 0
          // TODO check remaining slots
        ) {
          throw new Error(
            "Couldn't find all resumable slots by key/index during replaying. " +
              "The tree doesn't match so React will fallback to client rendering.",
          );
        }
        task.replay.pendingTasks--;
      } catch (x) {
        if (
          typeof x === 'object' &&
          x !== null &&
          (x === SuspenseException || typeof x.then === 'function')
        ) {
          // Suspend
          if (task.node === currentNode) {
            // This same element suspended so we need to pop the replay we just added.
            task.replay = replay;
          }
          throw x;
        }
        task.replay.pendingTasks--;
        // Unlike regular render, we don't terminate the siblings if we error
        // during a replay. That's because this component didn't actually error
        // in the original prerender. What's unable to complete is the child
        // replay nodes which might be Suspense boundaries which are able to
        // absorb the error and we can still continue with siblings.
        const thrownInfo = getThrownInfo(task.componentStack);
        erroredReplay(
          request,
          task.blockedBoundary,
          x,
          thrownInfo,
          childNodes,
          childSlots,
          __DEV__ && enableOwnerStacks ? task.debugTask : null,
        );
      }
      task.replay = replay;
    } else {
      // Let's double check that the component type matches.
      if (type !== REACT_SUSPENSE_TYPE) {
        const expectedType = 'Suspense';
        throw new Error(
          'Expected the resume to render <' +
            expectedType +
            '> in this slot but instead it rendered <' +
            (getComponentNameFromType(type) || 'Unknown') +
            '>. ' +
            "The tree doesn't match so React will fallback to client rendering.",
        );
      }
      // Matched a replayable path.
      replaySuspenseBoundary(
        request,
        task,
        keyPath,
        props,
        node[5],
        node[2],
        node[3],
        node[4] === null ? [] : node[4][2],
        node[4] === null ? null : node[4][3],
      );
    }
    // We finished rendering this node, so now we can consume this
    // slot. This must happen after in case we rerender this task.
    replayNodes.splice(i, 1);
    return;
  }
  // We didn't find any matching nodes. We assume that this element was already
  // rendered in the prelude and skip it.
}

function validateIterable(
  task: Task,
  iterable: Iterable<any>,
  childIndex: number,
  iterator: Iterator<any>,
  iteratorFn: () => ?Iterator<any>,
): void {
  if (__DEV__) {
    if (iterator === iterable) {
      // We don't support rendering Generators as props because it's a mutation.
      // See https://github.com/facebook/react/issues/12995
      // We do support generators if they were created by a GeneratorFunction component
      // as its direct child since we can recreate those by rerendering the component
      // as needed.
      const isGeneratorComponent =
        childIndex === -1 && // Only the root child is valid
        task.componentStack !== null &&
        typeof task.componentStack.type === 'function' && // FunctionComponent
        // $FlowFixMe[method-unbinding]
        Object.prototype.toString.call(task.componentStack.type) ===
          '[object GeneratorFunction]' &&
        // $FlowFixMe[method-unbinding]
        Object.prototype.toString.call(iterator) === '[object Generator]';
      if (!isGeneratorComponent) {
        if (!didWarnAboutGenerators) {
          console.error(
            'Using Iterators as children is unsupported and will likely yield ' +
              'unexpected results because enumerating a generator mutates it. ' +
              'You may convert it to an array with `Array.from()` or the ' +
              '`[...spread]` operator before rendering. You can also use an ' +
              'Iterable that can iterate multiple times over the same items.',
          );
        }
        didWarnAboutGenerators = true;
      }
    } else if ((iterable: any).entries === iteratorFn) {
      // Warn about using Maps as children
      if (!didWarnAboutMaps) {
        console.error(
          'Using Maps as children is not supported. ' +
            'Use an array of keyed ReactElements instead.',
        );
        didWarnAboutMaps = true;
      }
    }
  }
}

function validateAsyncIterable(
  task: Task,
  iterable: AsyncIterable<any>,
  childIndex: number,
  iterator: AsyncIterator<any>,
): void {
  if (__DEV__) {
    if (iterator === iterable) {
      // We don't support rendering Generators as props because it's a mutation.
      // See https://github.com/facebook/react/issues/12995
      // We do support generators if they were created by a GeneratorFunction component
      // as its direct child since we can recreate those by rerendering the component
      // as needed.
      const isGeneratorComponent =
        childIndex === -1 && // Only the root child is valid
        task.componentStack !== null &&
        typeof task.componentStack.type === 'function' && // FunctionComponent
        // $FlowFixMe[method-unbinding]
        Object.prototype.toString.call(task.componentStack.type) ===
          '[object AsyncGeneratorFunction]' &&
        // $FlowFixMe[method-unbinding]
        Object.prototype.toString.call(iterator) === '[object AsyncGenerator]';
      if (!isGeneratorComponent) {
        if (!didWarnAboutGenerators) {
          console.error(
            'Using AsyncIterators as children is unsupported and will likely yield ' +
              'unexpected results because enumerating a generator mutates it. ' +
              'You can use an AsyncIterable that can iterate multiple times over ' +
              'the same items.',
          );
        }
        didWarnAboutGenerators = true;
      }
    }
  }
}

function warnOnFunctionType(invalidChild: Function) {
  if (__DEV__) {
    const name = invalidChild.displayName || invalidChild.name || 'Component';
    console.error(
      'Functions are not valid as a React child. This may happen if ' +
        'you return %s instead of <%s /> from render. ' +
        'Or maybe you meant to call this function rather than return it.',
      name,
      name,
    );
  }
}

function warnOnSymbolType(invalidChild: symbol) {
  if (__DEV__) {
    // eslint-disable-next-line react-internal/safe-string-coercion
    const name = String(invalidChild);
    console.error('Symbols are not valid as a React child.\n' + '  %s', name);
  }
}

// This function by it self renders a node and consumes the task by mutating it
// to update the current execution state.
function renderNodeDestructive(
  request: Request,
  task: Task,
  node: ReactNodeList,
  childIndex: number,
): void {
  if (task.replay !== null && typeof task.replay.slots === 'number') {
    //  恢复任务
    const resumeSegmentID = task.replay.slots;
    resumeNode(request, task, resumeSegmentID, node, childIndex);
    return;
  }

  //  暂存相应的内容，以便恢复
  task.node = node;
  task.childIndex = childIndex;

  const previousComponentStack = task.componentStack;
  const previousDebugTask =
    __DEV__ && enableOwnerStacks ? task.debugTask : null;

  pushComponentStack(task);

  retryNode(request, task);

  task.componentStack = previousComponentStack;
  if (__DEV__ && enableOwnerStacks) {
    task.debugTask = previousDebugTask;
  }
}
//  将React元素渲染成HTML
function retryNode(request: Request, task: Task): void {
  const node = task.node;// 当前要渲染的节点
  const childIndex = task.childIndex;// 当前节点在父节点的位置

  if (node === null) {
    return;
  }

  // Handle object types
  if (typeof node === 'object') {
    switch ((node: any).$$typeof) {
      //  处理React元素类型
      case REACT_ELEMENT_TYPE: {
        const element: any = node;
        const type = element.type;
        const key = element.key;
        const props = element.props;
        //  获取ref
        let ref;
        //  19开始，ref直接从props去
        if (enableRefAsProp) {
          // TODO: This is a temporary, intermediate step. Once the feature
          // flag is removed, we should get the ref off the props object right
          // before using it.
          const refProp = props.ref;
          ref = refProp !== undefined ? refProp : null;
        } else {
          ref = element.ref;
        }

        const debugTask: null | ConsoleTask =
          __DEV__ && enableOwnerStacks ? task.debugTask : null;

        const name = getComponentNameFromType(type);
        const keyOrIndex =
          key == null ? (childIndex === -1 ? 0 : childIndex) : key;
        const keyPath = [task.keyPath, name, keyOrIndex];
        // 基于是否重试执行replayElement/renderElement
        if (task.replay !== null) {
          if (debugTask) {
            debugTask.run(
              replayElement.bind(
                null,
                request,
                task,
                keyPath,
                name,
                keyOrIndex,
                childIndex,
                type,
                props,
                ref,
                task.replay,
              ),
            );
          } else {
            replayElement(
              request,
              task,
              keyPath,
              name,
              keyOrIndex,
              childIndex,
              type,
              props,
              ref,
              task.replay,
            );
          }
          // No matches found for this node. We assume it's already emitted in the
          // prelude and skip it during the replay.
        } else {
          // We're doing a plain render.
          if (debugTask) {
            debugTask.run(
              renderElement.bind(
                null,
                request,
                task,
                keyPath,
                type,
                props,
                ref,
              ),
            );
          } else {
            renderElement(request, task, keyPath, type, props, ref);
          }
        }
        return;
      }
      case REACT_PORTAL_TYPE:
        throw new Error(
          'Portals are not currently supported by the server renderer. ' +
            'Render them conditionally so that they only appear on the client render.',
        );
      case REACT_LAZY_TYPE: {
        const lazyNode: LazyComponentType<any, any> = (node: any);
        let resolvedNode;
        if (__DEV__) {
          resolvedNode = callLazyInitInDEV(lazyNode);
        } else {
          const payload = lazyNode._payload;
          const init = lazyNode._init;
          resolvedNode = init(payload);
        }
        if (request.status === ABORTING) {
          // eslint-disable-next-line no-throw-literal
          throw null;
        }
        // Now we render the resolved node
        renderNodeDestructive(request, task, resolvedNode, childIndex);
        return;
      }
    }

    if (isArray(node)) {
      renderChildrenArray(request, task, node, childIndex);
      return;
    }

    const iteratorFn = getIteratorFn(node);
    if (iteratorFn) {
      const iterator = iteratorFn.call(node);
      if (iterator) {
        if (__DEV__) {
          validateIterable(task, node, childIndex, iterator, iteratorFn);
        }
        // We need to know how many total children are in this set, so that we
        // can allocate enough id slots to acommodate them. So we must exhaust
        // the iterator before we start recursively rendering the children.
        // TODO: This is not great but I think it's inherent to the id
        // generation algorithm.
        let step = iterator.next();
        if (!step.done) {
          const children = [];
          do {
            children.push(step.value);
            step = iterator.next();
          } while (!step.done);
          renderChildrenArray(request, task, children, childIndex);
        }
        return;
      }
    }

    if (
      enableAsyncIterableChildren &&
      typeof (node: any)[ASYNC_ITERATOR] === 'function'
    ) {
      const iterator: AsyncIterator<ReactNodeList> = (node: any)[
        ASYNC_ITERATOR
      ]();
      if (iterator) {
        if (__DEV__) {
          validateAsyncIterable(task, (node: any), childIndex, iterator);
        }
        // TODO: Update the task.node to be the iterator to avoid asking
        // for new iterators, but we currently warn for rendering these
        // so needs some refactoring to deal with the warning.

        // Restore the thenable state before resuming.
        const prevThenableState = task.thenableState;
        task.thenableState = null;
        prepareToUseThenableState(prevThenableState);

        // We need to know how many total children are in this set, so that we
        // can allocate enough id slots to acommodate them. So we must exhaust
        // the iterator before we start recursively rendering the children.
        // TODO: This is not great but I think it's inherent to the id
        // generation algorithm.
        const children = [];

        let done = false;

        if (iterator === node) {
          // If it's an iterator we need to continue reading where we left
          // off. We can do that by reading the first few rows from the previous
          // thenable state.
          // $FlowFixMe
          let step = readPreviousThenableFromState();
          while (step !== undefined) {
            if (step.done) {
              done = true;
              break;
            }
            children.push(step.value);
            step = readPreviousThenableFromState();
          }
        }

        if (!done) {
          let step = unwrapThenable(iterator.next());
          while (!step.done) {
            children.push(step.value);
            step = unwrapThenable(iterator.next());
          }
        }
        renderChildrenArray(request, task, children, childIndex);
        return;
      }
    }

    // Usables are a valid React node type. When React encounters a Usable in
    // a child position, it unwraps it using the same algorithm as `use`. For
    // example, for promises, React will throw an exception to unwind the
    // stack, then replay the component once the promise resolves.
    //
    // A difference from `use` is that React will keep unwrapping the value
    // until it reaches a non-Usable type.
    //
    // e.g. Usable<Usable<Usable<T>>> should resolve to T
    const maybeUsable: Object = node;
    if (typeof maybeUsable.then === 'function') {
      // Clear any previous thenable state that was created by the unwrapping.
      task.thenableState = null;
      const thenable: Thenable<ReactNodeList> = (maybeUsable: any);
      const result = renderNodeDestructive(
        request,
        task,
        unwrapThenable(thenable),
        childIndex,
      );
      return result;
    }

    if (maybeUsable.$$typeof === REACT_CONTEXT_TYPE) {
      const context: ReactContext<ReactNodeList> = (maybeUsable: any);
      return renderNodeDestructive(
        request,
        task,
        readContext(context),
        childIndex,
      );
    }

    // $FlowFixMe[method-unbinding]
    const childString = Object.prototype.toString.call(node);

    throw new Error(
      `Objects are not valid as a React child (found: ${
        childString === '[object Object]'
          ? 'object with keys {' + Object.keys(node).join(', ') + '}'
          : childString
      }). ` +
        'If you meant to render a collection of children, use an array ' +
        'instead.',
    );
  }

  if (typeof node === 'string') {
    const segment = task.blockedSegment;
    if (segment === null) {
      // We assume a text node doesn't have a representation in the replay set,
      // since it can't postpone. If it does, it'll be left unmatched and error.
    } else {
      segment.lastPushedText = pushTextInstance(
        segment.chunks,
        node,
        request.renderState,
        segment.lastPushedText,
      );
    }
    return;
  }

  if (typeof node === 'number' || typeof node === 'bigint') {
    const segment = task.blockedSegment;
    if (segment === null) {
      // We assume a text node doesn't have a representation in the replay set,
      // since it can't postpone. If it does, it'll be left unmatched and error.
    } else {
      segment.lastPushedText = pushTextInstance(
        segment.chunks,
        '' + node,
        request.renderState,
        segment.lastPushedText,
      );
    }
    return;
  }

  if (__DEV__) {
    if (typeof node === 'function') {
      warnOnFunctionType(node);
    }
    if (typeof node === 'symbol') {
      warnOnSymbolType(node);
    }
  }
}

function replayFragment(
  request: Request,
  task: ReplayTask,
  children: Array<any>,
  childIndex: number,
): void {
  // If we're supposed follow this array, we'd expect to see a ReplayNode matching
  // this fragment.
  const replay = task.replay;
  const replayNodes = replay.nodes;
  for (let j = 0; j < replayNodes.length; j++) {
    const node = replayNodes[j];
    if (node[1] !== childIndex) {
      continue;
    }
    // Matched a replayable path.
    const childNodes = node[2];
    const childSlots = node[3];
    task.replay = {nodes: childNodes, slots: childSlots, pendingTasks: 1};
    try {
      renderChildrenArray(request, task, children, -1);
      if (task.replay.pendingTasks === 1 && task.replay.nodes.length > 0) {
        throw new Error(
          "Couldn't find all resumable slots by key/index during replaying. " +
            "The tree doesn't match so React will fallback to client rendering.",
        );
      }
      task.replay.pendingTasks--;
    } catch (x) {
      if (
        typeof x === 'object' &&
        x !== null &&
        (x === SuspenseException || typeof x.then === 'function')
      ) {
        // Suspend
        throw x;
      }
      task.replay.pendingTasks--;
      // Unlike regular render, we don't terminate the siblings if we error
      // during a replay. That's because this component didn't actually error
      // in the original prerender. What's unable to complete is the child
      // replay nodes which might be Suspense boundaries which are able to
      // absorb the error and we can still continue with siblings.
      // This is an error, stash the component stack if it is null.
      const thrownInfo = getThrownInfo(task.componentStack);
      erroredReplay(
        request,
        task.blockedBoundary,
        x,
        thrownInfo,
        childNodes,
        childSlots,
        __DEV__ && enableOwnerStacks ? task.debugTask : null,
      );
    }
    task.replay = replay;
    // We finished rendering this node, so now we can consume this
    // slot. This must happen after in case we rerender this task.
    replayNodes.splice(j, 1);
    break;
  }
}

function warnForMissingKey(request: Request, task: Task, child: mixed): void {
  if (__DEV__) {
    if (
      child === null ||
      typeof child !== 'object' ||
      (child.$$typeof !== REACT_ELEMENT_TYPE &&
        child.$$typeof !== REACT_PORTAL_TYPE)
    ) {
      return;
    }

    if (
      !child._store ||
      ((child._store.validated || child.key != null) &&
        child._store.validated !== 2)
    ) {
      return;
    }

    if (typeof child._store !== 'object') {
      throw new Error(
        'React Component in warnForMissingKey should have a _store. ' +
          'This error is likely caused by a bug in React. Please file an issue.',
      );
    }

    // $FlowFixMe[cannot-write] unable to narrow type from mixed to writable object
    child._store.validated = 1;

    let didWarnForKey = request.didWarnForKey;
    if (didWarnForKey == null) {
      didWarnForKey = request.didWarnForKey = new WeakSet();
    }
    const parentStackFrame = task.componentStack;
    if (parentStackFrame === null || didWarnForKey.has(parentStackFrame)) {
      // We already warned for other children in this parent.
      return;
    }
    didWarnForKey.add(parentStackFrame);

    const componentName = getComponentNameFromType(child.type);
    const childOwner = child._owner;
    const parentOwner = parentStackFrame.owner;

    let currentComponentErrorInfo = '';
    if (parentOwner && typeof parentOwner.type !== 'undefined') {
      const name = getComponentNameFromType(parentOwner.type);
      if (name) {
        currentComponentErrorInfo =
          '\n\nCheck the render method of `' + name + '`.';
      }
    }
    if (!currentComponentErrorInfo) {
      if (componentName) {
        currentComponentErrorInfo = `\n\nCheck the top-level render call using <${componentName}>.`;
      }
    }

    // Usually the current owner is the offender, but if it accepts children as a
    // property, it may be the creator of the child that's responsible for
    // assigning it a key.
    let childOwnerAppendix = '';
    if (childOwner != null && parentOwner !== childOwner) {
      let ownerName = null;
      if (typeof childOwner.type !== 'undefined') {
        ownerName = getComponentNameFromType(childOwner.type);
      } else if (typeof childOwner.name === 'string') {
        ownerName = childOwner.name;
      }
      if (ownerName) {
        // Give the component that originally created this child.
        childOwnerAppendix = ` It was passed a child from ${ownerName}.`;
      }
    }

    // We create a fake component stack for the child to log the stack trace from.
    const previousComponentStack = task.componentStack;
    const stackFrame = createComponentStackFromType(
      task.componentStack,
      (child: any).type,
      (child: any)._owner,
      enableOwnerStacks ? (child: any)._debugStack : null,
    );
    task.componentStack = stackFrame;
    console.error(
      'Each child in a list should have a unique "key" prop.' +
        '%s%s See https://react.dev/link/warning-keys for more information.',
      currentComponentErrorInfo,
      childOwnerAppendix,
    );
    task.componentStack = previousComponentStack;
  }
}

function renderChildrenArray(
  request: Request,
  task: Task,
  children: Array<any>,
  childIndex: number,
): void {
  const prevKeyPath = task.keyPath;
  const previousComponentStack = task.componentStack;
  let previousDebugTask = null;
  if (__DEV__) {
    if (enableOwnerStacks) {
      previousDebugTask = task.debugTask;
    }
    // We read debugInfo from task.node instead of children because it might have been an
    // unwrapped iterable so we read from the original node.
    pushServerComponentStack(task, (task.node: any)._debugInfo);
  }
  if (childIndex !== -1) {
    task.keyPath = [task.keyPath, 'Fragment', childIndex];
    if (task.replay !== null) {
      replayFragment(
        request,
        // $FlowFixMe: Refined.
        task,
        children,
        childIndex,
      );
      task.keyPath = prevKeyPath;
      if (__DEV__) {
        task.componentStack = previousComponentStack;
        if (enableOwnerStacks) {
          task.debugTask = previousDebugTask;
        }
      }
      return;
    }
  }

  const prevTreeContext = task.treeContext;
  const totalChildren = children.length;

  if (task.replay !== null) {
    // Replay
    // First we need to check if we have any resume slots at this level.
    const resumeSlots = task.replay.slots;
    if (resumeSlots !== null && typeof resumeSlots === 'object') {
      for (let i = 0; i < totalChildren; i++) {
        const node = children[i];
        task.treeContext = pushTreeContext(prevTreeContext, totalChildren, i);
        // We need to use the non-destructive form so that we can safely pop back
        // up and render the sibling if something suspends.
        const resumeSegmentID = resumeSlots[i];
        // TODO: If this errors we should still continue with the next sibling.
        if (typeof resumeSegmentID === 'number') {
          resumeNode(request, task, resumeSegmentID, node, i);
          // We finished rendering this node, so now we can consume this
          // slot. This must happen after in case we rerender this task.
          delete resumeSlots[i];
        } else {
          renderNode(request, task, node, i);
        }
      }
      task.treeContext = prevTreeContext;
      task.keyPath = prevKeyPath;
      if (__DEV__) {
        task.componentStack = previousComponentStack;
        if (enableOwnerStacks) {
          task.debugTask = previousDebugTask;
        }
      }
      return;
    }
  }

  for (let i = 0; i < totalChildren; i++) {
    const node = children[i];
    if (__DEV__) {
      warnForMissingKey(request, task, node);
    }
    task.treeContext = pushTreeContext(prevTreeContext, totalChildren, i);
    // We need to use the non-destructive form so that we can safely pop back
    // up and render the sibling if something suspends.
    renderNode(request, task, node, i);
  }

  // Because this context is always set right before rendering every child, we
  // only need to reset it to the previous value at the very end.
  task.treeContext = prevTreeContext;
  task.keyPath = prevKeyPath;
  if (__DEV__) {
    task.componentStack = previousComponentStack;
    if (enableOwnerStacks) {
      task.debugTask = previousDebugTask;
    }
  }
}

function trackPostpone(
  request: Request,
  trackedPostpones: PostponedHoles,
  task: Task,
  segment: Segment,
): void {
  segment.status = POSTPONED;

  const keyPath = task.keyPath;
  const boundary = task.blockedBoundary;

  if (boundary === null) {
    segment.id = request.nextSegmentId++;
    trackedPostpones.rootSlots = segment.id;
    if (request.completedRootSegment !== null) {
      // Postpone the root if this was a deeper segment.
      request.completedRootSegment.status = POSTPONED;
    }
    return;
  }

  if (boundary !== null && boundary.status === PENDING) {
    boundary.status = POSTPONED;
    // We need to eagerly assign it an ID because we'll need to refer to
    // it before flushing and we know that we can't inline it.
    boundary.rootSegmentID = request.nextSegmentId++;

    const boundaryKeyPath = boundary.trackedContentKeyPath;
    if (boundaryKeyPath === null) {
      throw new Error(
        'It should not be possible to postpone at the root. This is a bug in React.',
      );
    }

    const fallbackReplayNode = boundary.trackedFallbackNode;

    const children: Array<ReplayNode> = [];
    if (boundaryKeyPath === keyPath && task.childIndex === -1) {
      // Assign ID
      if (segment.id === -1) {
        if (segment.parentFlushed) {
          // If this segment's parent was already flushed, it means we really just
          // skipped the parent and this segment is now the root.
          segment.id = boundary.rootSegmentID;
        } else {
          segment.id = request.nextSegmentId++;
        }
      }
      // We postponed directly inside the Suspense boundary so we mark this for resuming.
      const boundaryNode: ReplaySuspenseBoundary = [
        boundaryKeyPath[1],
        boundaryKeyPath[2],
        children,
        segment.id,
        fallbackReplayNode,
        boundary.rootSegmentID,
      ];
      trackedPostpones.workingMap.set(boundaryKeyPath, boundaryNode);
      addToReplayParent(boundaryNode, boundaryKeyPath[0], trackedPostpones);
      return;
    } else {
      let boundaryNode: void | ReplayNode =
        trackedPostpones.workingMap.get(boundaryKeyPath);
      if (boundaryNode === undefined) {
        boundaryNode = [
          boundaryKeyPath[1],
          boundaryKeyPath[2],
          children,
          null,
          fallbackReplayNode,
          boundary.rootSegmentID,
        ];
        trackedPostpones.workingMap.set(boundaryKeyPath, boundaryNode);
        addToReplayParent(boundaryNode, boundaryKeyPath[0], trackedPostpones);
      } else {
        // Upgrade to ReplaySuspenseBoundary.
        const suspenseBoundary: ReplaySuspenseBoundary = (boundaryNode: any);
        suspenseBoundary[4] = fallbackReplayNode;
        suspenseBoundary[5] = boundary.rootSegmentID;
      }
      // Fall through to add the child node.
    }
  }

  // We know that this will leave a hole so we might as well assign an ID now.
  // We might have one already if we had a parent that gave us its ID.
  if (segment.id === -1) {
    if (segment.parentFlushed && boundary !== null) {
      // If this segment's parent was already flushed, it means we really just
      // skipped the parent and this segment is now the root.
      segment.id = boundary.rootSegmentID;
    } else {
      segment.id = request.nextSegmentId++;
    }
  }

  if (task.childIndex === -1) {
    // Resume starting from directly inside the previous parent element.
    if (keyPath === null) {
      trackedPostpones.rootSlots = segment.id;
    } else {
      const workingMap = trackedPostpones.workingMap;
      let resumableNode = workingMap.get(keyPath);
      if (resumableNode === undefined) {
        resumableNode = [
          keyPath[1],
          keyPath[2],
          ([]: Array<ReplayNode>),
          segment.id,
        ];
        addToReplayParent(resumableNode, keyPath[0], trackedPostpones);
      } else {
        resumableNode[3] = segment.id;
      }
    }
  } else {
    let slots;
    if (keyPath === null) {
      slots = trackedPostpones.rootSlots;
      if (slots === null) {
        slots = trackedPostpones.rootSlots = ({}: {[index: number]: number});
      } else if (typeof slots === 'number') {
        throw new Error(
          'It should not be possible to postpone both at the root of an element ' +
            'as well as a slot below. This is a bug in React.',
        );
      }
    } else {
      const workingMap = trackedPostpones.workingMap;
      let resumableNode = workingMap.get(keyPath);
      if (resumableNode === undefined) {
        slots = ({}: {[index: number]: number});
        resumableNode = ([
          keyPath[1],
          keyPath[2],
          ([]: Array<ReplayNode>),
          slots,
        ]: ReplayNode);
        workingMap.set(keyPath, resumableNode);
        addToReplayParent(resumableNode, keyPath[0], trackedPostpones);
      } else {
        slots = resumableNode[3];
        if (slots === null) {
          slots = resumableNode[3] = ({}: {[index: number]: number});
        } else if (typeof slots === 'number') {
          throw new Error(
            'It should not be possible to postpone both at the root of an element ' +
              'as well as a slot below. This is a bug in React.',
          );
        }
      }
    }
    slots[task.childIndex] = segment.id;
  }
}

// In case a boundary errors, we need to stop tracking it because we won't
// resume it.
function untrackBoundary(request: Request, boundary: SuspenseBoundary) {
  const trackedPostpones = request.trackedPostpones;
  if (trackedPostpones === null) {
    return;
  }
  const boundaryKeyPath = boundary.trackedContentKeyPath;
  if (boundaryKeyPath === null) {
    return;
  }
  const boundaryNode: void | ReplayNode =
    trackedPostpones.workingMap.get(boundaryKeyPath);
  if (boundaryNode === undefined) {
    return;
  }

  // Downgrade to plain ReplayNode since we won't replay through it.
  // $FlowFixMe[cannot-write]: We intentionally downgrade this to the other tuple.
  boundaryNode.length = 4;
  // Remove any resumable slots.
  boundaryNode[2] = [];
  boundaryNode[3] = null;

  // TODO: We should really just remove the boundary from all parent paths too so
  // we don't replay the path to it.
}

function injectPostponedHole(
  request: Request,
  task: RenderTask,
  reason: string,
  thrownInfo: ThrownInfo,
): Segment {
  logPostpone(
    request,
    reason,
    thrownInfo,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );
  // Something suspended, we'll need to create a new segment and resolve it later.
  const segment = task.blockedSegment;
  const insertionIndex = segment.chunks.length;
  const newSegment = createPendingSegment(
    request,
    insertionIndex,
    null,
    task.formatContext,
    // Adopt the parent segment's leading text embed
    segment.lastPushedText,
    // Assume we are text embedded at the trailing edge
    true,
  );
  segment.children.push(newSegment);
  // Reset lastPushedText for current Segment since the new Segment "consumed" it
  segment.lastPushedText = false;
  return newSegment;
}

function spawnNewSuspendedReplayTask(
  request: Request,
  task: ReplayTask,
  thenableState: ThenableState | null,
): ReplayTask {
  return createReplayTask(
    request,
    thenableState,
    task.replay,
    task.node,
    task.childIndex,
    task.blockedBoundary,
    task.hoistableState,
    task.abortSet,
    task.keyPath,
    task.formatContext,
    task.context,
    task.treeContext,
    task.componentStack,
    task.isFallback,
    !disableLegacyContext ? task.legacyContext : emptyContextObject,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );
}

function spawnNewSuspendedRenderTask(
  request: Request,
  task: RenderTask,
  thenableState: ThenableState | null,
): RenderTask {
  // Something suspended, we'll need to create a new segment and resolve it later.
  const segment = task.blockedSegment;
  const insertionIndex = segment.chunks.length;
  const newSegment = createPendingSegment(
    request,
    insertionIndex,
    null,
    task.formatContext,
    // Adopt the parent segment's leading text embed
    segment.lastPushedText,
    // Assume we are text embedded at the trailing edge
    true,
  );
  segment.children.push(newSegment);
  // Reset lastPushedText for current Segment since the new Segment "consumed" it
  segment.lastPushedText = false;
  return createRenderTask(
    request,
    thenableState,
    task.node,
    task.childIndex,
    task.blockedBoundary,
    newSegment,
    task.hoistableState,
    task.abortSet,
    task.keyPath,
    task.formatContext,
    task.context,
    task.treeContext,
    task.componentStack,
    task.isFallback,
    !disableLegacyContext ? task.legacyContext : emptyContextObject,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );
}

// This is a non-destructive form of rendering a node. If it suspends it spawns
// a new task and restores the context of this task to what it was before.
function renderNode(
  request: Request,
  task: Task,
  node: ReactNodeList,
  childIndex: number,
): void {
  // Snapshot the current context in case something throws to interrupt the
  // process.
  const previousFormatContext = task.formatContext;
  const previousLegacyContext = !disableLegacyContext
    ? task.legacyContext
    : emptyContextObject;
  const previousContext = task.context;
  const previousKeyPath = task.keyPath;
  const previousTreeContext = task.treeContext;
  const previousComponentStack = task.componentStack;
  const previousDebugTask =
    __DEV__ && enableOwnerStacks ? task.debugTask : null;
  let x;
  // Store how much we've pushed at this point so we can reset it in case something
  // suspended partially through writing something.
  const segment = task.blockedSegment;
  if (segment === null) {
    // Replay
    try {
      return renderNodeDestructive(request, task, node, childIndex);
    } catch (thrownValue) {
      resetHooksState();

      x =
        thrownValue === SuspenseException
          ? // This is a special type of exception used for Suspense. For historical
            // reasons, the rest of the Suspense implementation expects the thrown
            // value to be a thenable, because before `use` existed that was the
            // (unstable) API for suspending. This implementation detail can change
            // later, once we deprecate the old API in favor of `use`.
            getSuspendedThenable()
          : thrownValue;

      if (typeof x === 'object' && x !== null) {
        // $FlowFixMe[method-unbinding]
        if (typeof x.then === 'function') {
          const wakeable: Wakeable = (x: any);
          const thenableState = getThenableStateAfterSuspending();
          const newTask = spawnNewSuspendedReplayTask(
            request,
            // $FlowFixMe: Refined.
            task,
            thenableState,
          );
          const ping = newTask.ping;
          wakeable.then(ping, ping);

          // Restore the context. We assume that this will be restored by the inner
          // functions in case nothing throws so we don't use "finally" here.
          task.formatContext = previousFormatContext;
          if (!disableLegacyContext) {
            task.legacyContext = previousLegacyContext;
          }
          task.context = previousContext;
          task.keyPath = previousKeyPath;
          task.treeContext = previousTreeContext;
          task.componentStack = previousComponentStack;
          if (__DEV__ && enableOwnerStacks) {
            task.debugTask = previousDebugTask;
          }
          // Restore all active ReactContexts to what they were before.
          switchContext(previousContext);
          return;
        }
        if (x.message === 'Maximum call stack size exceeded') {
          // This was a stack overflow. We do a lot of recursion in React by default for
          // performance but it can lead to stack overflows in extremely deep trees.
          // We do have the ability to create a trampoile if this happens which makes
          // this kind of zero-cost.
          const thenableState = getThenableStateAfterSuspending();
          const newTask = spawnNewSuspendedReplayTask(
            request,
            // $FlowFixMe: Refined.
            task,
            thenableState,
          );

          // Immediately schedule the task for retrying.
          request.pingedTasks.push(newTask);

          // Restore the context. We assume that this will be restored by the inner
          // functions in case nothing throws so we don't use "finally" here.
          task.formatContext = previousFormatContext;
          if (!disableLegacyContext) {
            task.legacyContext = previousLegacyContext;
          }
          task.context = previousContext;
          task.keyPath = previousKeyPath;
          task.treeContext = previousTreeContext;
          task.componentStack = previousComponentStack;
          if (__DEV__ && enableOwnerStacks) {
            task.debugTask = previousDebugTask;
          }
          // Restore all active ReactContexts to what they were before.
          switchContext(previousContext);
          return;
        }
      }

      // TODO: Abort any undiscovered Suspense boundaries in the ReplayNode.
    }
  } else {
    // Render
    const childrenLength = segment.children.length;
    const chunkLength = segment.chunks.length;
    try {
      return renderNodeDestructive(request, task, node, childIndex);
    } catch (thrownValue) {
      resetHooksState();

      // Reset the write pointers to where we started.
      segment.children.length = childrenLength;
      segment.chunks.length = chunkLength;

      x =
        thrownValue === SuspenseException
          ? // This is a special type of exception used for Suspense. For historical
            // reasons, the rest of the Suspense implementation expects the thrown
            // value to be a thenable, because before `use` existed that was the
            // (unstable) API for suspending. This implementation detail can change
            // later, once we deprecate the old API in favor of `use`.
            getSuspendedThenable()
          : thrownValue;

      if (typeof x === 'object' && x !== null) {
        // $FlowFixMe[method-unbinding]
        if (typeof x.then === 'function') {
          const wakeable: Wakeable = (x: any);
          const thenableState = getThenableStateAfterSuspending();
          const newTask = spawnNewSuspendedRenderTask(
            request,
            // $FlowFixMe: Refined.
            task,
            thenableState,
          );
          const ping = newTask.ping;
          wakeable.then(ping, ping);

          // Restore the context. We assume that this will be restored by the inner
          // functions in case nothing throws so we don't use "finally" here.
          task.formatContext = previousFormatContext;
          if (!disableLegacyContext) {
            task.legacyContext = previousLegacyContext;
          }
          task.context = previousContext;
          task.keyPath = previousKeyPath;
          task.treeContext = previousTreeContext;
          task.componentStack = previousComponentStack;
          if (__DEV__ && enableOwnerStacks) {
            task.debugTask = previousDebugTask;
          }
          // Restore all active ReactContexts to what they were before.
          switchContext(previousContext);
          return;
        }
        if (
          enablePostpone &&
          x.$$typeof === REACT_POSTPONE_TYPE &&
          request.trackedPostpones !== null &&
          task.blockedBoundary !== null // bubble if we're postponing in the shell
        ) {
          // If we're tracking postpones, we inject a hole here and continue rendering
          // sibling. Similar to suspending. If we're not tracking, we treat it more like
          // an error. Notably this doesn't spawn a new task since nothing will fill it
          // in during this prerender.
          const trackedPostpones = request.trackedPostpones;

          const postponeInstance: Postpone = (x: any);
          const thrownInfo = getThrownInfo(task.componentStack);
          const postponedSegment = injectPostponedHole(
            request,
            ((task: any): RenderTask), // We don't use ReplayTasks in prerenders.
            postponeInstance.message,
            thrownInfo,
          );
          trackPostpone(request, trackedPostpones, task, postponedSegment);

          // Restore the context. We assume that this will be restored by the inner
          // functions in case nothing throws so we don't use "finally" here.
          task.formatContext = previousFormatContext;
          if (!disableLegacyContext) {
            task.legacyContext = previousLegacyContext;
          }
          task.context = previousContext;
          task.keyPath = previousKeyPath;
          task.treeContext = previousTreeContext;
          task.componentStack = previousComponentStack;
          if (__DEV__ && enableOwnerStacks) {
            task.debugTask = previousDebugTask;
          }
          // Restore all active ReactContexts to what they were before.
          switchContext(previousContext);
          return;
        }
        if (x.message === 'Maximum call stack size exceeded') {
          // This was a stack overflow. We do a lot of recursion in React by default for
          // performance but it can lead to stack overflows in extremely deep trees.
          // We do have the ability to create a trampoile if this happens which makes
          // this kind of zero-cost.
          const thenableState = getThenableStateAfterSuspending();
          const newTask = spawnNewSuspendedRenderTask(
            request,
            // $FlowFixMe: Refined.
            task,
            thenableState,
          );

          // Immediately schedule the task for retrying.
          request.pingedTasks.push(newTask);

          // Restore the context. We assume that this will be restored by the inner
          // functions in case nothing throws so we don't use "finally" here.
          task.formatContext = previousFormatContext;
          if (!disableLegacyContext) {
            task.legacyContext = previousLegacyContext;
          }
          task.context = previousContext;
          task.keyPath = previousKeyPath;
          task.treeContext = previousTreeContext;
          task.componentStack = previousComponentStack;
          if (__DEV__ && enableOwnerStacks) {
            task.debugTask = previousDebugTask;
          }
          // Restore all active ReactContexts to what they were before.
          switchContext(previousContext);
          return;
        }
      }
    }
  }

  // Restore the context. We assume that this will be restored by the inner
  // functions in case nothing throws so we don't use "finally" here.
  task.formatContext = previousFormatContext;
  if (!disableLegacyContext) {
    task.legacyContext = previousLegacyContext;
  }
  task.context = previousContext;
  task.keyPath = previousKeyPath;
  task.treeContext = previousTreeContext;
  // We intentionally do not restore the component stack on the error pathway
  // Whatever handles the error needs to use this stack which is the location of the
  // error. We must restore the stack wherever we handle this

  // Restore all active ReactContexts to what they were before.
  switchContext(previousContext);

  throw x;
}

function erroredReplay(
  request: Request,
  boundary: Root | SuspenseBoundary,
  error: mixed,
  errorInfo: ThrownInfo,
  replayNodes: ReplayNode[],
  resumeSlots: ResumeSlots,
  debugTask: null | ConsoleTask,
): void {
  // Erroring during a replay doesn't actually cause an error by itself because
  // that component has already rendered. What causes the error is the resumable
  // points that we did not yet finish which will be below the point of the reset.
  // For example, if we're replaying a path to a Suspense boundary that is not done
  // that doesn't error the parent Suspense boundary.
  // This might be a bit strange that the error in a parent gets thrown at a child.
  // We log it only once and reuse the digest.
  let errorDigest;
  if (
    enablePostpone &&
    typeof error === 'object' &&
    error !== null &&
    error.$$typeof === REACT_POSTPONE_TYPE
  ) {
    const postponeInstance: Postpone = (error: any);
    logPostpone(request, postponeInstance.message, errorInfo, debugTask);
    // TODO: Figure out a better signal than a magic digest value.
    errorDigest = 'POSTPONE';
  } else {
    errorDigest = logRecoverableError(request, error, errorInfo, debugTask);
  }
  abortRemainingReplayNodes(
    request,
    boundary,
    replayNodes,
    resumeSlots,
    error,
    errorDigest,
    errorInfo,
    false,
  );
}

function erroredTask(
  request: Request,
  boundary: Root | SuspenseBoundary,
  error: mixed,
  errorInfo: ThrownInfo,
  debugTask: null | ConsoleTask,
) {
  // Report the error to a global handler.
  let errorDigest;
  // We don't handle halts here because we only halt when prerendering and
  // when prerendering we should be finishing tasks not erroring them when
  // they halt or postpone
  if (
    enablePostpone &&
    typeof error === 'object' &&
    error !== null &&
    error.$$typeof === REACT_POSTPONE_TYPE
  ) {
    const postponeInstance: Postpone = (error: any);
    logPostpone(request, postponeInstance.message, errorInfo, debugTask);
    // TODO: Figure out a better signal than a magic digest value.
    errorDigest = 'POSTPONE';
  } else {
    errorDigest = logRecoverableError(request, error, errorInfo, debugTask);
  }
  if (boundary === null) {
    fatalError(request, error, errorInfo, debugTask);
  } else {
    boundary.pendingTasks--;
    if (boundary.status !== CLIENT_RENDERED) {
      boundary.status = CLIENT_RENDERED;
      encodeErrorForBoundary(boundary, errorDigest, error, errorInfo, false);
      untrackBoundary(request, boundary);

      // Regardless of what happens next, this boundary won't be displayed,
      // so we can flush it, if the parent already flushed.
      if (boundary.parentFlushed) {
        // We don't have a preference where in the queue this goes since it's likely
        // to error on the client anyway. However, intentionally client-rendered
        // boundaries should be flushed earlier so that they can start on the client.
        // We reuse the same queue for errors.
        request.clientRenderedBoundaries.push(boundary);
      }
    }
  }

  request.allPendingTasks--;
  if (request.allPendingTasks === 0) {
    completeAll(request);
  }
}

function abortTaskSoft(this: Request, task: Task): void {
  // This aborts task without aborting the parent boundary that it blocks.
  // It's used for when we didn't need this task to complete the tree.
  // If task was needed, then it should use abortTask instead.
  const request: Request = this;
  const boundary = task.blockedBoundary;
  const segment = task.blockedSegment;
  if (segment !== null) {
    segment.status = ABORTED;
    finishedTask(request, boundary, segment);
  }
}

function abortRemainingSuspenseBoundary(
  request: Request,
  rootSegmentID: number,
  error: mixed,
  errorDigest: ?string,
  errorInfo: ThrownInfo,
  wasAborted: boolean,
): void {
  const resumedBoundary = createSuspenseBoundary(request, new Set());
  resumedBoundary.parentFlushed = true;
  // We restore the same id of this boundary as was used during prerender.
  resumedBoundary.rootSegmentID = rootSegmentID;

  resumedBoundary.status = CLIENT_RENDERED;
  encodeErrorForBoundary(
    resumedBoundary,
    errorDigest,
    error,
    errorInfo,
    wasAborted,
  );

  if (resumedBoundary.parentFlushed) {
    request.clientRenderedBoundaries.push(resumedBoundary);
  }
}

function abortRemainingReplayNodes(
  request: Request,
  boundary: Root | SuspenseBoundary,
  nodes: Array<ReplayNode>,
  slots: ResumeSlots,
  error: mixed,
  errorDigest: ?string,
  errorInfo: ThrownInfo,
  aborted: boolean,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.length === 4) {
      abortRemainingReplayNodes(
        request,
        boundary,
        node[2],
        node[3],
        error,
        errorDigest,
        errorInfo,
        aborted,
      );
    } else {
      const boundaryNode: ReplaySuspenseBoundary = node;
      const rootSegmentID = boundaryNode[5];
      abortRemainingSuspenseBoundary(
        request,
        rootSegmentID,
        error,
        errorDigest,
        errorInfo,
        aborted,
      );
    }
  }
  // Empty the set, since we've cleared it now.
  nodes.length = 0;

  if (slots !== null) {
    // We had something still to resume in the parent boundary. We must trigger
    // the error on the parent boundary since it's not able to complete.
    if (boundary === null) {
      throw new Error(
        'We should not have any resumable nodes in the shell. ' +
          'This is a bug in React.',
      );
    } else if (boundary.status !== CLIENT_RENDERED) {
      boundary.status = CLIENT_RENDERED;
      encodeErrorForBoundary(boundary, errorDigest, error, errorInfo, aborted);
      if (boundary.parentFlushed) {
        request.clientRenderedBoundaries.push(boundary);
      }
    }
    // Empty the set
    if (typeof slots === 'object') {
      for (const index in slots) {
        delete slots[(index: any)];
      }
    }
  }
}

function abortTask(task: Task, request: Request, error: mixed): void {
  // This aborts the task and aborts the parent that it blocks, putting it into
  // client rendered mode.
  const boundary = task.blockedBoundary;
  const segment = task.blockedSegment;
  if (segment !== null) {
    if (segment.status === RENDERING) {
      // This is the a currently rendering Segment. The render itself will
      // abort the task.
      return;
    }
    segment.status = ABORTED;
  }

  const errorInfo = getThrownInfo(task.componentStack);

  if (boundary === null) {
    if (request.status !== CLOSING && request.status !== CLOSED) {
      const replay: null | ReplaySet = task.replay;
      if (replay === null) {
        // We didn't complete the root so we have nothing to show. We can close
        // the request;
        if (
          enablePostpone &&
          typeof error === 'object' &&
          error !== null &&
          error.$$typeof === REACT_POSTPONE_TYPE
        ) {
          const postponeInstance: Postpone = (error: any);
          const trackedPostpones = request.trackedPostpones;

          if (trackedPostpones !== null && segment !== null) {
            // We are prerendering. We don't want to fatal when the shell postpones
            // we just need to mark it as postponed.
            logPostpone(request, postponeInstance.message, errorInfo, null);
            trackPostpone(request, trackedPostpones, task, segment);
            finishedTask(request, null, segment);
          } else {
            const fatal = new Error(
              'The render was aborted with postpone when the shell is incomplete. Reason: ' +
                postponeInstance.message,
            );
            logRecoverableError(request, fatal, errorInfo, null);
            fatalError(request, fatal, errorInfo, null);
          }
        } else if (
          enableHalt &&
          request.trackedPostpones !== null &&
          segment !== null
        ) {
          const trackedPostpones = request.trackedPostpones;
          // We are aborting a prerender and must treat the shell as halted
          // We log the error but we still resolve the prerender
          logRecoverableError(request, error, errorInfo, null);
          trackPostpone(request, trackedPostpones, task, segment);
          finishedTask(request, null, segment);
        } else {
          logRecoverableError(request, error, errorInfo, null);
          fatalError(request, error, errorInfo, null);
        }
        return;
      } else {
        // If the shell aborts during a replay, that's not a fatal error. Instead
        // we should be able to recover by client rendering all the root boundaries in
        // the ReplaySet.
        replay.pendingTasks--;
        if (replay.pendingTasks === 0 && replay.nodes.length > 0) {
          let errorDigest;
          if (
            enablePostpone &&
            typeof error === 'object' &&
            error !== null &&
            error.$$typeof === REACT_POSTPONE_TYPE
          ) {
            const postponeInstance: Postpone = (error: any);
            logPostpone(request, postponeInstance.message, errorInfo, null);
            // TODO: Figure out a better signal than a magic digest value.
            errorDigest = 'POSTPONE';
          } else {
            errorDigest = logRecoverableError(request, error, errorInfo, null);
          }
          abortRemainingReplayNodes(
            request,
            null,
            replay.nodes,
            replay.slots,
            error,
            errorDigest,
            errorInfo,
            true,
          );
        }
        request.pendingRootTasks--;
        if (request.pendingRootTasks === 0) {
          completeShell(request);
        }
      }
    }
  } else {
    boundary.pendingTasks--;
    // We construct an errorInfo from the boundary's componentStack so the error in dev will indicate which
    // boundary the message is referring to
    const trackedPostpones = request.trackedPostpones;
    if (boundary.status !== CLIENT_RENDERED) {
      if (enableHalt) {
        if (trackedPostpones !== null && segment !== null) {
          // We are aborting a prerender
          if (
            enablePostpone &&
            typeof error === 'object' &&
            error !== null &&
            error.$$typeof === REACT_POSTPONE_TYPE
          ) {
            const postponeInstance: Postpone = (error: any);
            logPostpone(request, postponeInstance.message, errorInfo, null);
          } else {
            // We are aborting a prerender and must halt this boundary.
            // We treat this like other postpones during prerendering
            logRecoverableError(request, error, errorInfo, null);
          }
          trackPostpone(request, trackedPostpones, task, segment);
          // If this boundary was still pending then we haven't already cancelled its fallbacks.
          // We'll need to abort the fallbacks, which will also error that parent boundary.
          boundary.fallbackAbortableTasks.forEach(fallbackTask =>
            abortTask(fallbackTask, request, error),
          );
          boundary.fallbackAbortableTasks.clear();
          return finishedTask(request, boundary, segment);
        }
      }
      boundary.status = CLIENT_RENDERED;
      // We are aborting a render or resume which should put boundaries
      // into an explicitly client rendered state
      let errorDigest;
      if (
        enablePostpone &&
        typeof error === 'object' &&
        error !== null &&
        error.$$typeof === REACT_POSTPONE_TYPE
      ) {
        const postponeInstance: Postpone = (error: any);
        logPostpone(request, postponeInstance.message, errorInfo, null);
        if (request.trackedPostpones !== null && segment !== null) {
          trackPostpone(request, request.trackedPostpones, task, segment);
          finishedTask(request, task.blockedBoundary, segment);

          // If this boundary was still pending then we haven't already cancelled its fallbacks.
          // We'll need to abort the fallbacks, which will also error that parent boundary.
          boundary.fallbackAbortableTasks.forEach(fallbackTask =>
            abortTask(fallbackTask, request, error),
          );
          boundary.fallbackAbortableTasks.clear();
          return;
        }
        // TODO: Figure out a better signal than a magic digest value.
        errorDigest = 'POSTPONE';
      } else {
        errorDigest = logRecoverableError(request, error, errorInfo, null);
      }
      boundary.status = CLIENT_RENDERED;
      encodeErrorForBoundary(boundary, errorDigest, error, errorInfo, true);

      untrackBoundary(request, boundary);

      if (boundary.parentFlushed) {
        request.clientRenderedBoundaries.push(boundary);
      }
    }

    // If this boundary was still pending then we haven't already cancelled its fallbacks.
    // We'll need to abort the fallbacks, which will also error that parent boundary.
    boundary.fallbackAbortableTasks.forEach(fallbackTask =>
      abortTask(fallbackTask, request, error),
    );
    boundary.fallbackAbortableTasks.clear();
  }

  request.allPendingTasks--;
  if (request.allPendingTasks === 0) {
    completeAll(request);
  }
}

function safelyEmitEarlyPreloads(
  request: Request,
  shellComplete: boolean,
): void {
  try {
    emitEarlyPreloads(
      request.renderState,
      request.resumableState,
      shellComplete,
    );
  } catch (error) {
    // We assume preloads are optimistic and thus non-fatal if errored.
    const errorInfo: ThrownInfo = {};
    logRecoverableError(request, error, errorInfo, null);
  }
}

// I extracted this function out because we want to ensure we consistently emit preloads before
// transitioning to the next request stage and this transition can happen in multiple places in this
// implementation.
function completeShell(request: Request) {
  if (request.trackedPostpones === null) {
    // We only emit early preloads on shell completion for renders. For prerenders
    // we wait for the entire Request to finish because we are not responding to a
    // live request and can wait for as much data as possible.

    // we should only be calling completeShell when the shell is complete so we
    // just use a literal here
    const shellComplete = true;
    safelyEmitEarlyPreloads(request, shellComplete);
  }
  // We have completed the shell so the shell can't error anymore.
  request.onShellError = noop;
  const onShellReady = request.onShellReady;
  onShellReady();
}

// I extracted this function out because we want to ensure we consistently emit preloads before
// transitioning to the next request stage and this transition can happen in multiple places in this
// implementation.
function completeAll(request: Request) {
  // During a render the shell must be complete if the entire request is finished
  // however during a Prerender it is possible that the shell is incomplete because
  // it postponed. We cannot use rootPendingTasks in the prerender case because
  // those hit zero even when the shell postpones. Instead we look at the completedRootSegment
  const shellComplete =
    request.trackedPostpones === null
      ? // Render, we assume it is completed
        true
      : // Prerender Request, we use the state of the root segment
        request.completedRootSegment === null ||
        request.completedRootSegment.status !== POSTPONED;
  safelyEmitEarlyPreloads(request, shellComplete);
  const onAllReady = request.onAllReady;
  onAllReady();
}

function queueCompletedSegment(
  boundary: SuspenseBoundary,
  segment: Segment,
): void {
  if (
    segment.chunks.length === 0 &&
    segment.children.length === 1 &&
    segment.children[0].boundary === null &&
    segment.children[0].id === -1
  ) {
    // This is an empty segment. There's nothing to write, so we can instead transfer the ID
    // to the child. That way any existing references point to the child.
    const childSegment = segment.children[0];
    childSegment.id = segment.id;
    childSegment.parentFlushed = true;
    if (childSegment.status === COMPLETED) {
      queueCompletedSegment(boundary, childSegment);
    }
  } else {
    const completedSegments = boundary.completedSegments;
    completedSegments.push(segment);
  }
}

function finishedTask(
  request: Request,
  boundary: Root | SuspenseBoundary,
  segment: null | Segment,
) {
  if (boundary === null) {
    if (segment !== null && segment.parentFlushed) {
      if (request.completedRootSegment !== null) {
        throw new Error(
          'There can only be one root segment. This is a bug in React.',
        );
      }

      request.completedRootSegment = segment;
    }
    request.pendingRootTasks--;
    if (request.pendingRootTasks === 0) {
      completeShell(request);
    }
  } else {
    boundary.pendingTasks--;
    if (boundary.status === CLIENT_RENDERED) {
      // This already errored.
    } else if (boundary.pendingTasks === 0) {
      if (boundary.status === PENDING) {
        boundary.status = COMPLETED;
      }
      // This must have been the last segment we were waiting on. This boundary is now complete.
      if (segment !== null && segment.parentFlushed) {
        // Our parent segment already flushed, so we need to schedule this segment to be emitted.
        // If it is a segment that was aborted, we'll write other content instead so we don't need
        // to emit it.
        if (segment.status === COMPLETED) {
          queueCompletedSegment(boundary, segment);
        }
      }
      if (boundary.parentFlushed) {
        // The segment might be part of a segment that didn't flush yet, but if the boundary's
        // parent flushed, we need to schedule the boundary to be emitted.
        request.completedBoundaries.push(boundary);
      }

      // We can now cancel any pending task on the fallback since we won't need to show it anymore.
      // This needs to happen after we read the parentFlushed flags because aborting can finish
      // work which can trigger user code, which can start flushing, which can change those flags.
      // If the boundary was POSTPONED, we still need to finish the fallback first.
      if (boundary.status === COMPLETED) {
        boundary.fallbackAbortableTasks.forEach(abortTaskSoft, request);
        boundary.fallbackAbortableTasks.clear();
      }
    } else {
      if (segment !== null && segment.parentFlushed) {
        // Our parent already flushed, so we need to schedule this segment to be emitted.
        // If it is a segment that was aborted, we'll write other content instead so we don't need
        // to emit it.
        if (segment.status === COMPLETED) {
          queueCompletedSegment(boundary, segment);
          const completedSegments = boundary.completedSegments;
          if (completedSegments.length === 1) {
            // This is the first time since we last flushed that we completed anything.
            // We can schedule this boundary to emit its partially completed segments early
            // in case the parent has already been flushed.
            if (boundary.parentFlushed) {
              request.partialBoundaries.push(boundary);
            }
          }
        }
      }
    }
  }

  request.allPendingTasks--;
  if (request.allPendingTasks === 0) {
    completeAll(request);
  }
}

function retryTask(request: Request, task: Task): void {
  //  blockedSegment代表一个段
  //  表示当前任务应该写入的HTML段
  //  renderToString中，blockedSegment为创建的根节点段。它没有父级
  const segment = task.blockedSegment;
  if (segment === null) {
    retryReplayTask(
      request,
      // $FlowFixMe: Refined.
      task,
    );
  } else {
    retryRenderTask(
      request,
      // $FlowFixMe: Refined.
      task,
      segment,
    );
  }
}

function retryRenderTask(
  request: Request,// 当前的渲染请求
  task: RenderTask,// 要执行的任务 pingedTasks中的任务集中一个
  segment: Segment,// 对应根段模块
): void {
  if (segment.status !== PENDING) {
    //  任务非待处理，直接不执行
    return;
  }

  //  设置执行的状态
  segment.status = RENDERING;

  //  设置对应的上下文
  switchContext(task.context);
  let prevTaskInDEV = null;
  if (__DEV__) {
    prevTaskInDEV = currentTaskInDEV;
    setCurrentTaskInDEV(task);
  }
  const childrenLength = segment.children.length;
  const chunkLength = segment.chunks.length;
  try {
    // 开始渲染
    retryNode(request, task);
    //  一个组件渲染文本节点后，抛出了一个promise（suspense、use）时，lastPushedText、textEmbedded为true。会插入节点
    //  多个文本节点之间也会插入，区分多个节点
    //  
    pushSegmentFinale(
      segment.chunks,
      request.renderState,
      segment.lastPushedText,// 为true代表被中断了
      segment.textEmbedded,
    );
    // 从中止集合中移除任务
    task.abortSet.delete(task);
    // 标记段为已完成
    segment.status = COMPLETED;
     // 处理已完成任务。管理段的状态
     // 当完成任务后，调用completeShell/completeAll
    finishedTask(request, task.blockedBoundary, segment);
  } catch (thrownValue: mixed) {
    resetHooksState();

    // 重置指针
    segment.chunks.length = chunkLength;
    //  suspense异常
    const x =
      thrownValue === SuspenseException
        ? // This is a special type of exception used for Suspense. For historical
          // reasons, the rest of the Suspense implementation expects the thrown
          // value to be a thenable, because before `use` existed that was the
          // (unstable) API for suspending. This implementation detail can change
          // later, once we deprecate the old API in favor of `use`.
          getSuspendedThenable()
        : request.status === ABORTING
          ? request.fatalError
          : thrownValue;

    if (
      enableHalt &&
      request.status === ABORTING &&
      request.trackedPostpones !== null
    ) {
      // We are aborting a prerender and need to halt this task.
      const trackedPostpones = request.trackedPostpones;
      const thrownInfo = getThrownInfo(task.componentStack);
      task.abortSet.delete(task);
      //预渲染中止 
      if (
        enablePostpone &&
        typeof x === 'object' &&
        x !== null &&
        x.$$typeof === REACT_POSTPONE_TYPE
      ) {
        const postponeInstance: Postpone = (x: any);
        logPostpone(
          request,
          postponeInstance.message,
          thrownInfo,
          __DEV__ && enableOwnerStacks ? task.debugTask : null,
        );
      } else {
        logRecoverableError(
          request,
          x,
          thrownInfo,
          __DEV__ && enableOwnerStacks ? task.debugTask : null,
        );
      }

      trackPostpone(request, trackedPostpones, task, segment);
      finishedTask(request, task.blockedBoundary, segment);
      return;
    }
    //  promise。直接返回
    if (typeof x === 'object' && x !== null) {
      // $FlowFixMe[method-unbinding]
      if (typeof x.then === 'function') {
        // Something suspended again, let's pick it back up later.
        segment.status = PENDING;
        task.thenableState = getThenableStateAfterSuspending();
        const ping = task.ping;
        // We've asserted that x is a thenable above
        (x: any).then(ping, ping);
        return;
      } else if (
        enablePostpone &&
        request.trackedPostpones !== null &&
        x.$$typeof === REACT_POSTPONE_TYPE
      ) {
        // If we're tracking postpones, we mark this segment as postponed and finish
        // the task without filling it in. If we're not tracking, we treat it more like
        // an error.
        const trackedPostpones = request.trackedPostpones;
        task.abortSet.delete(task);
        const postponeInstance: Postpone = (x: any);

        const postponeInfo = getThrownInfo(task.componentStack);
        logPostpone(
          request,
          postponeInstance.message,
          postponeInfo,
          __DEV__ && enableOwnerStacks ? task.debugTask : null,
        );
        trackPostpone(request, trackedPostpones, task, segment);
        finishedTask(request, task.blockedBoundary, segment);
        return;
      }
    }
    //  其它错误
    const errorInfo = getThrownInfo(task.componentStack);
    task.abortSet.delete(task);

    segment.status = ERRORED;
    //  设置错误信息，可以降级到客户端渲染
    erroredTask(
      request,
      task.blockedBoundary,
      x,
      errorInfo,
      __DEV__ && enableOwnerStacks ? task.debugTask : null,
    );
    return;
  } finally {
    if (__DEV__) {
      setCurrentTaskInDEV(prevTaskInDEV);
    }
  }
}

function retryReplayTask(request: Request, task: ReplayTask): void {
  if (task.replay.pendingTasks === 0) {
    // There are no pending tasks working on this set, so we must have aborted.
    return;
  }

  // We restore the context to what it was when we suspended.
  // We don't restore it after we leave because it's likely that we'll end up
  // needing a very similar context soon again.
  switchContext(task.context);
  let prevTaskInDEV = null;
  if (__DEV__) {
    prevTaskInDEV = currentTaskInDEV;
    setCurrentTaskInDEV(task);
  }

  try {
    // We call the destructive form that mutates this task. That way if something
    // suspends again, we can reuse the same task instead of spawning a new one.
    if (typeof task.replay.slots === 'number') {
      const resumeSegmentID = task.replay.slots;
      resumeNode(request, task, resumeSegmentID, task.node, task.childIndex);
    } else {
      retryNode(request, task);
    }

    if (task.replay.pendingTasks === 1 && task.replay.nodes.length > 0) {
      throw new Error(
        "Couldn't find all resumable slots by key/index during replaying. " +
          "The tree doesn't match so React will fallback to client rendering.",
      );
    }
    task.replay.pendingTasks--;

    task.abortSet.delete(task);
    finishedTask(request, task.blockedBoundary, null);
  } catch (thrownValue) {
    resetHooksState();

    const x =
      thrownValue === SuspenseException
        ? // This is a special type of exception used for Suspense. For historical
          // reasons, the rest of the Suspense implementation expects the thrown
          // value to be a thenable, because before `use` existed that was the
          // (unstable) API for suspending. This implementation detail can change
          // later, once we deprecate the old API in favor of `use`.
          getSuspendedThenable()
        : thrownValue;

    if (typeof x === 'object' && x !== null) {
      // $FlowFixMe[method-unbinding]
      if (typeof x.then === 'function') {
        // Something suspended again, let's pick it back up later.
        const ping = task.ping;
        x.then(ping, ping);
        task.thenableState = getThenableStateAfterSuspending();
        return;
      }
    }
    task.replay.pendingTasks--;
    task.abortSet.delete(task);
    const errorInfo = getThrownInfo(task.componentStack);
    erroredReplay(
      request,
      task.blockedBoundary,
      request.status === ABORTING ? request.fatalError : x,
      errorInfo,
      task.replay.nodes,
      task.replay.slots,
      __DEV__ && enableOwnerStacks ? task.debugTask : null,
    );
    request.pendingRootTasks--;
    if (request.pendingRootTasks === 0) {
      completeShell(request);
    }
    request.allPendingTasks--;
    if (request.allPendingTasks === 0) {
      completeAll(request);
    }
    return;
  } finally {
    if (__DEV__) {
      setCurrentTaskInDEV(prevTaskInDEV);
    }
  }
}

export function performWork(request: Request): void {
  //  请求关系，直接返回
  if (request.status === CLOSED || request.status === CLOSING) {
    return;
  }
  const prevContext = getActiveContext();
  const prevDispatcher = ReactSharedInternals.H;
  ReactSharedInternals.H = HooksDispatcher;
  let prevAsyncDispatcher = null;
  if (enableCache || __DEV__ || !disableStringRefs) {
    prevAsyncDispatcher = ReactSharedInternals.A;
    ReactSharedInternals.A = DefaultAsyncDispatcher;
  }
  //  保存当前上下文，
  const prevRequest = currentRequest;
  // 并设置当前上下文
  currentRequest = request;

  let prevGetCurrentStackImpl = null;
  if (__DEV__) {
    prevGetCurrentStackImpl = ReactSharedInternals.getCurrentStack;
    ReactSharedInternals.getCurrentStack = getCurrentStackInDEV;
  }
  const prevResumableState = currentResumableState;
  setCurrentResumableState(request.resumableState);
  try {
    //  获取待处理的高优先级任务
    const pingedTasks = request.pingedTasks;
    let i;
    for (i = 0; i < pingedTasks.length; i++) {
      const task = pingedTasks[i];
      //  实际的执行/重试任务
      retryTask(request, task);
    }
    //  清空已处理的任务
    pingedTasks.splice(0, i);
    //  存在输出目标，刷新已完成的内容
    if (request.destination !== null) {
      flushCompletedQueues(request, request.destination);
    }
  } catch (error) {
    // 错误处理：记录可恢复错误并触发致命错误处理
    const errorInfo: ThrownInfo = {};
    logRecoverableError(request, error, errorInfo, null);
    fatalError(request, error, errorInfo, null);
  } finally {
    // 恢复所有之前保存的上下文环境
    setCurrentResumableState(prevResumableState);
    ReactSharedInternals.H = prevDispatcher;
    if (enableCache) {
      ReactSharedInternals.A = prevAsyncDispatcher;
    }

    if (__DEV__) {
      ReactSharedInternals.getCurrentStack = prevGetCurrentStackImpl;
    }
    if (prevDispatcher === HooksDispatcher) {
      // This means that we were in a reentrant work loop. This could happen
      // in a renderer that supports synchronous work like renderToString,
      // when it's called from within another renderer.
      // Normally we don't bother switching the contexts to their root/default
      // values when leaving because we'll likely need the same or similar
      // context again. However, when we're inside a synchronous loop like this
      // we'll to restore the context to what it was before returning.
      switchContext(prevContext);
    }
    currentRequest = prevRequest;
  }
}

function flushPreamble(
  request: Request,
  destination: Destination,
  rootSegment: Segment,
) {
  const willFlushAllSegments =
    request.allPendingTasks === 0 && request.trackedPostpones === null;
  writePreamble(
    destination,
    request.resumableState,
    request.renderState,
    willFlushAllSegments,
  );
}

function flushSubtree(
  request: Request,
  destination: Destination,
  segment: Segment,
  hoistableState: null | HoistableState,
): boolean {
  segment.parentFlushed = true;
  switch (segment.status) {
    case PENDING: {
      // We're emitting a placeholder for this segment to be filled in later.
      // Therefore we'll need to assign it an ID - to refer to it by.
      segment.id = request.nextSegmentId++;
      // Fallthrough
    }
    case POSTPONED: {
      const segmentID = segment.id;
      // When this segment finally completes it won't be embedded in text since it will flush separately
      segment.lastPushedText = false;
      segment.textEmbedded = false;
      return writePlaceholder(destination, request.renderState, segmentID);
    }
    case COMPLETED: {
      segment.status = FLUSHED;
      let r = true;
      const chunks = segment.chunks;
      let chunkIdx = 0;
      const children = segment.children;

      for (let childIdx = 0; childIdx < children.length; childIdx++) {
        const nextChild = children[childIdx];
        // Write all the chunks up until the next child.
        for (; chunkIdx < nextChild.index; chunkIdx++) {
          writeChunk(destination, chunks[chunkIdx]);
        }
        r = flushSegment(request, destination, nextChild, hoistableState);
      }
      // Finally just write all the remaining chunks
      for (; chunkIdx < chunks.length - 1; chunkIdx++) {
        writeChunk(destination, chunks[chunkIdx]);
      }
      if (chunkIdx < chunks.length) {
        r = writeChunkAndReturn(destination, chunks[chunkIdx]);
      }
      return r;
    }
    default: {
      throw new Error(
        'Aborted, errored or already flushed boundaries should not be flushed again. This is a bug in React.',
      );
    }
  }
}

function flushSegment(
  request: Request,
  destination: Destination,
  segment: Segment,
  hoistableState: null | HoistableState,
): boolean {
  const boundary = segment.boundary;
  if (boundary === null) {
    // Not a suspense boundary.
    return flushSubtree(request, destination, segment, hoistableState);
  }

  boundary.parentFlushed = true;
  // This segment is a Suspense boundary. We need to decide whether to
  // emit the content or the fallback now.
  if (boundary.status === CLIENT_RENDERED) {
    // Emit a client rendered suspense boundary wrapper.
    // We never queue the inner boundary so we'll never emit its content or partial segments.

    if (__DEV__) {
      writeStartClientRenderedSuspenseBoundary(
        destination,
        request.renderState,
        boundary.errorDigest,
        boundary.errorMessage,
        boundary.errorStack,
        boundary.errorComponentStack,
      );
    } else {
      writeStartClientRenderedSuspenseBoundary(
        destination,
        request.renderState,
        boundary.errorDigest,
        null,
        null,
        null,
      );
    }
    // Flush the fallback.
    flushSubtree(request, destination, segment, hoistableState);

    return writeEndClientRenderedSuspenseBoundary(
      destination,
      request.renderState,
    );
  } else if (boundary.status !== COMPLETED) {
    if (boundary.status === PENDING) {
      // For pending boundaries we lazily assign an ID to the boundary
      // and root segment.
      boundary.rootSegmentID = request.nextSegmentId++;
    }

    if (boundary.completedSegments.length > 0) {
      // If this is at least partially complete, we can queue it to be partially emitted early.
      request.partialBoundaries.push(boundary);
    }

    // This boundary is still loading. Emit a pending suspense boundary wrapper.

    const id = boundary.rootSegmentID;
    writeStartPendingSuspenseBoundary(destination, request.renderState, id);

    if (hoistableState) {
      hoistHoistables(hoistableState, boundary.fallbackState);
    }
    // Flush the fallback.
    flushSubtree(request, destination, segment, hoistableState);

    return writeEndPendingSuspenseBoundary(destination, request.renderState);
  } else if (boundary.byteSize > request.progressiveChunkSize) {
    // This boundary is large and will be emitted separately so that we can progressively show
    // other content. We add it to the queue during the flush because we have to ensure that
    // the parent flushes first so that there's something to inject it into.
    // We also have to make sure that it's emitted into the queue in a deterministic slot.
    // I.e. we can't insert it here when it completes.

    // Assign an ID to refer to the future content by.
    boundary.rootSegmentID = request.nextSegmentId++;

    request.completedBoundaries.push(boundary);
    // Emit a pending rendered suspense boundary wrapper.
    writeStartPendingSuspenseBoundary(
      destination,
      request.renderState,
      boundary.rootSegmentID,
    );

    // While we are going to flush the fallback we are going to follow it up with
    // the completed boundary immediately so we make the choice to omit fallback
    // boundary state from the parent since it will be replaced when the boundary
    // flushes later in this pass or in a future flush

    // Flush the fallback.
    flushSubtree(request, destination, segment, hoistableState);

    return writeEndPendingSuspenseBoundary(destination, request.renderState);
  } else {
    if (hoistableState) {
      hoistHoistables(hoistableState, boundary.contentState);
    }
    // We can inline this boundary's content as a complete boundary.
    writeStartCompletedSuspenseBoundary(destination, request.renderState);

    const completedSegments = boundary.completedSegments;

    if (completedSegments.length !== 1) {
      throw new Error(
        'A previously unvisited boundary must have exactly one root segment. This is a bug in React.',
      );
    }

    const contentSegment = completedSegments[0];
    flushSegment(request, destination, contentSegment, hoistableState);

    return writeEndCompletedSuspenseBoundary(destination, request.renderState);
  }
}

function flushClientRenderedBoundary(
  request: Request,
  destination: Destination,
  boundary: SuspenseBoundary,
): boolean {
  if (__DEV__) {
    return writeClientRenderBoundaryInstruction(
      destination,
      request.resumableState,
      request.renderState,
      boundary.rootSegmentID,
      boundary.errorDigest,
      boundary.errorMessage,
      boundary.errorStack,
      boundary.errorComponentStack,
    );
  } else {
    return writeClientRenderBoundaryInstruction(
      destination,
      request.resumableState,
      request.renderState,
      boundary.rootSegmentID,
      boundary.errorDigest,
      null,
      null,
      null,
    );
  }
}

function flushSegmentContainer(
  request: Request,
  destination: Destination,
  segment: Segment,
  hoistableState: HoistableState,
): boolean {
  writeStartSegment(
    destination,
    request.renderState,
    segment.parentFormatContext,
    segment.id,
  );
  flushSegment(request, destination, segment, hoistableState);
  return writeEndSegment(destination, segment.parentFormatContext);
}

function flushCompletedBoundary(
  request: Request,
  destination: Destination,
  boundary: SuspenseBoundary,
): boolean {
  const completedSegments = boundary.completedSegments;
  let i = 0;
  for (; i < completedSegments.length; i++) {
    const segment = completedSegments[i];
    flushPartiallyCompletedSegment(request, destination, boundary, segment);
  }
  completedSegments.length = 0;

  writeHoistablesForBoundary(
    destination,
    boundary.contentState,
    request.renderState,
  );
  return writeCompletedBoundaryInstruction(
    destination,
    request.resumableState,
    request.renderState,
    boundary.rootSegmentID,
    boundary.contentState,
  );
}

function flushPartialBoundary(
  request: Request,
  destination: Destination,
  boundary: SuspenseBoundary,
): boolean {
  const completedSegments = boundary.completedSegments;
  let i = 0;
  for (; i < completedSegments.length; i++) {
    const segment = completedSegments[i];
    if (
      !flushPartiallyCompletedSegment(request, destination, boundary, segment)
    ) {
      i++;
      completedSegments.splice(0, i);
      // Only write as much as the buffer wants. Something higher priority
      // might want to write later.
      return false;
    }
  }
  completedSegments.splice(0, i);

  return writeHoistablesForBoundary(
    destination,
    boundary.contentState,
    request.renderState,
  );
}

function flushPartiallyCompletedSegment(
  request: Request,
  destination: Destination,
  boundary: SuspenseBoundary,
  segment: Segment,
): boolean {
  if (segment.status === FLUSHED) {
    // We've already flushed this inline.
    return true;
  }

  const hoistableState = boundary.contentState;

  const segmentID = segment.id;
  if (segmentID === -1) {
    // This segment wasn't previously referred to. This happens at the root of
    // a boundary. We make kind of a leap here and assume this is the root.
    const rootSegmentID = (segment.id = boundary.rootSegmentID);

    if (rootSegmentID === -1) {
      throw new Error(
        'A root segment ID must have been assigned by now. This is a bug in React.',
      );
    }

    return flushSegmentContainer(request, destination, segment, hoistableState);
  } else if (segmentID === boundary.rootSegmentID) {
    // When we emit postponed boundaries, we might have assigned the ID already
    // but it's still the root segment so we can't inject it into the parent yet.
    return flushSegmentContainer(request, destination, segment, hoistableState);
  } else {
    flushSegmentContainer(request, destination, segment, hoistableState);
    return writeCompletedSegmentInstruction(
      destination,
      request.resumableState,
      request.renderState,
      segmentID,
    );
  }
}

function flushCompletedQueues(
  request: Request,
  destination: Destination,
): void {
  beginWriting(destination);
  try {
    // The structure of this is to go through each queue one by one and write
    // until the sink tells us to stop. When we should stop, we still finish writing
    // that item fully and then yield. At that point we remove the already completed
    // items up until the point we completed them.

    if (request.pendingRootTasks > 0) {
      // When there are pending root tasks we don't want to flush anything
      return;
    }

    let i;
    const completedRootSegment = request.completedRootSegment;
    if (completedRootSegment !== null) {
      if (completedRootSegment.status === POSTPONED) {
        // We postponed the root, so we write nothing.
        return;
      }
      //  写入HTML文档开头部分
      flushPreamble(request, destination, completedRootSegment);
      //  写入根段内容
      flushSegment(request, destination, completedRootSegment, null);
      request.completedRootSegment = null;
      writeCompletedRoot(destination, request.renderState);
    }

    writeHoistables(destination, request.resumableState, request.renderState);
    //  获取客户端渲染边界
    const clientRenderedBoundaries = request.clientRenderedBoundaries;
    for (i = 0; i < clientRenderedBoundaries.length; i++) {
      const boundary = clientRenderedBoundaries[i];
      if (!flushClientRenderedBoundary(request, destination, boundary)) {
        request.destination = null;
        i++;
        clientRenderedBoundaries.splice(0, i);
        return;
      }
    }
    clientRenderedBoundaries.splice(0, i);

    // Next we emit any complete boundaries. It's better to favor boundaries
    // that are completely done since we can actually show them, than it is to emit
    // any individual segments from a partially complete boundary.
    const completedBoundaries = request.completedBoundaries;
    for (i = 0; i < completedBoundaries.length; i++) {
      const boundary = completedBoundaries[i];
      if (!flushCompletedBoundary(request, destination, boundary)) {
        request.destination = null;
        i++;
        completedBoundaries.splice(0, i);
        return;
      }
    }
    completedBoundaries.splice(0, i);

    // Allow anything written so far to flush to the underlying sink before
    // we continue with lower priorities.
    completeWriting(destination);
    beginWriting(destination);

    // TODO: Here we'll emit data used by hydration.

    // Next we emit any segments of any boundaries that are partially complete
    // but not deeply complete.
    const partialBoundaries = request.partialBoundaries;
    for (i = 0; i < partialBoundaries.length; i++) {
      const boundary = partialBoundaries[i];
      if (!flushPartialBoundary(request, destination, boundary)) {
        request.destination = null;
        i++;
        partialBoundaries.splice(0, i);
        return;
      }
    }
    partialBoundaries.splice(0, i);

    // Next we check the completed boundaries again. This may have had
    // boundaries added to it in case they were too larged to be inlined.
    // New ones might be added in this loop.
    const largeBoundaries = request.completedBoundaries;
    for (i = 0; i < largeBoundaries.length; i++) {
      const boundary = largeBoundaries[i];
      if (!flushCompletedBoundary(request, destination, boundary)) {
        request.destination = null;
        i++;
        largeBoundaries.splice(0, i);
        return;
      }
    }
    largeBoundaries.splice(0, i);
  } finally {
    if (
      request.allPendingTasks === 0 &&
      request.pingedTasks.length === 0 &&
      request.clientRenderedBoundaries.length === 0 &&
      request.completedBoundaries.length === 0
      // We don't need to check any partially completed segments because
      // either they have pending task or they're complete.
    ) {
      request.flushScheduled = false;
      // We write the trailing tags but only if don't have any data to resume.
      // If we need to resume we'll write the postamble in the resume instead.
      if (!enablePostpone || request.trackedPostpones === null) {
        writePostamble(destination, request.resumableState);
      }
      completeWriting(destination);
      flushBuffered(destination);
      if (__DEV__) {
        if (request.abortableTasks.size !== 0) {
          console.error(
            'There was still abortable task at the root when we closed. This is a bug in React.',
          );
        }
      }
      // We're done.
      request.status = CLOSED;
      close(destination);
      // We need to stop flowing now because we do not want any async contexts which might call
      // float methods to initiate any flushes after this point
      stopFlowing(request);
    } else {
      completeWriting(destination);
      flushBuffered(destination);
    }
  }
}

export function startWork(request: Request): void {
  // flushScheduled：是否存在目标输出模块。如果没有，会继续渲染，但不输出
  request.flushScheduled = request.destination !== null;
  if (supportsRequestStorage) {// 请求存储
    //  预渲染模式下，采用微任务调度
    //  requestStorage.run。在上下文中红执行回调函数
    scheduleMicrotask(() => requestStorage.run(request, performWork, request));
  } else {
    //  不支持请求存储。直接执行
    scheduleMicrotask(() => performWork(request));
  }
  scheduleWork(() => {
    //  调度一个异步任务
    if (request.status === OPENING) {// 请求刚创建还未开始处理
      request.status = OPEN;//  设置开始处理，可以接收、处理数据
    }

    if (request.trackedPostpones === null) {
      //  当前是常规渲染或者恢复操作
      //  期望尽早返回内容 调用emitEarlyPreloads
      //  预渲染则不同，不想过早发送，等待预渲染完成后u发送
      if (supportsRequestStorage) {
        requestStorage.run(
          request,
          enqueueEarlyPreloadsAfterInitialWork,
          request,
        );
      } else {
        // 初始渲染工作后，安全早起资源预加载
        enqueueEarlyPreloadsAfterInitialWork(request);
      }
    }
  });
}

function enqueueEarlyPreloadsAfterInitialWork(request: Request) {
  const shellComplete = request.pendingRootTasks === 0;
  safelyEmitEarlyPreloads(request, shellComplete);
}

function enqueueFlush(request: Request): void {
  if (
    request.flushScheduled === false &&
    // If there are pinged tasks we are going to flush anyway after work completes
    request.pingedTasks.length === 0 &&
    // If there is no destination there is nothing we can flush to. A flush will
    // happen when we start flowing again
    request.destination !== null
  ) {
    request.flushScheduled = true;
    scheduleWork(() => {
      // We need to existence check destination again here because it might go away
      // in between the enqueueFlush call and the work execution
      const destination = request.destination;
      if (destination) {
        flushCompletedQueues(request, destination);
      } else {
        request.flushScheduled = false;
      }
    });
  }
}

// This function is intented to only be called during the pipe function for the Node builds.
// The reason we need this is because `renderToPipeableStream` is the only API which allows
// you to start flowing before the shell is complete and we've had a chance to emit early
// preloads already. This is really just defensive programming to ensure that we give hosts an
// opportunity to flush early preloads before streaming begins in case they are in an environment
// that only supports a single call to emitEarlyPreloads like the DOM renderers. It's unfortunate
// to put this Node only function directly in ReactFizzServer but it'd be more ackward to factor it
// by moving the implementation into ReactServerStreamConfigNode and even then we may not be able to
// eliminate all the wasted branching.
export function prepareForStartFlowingIfBeforeAllReady(request: Request) {
  const shellComplete =
    request.trackedPostpones === null
      ? // Render Request, we define shell complete by the pending root tasks
        request.pendingRootTasks === 0
      : // Prerender Request, we define shell complete by completedRootSegemtn
        request.completedRootSegment === null
        ? request.pendingRootTasks === 0
        : request.completedRootSegment.status !== POSTPONED;
  safelyEmitEarlyPreloads(request, shellComplete);
}

export function startFlowing(request: Request, destination: Destination): void {
  if (request.status === CLOSING) {
    request.status = CLOSED;
    closeWithError(destination, request.fatalError);
    return;
  }
  if (request.status === CLOSED) {
    return;
  }
  if (request.destination !== null) {
    // We're already flowing.
    return;
  }
  request.destination = destination;

  try {
    flushCompletedQueues(request, destination);
  } catch (error) {
    const errorInfo: ThrownInfo = {};
    logRecoverableError(request, error, errorInfo, null);
    fatalError(request, error, errorInfo, null);
  }
}

export function stopFlowing(request: Request): void {
  request.destination = null;
}

// This is called to early terminate a request. It puts all pending boundaries in client rendered state.
export function abort(request: Request, reason: mixed): void {
  if (request.status === OPEN || request.status === OPENING) {
    request.status = ABORTING;
  }

  try {
    const abortableTasks = request.abortableTasks;
    if (abortableTasks.size > 0) {
      const error =
        reason === undefined
          ? new Error('The render was aborted by the server without a reason.')
          : typeof reason === 'object' &&
              reason !== null &&
              typeof reason.then === 'function'
            ? new Error('The render was aborted by the server with a promise.')
            : reason;
      // This error isn't necessarily fatal in this case but we need to stash it
      // so we can use it to abort any pending work
      request.fatalError = error;
      abortableTasks.forEach(task => abortTask(task, request, error));
      abortableTasks.clear();
    }
    if (request.destination !== null) {
      flushCompletedQueues(request, request.destination);
    }
  } catch (error) {
    const errorInfo: ThrownInfo = {};
    logRecoverableError(request, error, errorInfo, null);
    fatalError(request, error, errorInfo, null);
  }
}

export function flushResources(request: Request): void {
  enqueueFlush(request);
}

export function getFormState(
  request: Request,
): ReactFormState<any, any> | null {
  return request.formState;
}

export function getResumableState(request: Request): ResumableState {
  return request.resumableState;
}

export function getRenderState(request: Request): RenderState {
  return request.renderState;
}

function addToReplayParent(
  node: ReplayNode,
  parentKeyPath: Root | KeyNode,
  trackedPostpones: PostponedHoles,
): void {
  if (parentKeyPath === null) {
    trackedPostpones.rootNodes.push(node);
  } else {
    const workingMap = trackedPostpones.workingMap;
    let parentNode = workingMap.get(parentKeyPath);
    if (parentNode === undefined) {
      parentNode = ([
        parentKeyPath[1],
        parentKeyPath[2],
        ([]: Array<ReplayNode>),
        null,
      ]: ReplayNode);
      workingMap.set(parentKeyPath, parentNode);
      addToReplayParent(parentNode, parentKeyPath[0], trackedPostpones);
    }
    parentNode[2].push(node);
  }
}

export type PostponedState = {
  nextSegmentId: number,
  rootFormatContext: FormatContext,
  progressiveChunkSize: number,
  resumableState: ResumableState,
  replayNodes: Array<ReplayNode>,
  replaySlots: ResumeSlots,
};

// Returns the state of a postponed request or null if nothing was postponed.
export function getPostponedState(request: Request): null | PostponedState {
  const trackedPostpones = request.trackedPostpones;
  if (
    trackedPostpones === null ||
    (trackedPostpones.rootNodes.length === 0 &&
      trackedPostpones.rootSlots === null)
  ) {
    // Reset. Let the flushing behave as if we completed the whole document.
    request.trackedPostpones = null;
    return null;
  }
  if (
    request.completedRootSegment !== null &&
    request.completedRootSegment.status === POSTPONED
  ) {
    // We postponed the root so we didn't flush anything.
    resetResumableState(request.resumableState, request.renderState);
  } else {
    completeResumableState(request.resumableState);
  }
  return {
    nextSegmentId: request.nextSegmentId,
    rootFormatContext: request.rootFormatContext,
    progressiveChunkSize: request.progressiveChunkSize,
    resumableState: request.resumableState,
    replayNodes: trackedPostpones.rootNodes,
    replaySlots: trackedPostpones.rootSlots,
  };
}
