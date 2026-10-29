/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@components/ErrorBoundary`: same contract as Vencord's (noop → renders nothing, fallback, onError, wrap()),
// and every caught error lands in `caughtErrors`, so a component test can assert that nothing crashed:
//   assert.deepEqual(caughtErrors, []);

import type { ComponentType, ErrorInfo, PropsWithChildren } from "react";
import * as React from "react";

export interface CaughtError {
    error: unknown;
    message?: string;
}

/** Errors caught by any fake ErrorBoundary, oldest first. */
export const caughtErrors: CaughtError[] = [];

interface Props<T = any> {
    noop?: boolean;
    fallback?: ComponentType<PropsWithChildren<{ error: any; message: string; stack: string; wrappedProps: T; }>>;
    onError?(data: { error: Error; errorInfo: ErrorInfo; props: T; }): void;
    message?: string;
    wrappedProps?: T;
}

const NO_ERROR = {};

class ErrorBoundary extends React.PureComponent<PropsWithChildren<Props>> {
    state = { error: NO_ERROR as any, message: "", stack: "" };

    static getDerivedStateFromError(error: any) {
        return { error, message: error?.message || String(error), stack: error?.stack ?? "" };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        caughtErrors.push({ error, message: this.props.message });
        this.props.onError?.({ error, errorInfo, props: this.props.wrappedProps });
    }

    render() {
        if (this.state.error === NO_ERROR) return this.props.children;
        if (this.props.noop) return null;
        const Fallback = this.props.fallback;
        if (Fallback) return <Fallback wrappedProps={this.props.wrappedProps} {...this.state}>{this.props.children}</Fallback>;
        return <div role="alert" data-error-boundary="">{this.props.message ?? "An error occurred"}: {this.state.message}</div>;
    }

    static wrap<T extends object = any>(Component: ComponentType<T>, props?: Omit<Props<T>, "wrappedProps"> & { displayName?: string; }) {
        const wrapper = (p: T) => (
            <ErrorBoundary {...props} wrappedProps={p}>
                <Component {...p} />
            </ErrorBoundary>
        );
        if (props?.displayName) (wrapper as ComponentType<T>).displayName = props.displayName;
        return wrapper;
    }
}

export default ErrorBoundary;

export function resetErrorBoundaries() {
    caughtErrors.length = 0;
}
