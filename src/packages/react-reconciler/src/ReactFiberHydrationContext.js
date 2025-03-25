/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactInternalTypes';
import type {
  Instance,
  TextInstance,
  HydratableInstance,
  SuspenseInstance,
  Container,
  HostContext,
} from './ReactFiberConfig';
import type {SuspenseState} from './ReactFiberSuspenseComponent';
import type {TreeContext} from './ReactFiberTreeContext';
import type {CapturedValue} from './ReactCapturedValue';
import type {HydrationDiffNode} from './ReactFiberHydrationDiffs';

import {
  HostComponent,
  HostSingleton,
  HostRoot,
  SuspenseComponent,
} from './ReactWorkTags';
import {favorSafetyOverHydrationPerf} from 'shared/ReactFeatureFlags';

import {createCapturedValueAtFiber} from './ReactCapturedValue';

import {createFiberFromDehydratedFragment} from './ReactFiber';
import {
  shouldSetTextContent,
  supportsHydration,
  supportsSingletons,
  getNextHydratableSibling,
  getFirstHydratableChild,
  getFirstHydratableChildWithinContainer,
  getFirstHydratableChildWithinSuspenseInstance,
  hydrateInstance,
  diffHydratedPropsForDevWarnings,
  describeHydratableInstanceForDevWarnings,
  hydrateTextInstance,
  diffHydratedTextForDevWarnings,
  hydrateSuspenseInstance,
  getNextHydratableInstanceAfterSuspenseInstance,
  shouldDeleteUnhydratedTailInstances,
  resolveSingletonInstance,
  canHydrateInstance,
  canHydrateTextInstance,
  canHydrateSuspenseInstance,
  canHydrateFormStateMarker,
  isFormStateMarkerMatching,
  validateHydratableInstance,
  validateHydratableTextInstance,
} from './ReactFiberConfig';
import {OffscreenLane} from './ReactFiberLane';
import {
  getSuspendedTreeContext,
  restoreSuspendedTreeContext,
} from './ReactFiberTreeContext';
import {queueRecoverableErrors} from './ReactFiberWorkLoop';
import {getRootHostContainer, getHostContext} from './ReactFiberHostContext';
import {describeDiff} from './ReactFiberHydrationDiffs';

// The deepest Fiber on the stack involved in a hydration context.
// This may have been an insertion or a hydration.
let hydrationParentFiber: null | Fiber = null;
let nextHydratableInstance: null | HydratableInstance = null;
let isHydrating: boolean = false;

// This flag allows for warning supression when we expect there to be mismatches
// due to earlier mismatches or a suspended fiber.
let didSuspendOrErrorDEV: boolean = false;

// Hydration differences found that haven't yet been logged.
let hydrationDiffRootDEV: null | HydrationDiffNode = null;

// Hydration errors that were thrown inside this boundary
let hydrationErrors: Array<CapturedValue<mixed>> | null = null;

let rootOrSingletonContext = false;

// Builds a common ancestor tree from the root down for collecting diffs.
function buildHydrationDiffNode(
  fiber: Fiber,
  distanceFromLeaf: number,
): HydrationDiffNode {
  if (fiber.return === null) {
    // We're at the root.
    if (hydrationDiffRootDEV === null) {
      hydrationDiffRootDEV = {
        fiber: fiber,
        children: [],
        serverProps: undefined,
        serverTail: [],
        distanceFromLeaf: distanceFromLeaf,
      };
    } else if (hydrationDiffRootDEV.fiber !== fiber) {
      throw new Error(
        'Saw multiple hydration diff roots in a pass. This is a bug in React.',
      );
    } else if (hydrationDiffRootDEV.distanceFromLeaf > distanceFromLeaf) {
      hydrationDiffRootDEV.distanceFromLeaf = distanceFromLeaf;
    }
    return hydrationDiffRootDEV;
  }
  const siblings = buildHydrationDiffNode(
    fiber.return,
    distanceFromLeaf + 1,
  ).children;
  // The same node may already exist in the parent. Since we currently always render depth first
  // and rerender if we suspend or terminate early, if a shared ancestor was added we should still
  // be inside of that shared ancestor which means it was the last one to be added. If this changes
  // we may have to scan the whole set.
  if (siblings.length > 0 && siblings[siblings.length - 1].fiber === fiber) {
    const existing = siblings[siblings.length - 1];
    if (existing.distanceFromLeaf > distanceFromLeaf) {
      existing.distanceFromLeaf = distanceFromLeaf;
    }
    return existing;
  }
  const newNode: HydrationDiffNode = {
    fiber: fiber,
    children: [],
    serverProps: undefined,
    serverTail: [],
    distanceFromLeaf: distanceFromLeaf,
  };
  siblings.push(newNode);
  return newNode;
}

