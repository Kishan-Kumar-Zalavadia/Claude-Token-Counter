(() => {
	'use strict';

	// The dashboard: one compact panel directly under the chat input, inside the composer card.
	// It only displays what usage-core.computeView() says. Text is set with textContent (never
	// innerHTML) and only when it changed, so our own updates do not churn the page's DOM.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	class Dashboard {
		constructor() {
			this.root = null;
			this._last = {};
			this._observer = null;
			this._mountTimer = null;
			this._mountedOnce = false;
			this._lastFailLogAt = 0;
			this._createdAt = Date.now();
			this.onRefresh = null; // set by main.js
		}

		_build() {
			const root = el('div', 'ccr-dashboard');
			root.setAttribute(CC.DOM.DASHBOARD_ATTR, CC.DOM.DASHBOARD_VALUE);
			root.setAttribute('role', 'group');
			root.setAttribute('aria-label', 'Claude session usage');

			const head = el('div', 'ccr-row ccr-head');
			const headLeft = el('span', 'ccr-headleft');
			this.titleEl = el('span', 'ccr-title', 'SESSION USAGE');
			this.updatedEl = el('span', 'ccr-updated', '');
			headLeft.appendChild(this.titleEl);
			headLeft.appendChild(this.updatedEl);
			const headRight = el('span', 'ccr-headright');
			this.pctEl = el('span', 'ccr-pct', '--');
			this.refreshEl = el('button', 'ccr-refresh', '\u21bb');
			this.refreshEl.setAttribute('type', 'button');
			this.refreshEl.setAttribute('aria-label', 'Refresh session usage now');
			this.refreshEl.setAttribute('title', 'Refresh session usage now');
			this.refreshEl.addEventListener('click', (event) => {
				// The strip sits inside the composer: the click must not reach the page.
				event.preventDefault?.();
				event.stopPropagation?.();
				if (this.onRefresh) this.onRefresh();
			});
			headRight.appendChild(this.pctEl);
			headRight.appendChild(this.refreshEl);
			head.appendChild(headLeft);
			head.appendChild(headRight);

			this.barEl = el('div', 'ccr-bar');
			this.barEl.setAttribute('role', 'progressbar');
			this.barEl.setAttribute('aria-valuemin', '0');
			this.barEl.setAttribute('aria-valuemax', '100');
			this.fillEl = el('div', 'ccr-fill');
			this.barEl.appendChild(this.fillEl);

			// One small line: used / left on the left, the reset countdown on the right.
			const foot = el('div', 'ccr-row ccr-foot');
			this.subRow = el('span', 'ccr-subgroup');
			this.usedEl = el('span', 'ccr-used', '');
			this.leftEl = el('span', 'ccr-left', '');
			this.subRow.appendChild(this.usedEl);
			this.subRow.appendChild(this.leftEl);
			this.messageEl = el('span', 'ccr-message', '');
			const resetGroup = el('span', 'ccr-resetgroup');
			this.resetLabelEl = el('span', 'ccr-resetlabel', 'RESETS IN');
			this.countdownEl = el('span', 'ccr-countdown', '');
			resetGroup.appendChild(this.resetLabelEl);
			resetGroup.appendChild(this.countdownEl);
			const left = el('span', 'ccr-footleft');
			left.appendChild(this.subRow);
			left.appendChild(this.messageEl);
			foot.appendChild(left);
			foot.appendChild(resetGroup);

			for (const node of [head, this.barEl, foot]) root.appendChild(node);
			this.root = root;
			return root;
		}

		_set(key, node, prop, value) {
			if (this._last[key] === value) return;
			this._last[key] = value;
			if (prop === 'text') node.textContent = value;
			else if (prop === 'width') node.style.width = value;
			else if (prop === 'title') node.setAttribute('title', value);
			else if (prop === 'hidden') node.classList.toggle('ccr-hidden', !!value);
			else if (prop === 'busy') node.classList.toggle('ccr-busy', !!value);
		}

		/** Draw the current state. Safe to call every second. */
		render(state, now, ctx) {
			if (!this.root) this._build();
			const v = CC.core.computeView(state, now, ctx || {});
			const live = v.status === 'live';

			this.root.setAttribute('data-status', v.status);
			this.root.setAttribute('data-level', v.level);

			this._set('busy', this.refreshEl, 'busy', !!(ctx && ctx.refreshing));
			this._set('pct', this.pctEl, 'text', v.pctText);
			this._set('fill', this.fillEl, 'width', `${v.barWidth}%`);
			if (this._last.now !== String(v.pct)) {
				this._last.now = String(v.pct);
				if (live) this.barEl.setAttribute('aria-valuenow', String(Math.round(v.pct)));
				else this.barEl.removeAttribute?.('aria-valuenow');
			}
			this._set('used', this.usedEl, 'text', v.usedText);
			this._set('left', this.leftEl, 'text', v.leftText);
			this._set('subHidden', this.subRow, 'hidden', !live);
			this._set('message', this.messageEl, 'text', v.message);
			this._set('messageHidden', this.messageEl, 'hidden', !v.message);
			this._set('resetLabel', this.resetLabelEl, 'text', v.resetLabel);
			this._set('resetLabelHidden', this.resetLabelEl, 'hidden', !v.resetLabel);
			this._set('countdown', this.countdownEl, 'text', v.countdownText);
			this._set('updated', this.updatedEl, 'text', v.updatedText);
			this._set('updatedHidden', this.updatedEl, 'hidden', !v.updatedText);
			// Other details live in the tooltip so the panel stays small.
			const tip = [v.hint, CC.diag ? CC.diag.summary() : ''].filter(Boolean).join('\n');
			this._set('title', this.root, 'title', tip);
			return v;
		}

		// ---- placement ---------------------------------------------------------------------------

		/** Where the dashboard goes: right after the composer's input area, inside the composer card. */
		_findAnchor() {
			const input = document.querySelector(CC.DOM.CHAT_INPUT);
			if (!input) return null;

			const flow = input.closest('.relative.w-full.min-w-0');
			if (flow && flow.parentElement) return { kind: 'after', node: flow };

			const box = input.closest('.bg-surface-3') || input.closest('[data-cds="ChatComposer"]') || input.closest('fieldset') || input.closest('form');
			if (box) return { kind: 'append', node: box };

			const parent = input.closest('.flex-col') || input.parentElement;
			return parent ? { kind: 'append', node: parent } : null;
		}

		_removeDuplicates() {
			const all = document.querySelectorAll(`[${CC.DOM.DASHBOARD_ATTR}="${CC.DOM.DASHBOARD_VALUE}"]`);
			for (const node of all) if (node !== this.root) node.remove();
		}

		/** Put the dashboard where it belongs. Returns true when it is in the page afterwards. */
		mount() {
			if (!this.root) this._build();
			this._removeDuplicates();
			const anchor = this._findAnchor();
			if (!anchor) {
				const now = Date.now();
				if (now - this._createdAt < CC.CONST.MOUNT_GRACE_MS) return document.contains(this.root);
				if (now - this._lastFailLogAt > CC.CONST.MOUNT_LOG_THROTTLE_MS) {
					this._lastFailLogAt = now;
					CC.diag?.log('UI_MOUNT_FAILED');
				}
				return document.contains(this.root);
			}

			const wasInPage = document.contains(this.root);
			if (anchor.kind === 'after') {
				if (anchor.node.nextElementSibling !== this.root) anchor.node.after(this.root);
			} else if (anchor.node.lastElementChild !== this.root) {
				anchor.node.appendChild(this.root);
			}

			if (!wasInPage) {
				CC.diag?.log(this._mountedOnce ? 'DASHBOARD_REATTACHED' : 'DASHBOARD_MOUNTED');
				this._mountedOnce = true;
			}
			return document.contains(this.root);
		}

		/** Cheap check, called every second and after DOM changes. */
		ensureMounted() {
			if (this.root && document.contains(this.root)) {
				const anchor = this._findAnchor();
				const placed = !anchor || (anchor.kind === 'after' ? anchor.node.nextElementSibling === this.root : anchor.node.lastElementChild === this.root);
				if (placed) return true;
			}
			return this.mount();
		}

		/** Re-attach after the page replaced parts of its DOM (route changes, re-renders). */
		observe() {
			if (this._observer || typeof MutationObserver === 'undefined') return;
			const target = document.body || document.documentElement;
			if (!target) return;
			this._observer = new MutationObserver((mutations) => {
				// Our own text updates are not interesting.
				if (this.root && mutations && mutations.every((m) => m.target && this.root.contains(m.target))) return;
				if (this._mountTimer) return;
				this._mountTimer = setTimeout(() => {
					this._mountTimer = null;
					this.ensureMounted();
				}, 50);
			});
			this._observer.observe(target, { childList: true, subtree: true });
		}

		destroy() {
			this._observer?.disconnect();
			this._observer = null;
			this.root?.remove();
		}
	}

	CC.ui = { Dashboard };
})();
