import { expect, test, vi } from 'vitest';
import type { Project } from '../../../src/adapters/types';
import type { RunSettings } from '../../../src/settings';

interface FakeItem { label: string; kind?: number; description?: string; project?: Project }
interface FakeButton { tooltip: string; iconPath: { id: string } }

/** The parts of a QuickPick the picker uses; the test plays the user through `accept`, `press` and `hide`. */
class FakeQuickPick {
  title = '';
  placeholder = '';
  canSelectMany = false;
  matchOnDescription = false;
  items: FakeItem[] = [];
  selectedItems: FakeItem[] = [];
  buttons: FakeButton[] = [];
  shown = false;
  disposed = false;
  private onAccept: () => void = () => undefined;
  private onHide: () => void = () => undefined;
  private onButton: (b: FakeButton) => void = () => undefined;
  onDidAccept(l: () => void) { this.onAccept = l; return { dispose() {} }; }
  onDidHide(l: () => void) { this.onHide = l; return { dispose() {} }; }
  onDidTriggerButton(l: (b: FakeButton) => void) { this.onButton = l; return { dispose() {} }; }
  show() { this.shown = true; }
  hide() { this.onHide(); }
  dispose() { this.disposed = true; }
  tick(...labels: string[]) { this.selectedItems = this.items.filter(i => labels.includes(i.label)); }
  accept() { this.onAccept(); }
  press(tooltip: RegExp) {
    const button = this.buttons.find(b => tooltip.test(b.tooltip));
    if (button === undefined) throw new Error(`no button matches ${tooltip}: ${this.buttons.map(b => b.tooltip).join(' | ')}`);
    this.onButton(button);
  }
}

const h = vi.hoisted(() => ({ picks: [] as unknown[] }));

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ThemeIcon: class { constructor(public id: string) {} },
  window: {
    createQuickPick: () => {
      const pick = new FakeQuickPick();
      h.picks.push(pick);
      return pick;
    },
  },
}));

const { pickProjects } = await import('../../../src/vscode/projectPicker');

function project(folder: string, name: string): Project {
  const dir = `${folder}/${name}`;
  return { key: `project:${dir}`, adapter: 'jest', ecosystem: 'node', dir, name, supportsPartial: true, meta: { workspaceFolder: folder } };
}
const a = project('/w/one', 'a');
const b = project('/w/one', 'b');
const c = project('/w/two', 'c');
const folders = [{ name: 'one', fsPath: '/w/one' }, { name: 'two', fsPath: '/w/two' }];

function open(remembered: string[] = [], initial: RunSettings['mode'] = 'sequential') {
  let mode = initial;
  const written: string[] = [];
  const result = pickProjects([a, b, c], {
    folders, remembered, mode: () => mode,
    setMode: async next => { written.push(next); mode = next; },
  });
  return { result, written, pick: h.picks[h.picks.length - 1] as FakeQuickPick };
}

const tick = () => new Promise(r => setImmediate(r));

test('the picker lists every project under its workspace folder, ticks several at once and filters on path and stack too', () => {
  const { pick } = open();
  expect(pick.shown).toBe(true);
  expect(pick.canSelectMany).toBe(true);
  expect(pick.matchOnDescription).toBe(true);
  expect(pick.items.map(i => (i.kind === -1 ? `# ${i.label}` : `${i.label} | ${i.description}`))).toEqual([
    '# one', 'a | a · Jest', 'b | b · Jest', '# two', 'c | c · Jest',
  ]);
  expect(pick.placeholder).toBe('Tick the test projects to run coverage for');
});

test('nothing is ticked the first time; afterwards the projects run last time are', () => {
  expect(open().pick.selectedItems).toEqual([]);
  expect(open([b.key, c.key]).pick.selectedItems.map(i => i.label)).toEqual(['b', 'c']);
});

test('accepting resolves with the ticked projects, in list order whatever order they were ticked in', async () => {
  const { pick, result } = open();
  pick.selectedItems = [pick.items[4], pick.items[1]];
  pick.accept();
  expect(await result).toEqual([a, c]);
  expect(pick.disposed).toBe(true);
});

test('accepting with nothing ticked resolves with no project', async () => {
  const { pick, result } = open();
  pick.accept();
  expect(await result).toEqual([]);
});

test('dismissing the picker resolves with undefined: nothing runs', async () => {
  const { pick, result } = open([a.key]);
  pick.hide();
  expect(await result).toBeUndefined();
  expect(pick.disposed).toBe(true);
});

test('the Run All button resolves with every project, whatever is ticked', async () => {
  const { pick, result } = open([a.key]);
  pick.press(/^Run all 3 projects$/);
  expect(await result).toEqual([a, b, c]);
});

test('the title tells the run mode; the mode button switches it, stores the choice and keeps the picker open with its ticks', async () => {
  const { pick, written } = open([a.key]);
  expect(pick.title).toBe('Run Coverage: one project at a time (lighter on CPU and memory)');
  pick.press(/^Switch to projects in parallel \(faster, uses more CPU and memory\)$/);
  await tick();
  expect(written).toEqual(['parallel']);
  expect(pick.title).toBe('Run Coverage: projects in parallel (faster, uses more CPU and memory)');
  expect(pick.selectedItems.map(i => i.label)).toEqual(['a']);
  expect(pick.disposed).toBe(false);
  pick.press(/^Switch to one project at a time \(lighter on CPU and memory\)$/);
  await tick();
  expect(written).toEqual(['parallel', 'sequential']);
  expect(pick.title).toBe('Run Coverage: one project at a time (lighter on CPU and memory)');
});

test('a mode that cannot be stored leaves the picker as it was', async () => {
  const result = pickProjects([a], { folders, remembered: [], mode: () => 'sequential', setMode: async () => { throw new Error('read-only settings'); } });
  const pick = h.picks[h.picks.length - 1] as FakeQuickPick;
  pick.press(/^Switch to projects in parallel/);
  await tick();
  expect(pick.title).toBe('Run Coverage: one project at a time (lighter on CPU and memory)');
  pick.hide();
  expect(await result).toBeUndefined();
});
