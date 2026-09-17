export interface CashierLoad {
  userId: string;
  activeClientCount: number;
}

export type RandomIndex = (exclusiveUpperBound: number) => number;

export function selectLeastLoadedCashier<T extends CashierLoad>(
  candidates: readonly T[],
  randomIndex: RandomIndex
): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  let minimum = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (
      !Number.isSafeInteger(candidate.activeClientCount) ||
      candidate.activeClientCount < 0
    ) {
      throw new RangeError("El conteo de clientes activos no es válido.");
    }
    minimum = Math.min(minimum, candidate.activeClientCount);
  }

  const tied = candidates.filter(
    (candidate) => candidate.activeClientCount === minimum
  );
  const selectedIndex = randomIndex(tied.length);

  if (
    !Number.isSafeInteger(selectedIndex) ||
    selectedIndex < 0 ||
    selectedIndex >= tied.length
  ) {
    throw new RangeError("El índice aleatorio no es válido.");
  }

  return tied[selectedIndex];
}
