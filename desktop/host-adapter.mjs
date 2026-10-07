/** Desktop-only implementation of the documented SpeechHostPort contract. */
export class DesktopHostAdapter {
  constructor(sdk) {
    this.sdk = sdk;
    this.state = sdk.state;
    this.composer = sdk.composer;
  }
  profileRoutes(...args) { return this.sdk.profileRoutes(...args); }
  requestProfile(...args) { return this.sdk.requestProfile(...args); }
  navigate(...args) { return this.sdk.navigate(...args); }
  locationKey() { return globalThis.location?.hash || ''; }
}

