/* Reusable UI primitives. */
import { forwardRef, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { Severity } from "../api/types";
import { dangerInfo } from "../lib/constants";
import { IconCheck, IconCopy, IconInfo, IconAlert, IconX } from "./Icons";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

// ------------------------------------------------------------------ Button
type BtnVariant = "default" | "primary" | "danger" | "ghost";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
  active?: boolean;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", loading, icon, block, active, iconOnly, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", variant !== "default" && variant, size !== "md" && size, block && "block", active && "active", iconOnly && "icon", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function ButtonLink({ to, variant = "default", size = "md", icon, children, className, ...rest }: { to: string; variant?: BtnVariant; size?: "sm" | "md" | "lg"; icon?: ReactNode; children?: ReactNode; className?: string; target?: string; rel?: string }) {
  return (
    <Link to={to} className={cx("btn", variant !== "default" && variant, size !== "md" && size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

// ------------------------------------------------------------------ Form fields
export function Field({ label, hint, error, required, children, htmlFor, className }: { label?: ReactNode; hint?: ReactNode; error?: string; required?: boolean; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cx("field", className)}>
      {label && (
        <label htmlFor={htmlFor}>
          {label}
          {required && <span className="req" aria-hidden="true">*</span>}
        </label>
      )}
      {children}
      {error ? <div className="error" role="alert">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: string; fieldClassName?: string; inputSize?: "sm" | "md" };
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, fieldClassName, className, id, inputSize, required, ...rest }, ref) {
  const auto = useId();
  const iid = id || auto;
  const input = <input ref={ref} id={iid} className={cx("input", inputSize === "sm" && "sm", className)} aria-invalid={error ? true : undefined} required={required} {...rest} />;
  if (!label && !hint && !error) return input;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={iid} required={required} className={fieldClassName}>
      {input}
    </Field>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; hint?: ReactNode; error?: string; options?: { value: string | number; label: string }[]; fieldClassName?: string; inputSize?: "sm" | "md" };
export function Select({ label, hint, error, options, children, fieldClassName, className, id, inputSize, required, ...rest }: SelectProps) {
  const auto = useId();
  const iid = id || auto;
  const sel = (
    <select id={iid} className={cx("select", inputSize === "sm" && "sm", className)} required={required} {...rest}>
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
  if (!label && !hint && !error) return sel;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={iid} required={required} className={fieldClassName}>
      {sel}
    </Field>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: string; fieldClassName?: string };
export function Textarea({ label, hint, error, fieldClassName, className, id, required, ...rest }: TextareaProps) {
  const auto = useId();
  const iid = id || auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={iid} required={required} className={fieldClassName}>
      <textarea id={iid} className={cx("textarea", className)} aria-invalid={error ? true : undefined} required={required} {...rest} />
    </Field>
  );
}

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-checked={checked} />
      <span className="track" aria-hidden="true" />
      {label}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Segmented<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Display
export function Spinner({ size }: { size?: "lg" }) {
  return <span className={cx("spinner", size)} role="status" aria-label="Loading" />;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner /> {label}…
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="notice bad" role="alert">
      <IconAlert />
      <div className="grow">
        <div className="strong">Couldn't load this</div>
        <div className="small">{error.message}</div>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ kind = "info", children, title, action }: { kind?: "info" | "warn" | "bad" | "ok"; children?: ReactNode; title?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("notice", kind)} role={kind === "bad" ? "alert" : undefined}>
      {kind === "info" || kind === "ok" ? <IconInfo /> : <IconAlert />}
      <div className="grow">
        {title && <div className="strong">{title}</div>}
        {children && <div className={title ? "small mt-4" : undefined}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ kind, children, dot, title }: { kind?: "ok" | "warn" | "bad" | "info" | "accent" | "live"; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={cx("badge", kind === "live" ? "ok live" : kind)} title={title}>
      {(dot || kind === "live") && <span className="dot" />}
      {children}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity | string }) {
  return <span className={`sev sev-${severity}`}>{severity}</span>;
}

export function DangerPill({ danger, children }: { danger: string; children?: ReactNode }) {
  const d = dangerInfo(danger);
  return (
    <span className="danger-pill" style={{ background: d.color, color: danger === "extreme" ? "#fff" : "#14161c" }}>
      {children ?? d.label}
    </span>
  );
}

export function Tile({ label, value, unit, foot, accent, to, compact }: { label: ReactNode; value: ReactNode; unit?: string; foot?: ReactNode; accent?: string; to?: string; compact?: boolean }) {
  const inner = (
    <>
      {accent && <span className="accent-bar" style={{ background: accent }} />}
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {foot && <div className="foot">{foot}</div>}
    </>
  );
  if (to)
    return (
      <Link to={to} className={cx("tile", compact && "compact")}>
        {inner}
      </Link>
    );
  return <div className={cx("tile", compact && "compact")}>{inner}</div>;
}

export function Card({ title, sub, actions, children, className, flush, footer }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; flush?: boolean; footer?: ReactNode }) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <div className="card-head">
          <div className="grow">
            {title && <h2>{title}</h2>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions && <div className="row wrap">{actions}</div>}
        </div>
      )}
      <div className={cx("card-body", flush && "flush")}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; label?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const n = (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    refs.current[n]?.focus();
    onChange(tabs[n]!.id);
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => (refs.current[i] = el)}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Modal
export function Modal({ open, onClose, title, description, children, footer, size, dismissible = true }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: "wide" | "xwide"; dismissible?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button:not(.close-btn), [href]");
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
      if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const f = items[0]!, l = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === f) {
          e.preventDefault();
          l.focus();
        } else if (!e.shiftKey && document.activeElement === l) {
          e.preventDefault();
          f.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open, dismissible, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && dismissible && onClose()}>
      <div ref={ref} className={cx("modal", size)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          <div className="grow">
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {dismissible && (
            <button className="close-btn" onClick={onClose} aria-label="Close dialog" type="button">
              <IconX />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Imperative confirm dialog hook. */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback(
    (opts: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  );
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const dialog = (
    <Modal
      open={!!state}
      onClose={() => close(false)}
      title={state?.title ?? ""}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={state?.danger ? "danger" : "primary"} onClick={() => close(true)}>
            {state?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {state?.body && <div className="muted">{state.body}</div>}
    </Modal>
  );
  return { confirm, dialog };
}

// ------------------------------------------------------------------ Drawer
export function Drawer({ title, subtitle, onClose, children, className }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; className?: string }) {
  const titleId = useId();
  return (
    <aside className={cx("drawer", className)} role="dialog" aria-labelledby={titleId}>
      <div className="drawer-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 id={titleId} style={{ fontSize: 17 }}>
            {title}
          </h2>
          {subtitle && <div className="small muted mt-4">{subtitle}</div>}
        </div>
        <button className="close-btn" onClick={onClose} aria-label="Close panel" type="button">
          <IconX />
        </button>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}

// ------------------------------------------------------------------ Copy
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      icon={done ? <IconCheck /> : <IconCopy />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <nav className="row between small" aria-label="Pagination" style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
      <span className="muted">
        {offset + 1}–{Math.min(total, offset + limit)} of {total.toLocaleString()}
      </span>
      <div className="row">
        <Button size="sm" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <span className="muted">
          Page {page} / {pages}
        </span>
        <Button size="sm" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
          Next
        </Button>
      </div>
    </nav>
  );
}
