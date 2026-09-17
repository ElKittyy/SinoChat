export interface LocalRateLimitBucket {
  windowStartedAt: number;
  hits: number;
  blockedUntil: number;
}

export type LocalRateLimitBuckets = Map<string, LocalRateLimitBucket>;

const GENERAL_POLICY = {
  limit: 40,
  ttl: 10_000,
  blockDuration: 30_000
} as const;

const TYPING_POLICY = {
  limit: 8,
  ttl: 2_000,
  blockDuration: 10_000
} as const;

const ACCEPTED_EVENTS = new Set(["conversation:typing"]);

export function consumeSocketPacketLocally(
  buckets: LocalRateLimitBuckets,
  eventName: string,
  now = Date.now()
): boolean {
  if (!ACCEPTED_EVENTS.has(eventName)) {
    return false;
  }
  if (!consumeBucket(buckets, "all", GENERAL_POLICY, now)) {
    return false;
  }
  if (
    eventName === "conversation:typing" &&
    !consumeBucket(buckets, "typing", TYPING_POLICY, now)
  ) {
    return false;
  }
  return true;
}

function consumeBucket(
  buckets: LocalRateLimitBuckets,
  name: string,
  policy: {
    limit: number;
    ttl: number;
    blockDuration: number;
  },
  now: number
): boolean {
  const current = buckets.get(name);
  if (current?.blockedUntil && current.blockedUntil > now) {
    return false;
  }

  const bucket =
    !current ||
    current.blockedUntil > 0 ||
    now - current.windowStartedAt >= policy.ttl
      ? { windowStartedAt: now, hits: 0, blockedUntil: 0 }
      : current;
  bucket.hits += 1;
  if (bucket.hits > policy.limit) {
    bucket.blockedUntil = now + policy.blockDuration;
    buckets.set(name, bucket);
    return false;
  }
  buckets.set(name, bucket);
  return true;
}
