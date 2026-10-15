import type { CanonicalSubmitAvailability } from "./sessionLifecycle.availability.ts";
import type { PromptQueueRecord } from "./promptQueue.types.ts";

/**
 * Whether an ordinary auto submit stays visible in the composer queue instead
 * of draining into an immediate send. Shared by enqueueSubmit and the
 * submit/requested diagnostics stamp so recording and queue admission agree.
 */
export function promptVisibleInQueueAdmission(
  record: PromptQueueRecord | null | undefined,
  availabilityState: CanonicalSubmitAvailability["state"]
): boolean {
  return Boolean(
    record?.prompts.length ||
    record?.inFlight ||
    record?.uncertainDelivery ||
    record?.deliveryBarrierTurnId ||
    availabilityState !== "available"
  );
}
