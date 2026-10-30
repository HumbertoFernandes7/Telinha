/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake Discord UI pieces that @webpack/common exports: Modal + the modal API, Select, Menu, Tooltip, showToast and
// the OAuth2AuthorizeModal. They render plain, queryable DOM (role/aria/data-* attributes) so component tests can use
// @testing-library queries, and they record what the plugin asked for (toasts, open modals).

import type { ComponentType, ReactNode } from "react";
import * as React from "react";

// #region toasts

export interface ToastRecord {
    text: string;
    variant?: string;
    [key: string]: unknown;
}

/** Every showToast call, oldest first. */
export const toasts: ToastRecord[] = [];

export function showToast(data: ToastRecord) {
    toasts.push({ ...data });
}

// #endregion

// #region modals

export interface ModalRenderProps {
    transitionState: number;
    onClose(): void;
}

export interface ModalOptionsLike {
    modalKey?: string;
    onCloseRequest?(): void;
    onCloseCallback?(): void;
}

export interface OpenModal {
    key: string;
    render: (props: ModalRenderProps) => ReactNode;
    options: ModalOptionsLike | undefined;
}

const openModals: OpenModal[] = [];
const modalListeners = new Set<() => void>();
let modalSeq = 0;
let modalsVersion = 0;

function modalsChanged() {
    modalsVersion++;
    for (const fn of [...modalListeners]) fn();
}

export function openModal(render: (props: ModalRenderProps) => ReactNode, options?: ModalOptionsLike): string {
    const key = options?.modalKey ?? `fake-modal-${++modalSeq}`;
    openModals.push({ key, render, options });
    modalsChanged();
    return key;
}

export function closeModal(key: string) {
    const i = openModals.findIndex(m => m.key === key);
    if (i < 0) return;
    const [m] = openModals.splice(i, 1);
    modalsChanged();
    m.options?.onCloseCallback?.();
}

export function closeAllModals() {
    for (const m of [...openModals]) closeModal(m.key);
}

export function openModalLazy(render: () => Promise<(props: ModalRenderProps) => ReactNode>, options?: ModalOptionsLike) {
    return render().then(r => openModal(r, options));
}

/** Test view of the modal stack. */
export const modals = {
    /** open modals, oldest first */
    list: (): readonly OpenModal[] => openModals,
    top: (): OpenModal | undefined => openModals[openModals.length - 1],
    /** The element a modal renders, with the props Discord passes (onClose closes it). Default: the top one. */
    element(key?: string): ReactNode {
        const m = key ? openModals.find(x => x.key === key) : openModals[openModals.length - 1];
        if (!m) throw new Error("fake modals: no open modal" + (key ? ` with key ${key}` : ""));
        return m.render({ transitionState: 1, onClose: () => closeModal(m.key) });
    },
    close: closeModal,
    closeAll: closeAllModals,
    reset() {
        openModals.length = 0;
        modalsChanged();
    }
};

// Discord has ONE modal layer: with several ModalHosts mounted (a test's own plus a helper's), only the oldest draws
// the modals, so none appears twice. When it unmounts the next one takes over.
const mountedHosts: object[] = [];

/** Renders every open modal and follows openModal/closeModal (render it once in a component test). */
export function ModalHost() {
    const self = React.useRef<object>(null);
    self.current ??= {};
    React.useSyncExternalStore(
        fn => {
            modalListeners.add(fn);
            return () => void modalListeners.delete(fn);
        },
        () => modalsVersion
    );
    React.useLayoutEffect(() => {
        const me = self.current!;
        mountedHosts.push(me);
        modalsChanged();
        return () => {
            mountedHosts.splice(mountedHosts.indexOf(me), 1);
            modalsChanged();
        };
    }, []);
    // (in the render before its own effect has run, a host that nobody preceded draws: the effect then re-renders the rest)
    if ((mountedHosts[0] ?? self.current) !== self.current) return null;
    return (
        <>
            {openModals.map(m => (
                <div key={m.key} data-modal-key={m.key}>
                    {m.render({ transitionState: 1, onClose: () => closeModal(m.key) })}
                </div>
            ))}
        </>
    );
}

export interface FakeModalProps extends ModalRenderProps {
    size?: string;
    role?: string;
    title: ReactNode;
    subtitle?: ReactNode;
    children?: ReactNode;
    actions?: { text: string; variant: string; onClick(): void; loading?: boolean; disabled?: boolean; }[];
    actionBarInput?: ReactNode;
    notice?: { message: string; type: string; };
}

/**
 * The accessible name of the Modal's own "×". Discord's is "Fechar" too (pt-BR), but here it must not equal the plugin's
 * own "Fechar" action buttons (StreamersModal, ViewersModal): getByRole("button", { name: "Fechar" }) finds just those.
 */
export const MODAL_CLOSE_LABEL = "Fechar janela";

