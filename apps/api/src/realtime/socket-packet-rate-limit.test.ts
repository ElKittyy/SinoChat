import { equal } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consumeSocketPacketLocally,
  type LocalRateLimitBuckets
} from "./socket-packet-rate-limit";

describe("consumeSocketPacketLocally", () => {
  it("rechaza eventos desconocidos sin consultar servicios externos", () => {
    const buckets: LocalRateLimitBuckets = new Map();
    equal(consumeSocketPacketLocally(buckets, "otro:evento", 1_000), false);
    equal(buckets.size, 0);
  });

  it("bloquea un flood de typing por conexión antes del noveno paquete", () => {
    const buckets: LocalRateLimitBuckets = new Map();
    for (let index = 0; index < 8; index += 1) {
      equal(
        consumeSocketPacketLocally(
          buckets,
          "conversation:typing",
          1_000 + index
        ),
        true
      );
    }
    equal(
      consumeSocketPacketLocally(
        buckets,
        "conversation:typing",
        1_009
      ),
      false
    );
    equal(
      consumeSocketPacketLocally(
        buckets,
        "conversation:typing",
        5_000
      ),
      false
    );
    equal(
      consumeSocketPacketLocally(
        buckets,
        "conversation:typing",
        11_010
      ),
      true
    );
  });
});
