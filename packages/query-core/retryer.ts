/**
 * Retryer
 * 重试机制逻辑
 * 功能逻辑概述：
 *
 * @Author: Junting
 * @Last Modified by: Junting
 * @Last Modified time: 2022-12-03 12:40:10
 * @Last Modified time: 2022-12-03 16:33:53
 */

import { focusManager } from "./focusManager";
import { onlineManager } from "./onlineManager";
import type { CancelOptions, NetworkMode } from "./types";
import { sleep } from "./utils";

// TYPES

interface RetryerConfig<TData = unknown, TError = unknown> {
  fn: () => TData | Promise<TData>; // 需要重试执行回调
  abort?: () => void; // 中止、废弃当前操作
  onError?: (error: TError) => void; // 出错时触发回调
  onSuccess?: (data: TData) => void; // 成功时触发回调
  onFail?: (failureCount: number, error: TError) => void; // 失败时触发回调
  onPause?: () => void; // 暂停时触发回调
  onContinue?: () => void; // 继续执行时触发回调
  retry?: RetryValue<TError>; // 是否开启重试、重试次数、自定义是否执行重试逻辑函数
  retryDelay?: RetryDelayValue<TError>; // 延迟重试（毫秒）
  networkMode: NetworkMode | undefined; // 网络模式：online、offlineFirst、always
}

export interface Retryer<TData = unknown> {
  promise: Promise<TData>;
  cancel: (cancelOptions?: CancelOptions) => void; // 取消
  continue: () => void; // 继续
  cancelRetry: () => void; // 取消重试
  continueRetry: () => void; // 继续重试
}

/**
 * Retry Value 三种值分别：
 * boolean: 是否执行重试
 * number: 重试次数
 * ShouldRetryFunction: 自定义执行重试逻辑
 */
export type RetryValue<TError> = boolean | number | ShouldRetryFunction<TError>;

type ShouldRetryFunction<TError = unknown> = (
  failureCount: number,
  error: TError
) => boolean;

export type RetryDelayValue<TError> = number | RetryDelayFunction<TError>;

type RetryDelayFunction<TError = unknown> = (
  failureCount: number,
  error: TError
) => number;


/**
 * 默认重试延迟毫秒值
 * * <= 30s
 * * 依据失败次数累计递增延迟时长
 * @param failureCount
 * @returns
 */
function defaultRetryDelay(failureCount: number) {
  return Math.min(1000 * 2 ** failureCount, 30000);
}

/**
 * 依据 networkMode 返回是否可以 fetch
 * 默认模式：online, 在线模式下，控制由 onlineManager 管控
 * @param networkMode online ｜ offlineFirst｜ always
 */
export function canFetch(networkMode: NetworkMode | undefined): boolean {
  return (networkMode ?? "online") === "online"
    ? onlineManager.isOnline()
    : true;
}

/**
 * 被取消的错误
 */
export class CancelledError {
  revert?: boolean;
  silent?: boolean;
  constructor (options?: CancelOptions) {
    this.revert = options?.revert;
    this.silent = options?.silent;
  }
}

/**
 * 判断是否是 CancelledError 的实例
 * @param value {any}
 * @returns {boolean}
 */
export function isCancelledError(value: any): value is CancelledError {
  return value instanceof CancelledError;
}

export function CreateRetryer<TData = unknown, TError = unknown>(
  config: RetryerConfig<TData, TError>
): Retryer<TData> {
  let isRetryCancelled = false; // 判定是否已被取消
  let failureCount = 0; // 失败计数
  let isResolved = false; // 判定当前操作是否已完毕, 循环终止必要条件

  let continueFn: ((value?: unknown) => void) | undefined
  let promiseResolve: (data: TData) => void
  let promiseReject: (error:TError) => void

  // Promise 化，通过内部的一层包装，使状态间扭转更好控制
  const promise = new Promise<TData>((outerResolve, outerReject) => {
    promiseResolve = outerResolve;
    promiseReject = outerReject;
  });

  // 取消操作
  const cancel = (cancelOptions?: CancelOptions): void => {
    if (!isResolved) {
      reject(new CancelledError(cancelOptions));
      // 执行废除
      config.abort?.();
    }
  };

  // 变更状态，已被取消
  const cancelRetry = () => {
    isRetryCancelled = true;
  };

  // 变更状态，未被取消
  const continueRetry = () => {
    isRetryCancelled = false;
  };

  // 成功后处理逻辑
  const resolve = (value: any) => {
    if (!isResolved) {
      isResolved = true;
      config.onSuccess?.(value);
      // TODO: 待理解
      continueFn?.();
      promiseResolve(value);
    }
  };

  // 失败后处理逻辑
  const reject = (value: any) => {
    if (!isResolved) {
      isResolved = true;
      config.onError?.(value);
      continueFn?.();
      promiseReject(value);
    }
  };

  // 判定是否应该暂定执行，当窗口失焦时或（网络模式不为 always 并且不在线）
  const shouldPause = () =>
    !focusManager.isFocused() ||
    (config.networkMode === "always" && !onlineManager.isOnline());

  // 暂停处理逻辑
  const pause = () => {
    return new Promise((continueResolve) => {
      continueFn = (value) => {
        if (isResolved || !shouldPause()) {
          return continueResolve(value);
        }
        config.onPause?.();
      }
    // 暂定执行逻辑处理完，恢复 pause 相关初始值
    }).then(() => {
      continueFn = undefined;
      // 如果是一个没有解决完，执行用户提供的 onContinue 回调
      if (!isResolved) {
        config.onContinue?.();
      }
    });
  }

  // 创建循环函数，用于不停 retry
  const run = () => {
    // 如果已经解决，则不做任何事情
    if (isResolved) return

    let promiseOrValue: any;

    // 执行查询, 捕获用户未提供执行函数时
    try {
      promiseOrValue = config.fn();
    } catch(error) {
      promiseOrValue = Promise.reject(error);
    }

    Promise.resolve(promiseOrValue)
      .then(resolve)
      .catch((error) => { // 失败重试逻辑，达到循环目的
        // 检测先决条件
        if (isResolved) return;

        // 有自定义采用自定义，没有默认值为 3 次
        const retry = config.retry ?? 3;
        const retryDelay = config.retryDelay ?? defaultRetryDelay;
        const delay =
          typeof retryDelay === "function"
            ? retryDelay(failureCount, error)
            : retryDelay;
        // 判定是否重试
        const shouldRetry =
          retry === true ||
          (typeof retry === "number" && failureCount < retry) ||
          (typeof retry === "function" && retry(failureCount, error));

        // 已被取消或不满足重试条件的情况下，reject 并返回
        if (isRetryCancelled || !shouldRetry) {
          reject(error);
          return
        }

        failureCount++;
        // 通知失败
        config.onFail?.(failureCount, error);

        // 满足延迟时间，继续执行
        sleep(delay)
          .then(() => {
            // 检测当前是否应该暂停，离线、窗口失焦情况
            if (shouldPause()) {
              return pause();
            }
          })
          .then(() => {
            if (isRetryCancelled) {
              reject(error)
            } else {
              run()
            }
          })
      })
  }

  // 开启循环
  if (canFetch(config.networkMode)) {
    run();
  } else {
    // 离线、失去焦点等情况下，先暂停，待后续接着执行。
    pause().then(run);
  }

  return {
    promise,
    cancel,
    continue: () => {
      continueFn?.();
    },
    cancelRetry,
    continueRetry
  }
}