/** Discord's Modal: a dialog with heading, notice, content and one <button> per action (+ the "×", data-modal-close). */
export function Modal({ size, role, title, subtitle, children, actions, actionBarInput, notice, onClose }: FakeModalProps) {
    return (
        <div role={role ?? "dialog"} aria-modal="true" data-size={size}>
            <h1>{title}</h1>
            {subtitle != null && <div data-modal-subtitle="">{subtitle}</div>}
            {notice && <div role="alert" data-notice-type={notice.type}>{notice.message}</div>}
            <div data-modal-content="">{children}</div>
            {actionBarInput}
            {actions?.map(a => (
                <button key={a.text} type="button" data-variant={a.variant} disabled={!!a.disabled || !!a.loading} onClick={() => a.onClick()}>
                    {a.text}
                </button>
            ))}
            <button type="button" aria-label={MODAL_CLOSE_LABEL} data-modal-close="" onClick={onClose}>×</button>
        </div>
    );
}

// #endregion

// #region Select

export interface FakeSelectOption {
    label: string;
    value: any;
    disabled?: boolean;
    default?: boolean;
}

export interface FakeSelectProps {
    options: readonly FakeSelectOption[];
    select(value: any): void;
    isSelected(value: any): boolean;
    serialize(value: any): string;
    placeholder?: string;
    isDisabled?: boolean;
    className?: string;
    closeOnSelect?: boolean;
}

/** Discord's Select as a native <select>: fireEvent.change(select, { target: { value: serialize(v) } }) picks `v`. */
export function Select({ options, select, isSelected, serialize, placeholder, isDisabled, className }: FakeSelectProps) {
    const selected = options.find(o => isSelected(o.value));
    return (
        <select
            className={className}
            aria-label={placeholder}
            disabled={isDisabled}
            value={selected ? serialize(selected.value) : ""}
            onChange={e => {
                const opt = options.find(o => serialize(o.value) === e.currentTarget.value);
                if (opt) select(opt.value);
            }}
        >
            {!selected && <option value="">{placeholder ?? ""}</option>}
            {options.map(o => (
                <option key={serialize(o.value)} value={serialize(o.value)} disabled={o.disabled}>{o.label}</option>
            ))}
        </select>
    );
}

// #endregion

// #region Menu

interface MenuItemProps {
    id: string;
    label?: ReactNode;
    action?(e: unknown): void;
    icon?: ComponentType<any>;
    color?: string;
    disabled?: boolean;
    checked?: boolean;
    children?: ReactNode;
}

function MenuItem({ id, label, action, icon: Icon, color, disabled, children }: MenuItemProps) {
    return (
        <div role="menuitem" id={id} data-color={color} aria-disabled={disabled || undefined} onClick={e => !disabled && action?.(e)}>
            {Icon && <Icon />}
            {label}
            {children}
        </div>
    );
}

function MenuCheckboxItem({ id, label, action, checked, disabled }: MenuItemProps) {
    return (
        <div role="menuitemcheckbox" id={id} aria-checked={!!checked} aria-disabled={disabled || undefined} onClick={e => !disabled && action?.(e)}>
            {label}
        </div>
    );
}

/** Discord's context menu components, as role="menu"/"group"/"menuitem" DOM. */
export const Menu = {
    Menu: ({ navId, children }: { navId: string; onClose?(): void; children?: ReactNode; }) => <div role="menu" id={navId}>{children}</div>,
    MenuSeparator: () => <hr />,
    MenuGroup: ({ label, children }: { label?: string; children?: ReactNode; }) => <div role="group" aria-label={label}>{children}</div>,
    MenuItem,
    MenuCheckboxItem,
    MenuRadioItem: MenuCheckboxItem,
    MenuControlItem: ({ id, label }: { id: string; label?: string; }) => <div role="menuitem" id={id}>{label}</div>
};

// #endregion

// #region Tooltip

export interface FakeTooltipChildProps {
    onClick(): void;
    onMouseEnter(): void;
    onMouseLeave(): void;
    onContextMenu(): void;
    onFocus(): void;
    onBlur(): void;
    "aria-label"?: string;
}

/**
 * Discord's Tooltip: calls the render-prop child with the trigger props and wraps the result in
 * <span data-tooltip="text">, so tests can read the tooltip text without hovering. The child's `aria-label` is the
 * Tooltip's own `aria-label` prop, else the text when it is a string (none for a node: nothing to read out); a child
 * that spreads the props onto a button gets that name, as in Discord.
 */
export function Tooltip({ text, children, "aria-label": ariaLabel }: { text: ReactNode; children(props: FakeTooltipChildProps): ReactNode; "aria-label"?: string; [key: string]: unknown; }) {
    const noop = () => { };
    const label = ariaLabel ?? (typeof text === "string" ? text : undefined);
    const props: FakeTooltipChildProps = {
        onClick: noop, onMouseEnter: noop, onMouseLeave: noop, onContextMenu: noop, onFocus: noop, onBlur: noop,
        ...(label !== undefined ? { "aria-label": label } : {})
    };
    return <span data-tooltip={typeof text === "string" ? text : ""}>{children(props)}</span>;
}

// #endregion

/**
 * Discord's OAuth2AuthorizeModal: renders nothing interactive; the test reads the props from the open modal and
 * calls props.callback({ location }) (or closes the modal) to finish the flow.
 */
export function OAuth2AuthorizeModal(props: Record<string, unknown>) {
    return <div role="dialog" data-oauth2-client-id={String(props.clientId ?? "")} />;
}

export function resetUi() {
    toasts.length = 0;
    modals.reset();
}
