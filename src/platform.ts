// Platform detection lives in its own module so the test suite can pin it.
// App reads this once at import time to decide which paste path to register.

export const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.userAgent) &&
  !/iphone|ipad/i.test(navigator.userAgent);
