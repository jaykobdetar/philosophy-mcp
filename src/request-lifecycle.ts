/**
 * SDK 1.29.0 suppresses responses to canceled requests, then deletes the
 * request's AbortController after its handler and any pending response write
 * finish. Observe that terminal cleanup so transport admission is reclaimed
 * even when there is no response. Never release a slot on cancellation alone.
 *
 * The pinned SDK has no public request-completion hook. Keep this instance-local
 * adapter explicit and fail closed if its internal lifecycle contract changes.
 */
export function trackCanceledRequestCompletion(
  protocol: object,
  onComplete: (requestId: unknown) => void,
): void {
  const controllers = (
    protocol as { _requestHandlerAbortControllers?: Map<unknown, AbortController> }
  )._requestHandlerAbortControllers;
  if (!(controllers instanceof Map)) {
    throw new Error("Unable to observe SDK request completion; refusing unbounded admission.");
  }
  const deleteController = controllers.delete.bind(controllers);
  controllers.delete = (requestId) => {
    const controller = controllers.get(requestId);
    const deleted = deleteController(requestId);
    if (deleted && controller?.signal.aborted) onComplete(requestId);
    return deleted;
  };
}
