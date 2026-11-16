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

// A question folded to one line with its domain. Rendering replaces the whole list on every
// storage change, so `unfolded` keeps a question open that you unfolded.
const unfolded = new Set();
export function foldedAsk(domain) {
  const details = el('details', { className: 'ask-fold', open: unfolded.has(domain) }, el('summary', { textContent: domain }), askCard(domain));
  details.addEventListener('toggle', () => (details.open ? unfolded.add(domain) : unfolded.delete(domain)));
  return details;
}

// A button that clears the questions about `domains`.
export const clearAsksButton = (domains) => el('button', {
  className: 'secondary small',
  textContent: t('asksClear'),
  title: t('asksClearHelp'),
  onclick: () => actions.clearAsks(domains),
});

// The questions about detected sites that still wait for a choice, each folded to one line.
// `current` (the site of the active tab) comes first and stays unfolded.
export function askCards(asks, settings, current = null) {
  const open = openAsks(asks, settings);
  return [
    ...(open.includes(current) ? [askCard(current)] : []),
    ...open.filter((domain) => domain !== current).map(foldedAsk),
  ];
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
    el('div', { className: 'ask-actions' },
      never,
      el('button', {
        className: 'secondary',
        textContent: t('askDismiss'),
        title: t('askDismissHelp'),
        onclick: () => actions.dismissAsks([domain]),
      })));
}
