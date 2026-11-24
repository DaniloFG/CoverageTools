/** Effective settings of one workspace folder. */
export interface Settings {
  watchEnabled: boolean;
  watchGlobs: string[];
  exclude: string[];
  nestedProjects: 'inner' | 'outer';
  dotnetCollector: string;
  dotnetExtraArgs: string[];
  nodeExtraArgs: string[];
  pythonInterpreter: string;
  pythonExtraArgs: string[];
  commands: Record<string, string>;
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const v of Object.values(value)) if (typeof v === 'object' && v !== null) deepFreeze(v);
  return Object.freeze(value);
}

/**
 * Deeply frozen: copy what you need to change (`{ ...DEFAULT_SETTINGS, exclude: [...DEFAULT_SETTINGS.exclude] }`).
 * Typed shallowly `Readonly` so it still passes where a `Settings` is expected.
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = deepFreeze({
  watchEnabled: true,
  watchGlobs: [
    '**/TestResults/**/*.cobertura.xml',
    '**/coverage/coverage-final.json',
    '**/coverage/lcov.info',
    '**/coverage/cobertura-coverage.xml',
    '**/coverage.xml',
    '**/coverage.lcov',
    '**/.coverage',
  ],
  exclude: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**'],
  nestedProjects: 'inner',
  dotnetCollector: '',
  dotnetExtraArgs: [],
  nodeExtraArgs: [],
  pythonInterpreter: '',
  pythonExtraArgs: [],
  commands: {},
});
