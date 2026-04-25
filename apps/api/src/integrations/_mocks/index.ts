import { setHttpTransport } from '../_http/client.js';
import { MockTransport } from './transport.js';

export { getMockStore, resetMockStore } from './store.js';
export { MockTransport } from './transport.js';

// Install the mock transport globally. Call from server boot when
// USE_INTEGRATION_MOCKS=true; from test setUp() per file otherwise.
export function installMockTransport(): void {
  setHttpTransport(new MockTransport());
}
