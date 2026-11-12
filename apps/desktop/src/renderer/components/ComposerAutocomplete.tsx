/**
 * Autocomplete popup for the chat composer (UI-6, v0.60).
 *
 * Pure presentational component: ChatView owns the trigger detection
 * (composer.ts), the item list and keyboard navigation; this renders the
 * floating list above the textarea. `onMouseDown` selects (instead of
 * `onClick`) so the textarea never loses focus — and its cursor — before
 * the insertion runs.
 */
import type { AutocompleteItem } from './composer';

interface Props {
  items: AutocompleteItem[];
  activeIndex: number;
  /** Shown when the trigger is live but nothing matched (slash only). */
  emptyText?: string | null;
  onSelect: (item: AutocompleteItem) => void;
  onHover: (index: number) => void;
}

export default function ComposerAutocomplete({ items, activeIndex, emptyText, onSelect, onHover }: Props) {
  return (
    <div className="composer-autocomplete" role="listbox" data-testid="composer-autocomplete">
      {items.length === 0 ? (
        <div className="composer-autocomplete-empty">{emptyText ?? ''}</div>
      ) : (
        items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`composer-autocomplete-item${index === activeIndex ? ' active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            onMouseEnter={() => onHover(index)}
          >
            <span className="composer-autocomplete-label">{item.label}</span>
            {item.description ? (
              <span className="composer-autocomplete-desc">{item.description}</span>
            ) : null}
          </button>
        ))
      )}
    </div>
  );
}