function warnIfHydrating() {
  if (__DEV__) {
    if (isHydrating) {
      console.error(
        'We should not be hydrating here. This is a bug in React. Please file a bug.',
      );
    }
  }
}

export function markDidThrowWhileHydratingDEV() {
  if (__DEV__) {
    didSuspendOrErrorDEV = true;
  }
}

function enterHydrationState(fiber: Fiber): boolean {
  if (!supportsHydration) {
    return false;
  }

  const parentInstance: Container = fiber.stateNode.containerInfo;
  nextHydratableInstance =
    getFirstHydratableChildWithinContainer(parentInstance);
  hydrationParentFiber = fiber;
  isHydrating = true;
  hydrationErrors = null;
  didSuspendOrErrorDEV = false;
  hydrationDiffRootDEV = null;
  rootOrSingletonContext = true;
  return true;
}

function reenterHydrationStateFromDehydratedSuspenseInstance(
  fiber: Fiber,
  suspenseInstance: SuspenseInstance,
  treeContext: TreeContext | null,
): boolean {
  if (!supportsHydration) {
    return false;
  }
  //  找到suspenseInstance内部可以进行水合的节点
  nextHydratableInstance =
    getFirstHydratableChildWithinSuspenseInstance(suspenseInstance);
  hydrationParentFiber = fiber;
  isHydrating = true;
  hydrationErrors = null;
  didSuspendOrErrorDEV = false;
  hydrationDiffRootDEV = null;
  rootOrSingletonContext = false;
  if (treeContext !== null) {
    restoreSuspendedTreeContext(fiber, treeContext);// 恢复上下文
  }
  return true;
}

function warnNonHydratedInstance(
  fiber: Fiber,
  rejectedCandidate: null | HydratableInstance,
) {
  if (__DEV__) {
    if (didSuspendOrErrorDEV) {
      // Inside a boundary that already suspended. We're currently rendering the
      // siblings of a suspended node. The mismatch may be due to the missing
      // data, so it's probably a false positive.
      return;
    }

    // Add this fiber to the diff tree.
    const diffNode = buildHydrationDiffNode(fiber, 0);
    // We use null as a signal that there was no node to match.
    diffNode.serverProps = null;
    if (rejectedCandidate !== null) {
      const description =
        describeHydratableInstanceForDevWarnings(rejectedCandidate);
      diffNode.serverTail.push(description);
    }
  }
}

function tryHydrateInstance(
  fiber: Fiber,
  nextInstance: any,
  hostContext: HostContext,
) {
  // fiber is a HostComponent Fiber
  const instance = canHydrateInstance(
    nextInstance,
    fiber.type,
    fiber.pendingProps,
    rootOrSingletonContext,
  );
  if (instance !== null) {
    fiber.stateNode = (instance: Instance);

    if (__DEV__) {
      if (!didSuspendOrErrorDEV) {
        const differences = diffHydratedPropsForDevWarnings(
          instance,
          fiber.type,
          fiber.pendingProps,
          hostContext,
        );
        if (differences !== null) {
          const diffNode = buildHydrationDiffNode(fiber, 0);
          diffNode.serverProps = differences;
        }
      }
    }

    hydrationParentFiber = fiber;
    nextHydratableInstance = getFirstHydratableChild(instance);
    rootOrSingletonContext = false;
    return true;
  }
  return false;
}

function tryHydrateText(fiber: Fiber, nextInstance: any) {
  // fiber is a HostText Fiber
  const text = fiber.pendingProps;
  const textInstance = canHydrateTextInstance(
    nextInstance,
    text,
    rootOrSingletonContext,
  );
  if (textInstance !== null) {
    fiber.stateNode = (textInstance: TextInstance);
    hydrationParentFiber = fiber;
    // Text Instances don't have children so there's nothing to hydrate.
    nextHydratableInstance = null;
    return true;
  }
  return false;
}

