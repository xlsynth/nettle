// SPDX-License-Identifier: Apache-2.0

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly NETTLE_BUILD_DATE_UTC?: string;
  readonly NETTLE_BUILD_GIT_SHA?: string;
  readonly NETTLE_BUILD_SUFFIX?: string;
  readonly NETTLE_PUBLIC_MODE?: string;
}
