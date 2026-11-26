(() => {
	'use strict';

	// Content-script side of the bridge. The page-world script (src/injected/bridge.js) is loaded by
	// the manifest with "world": "MAIN", so there is no script tag to inject (which a strict
	// Content-Security-Policy could block). This class only talks to it with window.postMessage.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function makeRequestId() {
		return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	class BridgeClient {
		constructor() {
			this._pending = new Map();
			this._listeners = new Map();

			window.addEventListener('message', (event) => {
				if (event.source !== window) return;
				const data = event.data;
				if (!data || data.cc !== 'ClaudeCounter') return;

				if (data.type === 'cc:response') {
					const { requestId, ok, payload, error } = data;
					const pending = this._pending.get(requestId);
					if (!pending) return;
					this._pending.delete(requestId);
					clearTimeout(pending.timeoutId);
					if (ok) pending.resolve(payload);
					else pending.reject(new Error(error || 'Bridge request failed'));
					return;
				}

				this._emit(data.type, data.payload);
			});
		}

		_emit(type, payload) {
			const listeners = this._listeners.get(type);
			if (!listeners) return;
			for (const fn of Array.from(listeners)) {
				try {
					fn(payload);
				} catch (e) {
					CC.diag?.log('EVENT_IGNORED', `handler for ${type} threw`);
				}
			}
		}

		on(type, fn) {
			if (!this._listeners.has(type)) this._listeners.set(type, new Set());
			this._listeners.get(type).add(fn);
			return () => this._listeners.get(type)?.delete(fn);
		}

		request(kind, payload, { timeoutMs = 10000 } = {}) {
			const requestId = makeRequestId();
			return new Promise((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					this._pending.delete(requestId);
					reject(new Error(`Bridge request timed out (${kind})`));
				}, timeoutMs);

				this._pending.set(requestId, { resolve, reject, timeoutId });
				window.postMessage({ cc: 'ClaudeCounter', type: 'cc:request', requestId, kind, payload }, '*');
			});
		}

		requestUsage(orgId) {
			return this.request('usage', { orgId }, { timeoutMs: 15000 });
		}

		/** True when the page-world bridge announced itself (the manifest runs it at document_start). */
		isBridgeReady() {
			try {
				return document.documentElement?.dataset?.ccBridgeReady === 'true';
			} catch {
				return false;
			}
		}
	}

	CC.bridge = new BridgeClient();
})();
