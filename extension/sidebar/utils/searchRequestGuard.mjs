export function createSearchRequestGuard() {
  let activeRequestId = 0;

  return {
    begin() {
      activeRequestId += 1;
      return activeRequestId;
    },
    invalidate() {
      activeRequestId += 1;
      return activeRequestId;
    },
    isCurrent(requestId) {
      return requestId === activeRequestId;
    }
  };
}
