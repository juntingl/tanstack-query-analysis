
export type NetworkMode = 'online' | 'always' | 'offlineFirst';

/**
 * 取消、废除参数类型
 */
export type CancelOptions = {
  revert?: boolean; // 恢复、归还
  silent?: boolean; // 无声、安静
}