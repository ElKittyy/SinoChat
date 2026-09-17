import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { selectLeastLoadedCashier } from "./cashier-selection";

describe("selectLeastLoadedCashier", () => {
  it("devuelve undefined cuando no hay cajeros elegibles", () => {
    equal(selectLeastLoadedCashier([], () => 0), undefined);
  });

  it("elige exclusivamente al cajero con menor carga", () => {
    const selected = selectLeastLoadedCashier(
      [
        { userId: "cajero-10", activeClientCount: 10 },
        { userId: "cajero-5", activeClientCount: 5 },
        { userId: "cajero-8", activeClientCount: 8 }
      ],
      () => 0
    );

    equal(selected?.userId, "cajero-5");
  });

  it("desempata aleatoriamente solo dentro del mínimo", () => {
    const source = [
      { userId: "primero", activeClientCount: 5 },
      { userId: "sobrecargado", activeClientCount: 9 },
      { userId: "segundo", activeClientCount: 5 }
    ] as const;

    const selected = selectLeastLoadedCashier(source, (tieCount) => {
      equal(tieCount, 2);
      return 1;
    });

    equal(selected?.userId, "segundo");
    deepEqual(source.map((candidate) => candidate.userId), [
      "primero",
      "sobrecargado",
      "segundo"
    ]);
  });

  it("rechaza conteos e índices inválidos", () => {
    throws(
      () =>
        selectLeastLoadedCashier(
          [{ userId: "cajero", activeClientCount: -1 }],
          () => 0
        ),
      RangeError
    );
    throws(
      () =>
        selectLeastLoadedCashier(
          [{ userId: "cajero", activeClientCount: 0 }],
          () => 1
        ),
      RangeError
    );
  });
});
