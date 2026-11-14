export const BALANCE_ADJUSTMENT_HISTORY_LIMIT = 50;

export function createBalanceAdjustmentRecord(transaction, balanceBeforeCents, names = {}) {
  return {
    id: transaction.id,
    userId: transaction.userId,
    actorId: transaction.createdBy,
    actorUsername: String(names.actorUsername || transaction.createdBy || '').slice(0, 160),
    targetUsername: String(names.targetUsername || transaction.userId).slice(0, 160),
    amountCents: Number(transaction.amountCents),
    balanceBeforeCents: Number(balanceBeforeCents),
    balanceAfterCents: Number(balanceBeforeCents) + Number(transaction.amountCents),
    createdAt: transaction.createdAt,
  };
}

export function retainBalanceAdjustmentHistory(records) {
  return records.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-BALANCE_ADJUSTMENT_HISTORY_LIMIT);
}