function tryHydrateSuspense(fiber: Fiber, nextInstance: any) {
  //  获取可以水合的节点
  const suspenseInstance = canHydrateSuspenseInstance(
    nextInstance,
    rootOrSingletonContext,
  );
  if (suspenseInstance !== null) {
    //  创建suspenseState对象
    const suspenseState: SuspenseState = {
      dehydrated: suspenseInstance,
      treeContext: getSuspendedTreeContext(),
      retryLane: OffscreenLane,
    };
    // 将创建的状态对象赋值给 Suspense fiber 的 memoizedState
    // 这样 Suspense 组件就知道它有一个脱水状态需要处理
    fiber.memoizedState = suspenseState;

    // 创建一个表示脱水片段的 fiber 节点
    // 这简化了后续的节点操作，如查找兄弟节点和删除节点
    // 因为不需要考虑所有 Suspense 边界并检查它们是否是脱水状态
    const dehydratedFragment =
      createFiberFromDehydratedFragment(suspenseInstance);
      // 设置脱水片段 fiber 的父指针指向 Suspense fiber
    dehydratedFragment.return = fiber;

    // 将 Suspense fiber 的子指针指向脱水片段
    // 这建立了 Suspense 和其脱水内容之间的连接
    fiber.child = dehydratedFragment;
    hydrationParentFiber = fiber;
    // 将下一个待水合实例设为 null
    // 这是因为虽然 Suspense 实例有子节点，但我们不会在第一次遍历时处理它们
    // 而是在后续的特殊处理中重新进入这个 Suspense 进行水合
    nextHydratableInstance = null;
    return true;
  }
  return false;
}

export const HydrationMismatchException: mixed = new Error(
  'Hydration Mismatch Exception: This is not a real error, and should not leak into ' +
    "userspace. If you're seeing this, it's likely a bug in React.",
);

function throwOnHydrationMismatch(fiber: Fiber) {
  let diff = '';
  if (__DEV__) {
    // Consume the diff root for this mismatch.
    // Any other errors will get their own diffs.
    const diffRoot = hydrationDiffRootDEV;
    if (diffRoot !== null) {
      hydrationDiffRootDEV = null;
      diff = describeDiff(diffRoot);
    }
  }
  const error = new Error(
    "Hydration failed because the server rendered HTML didn't match the client. As a result this tree will be regenerated on the client. This can happen if a SSR-ed Client Component used:\n" +
      '\n' +
      "- A server/client branch `if (typeof window !== 'undefined')`.\n" +
      "- Variable input such as `Date.now()` or `Math.random()` which changes each time it's called.\n" +
      "- Date formatting in a user's locale which doesn't match the server.\n" +
      '- External changing data without sending a snapshot of it along with the HTML.\n' +
      '- Invalid HTML tag nesting.\n' +
      '\n' +
      'It can also happen if the client has a browser extension installed which messes with the HTML before React loaded.\n' +
      '\n' +
      'https://react.dev/link/hydration-mismatch' +
      diff,
  );
  queueHydrationError(createCapturedValueAtFiber(error, fiber));
  throw HydrationMismatchException;
}

function claimHydratableSingleton(fiber: Fiber): void {
  if (supportsSingletons) {
    if (!isHydrating) {
      return;
    }
    const currentRootContainer = getRootHostContainer();
    const currentHostContext = getHostContext();
    const instance = (fiber.stateNode = resolveSingletonInstance(
      fiber.type,
      fiber.pendingProps,
      currentRootContainer,
      currentHostContext,
      false,
    ));

    if (__DEV__) {
      if (!didSuspendOrErrorDEV) {
        const differences = diffHydratedPropsForDevWarnings(
          instance,
          fiber.type,
          fiber.pendingProps,
          currentHostContext,
        );
        if (differences !== null) {
          const diffNode = buildHydrationDiffNode(fiber, 0);
          diffNode.serverProps = differences;
        }
      }
    }

    hydrationParentFiber = fiber;
    rootOrSingletonContext = true;
    nextHydratableInstance = getFirstHydratableChild(instance);
  }
}

