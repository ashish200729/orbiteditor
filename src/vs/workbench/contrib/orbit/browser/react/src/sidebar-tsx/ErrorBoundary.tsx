/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { WarningBox } from '../orbit-settings-tsx/WarningBox.js';

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
	onDismiss?: () => void;
	/** When any value here changes while errored, the boundary resets and re-renders its children.
	 * Without this a transient render error (e.g. mid-stream malformed tool data) latches forever
	 * even after the underlying content becomes valid again. */
	resetKeys?: ReadonlyArray<unknown>;
}

interface State {
	hasError: boolean;
	error: Error | null;
	errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			errorInfo: null
		};
	}

	static getDerivedStateFromError(error: Error): Partial<State> {
		return {
			hasError: true,
			error
		};
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		console.error('[ErrorBoundary] React render error caught:', error, errorInfo);
		this.setState({
			error,
			errorInfo
		});
	}

	componentDidUpdate(prevProps: Props): void {
		if (!this.state.hasError) return;
		const prev = prevProps.resetKeys;
		const next = this.props.resetKeys;
		const changed = (prev?.length ?? 0) !== (next?.length ?? 0)
			|| !!next?.some((k, i) => !Object.is(k, prev?.[i]));
		if (changed) {
			this.setState({ hasError: false, error: null, errorInfo: null });
		}
	}

	render(): ReactNode {
		if (this.state.hasError && this.state.error) {
			// If a custom fallback is provided, use it
			if (this.props.fallback) {
				return this.props.fallback;
			}

			// Use ErrorDisplay component as the default error UI
			return (
				<WarningBox text={this.state.error + ''} />
				// <ErrorDisplay
				// 	message={this.state.error + ''}
				// 	fullError={this.state.error}
				// 	onDismiss={this.props.onDismiss || null}
				// />
			);
		}

		return this.props.children;
	}
}

export default ErrorBoundary;
