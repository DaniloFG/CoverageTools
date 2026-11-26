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

/** How the test runs of the whole window are scheduled. */
export interface RunSettings {
  mode: 'sequential' | 'parallel';
  /** The most runs at a time in parallel mode; 0 chooses from the machine's cores. */
  maxParallel: number;
}

export const DEFAULT_RUN_SETTINGS: Readonly<RunSettings> = Object.freeze({ mode: 'sequential', maxParallel: 0 });

/** The run settings from raw configuration values, with the defaults for anything unset or invalid. */
export function runSettingsFrom(mode: unknown, maxParallel: unknown): RunSettings {
  const valid = typeof maxParallel === 'number' && Number.isFinite(maxParallel) && maxParallel >= 1;
  return {
    mode: mode === 'sequential' || mode === 'parallel' ? mode : DEFAULT_RUN_SETTINGS.mode,
    maxParallel: valid ? Math.floor(maxParallel) : DEFAULT_RUN_SETTINGS.maxParallel,
  };
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
  exclude: [
    '**/node_modules/**',
    '**/bin/**',
    '**/obj/**',
    '**/.venv/**',
    '**/venv/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/.conda/**',
    '**/site-packages/**',
    '**/build/lib/**',
    '**/__pycache__/**',
  ],
  nestedProjects: 'inner',
  dotnetCollector: '',
  dotnetExtraArgs: [],
  nodeExtraArgs: [],
  pythonInterpreter: '',
  pythonExtraArgs: [],
  commands: {},
});