function tryToClaimNextHydratableInstance(fiber: Fiber): void {
  if (!isHydrating) {
    return;
  }

  // Validate that this is ok to render here before any mismatches.
  const currentHostContext = getHostContext();
  const shouldKeepWarning = validateHydratableInstance(
    fiber.type,
    fiber.pendingProps,
    currentHostContext,
  );

  const nextInstance = nextHydratableInstance;
  if (
    !nextInstance ||
    !tryHydrateInstance(fiber, nextInstance, currentHostContext)
  ) {
    if (shouldKeepWarning) {
      warnNonHydratedInstance(fiber, nextInstance);
    }
    throwOnHydrationMismatch(fiber);
  }
}

function tryToClaimNextHydratableTextInstance(fiber: Fiber): void {
  if (!isHydrating) {
    return;
  }
  const text = fiber.pendingProps;

  let shouldKeepWarning = true;
  // Validate that this is ok to render here before any mismatches.
  const currentHostContext = getHostContext();
  shouldKeepWarning = validateHydratableTextInstance(text, currentHostContext);

  const nextInstance = nextHydratableInstance;
  if (!nextInstance || !tryHydrateText(fiber, nextInstance)) {
    if (shouldKeepWarning) {
      warnNonHydratedInstance(fiber, nextInstance);
    }
    throwOnHydrationMismatch(fiber);
  }
}

function tryToClaimNextHydratableSuspenseInstance(fiber: Fiber): void {
  if (!isHydrating) {
    return;
  }
  const nextInstance = nextHydratableInstance;
  if (!nextInstance || !tryHydrateSuspense(fiber, nextInstance)) {
    warnNonHydratedInstance(fiber, nextInstance);
    throwOnHydrationMismatch(fiber);
  }
}

export function tryToClaimNextHydratableFormMarkerInstance(
  fiber: Fiber,
): boolean {
  if (!isHydrating) {
    return false;
  }
  if (nextHydratableInstance) {
    const markerInstance = canHydrateFormStateMarker(
      nextHydratableInstance,
      rootOrSingletonContext,
    );
    if (markerInstance) {
      // Found the marker instance.
      nextHydratableInstance = getNextHydratableSibling(markerInstance);
      // Return true if this marker instance should use the state passed
      // to hydrateRoot.
      // TODO: As an optimization, Fizz should only emit these markers if form
      // state is passed at the root.
      return isFormStateMarkerMatching(markerInstance);
    }
  }
  // Should have found a marker instance. Throw an error to trigger client
  // rendering. We don't bother to check if we're in a concurrent root because
  // useActionState is a new API, so backwards compat is not an issue.
  throwOnHydrationMismatch(fiber);
  return false;
}

