import { useId, type ReactNode, type Ref } from 'react';

export type Tone = 'neutral' | 'success' | 'attention' | 'critical' | 'info';

export type ButtonProps = {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  'aria-label'?: string;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  onClick,
  disabled = false,
  type = 'button',
  ref,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className="mona-button"
      data-variant={variant}
      data-size={size}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

export type FieldProps = {
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  onChange?: (value: string) => void;
};

export function Field({
  label,
  value = '',
  placeholder,
  hint,
  error,
  required = false,
  disabled = false,
  onChange,
}: FieldProps): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="mona-field">
      <label className="mona-field-label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        className="mona-input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange?.(event.target.value)}
      />
      {hint ? (
        <span className="mona-field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="mona-field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

export type SelectProps = {
  label: string;
  value: string;
  options: readonly SelectOption[];
  hint?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
};

export function Select({ label, value, options, hint, disabled, onChange }: SelectProps): React.JSX.Element {
  const id = useId();
  return (
    <div className="mona-field">
      <label className="mona-field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="mona-select"
        value={value}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="mona-field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const TONE_GLYPH: Record<Tone, string> = {
  neutral: '\u25cb',
  success: '\u2713',
  attention: '!',
  critical: '\u2715',
  info: 'i',
};

/** Badge: shape, glyph and text carry the meaning; colour only reinforces it. */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): React.JSX.Element {
  return (
    <span className="mona-badge" data-tone={tone}>
      <span className="mona-badge-glyph" aria-hidden="true">
        {TONE_GLYPH[tone]}
      </span>
      {children}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
  labelledBy,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
}): React.JSX.Element {
  return (
    <section className="mona-card" aria-labelledby={labelledBy}>
      {title || actions ? (
        <header className="mona-screen-head">
          {title ? (
            <h3 id={labelledBy} style={{ margin: 0, fontSize: 'var(--text-md)' }}>
              {title}
            </h3>
          ) : null}
          {actions ? <div className="mona-row">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Inspector({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <aside className="mona-inspector" aria-label={title}>
      <h2 className="mona-inspector-title">{title}</h2>
      {children}
    </aside>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mona-empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {action ? <div className="mona-row">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="mona-stack" aria-busy="true" aria-live="polite">
      <span className="mona-skeleton" style={{ width: '70%' }} />
      <span className="mona-skeleton" style={{ width: '90%' }} />
      <span className="mona-skeleton" style={{ width: '45%' }} />
      <span className="mona-muted">{label}</span>
    </div>
  );
}

export function ErrorState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mona-error" role="alert">
      <h3>{title}</h3>
      <p style={{ margin: 0 }}>{detail}</p>
      {action ? <div className="mona-row">{action}</div> : null}
    </div>
  );
}

export function Notification({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="mona-notification"
      data-tone={tone}
      role={tone === 'critical' ? 'alert' : 'status'}
      aria-live={tone === 'critical' ? 'assertive' : 'polite'}
    >
      <Badge tone={tone}>{tone === 'neutral' ? 'Note' : tone}</Badge>
      <div>
        <strong>{title}</strong>
        {children ? <div className="mona-muted">{children}</div> : null}
      </div>
    </div>
  );
}
