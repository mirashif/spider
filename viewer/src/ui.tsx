import type { ChangeStatus } from '@contracts';
import type { ReactNode } from 'react';
import { STATUS_LABEL } from './model';

export function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
    iconOnly,
}: {
    label: string;
    value: T;
    options: { value: T; label: string; icon?: ReactNode }[];
    onChange: (value: T) => void;
    iconOnly?: boolean;
}) {
    return (
        <div className="segmented" role="radiogroup" aria-label={label}>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={option.value === value}
                    className={option.value === value ? 'on' : undefined}
                    onClick={() => onChange(option.value)}
                    title={option.label}
                >
                    {option.icon}
                    {!iconOnly && <span>{option.label}</span>}
                </button>
            ))}
        </div>
    );
}

export function StatusDot({ status }: { status?: ChangeStatus }) {
    if (!status) return null;
    return <span className={`dot dot-${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />;
}

export function StatusBadge({ status }: { status?: ChangeStatus }) {
    if (!status) return null;
    return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}