function prepareToHydrateHostInstance(
  fiber: Fiber,
  hostContext: HostContext,
): void {
  if (!supportsHydration) {
    throw new Error(
      'Expected prepareToHydrateHostInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  const instance: Instance = fiber.stateNode;
  const didHydrate = hydrateInstance(
    instance,
    fiber.type,
    fiber.memoizedProps,
    hostContext,
    fiber,
  );
  if (!didHydrate && favorSafetyOverHydrationPerf) {
    throwOnHydrationMismatch(fiber);
  }
}

function prepareToHydrateHostTextInstance(fiber: Fiber): void {
  if (!supportsHydration) {
    throw new Error(
      'Expected prepareToHydrateHostTextInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  const textInstance: TextInstance = fiber.stateNode;// 当前的DOM 实例
  const textContent: string = fiber.memoizedProps;//  Fiber 中预期的文本内容
  const shouldWarnIfMismatchDev = !didSuspendOrErrorDEV;
  let parentProps = null;
  // We assume that prepareToHydrateHostTextInstance is called in a context where the
  // hydration parent is the parent host component of this host text.
  const returnFiber = hydrationParentFiber;//水合的父组件
  if (returnFiber !== null) {
    switch (returnFiber.tag) {
      case HostRoot: {
        if (__DEV__) {
          if (shouldWarnIfMismatchDev) {
            const difference = diffHydratedTextForDevWarnings(
              textInstance,
              textContent,
              parentProps,
            );
            if (difference !== null) {
              const diffNode = buildHydrationDiffNode(fiber, 0);
              diffNode.serverProps = difference;
            }
          }
        }
        break;
      }
      case HostSingleton:
      case HostComponent: {
        parentProps = returnFiber.memoizedProps;
        if (__DEV__) {
          if (shouldWarnIfMismatchDev) {
            const difference = diffHydratedTextForDevWarnings(
              textInstance,
              textContent,
              parentProps,
            );
            if (difference !== null) {
              const diffNode = buildHydrationDiffNode(fiber, 0);
              diffNode.serverProps = difference;
            }
          }
        }
        break;
      }
    }
    // TODO: What if it's a SuspenseInstance?
  }
  // 关联DOM跟Fiber的props内容
  const didHydrate = hydrateTextInstance(
    textInstance,
    textContent,
    fiber,
    parentProps,
  );
  if (!didHydrate && favorSafetyOverHydrationPerf) {
    throwOnHydrationMismatch(fiber);
  }
}

function prepareToHydrateHostSuspenseInstance(fiber: Fiber): void {
  if (!supportsHydration) {
    throw new Error(
      'Expected prepareToHydrateHostSuspenseInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  const suspenseState: null | SuspenseState = fiber.memoizedState;
  const suspenseInstance: null | SuspenseInstance =
    suspenseState !== null ? suspenseState.dehydrated : null;

  if (!suspenseInstance) {
    throw new Error(
      'Expected to have a hydrated suspense instance. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  hydrateSuspenseInstance(suspenseInstance, fiber);
}

function skipPastDehydratedSuspenseInstance(
  fiber: Fiber,
): null | HydratableInstance {
  if (!supportsHydration) {
    throw new Error(
      'Expected skipPastDehydratedSuspenseInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }
  //  获取脱水内容
  const suspenseState: null | SuspenseState = fiber.memoizedState;
  //  获取脱水的服务端渲染内容
  const suspenseInstance: null | SuspenseInstance =
    suspenseState !== null ? suspenseState.dehydrated : null;

  if (!suspenseInstance) {
    throw new Error(
      'Expected to have a hydrated suspense instance. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }
  return getNextHydratableInstanceAfterSuspenseInstance(suspenseInstance);
}

function popToNextHostParent(fiber: Fiber): void {
  hydrationParentFiber = fiber.return;
  while (hydrationParentFiber) {
    switch (hydrationParentFiber.tag) {
      case HostRoot:
      case HostSingleton:
        rootOrSingletonContext = true;
        return;
      case HostComponent:
      case SuspenseComponent:
        rootOrSingletonContext = false;
        return;
      default:
        hydrationParentFiber = hydrationParentFiber.return;
    }
  }
}
//  判断当前传入的fiber是否已经水合成功
function popHydrationState(fiber: Fiber): boolean {
  //  当前渲染器不支持水合。返回false
  if (!supportsHydration) {
    return false;
  }
  //  当前Fiber并不是水合父组件
  if (fiber !== hydrationParentFiber) {
    return false;
  }
  // 当前不在水合过程中但在水合上下文中
  if (!isHydrating) {
    //  说明这是一个插入操作，需要弹出并重新进入兄弟节点的水合过程。
    popToNextHostParent(fiber);
    isHydrating = true;
    return false;
  }

  let shouldClear = false;
  //  判断是否需要清理未水合的节点
  if (supportsSingletons) {
    //  单例节点
    if (
      fiber.tag !== HostRoot &&
      fiber.tag !== HostSingleton &&
      !(
        fiber.tag === HostComponent &&
        (!shouldDeleteUnhydratedTailInstances(fiber.type) ||//  是否应该删除未水合的尾部实例
          shouldSetTextContent(fiber.type, fiber.memoizedProps))//  是否应该直接设置文本内容
      )
      //  节点不是HostComponent元素
      // (fiber.tag !== HostComponent 
      //  或者应该删除未水合尾部且不应设置文本内容
      // || (shouldDeleteUnhydratedTailInstances(fiber.type) && !shouldSetTextContent(fiber.type, fiber.memoizedProps)))
    ) {
    
      shouldClear = true;
    }
  } else {
    if (
      fiber.tag !== HostRoot &&
      (fiber.tag !== HostComponent ||
        (shouldDeleteUnhydratedTailInstances(fiber.type) &&
          !shouldSetTextContent(fiber.type, fiber.memoizedProps)))
    ) {
      shouldClear = true;
    }
  }
  //  需要清理未水合节点
  if (shouldClear) {
    //  获取待水合的的实例
    //  服务端跟客户端不一致，需要报错
      // {typeof window === 'undefined' && (导致没有
      //   <p>这段内容只在服务端渲染时出现</p>
      // )}
    const nextInstance = nextHydratableInstance;
    if (nextInstance) {
      //  报错
      warnIfUnhydratedTailNodes(fiber);
      throwOnHydrationMismatch(fiber);
    }
  }
  //  退出当前水合Fiber，将return作为下一个水合父组件
  popToNextHostParent(fiber);
  //  定义下一个需要水合的实例
  if (fiber.tag === SuspenseComponent) {
    //  找到suspense的边界，然后获取下一个未水合的dom节点
    nextHydratableInstance = skipPastDehydratedSuspenseInstance(fiber);
  } else {
    // 直接找下一个
    nextHydratableInstance = hydrationParentFiber
      ? getNextHydratableSibling(fiber.stateNode)
      : null;
  }
  return true;
}

function warnIfUnhydratedTailNodes(fiber: Fiber) {
  if (__DEV__) {
    let nextInstance = nextHydratableInstance;
    while (nextInstance) {
      const diffNode = buildHydrationDiffNode(fiber, 0);
      const description =
        describeHydratableInstanceForDevWarnings(nextInstance);
      diffNode.serverTail.push(description);
      if (description.type === 'Suspense') {
        const suspenseInstance: SuspenseInstance = (nextInstance: any);
        nextInstance =
          getNextHydratableInstanceAfterSuspenseInstance(suspenseInstance);
      } else {
        nextInstance = getNextHydratableSibling(nextInstance);
      }
    }
  }
}

function resetHydrationState(): void {
  if (!supportsHydration) {
    return;
  }

  hydrationParentFiber = null;
  nextHydratableInstance = null;
  isHydrating = false;
  didSuspendOrErrorDEV = false;
}

export function upgradeHydrationErrorsToRecoverable(): void {
  if (hydrationErrors !== null) {
    // Successfully completed a forced client render. The errors that occurred
    // during the hydration attempt are now recovered. We will log them in
    // commit phase, once the entire tree has finished.
    queueRecoverableErrors(hydrationErrors);
    hydrationErrors = null;
  }
}

function getIsHydrating(): boolean {
  return isHydrating;
}

export function queueHydrationError(error: CapturedValue<mixed>): void {
  if (hydrationErrors === null) {
    hydrationErrors = [error];
  } else {
    hydrationErrors.push(error);
  }
}

export function emitPendingHydrationWarnings() {
  if (__DEV__) {
    // If we haven't yet thrown any hydration errors by the time we reach the end we've successfully
    // hydrated, however, we might still have DEV-only mismatches that we log now.
    const diffRoot = hydrationDiffRootDEV;
    if (diffRoot !== null) {
      hydrationDiffRootDEV = null;
      const diff = describeDiff(diffRoot);
      console.error(
        "A tree hydrated but some attributes of the server rendered HTML didn't match the client properties. This won't be patched up. " +
          'This can happen if a SSR-ed Client Component used:\n' +
          '\n' +
          "- A server/client branch `if (typeof window !== 'undefined')`.\n" +
          "- Variable input such as `Date.now()` or `Math.random()` which changes each time it's called.\n" +
          "- Date formatting in a user's locale which doesn't match the server.\n" +
          '- External changing data without sending a snapshot of it along with the HTML.\n' +
          '- Invalid HTML tag nesting.\n' +
          '\n' +
          'It can also happen if the client has a browser extension installed which messes with the HTML before React loaded.\n' +
          '\n' +
          '%s%s',
        'https://react.dev/link/hydration-mismatch',
        diff,
      );
    }
  }
}

export {
  warnIfHydrating,
  enterHydrationState,
  getIsHydrating,
  reenterHydrationStateFromDehydratedSuspenseInstance,
  resetHydrationState,
  claimHydratableSingleton,
  tryToClaimNextHydratableInstance,
  tryToClaimNextHydratableTextInstance,
  tryToClaimNextHydratableSuspenseInstance,
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  prepareToHydrateHostSuspenseInstance,
  popHydrationState,
};
