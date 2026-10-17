const SAFE_ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "PayUConfigurationError",
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoServerError",
  "MongoOperationTimeoutError",
  "MongoWaitQueueTimeoutError",
  "MongoParseError",
  "MongoInvalidArgumentError",
  "MongoTopologyClosedError",
  "MongoClientClosedError",
  "MongoPoolClosedError",
  "MongoRuntimeError",
]);

/** Returns an allowlisted class label without exposing an exception message. */
export function getSafeCheckoutErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return SAFE_ERROR_CLASSES.has(error.name) ? error.name : "OtherError";
}
