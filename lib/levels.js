// Protection level controls shared by the popup and the options page.
import { t } from './i18n.js';
import { el } from './ui.js';
import { actions, openAsks } from './storage.js';

// What each level leaves unprotected. "strict" covers everything Tab Chaperone can cover.
const WARNINGS = { login: 'levelLoginWarning', site: 'levelSiteWarning' };

// The warning for a level, or null when it has none.
function levelWarning(level) {
  return WARNINGS[level] ? el('p', { className: 'level-warning', textContent: t(WARNINGS[level]) }) : null;
}

// The levels to offer. "Login pages only" depends on automatic protection, so it is offered
// only when that is on (or when it is the current level, so the picker can show it).
export const levelsFor = (settings, current) => (settings.fieldDetection || current === 'login'
  ? ['login', 'site', 'strict'] : ['site', 'strict']);

// Radio buttons for the levels in `levels`, with the help text of each level and the warning
// of the chosen one. `onChange(level)` runs when you pick another level.
export function levelPicker(name, current, levels, onChange) {
  const warning = el('div', {}, levelWarning(current));
  const options = levels.map((level) => el('label', { className: 'level-option' },
    el('input', {
      type: 'radio',
      name,
      value: level,
      checked: level === current,
      onchange: () => {
        warning.replaceChildren(levelWarning(level) || '');
        onChange(level);
      },
    }),
    el('span', {},
      el('strong', { textContent: t(`level_${level}`) }), ' ',
      el('span', { className: 'muted', textContent: t(`level_${level}_help`) }))));
  return el('div', { className: 'level-picker' }, ...options, warning);
}

// One question card per detected site that still waits for a choice; `first` comes first.
export function askCards(asks, settings, first = null) {
  return openAsks(asks, settings).sort((a, b) => (b === first) - (a === first)).map(askCard);
}

// The question after the first detection on a site. Lowering protection ("never") needs a
// second click, like turning on a high-risk extension.
export function askCard(domain) {
  // A button that picks this level.
  const choice = (level, className) => el('button', {
    className: `level-choice ${className}`,
    onclick: () => actions.chooseLevel(domain, level),
  },
  el('strong', { textContent: t(`level_${level}`) }),
  el('span', { textContent: t(`level_${level}_help`) }));

  const never = el('button', { className: 'danger', textContent: t('level_never') });
  never.addEventListener('click', () => {
    if (!never.dataset.armed) {
      never.dataset.armed = '1';
      never.textContent = t('levelNeverConfirm');
      return;
    }
    actions.chooseLevel(domain, 'never');
  });

  return el('div', { className: 'ask-card' },
    el('p', {}, el('strong', { textContent: t('askHeading', { domain }) })),
    el('p', { className: 'muted', textContent: t('askQuestion') }),
    choice('strict', ''),
    choice('site', 'secondary'),
    choice('login', 'secondary'),
    never);
}
